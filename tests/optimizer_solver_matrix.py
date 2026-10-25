"""Solver numerical functional matrix — real OSQP / SciPy SLSQP.

Run with the shared AML venv:
    python tests/optimizer_solver_matrix.py

Every case asserts solver semantics against an analytic solution or an
independent formula (not just "the worker returned something").
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server/services/workshop/optimization/python"))

from problems import check_finite, solve_linear_mpc, solve_steady_response  # noqa: E402

TOL = 1e-5


def mpc_ir(
    *,
    A=(1.0,),
    B=(1.0,),
    C=(1.0,),
    D=(0.0,),
    bias=None,
    x0=(0.0,),
    horizon=1,
    cv_setpoints=(3.0,),
    mv_bounds=({"min": -10.0, "max": 10.0},),
    cv_bounds=({},),
    u_prev=(0.0,),
    cv_weights=(1.0,),
    du_weights=(0.0,),
    terminal=0.0,
):
    state_dim = int(round(math.sqrt(len(A))))
    mv_count = len(u_prev)
    cv_count = len(cv_setpoints)
    assert len(B) == state_dim * mv_count, (len(B), state_dim, mv_count)
    assert len(C) == cv_count * state_dim, (len(C), cv_count, state_dim)
    assert len(D) == cv_count * mv_count, (len(D), cv_count, mv_count)
    cv_weights = tuple(cv_weights) if len(cv_weights) == cv_count else (float(cv_weights[0]),) * cv_count
    du_weights = tuple(du_weights) if len(du_weights) == mv_count else (float(du_weights[0]),) * mv_count
    mv_bounds = tuple(mv_bounds) if len(mv_bounds) == mv_count else (mv_bounds[0],) * mv_count
    cv_bounds = tuple(cv_bounds) if len(cv_bounds) == cv_count else (cv_bounds[0],) * cv_count
    names_mv = [f"mv{i + 1}" for i in range(mv_count)]
    names_cv = [f"cv{j + 1}" for j in range(cv_count)]
    dyn = {"stateDim": state_dim, "A": list(A), "B": list(B), "C": list(C), "D": list(D),
           "delays": {name: 0 for name in names_mv}, "x0": list(x0)}
    if bias is not None:
        dyn["bias"] = list(bias)
    return {
        "irVersion": 1, "hash": "matrix", "profileRef": "p@1",
        "modelRef": {"modelId": "m", "artifactKind": "linear_state_space@1", "artifactHash": "h",
                     "modelInterface": "linear_state_space", "stage": "production"},
        "solverRef": "osqp_mpc@1",
        "conditions": {"conditionId": "c", "lineId": "l", "productId": "p", "recipeId": "r", "recipeVersion": 1},
        "horizon": horizon, "beatMs": 1000,
        "scaling": {name: {"scale": 1, "offset": 0} for name in [*names_mv, *names_cv]},
        "weights": {
            "cv": {name: cv_weights[j] for j, name in enumerate(names_cv)},
            "du": {name: du_weights[m] for m, name in enumerate(names_mv)},
            "terminal": terminal,
        },
        "context": {"capturedAt": "", "eventAsOf": 0, "availabilityWatermark": None, "evidenceSource": "simulation"},
        "problem": {
            "template": "linear_mpc_quadratic@1",
            "dynamics": dyn,
            "cvSetpoints": list(cv_setpoints),
            "cvBounds": list(cv_bounds),
            "mvOrder": names_mv,
            "cvOrder": names_cv,
            "mvBounds": list(mv_bounds),
            "uPrev": list(u_prev),
        },
    }


def static_ir(
    *,
    mv_order=("mv",),
    cv_order=("cv",),
    feature_order=("bias", "mv"),
    coefficients=None,
    targets=(3.0,),
    mv_bounds=({"min": -10.0, "max": 10.0},),
    cv_bounds=({},),
    u_prev=(0.0,),
    cv_weights=(1.0,),
    economic=None,
):
    coefficients = coefficients or {cv_order[0]: [0.0, 1.0]}
    return {
        "irVersion": 1, "hash": "matrix-static", "profileRef": "p@1",
        "modelRef": {"modelId": "m", "artifactKind": "static_response@1", "artifactHash": "h",
                     "modelInterface": "static_response", "stage": "production"},
        "solverRef": "scipy_slsqp@1",
        "conditions": {"conditionId": "c", "lineId": "l", "productId": "p", "recipeId": "r", "recipeVersion": 1},
        "horizon": 1, "beatMs": 1000,
        "scaling": {name: {"scale": 1, "offset": 0} for name in [*mv_order, *cv_order]},
        "weights": {
            "cv": {name: cv_weights[j] for j, name in enumerate(cv_order)},
            "du": {}, "terminal": 0, "economic": economic or {},
        },
        "context": {"capturedAt": "", "eventAsOf": 0, "availabilityWatermark": None, "evidenceSource": "simulation"},
        "problem": {
            "template": "steady_response@1",
            "mvOrder": list(mv_order),
            "cvOrder": list(cv_order),
            "coefficients": coefficients,
            "featureOrder": list(feature_order),
            "cvTargets": list(targets),
            "mvBounds": list(mv_bounds),
            "cvBounds": list(cv_bounds),
            "uPrev": list(u_prev),
        },
    }


def static_features(ir, u):
    problem = ir["problem"]
    by_name = {name: float(u[i]) for i, name in enumerate(problem["mvOrder"])}
    values = []
    for name in problem["featureOrder"]:
        if name == "bias":
            values.append(1.0)
        elif name.endswith("^2"):
            values.append(by_name.get(name[:-2], 0.0) ** 2)
        elif "*" in name:
            a, b = name.split("*", 1)
            values.append(by_name.get(a, 0.0) * by_name.get(b, 0.0))
        else:
            values.append(by_name.get(name, 0.0))
    return values


def recompute_static_cost(ir, controls):
    problem = ir["problem"]
    features = static_features(ir, controls)
    assert len(features) == len(problem["featureOrder"]), (features, problem["featureOrder"])
    cost = 0.0
    for i, name in enumerate(problem["mvOrder"]):
        cost += float((ir["weights"].get("economic") or {}).get(name, 0.0)) * float(controls[i])
    for j, cv in enumerate(problem["cvOrder"]):
        coef = problem["coefficients"][cv]
        y = sum(float(coef[k]) * features[k] for k in range(len(features)))
        cost += float(ir["weights"]["cv"].get(cv, 0.0)) * (y - float(problem["cvTargets"][j])) ** 2
    return cost


def recompute_mpc_cost(ir, controls):
    p = ir["problem"]
    dyn = p["dynamics"]
    n = int(dyn["stateDim"])
    mv_count = len(p["mvOrder"])
    cv_count = len(p["cvOrder"])
    A, B, C, D = dyn["A"], dyn["B"], dyn["C"], dyn["D"]
    x = [float(v) for v in dyn["x0"]]
    bias = [float(v) for v in (dyn.get("bias") or [0.0] * n)]
    predicted = []
    for t, u in enumerate(controls):
        nxt = []
        for r in range(n):
            v = bias[r]
            for c in range(n):
                v += A[r * n + c] * x[c]
            for m in range(mv_count):
                v += B[r * mv_count + m] * u[m]
            nxt.append(v)
        x = nxt
        y = []
        for j in range(cv_count):
            v = 0.0
            for c in range(n):
                v += C[j * n + c] * x[c]
            for m in range(mv_count):
                v += D[j * mv_count + m] * u[m]
            y.append(v)
        predicted.append(y)
    cost = 0.0
    for t, row in enumerate(predicted):
        w = 1.0 + (float(ir["weights"].get("terminal") or 0.0) if t == len(predicted) - 1 else 0.0)
        for j in range(cv_count):
            cv_name = p["cvOrder"][j]
            cost += w * float(ir["weights"]["cv"].get(cv_name, 1.0)) * (row[j] - p["cvSetpoints"][j]) ** 2
    for t, u in enumerate(controls):
        prev = p["uPrev"] if t == 0 else controls[t - 1]
        for m in range(mv_count):
            cost += float(ir["weights"]["du"].get(p["mvOrder"][m], 0.0)) * (u[m] - prev[m]) ** 2
    return predicted, cost


class LinearMpcMatrix(unittest.TestCase):
    def solve(self, ir, cancel=lambda: False):
        result = solve_linear_mpc(ir, cancel)
        self.assertTrue(check_finite(result), result)
        return result

    def test_unconstrained_analytic(self):
        result = self.solve(mpc_ir())
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["backend"], "osqp")
        self.assertAlmostEqual(result["controls"][0][0], 3.0, places=5)
        self.assertAlmostEqual(result["predicted"][0][0], 3.0, places=5)
        self.assertAlmostEqual(result["cost"], 0.0, places=5)

    def test_mv_upper_bound_is_active(self):
        result = self.solve(mpc_ir(cv_setpoints=(10.0,), mv_bounds=({"min": 0.0, "max": 4.0},)))
        self.assertEqual(result["status"], "optimal")
        self.assertAlmostEqual(result["controls"][0][0], 4.0, places=5)
        self.assertAlmostEqual(result["predicted"][0][0], 4.0, places=5)
        self.assertAlmostEqual(result["cost"], 36.0, places=4)

    def test_mv_lower_bound_is_active(self):
        result = self.solve(mpc_ir(cv_setpoints=(-10.0,), mv_bounds=({"min": 2.0, "max": 10.0},)))
        self.assertEqual(result["status"], "optimal")
        self.assertAlmostEqual(result["controls"][0][0], 2.0, places=5)
        self.assertAlmostEqual(result["predicted"][0][0], 2.0, places=5)
        self.assertAlmostEqual(result["cost"], 144.0, places=2)

    def test_rate_limit_ramps_one_step_per_beat(self):
        result = self.solve(mpc_ir(horizon=4, cv_setpoints=(10.0,), u_prev=(0.0,),
                                    mv_bounds=({"min": 0.0, "max": 10.0, "maxStep": 1.0},)))
        self.assertEqual(result["status"], "optimal")
        controls = [row[0] for row in result["controls"]]
        predicted = [row[0] for row in result["predicted"]]
        for i, value in enumerate(controls):
            self.assertAlmostEqual(value, float(i + 1), places=5)
        for i, value in enumerate(predicted):
            self.assertAlmostEqual(value, float((i + 1) * (i + 2) / 2), places=5)
        for i in range(1, len(controls)):
            self.assertLessEqual(abs(controls[i] - controls[i - 1]), 1.0 + 1e-6)
        # 全时域跟踪代价可解析:81+49+16+0 = 146
        self.assertAlmostEqual(result["cost"], 146.0, places=2)

    def test_cv_hard_bound_caps_tracking(self):
        result = self.solve(mpc_ir(cv_setpoints=(5.0,), cv_bounds=({"max": 2.0},),
                                    mv_bounds=({"min": 0.0, "max": 10.0},)))
        self.assertEqual(result["status"], "optimal")
        self.assertAlmostEqual(result["controls"][0][0], 2.0, places=5)
        self.assertAlmostEqual(result["predicted"][0][0], 2.0, places=5)
        self.assertAlmostEqual(result["cost"], 9.0, places=4)

    def test_infeasible_returns_without_controls(self):
        result = self.solve(mpc_ir(cv_setpoints=(5.0,), cv_bounds=({"min": 5.0, "max": 6.0},),
                                    mv_bounds=({"min": 0.0, "max": 1.0},)))
        self.assertEqual(result["status"], "infeasible")
        self.assertNotIn("controls", result)

    def test_terminal_weight_moves_final_error_down(self):
        base = mpc_ir(A=(0.5,), B=(0.5,), C=(1.0,), horizon=4, cv_setpoints=(5.0,), cv_weights=(1.0,), du_weights=(1.0,), terminal=0.0)
        strong = mpc_ir(A=(0.5,), B=(0.5,), C=(1.0,), horizon=4, cv_setpoints=(5.0,), cv_weights=(1.0,), du_weights=(1.0,), terminal=50.0)
        base_result = self.solve(base)
        strong_result = self.solve(strong)
        self.assertEqual(base_result["status"], "optimal")
        self.assertEqual(strong_result["status"], "optimal")
        base_err = abs(base_result["predicted"][-1][0] - 5.0)
        strong_err = abs(strong_result["predicted"][-1][0] - 5.0)
        self.assertGreater(base_err, 1e-3)  # 对照必须真的有差异,否则断言无意义
        self.assertLess(strong_err, base_err - 1e-3)
        predicted, independent = recompute_mpc_cost(strong, strong_result["controls"])
        self.assertAlmostEqual(independent, strong_result["cost"], places=5)
        for t, row in enumerate(predicted):
            self.assertAlmostEqual(row[0], strong_result["predicted"][t][0], places=6)

    def test_du_penalty_spreads_the_move(self):
        result = self.solve(mpc_ir(horizon=4, cv_setpoints=(5.0,), du_weights=(10.0,)))
        self.assertEqual(result["status"], "optimal")
        controls = [row[0] for row in result["controls"]]
        self.assertLess(controls[0], 5.0 - 1e-3)
        for i in range(1, len(controls)):
            self.assertLessEqual(abs(controls[i] - controls[i - 1]), 1.5)
        # 大 Δu 权重下 4 拍内不必完全到 5(欠调是优化结果,不是缺陷);但必须单调逼近
        final = result["predicted"][-1][0]
        self.assertGreater(final, 4.5)
        self.assertLess(final, 5.5)
        predicted, independent = recompute_mpc_cost(
            mpc_ir(horizon=4, cv_setpoints=(5.0,), du_weights=(10.0,)), [[v] for v in controls])
        self.assertAlmostEqual(independent, result["cost"], places=5)
        for t, row in enumerate(predicted):
            self.assertAlmostEqual(row[0], result["predicted"][t][0], places=6)

    def test_d_direct_feedthrough_parity(self):
        result = self.solve(mpc_ir(A=(1.0,), B=(0.0,), C=(1.0,), D=(1.0,), horizon=2,
                                    cv_setpoints=(2.0,), u_prev=(0.0,)))
        self.assertEqual(result["status"], "optimal")
        for t in range(2):
            self.assertAlmostEqual(result["controls"][t][0], 2.0, places=5)
            self.assertAlmostEqual(result["predicted"][t][0], 2.0, places=5)
        predicted, _ = recompute_mpc_cost(mpc_ir(A=(1.0,), B=(0.0,), C=(1.0,), D=(1.0,), horizon=2,
                                               cv_setpoints=(2.0,), u_prev=(0.0,)), result["controls"])
        self.assertAlmostEqual(predicted[0][0], 2.0, places=6)

    def test_bias_offsets_prediction(self):
        ir = mpc_ir(A=(1.0,), B=(0.0,), C=(1.0,), D=(0.0,), bias=(0.5,), horizon=3,
                    cv_setpoints=(1.0,))
        result = self.solve(ir)
        self.assertEqual(result["status"], "optimal")
        for t, expected in enumerate((0.5, 1.0, 1.5)):
            self.assertAlmostEqual(result["predicted"][t][0], expected, places=6)
        self.assertAlmostEqual(result["cost"], 0.5, places=5)

    def test_multi_mv_cv_identity_coupling(self):
        result = self.solve(mpc_ir(A=(1.0, 0.0, 0.0, 1.0), B=(1.0, 0.0, 0.0, 1.0),
                                    C=(1.0, 0.0, 0.0, 1.0), D=(0.0, 0.0, 0.0, 0.0),
                                    x0=(0.0, 0.0), cv_setpoints=(3.0, 4.0), u_prev=(0.0, 0.0)))
        self.assertEqual(result["status"], "optimal")
        self.assertAlmostEqual(result["controls"][0][0], 3.0, places=5)
        self.assertAlmostEqual(result["controls"][0][1], 4.0, places=5)
        self.assertAlmostEqual(result["predicted"][0][0], 3.0, places=5)
        self.assertAlmostEqual(result["predicted"][0][1], 4.0, places=5)

    def test_deterministic_repeat(self):
        ir = mpc_ir(horizon=6, cv_setpoints=(7.0,), u_prev=(1.0,), cv_weights=(2.0,),
                    du_weights=(0.3,), terminal=0.5,
                    mv_bounds=({"min": 0.0, "max": 8.0, "maxStep": 2.0},))
        first = self.solve(ir)
        second = self.solve(ir)
        self.assertEqual(first["status"], "optimal")
        self.assertEqual(second["status"], "optimal")
        self.assertEqual(first["controls"], second["controls"])
        self.assertEqual(first["predicted"], second["predicted"])
        self.assertAlmostEqual(first["cost"], second["cost"], places=12)

    def test_long_horizon_stays_finite(self):
        result = self.solve(mpc_ir(A=(0.9,), B=(0.1,), C=(1.0,), horizon=40,
                                    cv_setpoints=(5.0,), u_prev=(0.0,),
                                    mv_bounds=({"min": 0.0, "max": 10.0, "maxStep": 2.0},)))
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(len(result["controls"]), 40)
        self.assertTrue(all(math.isfinite(row[0]) for row in result["controls"]))
        self.assertTrue(all(math.isfinite(row[0]) for row in result["predicted"]))
        self.assertAlmostEqual(result["predicted"][-1][0], 5.0, places=3)
        predicted, independent = recompute_mpc_cost(
            mpc_ir(A=(0.9,), B=(0.1,), C=(1.0,), horizon=40, cv_setpoints=(5.0,), u_prev=(0.0,),
                   mv_bounds=({"min": 0.0, "max": 10.0, "maxStep": 2.0},)), result["controls"])
        self.assertAlmostEqual(independent, result["cost"], places=5)
        for t in (0, 9, 39):
            self.assertAlmostEqual(predicted[t][0], result["predicted"][t][0], places=6)

    def test_pre_cancel_short_circuits(self):
        result = solve_linear_mpc(mpc_ir(), lambda: True)
        self.assertEqual(result["status"], "cancelled")
        self.assertNotIn("controls", result)

    def test_bounds_dimension_mismatch_rejected(self):
        ir = mpc_ir(A=(1.0, 0.0, 0.0, 1.0), B=(1.0, 0.0, 0.0, 1.0), C=(1.0, 0.0, 0.0, 1.0),
                    D=(0.0, 0.0, 0.0, 0.0), x0=(0.0, 0.0), cv_setpoints=(1.0, 2.0), u_prev=(0.0, 0.0))
        ir["problem"]["cvBounds"] = [{}]
        with self.assertRaises(ValueError):
            solve_linear_mpc(ir, lambda: False)

    def test_empty_cv_bounds_rejected_not_silently_unbounded(self):
        ir = mpc_ir()
        ir["problem"]["cvBounds"] = []
        with self.assertRaises(ValueError):
            solve_linear_mpc(ir, lambda: False)

    def test_short_mv_bounds_rejected(self):
        ir = mpc_ir(A=(1.0, 0.0, 0.0, 1.0), B=(1.0, 0.0, 0.0, 1.0), C=(1.0, 0.0, 0.0, 1.0),
                    D=(0.0, 0.0, 0.0, 0.0), x0=(0.0, 0.0), cv_setpoints=(1.0, 2.0), u_prev=(0.0, 0.0))
        ir["problem"]["mvBounds"] = [{"min": 0.0, "max": 1.0}]
        with self.assertRaises(ValueError):
            solve_linear_mpc(ir, lambda: False)

    def test_nonfinite_setpoint_rejected(self):
        ir = mpc_ir(cv_setpoints=(float("inf"),))
        with self.assertRaises(ValueError):
            solve_linear_mpc(ir, lambda: False)


class StaticResponseMatrix(unittest.TestCase):
    def solve(self, ir, cancel=lambda: False):
        result = solve_steady_response(ir, cancel)
        self.assertTrue(check_finite(result), result)
        return result

    def test_linear_analytic(self):
        result = self.solve(static_ir())
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["backend"], "scipy")
        self.assertAlmostEqual(result["controls"][0][0], 3.0, places=5)
        self.assertAlmostEqual(result["predicted"][0][0], 3.0, places=5)
        self.assertAlmostEqual(result["cost"], 0.0, places=5)

    def test_economic_corner_upper(self):
        result = self.solve(static_ir(targets=(0.0,), cv_weights=(0.0,),
                                       economic={"mv": -1.0},
                                       mv_bounds=({"min": 0.0, "max": 10.0},)))
        self.assertEqual(result["status"], "optimal")
        self.assertAlmostEqual(result["controls"][0][0], 10.0, places=4)
        self.assertAlmostEqual(result["cost"], -10.0, places=4)

    def test_economic_corner_lower(self):
        result = self.solve(static_ir(targets=(0.0,), cv_weights=(0.0,),
                                       economic={"mv": 1.0},
                                       mv_bounds=({"min": 0.0, "max": 10.0},)))
        self.assertEqual(result["status"], "optimal")
        self.assertAlmostEqual(result["controls"][0][0], 0.0, places=4)
        self.assertAlmostEqual(result["predicted"][0][0], 0.0, places=4)
        self.assertAlmostEqual(result["cost"], 0.0, places=4)

    def test_rate_limit_is_active(self):
        result = self.solve(static_ir(targets=(8.0,), u_prev=(0.0,),
                                       mv_bounds=({"min": 0.0, "max": 10.0, "maxStep": 2.0},)))
        self.assertEqual(result["status"], "optimal")
        self.assertAlmostEqual(result["controls"][0][0], 2.0, places=5)
        self.assertAlmostEqual(result["predicted"][0][0], 2.0, places=5)

    def test_cv_bound_caps_tracking(self):
        result = self.solve(static_ir(targets=(5.0,), cv_bounds=({"max": 2.0},),
                                       mv_bounds=({"min": 0.0, "max": 10.0},)))
        self.assertEqual(result["status"], "optimal")
        self.assertAlmostEqual(result["controls"][0][0], 2.0, places=4)
        self.assertAlmostEqual(result["predicted"][0][0], 2.0, places=4)

    def test_cv_bound_infeasible(self):
        result = self.solve(static_ir(targets=(5.0,), cv_bounds=({"min": 5.0, "max": 6.0},),
                                       mv_bounds=({"min": 0.0, "max": 1.0},)))
        self.assertEqual(result["status"], "infeasible")
        self.assertNotIn("controls", result)

    def test_quadratic_feature_matches_formula(self):
        ir = static_ir(feature_order=("bias", "mv", "mv^2"),
                       coefficients={"cv": [0.0, 1.0, 1.0]},
                       targets=(2.0,), economic={"mv": -0.1},
                       mv_bounds=({"min": 0.0, "max": 3.0},))
        result = self.solve(ir)
        self.assertEqual(result["status"], "optimal")
        u = result["controls"][0][0]
        self.assertGreaterEqual(u, -1e-6)
        self.assertLessEqual(u, 3.0 + 1e-6)
        self.assertAlmostEqual(result["predicted"][0][0], u + u * u, places=6)
        self.assertAlmostEqual(result["cost"], recompute_static_cost(ir, [u]), places=6)

    def test_cross_feature_matches_formula(self):
        ir = static_ir(mv_order=("a", "b"), feature_order=("bias", "a", "b", "a*b"),
                       coefficients={"cv": [0.0, 1.0, 1.0, 0.5]},
                       targets=(8.0,), economic={"a": 0.001, "b": 0.001},
                       mv_bounds=({"min": 0.0, "max": 10.0}, {"min": 0.0, "max": 10.0}),
                       u_prev=(0.0, 0.0))
        result = self.solve(ir)
        self.assertEqual(result["status"], "optimal")
        a, b = result["controls"][0]
        self.assertAlmostEqual(result["predicted"][0][0], a + b + 0.5 * a * b, places=5)
        self.assertAlmostEqual(result["cost"], recompute_static_cost(ir, [a, b]), places=5)

    def test_multi_mv_economic_optimum(self):
        ir = static_ir(mv_order=("a", "b"), feature_order=("bias", "a", "b"),
                       coefficients={"cv": [0.0, 2.0, 3.0]},
                       targets=(12.0,), cv_weights=(1000.0,),
                       economic={"a": 1.0, "b": 1.0},
                       mv_bounds=({"min": 0.0, "max": 10.0}, {"min": 0.0, "max": 10.0}),
                       u_prev=(0.0, 0.0))
        result = self.solve(ir)
        self.assertEqual(result["status"], "optimal")
        a, b = result["controls"][0]
        self.assertAlmostEqual(2.0 * a + 3.0 * b, 12.0, places=2)
        self.assertAlmostEqual(a + b, 4.0, places=2)

    def test_pre_cancel_short_circuits(self):
        result = solve_steady_response(static_ir(), lambda: True)
        self.assertEqual(result["status"], "cancelled")
        self.assertNotIn("controls", result)

    def test_nonfinite_coefficients_never_escape(self):
        ir = static_ir(feature_order=("bias", "mv"),
                       coefficients={"cv": [0.0, float("nan")]})
        with self.assertRaises(ValueError):
            solve_steady_response(ir, lambda: False)

    def test_bounds_dimension_mismatch_rejected(self):
        ir = static_ir(mv_order=("a", "b"), cv_order=("c1", "c2"),
                       feature_order=("bias", "a", "b"),
                       coefficients={"c1": [0.0, 1.0, 1.0], "c2": [0.0, 1.0, 0.0]},
                       targets=(5.0, 4.0), cv_weights=(1.0, 1.0),
                       mv_bounds=({"min": 0.0, "max": 10.0}, {"min": 0.0, "max": 10.0}),
                       u_prev=(0.0, 0.0))
        ir["problem"]["cvBounds"] = [{}]
        with self.assertRaises(ValueError):
            solve_steady_response(ir, lambda: False)

    def test_empty_cv_bounds_rejected_not_silently_unbounded(self):
        ir = static_ir()
        ir["problem"]["cvBounds"] = []
        with self.assertRaises(ValueError):
            solve_steady_response(ir, lambda: False)

    def test_short_mv_bounds_rejected(self):
        ir = static_ir(mv_order=("a", "b"), feature_order=("bias", "a", "b"),
                       coefficients={"cv": [0.0, 1.0, 1.0]}, targets=(5.0,),
                       mv_bounds=({"min": 0.0, "max": 10.0}, {"min": 0.0, "max": 10.0}),
                       u_prev=(0.0, 0.0))
        ir["problem"]["mvBounds"] = [{"min": 0.0, "max": 10.0}]
        with self.assertRaises(ValueError):
            solve_steady_response(ir, lambda: False)

    def test_nonfinite_target_rejected(self):
        ir = static_ir(targets=(float("inf"),))
        with self.assertRaises(ValueError):
            solve_steady_response(ir, lambda: False)


class FiniteGuard(unittest.TestCase):
    def test_check_finite_walks_nested_payloads(self):
        self.assertTrue(check_finite({"a": [1.0, 2.0], "b": {"c": 3}}))
        self.assertFalse(check_finite({"a": [1.0, float("nan")]}))
        self.assertFalse(check_finite({"a": {"b": float("inf")}}))
        self.assertTrue(check_finite({"status": "optimal", "controls": [[1.0]]}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
