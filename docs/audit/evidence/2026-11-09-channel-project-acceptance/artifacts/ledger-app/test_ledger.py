#!/usr/bin/env python3
"""记账 CLI 测试(终验产物):覆盖 记账/汇总/分类统计 三条主路径。"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
LEDGER = HERE / "ledger.py"
DB = HERE / "ledger.json"


def run(*args):
    out = subprocess.run([sys.executable, str(LEDGER), *args],
                         capture_output=True, text=True)
    return out.returncode, out.stdout.strip()


def main():
    if DB.exists():
        DB.unlink()
    failures = []
    rc, _ = run("add", "5000", "工资", "月薪")
    if rc != 0: failures.append("add 收入失败")
    rc, _ = run("add", "-35.5", "餐饮", "午餐")
    if rc != 0: failures.append("add 支出失败")
    rc, out = run("summary")
    got = json.loads(out) if rc == 0 else {}
    if got.get("count") != 2: failures.append(f"count 期望 2 实得 {got.get('count')}")
    if got.get("balance") != 4964.5: failures.append(f"balance 期望 4964.5 实得 {got.get('balance')}")
    rc, out = run("by-category")
    cats = json.loads(out) if rc == 0 else {}
    if cats.get("工资") != 5000.0: failures.append(f"分类工资期望 5000 实得 {cats.get('工资')}")
    if cats.get("餐饮") != -35.5: failures.append(f"分类餐饮期望 -35.5 实得 {cats.get('餐饮')}")
    print("PASS" if not failures else "FAIL: " + "; ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
