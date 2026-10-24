"""Numerical regressions, run with the existing AML venv (no installation)."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import osqp

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server/services/workshop/optimization/python"))
from problems import solve_linear_mpc, solve_steady_response  # noqa: E402


def mpc_ir():
    return {
        "horizon": 1, "weights": {"cv": {"cv": 1}, "du": {"mv": 0}},
        "problem": {
            "dynamics": {"stateDim": 1, "A": [1], "B": [1], "C": [1], "D": [0], "x0": [0]},
            "mvOrder": ["mv"], "cvOrder": ["cv"], "uPrev": [0], "cvSetpoints": [1],
            "mvBounds": [{"min": -10, "max": 10}], "cvBounds": [{}],
        },
    }


def static_ir(bounds, prev=0):
    return {
        "weights": {"cv": {"cv": 1}},
        "problem": {
            "mvOrder": ["mv"], "cvOrder": ["cv"], "featureOrder": ["bias", "mv"],
            "coefficients": {"cv": [0, 1]}, "cvTargets": [8], "mvBounds": [bounds],
            "cvBounds": [{}], "uPrev": [prev],
        },
    }


def response(status, solution=None):
    return SimpleNamespace(x=solution, info=SimpleNamespace(status_val=status, status=f"OSQP {status}", iter=1))


class OptimizerNumericalRegressions(unittest.TestCase):
    def test_real_osqp_constants_are_mapped_without_retrying_infeasibility(self):
        for name, expected in [
            ("OSQP_PRIMAL_INFEASIBLE", "infeasible"),
            ("OSQP_PRIMAL_INFEASIBLE_INACCURATE", "infeasible"),
            ("OSQP_DUAL_INFEASIBLE", "unbounded"),
            ("OSQP_DUAL_INFEASIBLE_INACCURATE", "unbounded"),
            ("OSQP_TIME_LIMIT_REACHED", "timeout"),
            ("OSQP_NON_CVX", "numerical_error"),
            ("OSQP_SIGINT", "cancelled"),
        ]:
            with self.subTest(name=name), patch("problems.osqp.OSQP") as factory:
                factory.return_value.solve.return_value = response(osqp.constant(name))
                result = solve_linear_mpc(mpc_ir(), lambda: False)
                self.assertEqual(result["status"], expected)
                self.assertEqual(factory.return_value.solve.call_count, 1)

    def test_max_iterations_retries_in_chunks(self):
        with patch("problems.osqp.OSQP") as factory:
            factory.return_value.solve.side_effect = [
                response(osqp.constant("OSQP_MAX_ITER_REACHED")),
                response(osqp.constant("OSQP_SOLVED"), [1]),
            ]
            result = solve_linear_mpc(mpc_ir(), lambda: False)
            self.assertEqual(result["status"], "optimal")
            self.assertEqual(factory.return_value.solve.call_count, 2)

    def test_max_iterations_remains_bounded(self):
        with patch("problems.osqp.OSQP") as factory:
            factory.return_value.solve.return_value = response(osqp.constant("OSQP_MAX_ITER_REACHED"))
            self.assertEqual(solve_linear_mpc(mpc_ir(), lambda: False)["status"], "numerical_error")
            self.assertEqual(factory.return_value.solve.call_count, 21)

    def test_iteration_retry_checks_cancellation(self):
        with patch("problems.osqp.OSQP") as factory:
            factory.return_value.solve.return_value = response(osqp.constant("OSQP_MAX_ITER_REACHED"))
            self.assertEqual(solve_linear_mpc(mpc_ir(), iter([False, True]).__next__)["status"], "cancelled")
            self.assertEqual(factory.return_value.solve.call_count, 1)

    def test_static_solver_respects_max_step(self):
        result = solve_steady_response(static_ir({"min": 0, "max": 10, "maxStep": 2}), lambda: False)
        self.assertEqual(result["status"], "optimal")
        self.assertAlmostEqual(result["controls"][0][0], 2, places=6)

    def test_static_solver_rejects_empty_step_bound_intersection(self):
        result = solve_steady_response(static_ir({"min": 5, "max": 10, "maxStep": 2}), lambda: False)
        self.assertEqual(result["status"], "infeasible")
        self.assertNotIn("controls", result)


if __name__ == "__main__":
    unittest.main()
