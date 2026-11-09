#!/usr/bin/env python3
"""简易记账 CLI(Project 终验产物):记账/汇总/按分类统计。数据存 JSON 文件。"""
import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

DB = Path(__file__).with_name("ledger.json")


def load():
    if not DB.exists():
        return []
    return json.loads(DB.read_text(encoding="utf-8"))


def save(rows):
    DB.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def add(amount, category, note=""):
    rows = load()
    rows.append({"date": date.today().isoformat(), "amount": float(amount),
                 "category": category, "note": note})
    save(rows)
    return len(rows)


def summary():
    rows = load()
    income = sum(r["amount"] for r in rows if r["amount"] > 0)
    expense = sum(-r["amount"] for r in rows if r["amount"] < 0)
    return {"count": len(rows), "income": round(income, 2),
            "expense": round(expense, 2), "balance": round(income - expense, 2)}


def by_category():
    agg = defaultdict(float)
    for r in load():
        agg[r["category"]] += r["amount"]
    return {k: round(v, 2) for k, v in sorted(agg.items())}


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "summary"
    if cmd == "add":
        n = add(argv[2], argv[3], argv[4] if len(argv) > 4 else "")
        print(f"已记账,当前 {n} 笔")
    elif cmd == "summary":
        print(json.dumps(summary(), ensure_ascii=False))
    elif cmd == "by-category":
        print(json.dumps(by_category(), ensure_ascii=False))
    else:
        print("用法: ledger.py [add <金额> <分类> [备注] | summary | by-category]")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
