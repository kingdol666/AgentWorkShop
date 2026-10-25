#!/usr/bin/env python
"""
Optimizer Solver Worker(长驻子进程,NDJSON over stdin/stdout)。

约束(plan B.9.3):
  - stdout **只允许协议帧**;日志一律 stderr;
  - 每进程同时只跑 1 个 solve;请求级 deadlineMs 由 TS 侧硬超时兜底;
  - op: solve{cancel_check} / cancel / ping;
  - 协作取消:主线程读 stdin 置位 Event;求解线程在迭代分段间检查;
    不响应协作取消的长计算由 TS 直接终止本进程(单任务独占进程,安全兜底)。
"""
from __future__ import annotations

import json
import sys
import threading
import traceback
from typing import Any

from problems import check_finite, solve_linear_mpc, solve_steady_response

PROTOCOL_VERSION = 1

_event = threading.Event()
_cancel = threading.Event()
_busy = threading.Event()
_active_req: dict[str, Any] = {"reqId": None}


def emit(frame: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def run_solve(req: dict[str, Any]) -> None:
    req_id = str(req.get("reqId", ""))
    _active_req["reqId"] = req_id
    _cancel.clear()
    payload = req.get("payload") or {}
    ir = payload.get("problemIr")
    try:
        if not isinstance(ir, dict):
            raise ValueError("payload.problemIr 必须是对象")
        template = (ir.get("problem") or {}).get("template")
        if template == "linear_mpc_quadratic@1":
            result = solve_linear_mpc(ir, _cancel.is_set)
        elif template == "steady_response@1":
            result = solve_steady_response(ir, _cancel.is_set)
        else:
            result = {"status": "unsupported", "message": f"unsupported template: {template}"}
        if not check_finite(result):
            result = {"status": "numerical_error", "message": "solver produced NaN/Inf"}
        emit({
            "protocolVersion": PROTOCOL_VERSION,
            "reqId": req_id,
            "ok": True,
            "result": result,
            "diag": {"backend": result.get("backend"), "iterations": result.get("iterations")},
        })
    except Exception as exc:  # noqa: BLE001 - 协议层必须把任何异常变成 error 帧
        log(traceback.format_exc())
        emit({
            "protocolVersion": PROTOCOL_VERSION,
            "reqId": req_id,
            "ok": False,
            "error": {"code": "SOLVER_ERROR", "message": str(exc)},
        })
    finally:
        _busy.clear()
        _active_req["reqId"] = None


def handle(req: dict[str, Any]) -> None:
    op = req.get("op")
    req_id = str(req.get("reqId", ""))
    if req.get("protocolVersion") != PROTOCOL_VERSION:
        emit({"protocolVersion": PROTOCOL_VERSION, "reqId": req_id, "ok": False, "error": {"code": "PROTOCOL_MISMATCH", "message": "protocolVersion must be 1"}})
        return
    if op == "ping":
        emit({"protocolVersion": PROTOCOL_VERSION, "reqId": req_id, "ok": True, "result": {"pong": True, "busy": _busy.is_set()}})
        return
    if op == "cancel":
        target = (req.get("payload") or {}).get("reqId") or req_id
        if _active_req.get("reqId") == target:
            _cancel.set()
        emit({"protocolVersion": PROTOCOL_VERSION, "reqId": req_id, "ok": True, "result": {"cancelled": _cancel.is_set(), "target": target}})
        return
    if op == "solve":
        if _busy.is_set():
            emit({"protocolVersion": PROTOCOL_VERSION, "reqId": req_id, "ok": False, "error": {"code": "SOLVER_BUSY", "message": "worker 正在执行另一个 solve"}})
            return
        _busy.set()
        thread = threading.Thread(target=run_solve, args=(req,), daemon=True)
        thread.start()
        return
    emit({"protocolVersion": PROTOCOL_VERSION, "reqId": req_id, "ok": False, "error": {"code": "UNKNOWN_OP", "message": f"unknown op: {op}"}})


def main() -> None:
    emit({"protocolVersion": PROTOCOL_VERSION, "type": "ready", "diag": {"pid": __import__("os").getpid(), "python": sys.version.split()[0]}})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            emit({"protocolVersion": PROTOCOL_VERSION, "reqId": "", "ok": False, "error": {"code": "BAD_JSON", "message": "invalid JSON frame"}})
            continue
        handle(req)


if __name__ == "__main__":
    main()
