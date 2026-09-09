# -*- coding: utf-8 -*-
"""
AML 平台种(amlkit)—— Agent 训练代码唯一允许的平台依赖。

职责:
  1. 加载 AML 数据集快照(memmap 零拷贝);
  2. 进度协议上报(##AML NDJSON 行,stdout 唯一契约通道);
  3. 指标落盘(metrics.json 合并写);
  4. torch 模型 → one-step ONNX 导出助手(统一 IO 契约)。

模型 IO 契约(canonical one-step,MPC 面向):
  输入  history: float32 [batch, historySteps, nAllNodes](归一化)
  输出  y_next : float32 [batch, nTargetNodes](归一化的"下一拍"目标)
  多步预测 = 闭环滚动:预测输出回填 history 的 target 列,control 列取未来 U,
  feature 列持最后观测值(persistence 假设,评估器与推理服务同口径实现)。
"""
import json
import os
import sys
from pathlib import Path

import numpy as np


class Bundle:
    """数据集快照句柄:x/u/y 为 float32 memmap,split 切片为连续段。"""

    def __init__(self, dataset_path):
        base = Path(dataset_path)
        self.manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
        sp = self.manifest["split"]
        n = sp["train"] + sp["val"] + sp["test"]
        shapes = self.manifest["shapes"]
        arrays = base / "arrays"
        self.x = np.memmap(arrays / "x.f32", dtype="<f4", mode="r", shape=tuple(shapes["x"]))
        self.u = np.memmap(arrays / "u.f32", dtype="<f4", mode="r", shape=tuple(shapes["u"]))
        self.y = np.memmap(arrays / "y.f32", dtype="<f4", mode="r", shape=tuple(shapes["y"]))
        self.splits = {
            "train": slice(0, sp["train"]),
            "val": slice(sp["train"], sp["train"] + sp["val"]),
            "test": slice(sp["train"] + sp["val"], n),
        }

    def get(self, name, split):
        """name in {x,u,y};返回该切分的 numpy 拷贝(便于 shuffle/负采样)"""
        arr = getattr(self, name)
        return np.array(arr[self.splits[split]])


def load_bundle(dataset_path):
    return Bundle(dataset_path)


def _safe_job_path(*parts):
    """作业目录内收敛:resolve 规范化 + parents 前缀校验,越界即抛错。

    平台工件(metrics.json / model.onnx)只允许写进作业目录 artifacts/ 下。
    """
    env_job_dir = os.environ.get("AML_JOB_DIR", "")
    if not env_job_dir:
        raise RuntimeError("AML_JOB_DIR 未设置(只能经 aml_run.py 运行)")
    root = Path(env_job_dir).resolve()
    target = root.joinpath(*parts).resolve()
    if target != root and root not in target.parents:
        raise RuntimeError("工件路径越界(已拒绝): %s" % target)
    return str(target)


def _artifacts_dir():
    d = _safe_job_path("artifacts")
    os.makedirs(d, exist_ok=True)
    return d


def report_progress(pct, note=""):
    """进度上报(0-100);协议行之外的 print 也会被平台收进 run.log,但只有 ##AML 行被解析。"""
    pct = max(0, min(100, int(pct)))
    _emit({"type": "progress", "progress": pct, "note": str(note)[:200]})


def _emit(obj):
    sys.stdout.write("##AML " + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def save_metrics(extra):
    """合并写 artifacts/metrics.json(agent 侧自报指标;平台会在评估阶段补权威指标)"""
    p = Path(_artifacts_dir()) / "metrics.json"
    cur = {}
    if p.exists():
        try:
            cur = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            cur = {}
    cur.update(extra)
    p.write_text(json.dumps(cur, ensure_ascii=False, indent=2), encoding="utf-8")
    return cur


def export_torch_onnx(model, manifest, path=None):
    """把接受 [batch, H, nAll] → [batch, nTgt](归一化)的 torch 模型导出为契约 ONNX。

    返回导出路径;失败抛异常(训练作业按失败处理,不静默)。
    """
    import torch  # 惰性:仅深度模型需要

    h = manifest["shapes"]["x"][1]
    n_all = manifest["shapes"]["x"][2]
    n_tgt = manifest["shapes"]["y"][2]
    p = _safe_job_path("artifacts", "model.onnx") if path is None else str(path)
    model = model.cpu().eval()
    dummy = torch.zeros(1, h, n_all, dtype=torch.float32)
    with torch.no_grad():
        torch.onnx.export(
            model, dummy, p,
            input_names=["history"], output_names=["y_next"],
            dynamic_axes={"history": {0: "batch"}, "y_next": {0: "batch"}},
            opset_version=17,
        )
    return p
