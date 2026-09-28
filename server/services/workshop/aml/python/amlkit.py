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
    torch≥2.10 的 dynamo 导出器默认把权重写成外部数据文件(<path>.data)——
    模型实体必须自包含才能拷贝/移植,导出后立即内联。
    """
    import torch  # 惰性:仅深度模型需要

    h = manifest["shapes"]["x"][1]
    n_all = manifest["shapes"]["x"][2]
    n_tgt = manifest["shapes"]["y"][2]
    p = Path(_safe_job_path("artifacts", "model.onnx")) if path is None else Path(path)
    model = model.cpu().eval()
    dummy = torch.zeros(1, h, n_all, dtype=torch.float32)
    with torch.no_grad():
        torch.onnx.export(
            model, dummy, str(p),
            input_names=["history"], output_names=["y_next"],
            dynamic_axes={"history": {0: "batch"}, "y_next": {0: "batch"}},
            opset_version=17,
        )
    data_file = p.with_name(p.name + ".data")
    if data_file.exists():
        try:
            import onnx
            loaded = onnx.load(str(p), load_external_data=True)
            onnx.save(loaded, str(p))
            data_file.unlink()
        except Exception:
            pass  # onnx 包缺失或内联失败:保留外部数据文件,至少本地可推理
    return str(p)


def _load_json_from_job(name):
    """读取作业目录下的受控 Twin 工件，不允许越界。"""
    p = Path(_safe_job_path(name))
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def sha256_json(value):
    import hashlib
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def load_physics_spec(job_or_path=None):
    """加载受控 physics_spec.json；缺失时返回空对象，保持 legacy AML 兼容。"""
    if job_or_path:
        p = Path(str(job_or_path))
        if p.is_dir():
            candidate = p / "physics_spec.json"
            if candidate.exists():
                return json.loads(candidate.read_text(encoding="utf-8"))
    return _load_json_from_job("physics_spec.json")


def load_physics_manifest(job_or_path=None):
    """加载 physics_manifest.json；缺失时返回空 manifest，保持 legacy AML 兼容。"""
    if job_or_path:
        p = Path(str(job_or_path))
        if p.is_dir():
            candidate = p / "physics_manifest.json"
            if candidate.exists():
                return json.loads(candidate.read_text(encoding="utf-8"))
    return _load_json_from_job("physics_manifest.json")


def load_twin_snapshot(job_or_path=None):
    if job_or_path:
        p = Path(str(job_or_path))
        if p.is_dir():
            candidate = p / "twin_snapshot.json"
            if candidate.exists():
                return json.loads(candidate.read_text(encoding="utf-8"))
    return _load_json_from_job("twin_snapshot.json")


def load_objective_profile(job_or_path=None):
    if job_or_path:
        p = Path(str(job_or_path))
        if p.is_dir():
            candidate = p / "objective_profile.json"
            if candidate.exists():
                return json.loads(candidate.read_text(encoding="utf-8"))
    return _load_json_from_job("objective_profile.json")



def _physics_eval_expr(expr, values, parameters, dt_sec):
    if isinstance(expr, (int, float)):
        return float(expr)
    if not isinstance(expr, dict):
        return float("nan")
    if "ref" in expr:
        ref = str(expr["ref"])
        if ref in ("dt", "dtSec"):
            return float(dt_sec)
        return float(values.get(ref, float("nan")))
    if "param" in expr:
        return float(parameters.get(str(expr["param"]), float("nan")))
    for key in ("value", "const", "literal"):
        if key in expr:
            return float(expr[key])
    op = str(expr.get("op", ""))
    args = [_physics_eval_expr(a, values, parameters, dt_sec) for a in expr.get("args", [])]
    if not all(np.isfinite(a) for a in args):
        return float("nan")
    if op == "add": return float(sum(args))
    if op == "sub": return args[0] - args[1] if len(args) >= 2 else float("nan")
    if op == "mul": return float(np.prod(args))
    if op == "div": return args[0] / args[1] if len(args) >= 2 and args[1] != 0 else float("nan")
    if op == "pow": return float(np.power(args[0], args[1])) if len(args) >= 2 else float("nan")
    if op == "exp": return float(np.exp(args[0])) if len(args) == 1 else float("nan")
    if op == "log": return float(np.log(args[0])) if len(args) == 1 and args[0] > 0 else float("nan")
    if op == "min": return float(min(args)) if args else float("nan")
    if op == "max": return float(max(args)) if args else float("nan")
    if op == "clamp": return float(min(args[2], max(args[1], args[0]))) if len(args) == 3 else float("nan")
    return float("nan")


def _denorm(arr, norm):
    mean = np.asarray(norm.get("mean", []), dtype=np.float32)
    std = np.asarray(norm.get("std", []), dtype=np.float32)
    if mean.size != arr.shape[-1] or std.size != arr.shape[-1]:
        raise RuntimeError("PHYSICS_NORM_SHAPE_MISMATCH")
    return arr * std + mean


def _norm(arr, norm):
    mean = np.asarray(norm.get("mean", []), dtype=np.float32)
    std = np.maximum(np.asarray(norm.get("std", []), dtype=np.float32), 1e-8)
    return (arr - mean) / std


def compute_physics_targets(bundle, physics_spec, split="train"):
    """用受控 PhysicsSpec 对 bundle 每个窗口生成 raw/normalized y_phys。

    这是训练和平台评估共享的最小离散 rollout：物理方程先更新 state，
    observations 再产生 target；任何变量缺失、非法算子或非有限值都 fail-closed，
    绝不把 physics_next 默认为 0。
    """
    if not physics_spec or not isinstance(physics_spec, dict):
        raise RuntimeError("HYBRID_PHYSICS_SPEC_REQUIRED")
    manifest = bundle.manifest
    x_norm = bundle.get("x", split)
    u_norm = bundle.get("u", split)
    if x_norm.shape[0] == 0:
        return np.empty((0, manifest["shapes"]["u"][1], manifest["shapes"]["y"][2]), dtype=np.float32)
    all_nodes = [str(v) for v in manifest.get("allNodes", [])]
    control_nodes = [str(v) for v in manifest.get("controlNodes", [])]
    target_nodes = [str(v) for v in manifest.get("targetNodes", [])]
    if not all_nodes or not target_nodes:
        raise RuntimeError("HYBRID_NODE_ORDER_REQUIRED")
    all_pos = {name: i for i, name in enumerate(all_nodes)}
    control_pos = {name: i for i, name in enumerate(control_nodes)}
    target_pos = {name: i for i, name in enumerate(target_nodes)}
    x_raw = _denorm(x_norm, manifest["norm"]["x"])
    u_raw = _denorm(u_norm, manifest["norm"]["u"])
    variables = {str(v.get("id")): v for v in physics_spec.get("variables", []) if isinstance(v, dict) and v.get("id")}
    aliases = {str(v.get("nodeId")): str(v.get("id")) for v in physics_spec.get("variables", []) if isinstance(v, dict) and v.get("nodeId") and v.get("id")}
    parameters = {}
    for p in physics_spec.get("parameters", []):
        if isinstance(p, dict) and p.get("id"):
            value = p.get("value", p.get("defaultValue"))
            if value is None:
                raise RuntimeError("HYBRID_PARAMETER_VALUE_REQUIRED:" + str(p["id"]))
            parameters[str(p["id"])] = float(value)
    states = [e for e in physics_spec.get("states", []) if isinstance(e, dict)]
    observations = [e for e in physics_spec.get("observations", []) if isinstance(e, dict)]
    dt_sec = float((physics_spec.get("solver") or {}).get("dtSec", 1.0))
    horizon = int(manifest["shapes"]["u"][1])
    out = np.empty((x_raw.shape[0], horizon, len(target_nodes)), dtype=np.float32)
    for i in range(x_raw.shape[0]):
        hist = x_raw[i].copy()
        for k in range(horizon):
            values = {}
            for name, pos in all_pos.items():
                value = float(hist[-1, pos])
                values[name] = value
                if name in aliases:
                    values[aliases[name]] = value
            for name, pos in control_pos.items():
                value = float(u_raw[i, k, pos])
                values[name] = value
                if name in aliases:
                    values[aliases[name]] = value
            for equation in states:
                lhs = str(equation.get("lhs", ""))
                base = lhs[:-5] if lhs.endswith("_next") else lhs
                raw_value = _physics_eval_expr(equation.get("rhs"), values, parameters, dt_sec)
                value = (float(values.get(base, 0.0)) + dt_sec * raw_value) if str((physics_spec.get("solver") or {}).get("method", "discrete_state_space")) == "ode" else raw_value
                if not np.isfinite(value):
                    raise RuntimeError(f"HYBRID_PHYSICS_NON_FINITE:{i}:{k}:{lhs}")
                values[base] = value
                values[lhs] = value
            observed = {}
            for equation in observations:
                lhs = str(equation.get("lhs", ""))
                value = _physics_eval_expr(equation.get("rhs"), values, parameters, dt_sec)
                if not np.isfinite(value):
                    raise RuntimeError(f"HYBRID_PHYSICS_NON_FINITE:{i}:{k}:{lhs}")
                observed[lhs] = value
                values[lhs] = value
            for j, target in enumerate(target_nodes):
                variable_id = aliases.get(target, target)
                value = observed.get(target, observed.get(variable_id, values.get(target, values.get(variable_id, float("nan")))))
                if not np.isfinite(value):
                    raise RuntimeError(f"HYBRID_TARGET_NOT_PRODUCED:{target}")
                out[i, k, j] = value
            next_row = hist[-1].copy()
            for name, pos in control_pos.items():
                next_row[all_pos[name]] = u_raw[i, k, pos]
            for j, target in enumerate(target_nodes):
                if target in all_pos:
                    next_row[all_pos[target]] = out[i, k, j]
            hist = np.vstack([hist, next_row[None, :]])
    return _norm(out, manifest["norm"]["y"]).astype(np.float32)


def compute_physics_step(manifest, physics_spec, history_norm, control_norm):
    """根据一条归一化 history 和一拍未来 control 计算归一化物理 observation。"""
    all_nodes = [str(v) for v in manifest.get("allNodes", [])]
    control_nodes = [str(v) for v in manifest.get("controlNodes", [])]
    target_nodes = [str(v) for v in manifest.get("targetNodes", [])]
    x = np.asarray(history_norm, dtype=np.float32)
    u = np.asarray(control_norm, dtype=np.float32)
    if x.ndim != 2 or u.ndim != 1:
        raise RuntimeError("HYBRID_PHYSICS_STEP_SHAPE")
    x_raw = _denorm(x, manifest["norm"]["x"])
    u_raw = _denorm(u[None, :], manifest["norm"]["u"])[0]
    aliases = {str(v.get("nodeId")): str(v.get("id")) for v in physics_spec.get("variables", []) if isinstance(v, dict) and v.get("nodeId") and v.get("id")}
    values = {}
    for pos, name in enumerate(all_nodes):
        value = float(x_raw[-1, pos])
        values[name] = value
        if name in aliases:
            values[aliases[name]] = value
    for pos, name in enumerate(control_nodes):
        value = float(u_raw[pos])
        values[name] = value
        if name in aliases:
            values[aliases[name]] = value
    params = {}
    for p in physics_spec.get("parameters", []):
        if isinstance(p, dict) and p.get("id"):
            value = p.get("value", p.get("defaultValue"))
            if value is None:
                raise RuntimeError("HYBRID_PARAMETER_VALUE_REQUIRED:" + str(p["id"]))
            params[str(p["id"])] = float(value)
    dt_sec = float((physics_spec.get("solver") or {}).get("dtSec", 1.0))
    for equation in physics_spec.get("states", []):
        lhs = str(equation.get("lhs", ""))
        base = lhs[:-5] if lhs.endswith("_next") else lhs
        raw_value = _physics_eval_expr(equation.get("rhs"), values, params, dt_sec)
        value = (float(values.get(base, 0.0)) + dt_sec * raw_value) if str((physics_spec.get("solver") or {}).get("method", "discrete_state_space")) == "ode" else raw_value
        if not np.isfinite(value):
            raise RuntimeError("HYBRID_PHYSICS_NON_FINITE:" + lhs)
        values[base] = value
        values[lhs] = value
    observed = {}
    for equation in physics_spec.get("observations", []):
        lhs = str(equation.get("lhs", ""))
        value = _physics_eval_expr(equation.get("rhs"), values, params, dt_sec)
        if not np.isfinite(value):
            raise RuntimeError("HYBRID_PHYSICS_NON_FINITE:" + lhs)
        observed[lhs] = value
        values[lhs] = value
    aliases = {str(v.get("nodeId")): str(v.get("id")) for v in physics_spec.get("variables", []) if isinstance(v, dict) and v.get("nodeId") and v.get("id")}
    raw = []
    for target in target_nodes:
        variable_id = aliases.get(target, target)
        value = observed.get(target, observed.get(variable_id, values.get(target, values.get(variable_id, float("nan")))))
        if not np.isfinite(value):
            raise RuntimeError("HYBRID_TARGET_NOT_PRODUCED:" + target)
        raw.append(value)
    return _norm(np.asarray(raw, dtype=np.float32)[None, :], manifest["norm"]["y"])[0]


def report_physics_metrics(metrics):
    return save_metrics({"physics": dict(metrics)})


def report_uncertainty(metrics):
    return save_metrics({"uncertainty": dict(metrics)})


def export_hybrid_model(physics_model, residual_model, manifest, physics_parameters=None):
    """导出物理参数、残差 state_dict 和 ONNX（residual_model 需符合 one-step 输入契约）。"""
    import torch
    artifact_dir = Path(_artifacts_dir())
    if physics_parameters is not None:
        (artifact_dir / "physics_parameters.json").write_text(json.dumps(physics_parameters, ensure_ascii=False, indent=2), encoding="utf-8")
    if residual_model is not None:
        torch.save({"state_dict": residual_model.state_dict()}, artifact_dir / "model.pt")
        export_torch_onnx(residual_model, manifest)
    if physics_model is not None:
        try:
            torch.save({"state_dict": physics_model.state_dict()}, artifact_dir / "physics_model.pt")
        except AttributeError:
            (artifact_dir / "physics_model.json").write_text(json.dumps(physics_model, ensure_ascii=False, indent=2), encoding="utf-8")
    (artifact_dir / "hybrid_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(artifact_dir)
