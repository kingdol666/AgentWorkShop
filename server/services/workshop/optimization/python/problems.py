"""
ProblemIR 编译/求解的数值实现(与 TS problem-builder 的离散语义逐项对齐)。

- 线性 MPC:y_t = o_t + S_t·u(对 Δu 的稠密二次型),交给 OSQP;
- 稳态响应面:经济代价 + CV 跟踪,SciPy SLSQP 有界约束优化。
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
# 求解器依赖在模块加载时导入(不在求解线程内做 lazy import:3.12 下线程内 import
# 与主线程 stdin 阻塞读同时存在时会卡住导入锁)。
import osqp  # type: ignore
import scipy.sparse as sp  # type: ignore
from scipy.optimize import minimize  # type: ignore


def _as_matrix(flat: list[float], rows: int, cols: int) -> np.ndarray:
    return np.asarray(flat, dtype=float).reshape((rows, cols))


class LinearMpcProblem:
    def __init__(self, ir: dict[str, Any]):
        problem = ir["problem"]
        dyn = problem["dynamics"]
        self.state_dim = int(dyn["stateDim"])
        self.mv_order = list(problem["mvOrder"])
        self.cv_order = list(problem["cvOrder"])
        self.mv_count = len(self.mv_order)
        self.cv_count = len(self.cv_order)
        self.horizon = int(ir["horizon"])
        self.A = _as_matrix(dyn["A"], self.state_dim, self.state_dim)
        self.B = _as_matrix(dyn["B"], self.state_dim, self.mv_count)
        self.C = _as_matrix(dyn["C"], self.cv_count, self.state_dim)
        self.D = _as_matrix(dyn["D"], self.cv_count, self.mv_count)
        self.x0 = np.asarray(dyn["x0"], dtype=float)
        self.bias = np.asarray(dyn.get("bias") or [0.0] * self.state_dim, dtype=float)
        self.u_prev = np.asarray(problem["uPrev"], dtype=float)
        self.cv_setpoints = np.asarray(problem["cvSetpoints"], dtype=float)
        weights = ir["weights"]
        self.q = np.asarray([float(weights["cv"].get(cv, 1.0)) for cv in self.cv_order], dtype=float)
        self.r = np.asarray([float(weights["du"].get(mv, 0.0)) for mv in self.mv_order], dtype=float)
        self.terminal = float(weights.get("terminal") or 0.0)
        self.mv_bounds = problem["mvBounds"]
        raw_cv_bounds = problem.get("cvBounds")
        self.cv_bounds = [{} for _ in self.cv_order] if raw_cv_bounds is None else list(raw_cv_bounds)
        if len(self.mv_bounds) != self.mv_count:
            raise ValueError(f"mvBounds 维度 {len(self.mv_bounds)} != MV 数 {self.mv_count}")
        if len(self.cv_bounds) != self.cv_count:
            raise ValueError(f"cvBounds 维度 {len(self.cv_bounds)} != CV 数 {self.cv_count}")
        self.sensitivity: list[np.ndarray] = []
        self.offset: list[np.ndarray] = []
        self._build_sensitivity()

    def _build_sensitivity(self) -> None:
        """y_t = offset_t + S_t·u,t=1..H(u 为 H 步 MV 序列)。"""
        hm = self.horizon * self.mv_count
        x_affine_A = np.zeros((self.state_dim, self.state_dim))
        x_affine_b = np.zeros(self.state_dim)
        # x_0 = x0(与 u 无关);逐步展开:x_t = A^t x0 + Σ_{s<t} A^{t-1-s} B u_s
        powers = [np.eye(self.state_dim)]
        for _ in range(self.horizon):
            powers.append(powers[-1] @ self.A)
        for t in range(1, self.horizon + 1):
            bias_effect = np.zeros(self.state_dim)
            for k in range(t):
                bias_effect = bias_effect + powers[k] @ self.bias
            off = powers[t] @ self.x0 + bias_effect
            sens = np.zeros((self.cv_count, hm))
            for s in range(t):
                block = powers[t - 1 - s] @ self.B  # state effect of u_s
                yblock = self.C @ block  # cv effect
                for m in range(self.mv_count):
                    sens[:, s * self.mv_count + m] += yblock[:, m]
            # D 直通:y_t 含 D·u_{t-1}(u 序列第 t-1 个)
            sens[:, (t - 1) * self.mv_count:(t * self.mv_count)] += self.D
            self.sensitivity.append(sens)
            self.offset.append(self.C @ off)
        del x_affine_A, x_affine_b

    def qp(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        hm = self.horizon * self.mv_count
        P = np.zeros((hm, hm))
        q = np.zeros(hm)
        for t, (sens, off) in enumerate(zip(self.sensitivity, self.offset)):
            w = self.q if t < self.horizon - 1 else self.q * (1.0 + self.terminal)
            P += 2.0 * (sens.T @ (w[:, None] * sens))
            q += 2.0 * (sens.T @ (w * (off - self.cv_setpoints)))
        # Δu 惩罚:每个 MV 一个二阶差分矩阵 D,u_{-1}=uPrev。
        # cost = Σ_m r_m · ||D u_m + c_m||²;P += 2r·DᵀD,q += 2r·Dᵀc。
        for m in range(self.mv_count):
            if self.r[m] <= 0:
                continue
            D = np.zeros((self.horizon, self.horizon))
            c = np.zeros(self.horizon)
            for t in range(self.horizon):
                D[t, t] = 1.0
                if t == 0:
                    c[t] = -float(self.u_prev[m])
                else:
                    D[t, t - 1] = -1.0
            idx = [t * self.mv_count + m for t in range(self.horizon)]
            P[np.ix_(idx, idx)] += 2.0 * self.r[m] * (D.T @ D)
            q[idx] += 2.0 * self.r[m] * (D.T @ c)
        # 对称化
        P = 0.5 * (P + P.T)
        # 约束:l <= Az <= u(变量边界 + 速率)
        rows = []
        lows = []
        highs = []
        for t in range(self.horizon):
            for m in range(self.mv_count):
                idx = t * self.mv_count + m
                row = np.zeros(hm)
                row[idx] = 1.0
                rows.append(row)
                bounds = self.mv_bounds[m]
                lows.append(float(bounds.get("min", -np.inf)))
                highs.append(float(bounds.get("max", np.inf)))
                max_step = bounds.get("maxStep")
                if max_step is not None:
                    row2 = np.zeros(hm)
                    row2[idx] = 1.0
                    prev = self.u_prev[m] if t == 0 else None
                    if prev is not None:
                        lows.append(-float(max_step) + prev)
                        highs.append(float(max_step) + prev)
                    else:
                        row2[(t - 1) * self.mv_count + m] = -1.0
                        lows.append(-float(max_step))
                        highs.append(float(max_step))
                    rows.append(row2)
        # CV 有效域(软约束之外硬边界;首版按硬约束处理)
        for t in range(self.horizon):
            for j in range(self.cv_count):
                bounds = self.cv_bounds[j] or {}
                lo = bounds.get("min")
                hi = bounds.get("max")
                if lo is None and hi is None:
                    continue
                row = np.zeros(hm)
                sens = self.sensitivity[t][j]
                row += sens
                rows.append(row)
                lows.append(float(lo) - float(self.offset[t][j]) if lo is not None else -np.inf)
                highs.append(float(hi) - float(self.offset[t][j]) if hi is not None else np.inf)
        A = np.vstack(rows) if rows else np.zeros((0, hm))
        return P, q, A, np.asarray(lows), np.asarray(highs)


def _c_stdout_silenced():
    """OSQP(C 库)会绕过 Python 的 sys.stdout 直接写 fd 1;协议要求 stdout 仅 JSONL。"""
    import os
    from contextlib import contextmanager

    @contextmanager
    def _ctx():
        saved = os.dup(1)
        devnull = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull, 1)
            yield
        finally:
            os.dup2(saved, 1)
            os.close(devnull)
            os.close(saved)
    return _ctx()


def _assert_finite_ir(ir: dict[str, Any]) -> None:
    """NaN/Inf 输入必须在进入求解器前拒绝(SLSQP 会把 NaN 误报成 inequality infeasible)。"""
    if not check_finite(ir):
        raise ValueError("ProblemIR 含 NaN/Inf;拒绝求解")


def solve_linear_mpc(ir: dict[str, Any], cancel_check, max_chunk_iters: int = 400) -> dict[str, Any]:
    if cancel_check():
        return {"status": "cancelled", "message": "cancelled before solve"}
    _assert_finite_ir(ir)
    prob = LinearMpcProblem(ir)
    P, q, A, low, high = prob.qp()
    solver = osqp.OSQP()
    solver.setup(
        P=sp.csc_matrix(P), q=q, A=sp.csc_matrix(A), l=low, u=high,
        verbose=False, polish=False, max_iter=max_chunk_iters,
        eps_abs=1e-8, eps_rel=1e-8,
    )
    with _c_stdout_silenced():
        result = solver.solve()
        rounds = 0
        while int(result.info.status_val) == osqp.constant("OSQP_MAX_ITER_REACHED") and rounds < 20:
            if cancel_check():
                return {"status": "cancelled", "message": "cancelled during iterations"}
            rounds += 1
            result = solver.solve()
    status_val = int(result.info.status_val)
    status_text = str(result.info.status)
    solved = osqp.constant("OSQP_SOLVED")
    solved_inaccurate = osqp.constant("OSQP_SOLVED_INACCURATE")
    if result.x is None or status_val not in (solved, solved_inaccurate):
        mapped = {
            osqp.constant("OSQP_PRIMAL_INFEASIBLE"): 'infeasible',
            osqp.constant("OSQP_PRIMAL_INFEASIBLE_INACCURATE"): 'infeasible',
            osqp.constant("OSQP_DUAL_INFEASIBLE"): 'unbounded',
            osqp.constant("OSQP_DUAL_INFEASIBLE_INACCURATE"): 'unbounded',
            osqp.constant("OSQP_MAX_ITER_REACHED"): 'numerical_error',
            osqp.constant("OSQP_TIME_LIMIT_REACHED"): 'timeout',
            osqp.constant("OSQP_NON_CVX"): 'numerical_error',
            osqp.constant("OSQP_SIGINT"): 'cancelled',
        }.get(status_val, 'numerical_error')
        return {
            "status": mapped,
            "message": status_text,
            "iterations": int(getattr(result.info, "iter", 0)),
        }
    z = np.asarray(result.x, dtype=float).reshape((prob.horizon, prob.mv_count))
    predicted = []
    for sens, off in zip(prob.sensitivity, prob.offset):
        predicted.append(off + sens @ z.reshape(-1))
    # 平台同口径代价:全时域跟踪 + 终端 + Δu(不用 QP 的 0.5z'Pz+q'z,
    # 那里缺常数项;A4 要求 Solver 与 TS 独立重算逐项一致)
    cost = 0.0
    for t, row in enumerate(predicted):
        w = prob.q if t < prob.horizon - 1 else prob.q * (1.0 + prob.terminal)
        cost += float(np.sum(w * (row - prob.cv_setpoints) ** 2))
    for t in range(prob.horizon):
        prev = prob.u_prev if t == 0 else z[t - 1]
        cost += float(np.sum(prob.r * (z[t] - prev) ** 2))
    return {
        "status": "optimal" if status_val == solved else "feasible",
        "controls": z.tolist(),
        "predicted": [row.tolist() for row in predicted],
        "cost": cost,
        "iterations": int(getattr(result.info, "iter", 0)),
        "backend": "osqp",
        "solverVersion": getattr(osqp, "__version__", "unknown"),
    }


def solve_steady_response(ir: dict[str, Any], cancel_check) -> dict[str, Any]:
    _assert_finite_ir(ir)
    problem = ir["problem"]
    mv_order = list(problem["mvOrder"])
    cv_order = list(problem["cvOrder"])
    feature_order = list(problem["featureOrder"])
    coefficients = problem["coefficients"]
    targets = np.asarray(problem["cvTargets"], dtype=float)
    weights = ir["weights"]
    economic = weights.get("economic") or {}
    cv_weights = weights.get("cv") or {}
    mv_bounds = problem["mvBounds"]
    raw_cv_bounds = problem.get("cvBounds")
    cv_bounds = [{} for _ in cv_order] if raw_cv_bounds is None else list(raw_cv_bounds)
    if len(mv_bounds) != len(mv_order):
        raise ValueError(f"mvBounds 维度 {len(mv_bounds)} != MV 数 {len(mv_order)}")
    if len(cv_bounds) != len(cv_order):
        raise ValueError(f"cvBounds 维度 {len(cv_bounds)} != CV 数 {len(cv_order)}")
    x0 = np.asarray(problem["uPrev"], dtype=float)
    lo = np.asarray([float(b.get("min", -1e9)) for b in mv_bounds])
    hi = np.asarray([float(b.get("max", 1e9)) for b in mv_bounds])
    for m, bounds in enumerate(mv_bounds):
        if bounds.get("maxStep") is not None:
            step = float(bounds["maxStep"])
            lo[m] = max(lo[m], float(x0[m]) - step)
            hi[m] = min(hi[m], float(x0[m]) + step)
    if np.any(lo > hi):
        return {"status": "infeasible", "message": "MV bounds and maxStep have no feasible intersection"}
    x0 = np.clip(x0, lo, hi)

    def features(u: np.ndarray) -> np.ndarray:
        by_name = {name: float(u[i]) for i, name in enumerate(mv_order)}
        out = []
        for name in feature_order:
            if name == "bias":
                out.append(1.0)
            elif name.endswith("^2"):
                out.append(by_name.get(name[:-2], 0.0) ** 2)
            elif "*" in name:
                a, b = name.split("*", 1)
                out.append(by_name.get(a, 0.0) * by_name.get(b, 0.0))
            else:
                out.append(by_name.get(name, 0.0))
        return np.asarray(out)

    def objective(u: np.ndarray) -> float:
        cost = 0.0
        for i, name in enumerate(mv_order):
            cost += float(economic.get(name, 0.0)) * float(u[i])
        feat = features(u)
        for j, cv in enumerate(cv_order):
            coef = np.asarray(coefficients[cv], dtype=float)
            y = float(coef @ feat)
            cost += float(cv_weights.get(cv, 0.0)) * (y - float(targets[j])) ** 2
        return cost

    def constraints():
        cons = []
        for j, cv in enumerate(cv_order):
            bounds = cv_bounds[j] or {}
            if bounds.get("min") is None and bounds.get("max") is None:
                continue
            coef = np.asarray(coefficients[cv], dtype=float)
            def make(j=j, coef=coef, bounds=bounds):
                def f(u: np.ndarray) -> float:
                    return float(coef @ features(u))
                return f
            f = make()
            if bounds.get("min") is not None:
                cons.append({"type": "ineq", "fun": lambda u, f=f, lo=float(bounds["min"]): f(u) - lo})
            if bounds.get("max") is not None:
                cons.append({"type": "ineq", "fun": lambda u, f=f, hi=float(bounds["max"]): hi - f(u)})
        return cons

    if cancel_check():
        return {"status": "cancelled", "message": "cancelled before solve"}
    result = minimize(
        objective, x0, method="SLSQP", bounds=list(zip(lo, hi)), constraints=constraints(),
        options={"maxiter": 500, "ftol": 1e-10},
    )
    if not result.success:
        return {"status": "infeasible", "message": str(result.message), "iterations": int(result.nit)}
    controls = np.asarray(result.x, dtype=float)
    feat = features(controls)
    predicted = [float(np.asarray(coefficients[cv], dtype=float) @ feat) for cv in cv_order]
    return {
        "status": "optimal",
        "controls": [controls.tolist()],
        "predicted": [predicted],
        "cost": float(result.fun),
        "iterations": int(result.nit),
        "backend": "scipy",
        "solverVersion": "scipy",
    }


def check_finite(payload: Any) -> bool:
    def walk(value: Any) -> bool:
        if isinstance(value, float):
            return math.isfinite(value)
        if isinstance(value, list):
            return all(walk(v) for v in value)
        if isinstance(value, dict):
            return all(walk(v) for v in value.values())
        return True
    return walk(payload)
