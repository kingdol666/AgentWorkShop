# -*- coding: utf-8 -*-
"""
AML 权威评估器(平台代码,独立于训练进程):
  加载数据集 + artifacts/model.onnx → one-step(val/test)+ horizon 闭环滚动(test)
  → 反归一化计算 NRMSE/RMSE/MAE → 合并写 metrics.json → 协议行输出。

权威指标在这里统一计算,不采信 Agent 训练代码的自报(平台信任边界)。
训练进程(workspace/train.py)先行独立运行;本评估器是流水线第二拍。

用法: aml_eval.py --job <job.json>
退出码: 0 成功(metrics.json 权威段就绪);1 失败(含 test 切分为空/模型不可加载)。
"""
import argparse
import json
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # amlkit 与本文件同目录

JOB_DIR = Path(os.environ.get("AML_JOB_DIR", "")).resolve()
ARTIFACTS = JOB_DIR / "artifacts"


def emit(obj):
    sys.stdout.write("##AML " + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    args = ap.parse_args()
    job = json.loads(Path(args.job).read_text(encoding="utf-8"))

    import numpy as np
    import amlkit

    emit({"type": "stage", "stage": "evaluating"})
    bundle = amlkit.load_bundle(job["datasetPath"])
    manifest = bundle.manifest
    n_all = manifest["shapes"]["x"][2]
    n_tgt = manifest["shapes"]["y"][2]
    h_steps = manifest["shapes"]["x"][1]
    horizon = manifest["shapes"]["u"][1]

    model_path = ARTIFACTS / "model.onnx"
    if not model_path.is_file():
        emit({"type": "error", "message": "训练完成但未产出 artifacts/model.onnx(须调用 amlkit.export_torch_onnx 或自行按契约导出)"})
        return 1

    import onnxruntime as ort

    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name

    def predict_next(hist_norm):
        out = sess.run(None, {inp_name: hist_norm.astype(np.float32)[None, ...]})[0]
        return np.asarray(out[0], dtype=np.float64)  # [n_tgt] 归一化

    def denorm_targets(y_norm):
        mean = np.array(manifest["norm"]["y"]["mean"], dtype=np.float64)
        std = np.array(manifest["norm"]["y"]["std"], dtype=np.float64)
        return y_norm * std + mean

    def eval_one_step(split_name, max_windows=2000):
        x = bundle.get("x", split_name)
        y = bundle.get("y", split_name)
        if x.shape[0] == 0:
            return None
        idx = np.linspace(0, x.shape[0] - 1, min(max_windows, x.shape[0])).astype(int)
        preds = []
        truths = []
        for i in idx:
            preds.append(predict_next(x[i]))
            truths.append(y[i][0])
        preds = np.array(preds)
        truths = np.array(truths)
        p_raw = denorm_targets(preds)
        t_raw = denorm_targets(truths)
        per_target = []
        for j in range(n_tgt):
            rmse = float(np.sqrt(np.mean((p_raw[:, j] - t_raw[:, j]) ** 2)))
            std = float(np.std(t_raw[:, j])) or 1e-9
            per_target.append({
                "rmse": rmse,
                "mae": float(np.mean(np.abs(p_raw[:, j] - t_raw[:, j]))),
                "nrmse": rmse / std,
            })
        return {
            "windows": int(idx.size),
            "nrmse": float(np.mean([d["nrmse"] for d in per_target])),
            "perTarget": per_target,
        }

    # 闭环滚动:预测回填 target 列;control 列取未来 U;feature 列持最后观测(persistence)
    ctrl_positions = [manifest["allNodes"].index(cid) for cid in manifest["controlNodes"]]
    tgt_positions = [manifest["allNodes"].index(tid) for tid in manifest["targetNodes"]]
    feat_positions = [p for p in range(n_all) if p not in ctrl_positions and p not in tgt_positions]

    def eval_rollout(max_windows=500):
        x = bundle.get("x", "test")
        u = bundle.get("u", "test")
        y = bundle.get("y", "test")
        if x.shape[0] == 0:
            return None
        idx = np.linspace(0, x.shape[0] - 1, min(max_windows, x.shape[0])).astype(int)
        errs = np.zeros(n_tgt)
        count = 0
        for i in idx:
            hist = x[i].copy()  # [H, n_all] 归一化
            for k in range(horizon):
                nxt = predict_next(hist[-h_steps:])
                row = np.zeros(n_all, dtype=np.float64)
                row[feat_positions] = hist[-1][feat_positions]
                for cp, uv in zip(ctrl_positions, u[i][k]):
                    row[cp] = uv
                for tp, yv in zip(tgt_positions, nxt):
                    row[tp] = yv
                hist = np.vstack([hist, row[None, :]])
                truth_k = y[i][k]
                errs += (nxt - truth_k) ** 2
                count += 1
        # 逐 (窗口, 步) 平方误差均值 → 逐步 RMSE(与预测服务逐拍输出同口径)
        rmse_norm = np.sqrt(errs / max(1, count))
        std = np.array(manifest["norm"]["y"]["std"], dtype=np.float64)
        nrmse = float(np.mean(rmse_norm / std))
        return {"windows": int(idx.size), "horizon": horizon, "nrmse": nrmse}

    ev_val = eval_one_step("val")
    ev_test = eval_one_step("test")
    ev_roll = eval_rollout()
    if ev_test is None:
        emit({"type": "error", "message": "test 切分为空(byRun 切分后无测试批次),无法评估"})
        return 1

    platform_metrics = {"platform": {
        "oneStepVal": ev_val,
        "oneStepTest": ev_test,
        "rolloutTest": ev_roll,
        "ioSpec": {
            "historySteps": h_steps,
            "horizonSteps": horizon,
            "allNodes": manifest["allNodes"],
            "controlNodes": manifest["controlNodes"],
            "targetNodes": manifest["targetNodes"],
            "norm": manifest["norm"],
            "assumptions": "rollout: control 取未来 U,feature 持最后观测(persistence),target 回填预测",
        },
    }}
    merged = amlkit.save_metrics(platform_metrics)
    emit({"type": "metrics", "metrics": {"platform": platform_metrics["platform"], "agent": {
        k: v for k, v in merged.items() if k != "platform"}}})
    emit({"type": "done"})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - 评估器顶层兜底:失败必须带回信息而非裸崩
        emit({"type": "error", "message": "评估器异常:%s" % e})
        traceback.print_exc()
        sys.exit(1)
