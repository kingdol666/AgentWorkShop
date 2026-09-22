"""Characterise the ablation case taxonomy and the timing data available for figures."""
import collections
import csv
import json
import statistics
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve()
while ROOT.name != "AgentWorkShop":
    ROOT = ROOT.parent
R = ROOT / "bench" / "results"

rows = list(csv.DictReader(
    (R / "20260920094442-e1lite" / "e1-lite.csv").read_text(encoding="utf-8-sig").splitlines()))

print("=== arm x case x verdict ===")
c = collections.Counter((r["arm"], r["case"], r["verdict"]) for r in rows)
for k in sorted(c):
    print(f"  {k[0]:14s} {k[1]:9s} {k[2]:22s} {c[k]}")

print("\n=== attack kind x arm: executed vs rejected ===")
a = collections.defaultdict(lambda: collections.Counter())
for r in rows:
    if r["case"] == "attack":
        a[r["kind"]][r["arm"]] += 1 if r["verdict"] == "EXECUTED" else 0
arms = ["full", "no-interlock", "no-readback", "ungated"]
print(f"  {'kind':16s}" + "".join(f"{x:>14s}" for x in arms))
for kind in sorted(a):
    print(f"  {kind:16s}" + "".join(f"{a[kind].get(x, 0):>14d}" for x in arms))

print("\n=== per-arm latency by case (ms) ===")
for arm in arms:
    for case in ["timed", "legit", "attack", "boundary"]:
        v = [float(r["latency_ms"]) for r in rows
             if r["arm"] == arm and r["case"] == case and r["latency_ms"]]
        if not v:
            continue
        v.sort()
        p50 = v[len(v) // 2]
        print(f"  {arm:14s} {case:9s} n={len(v):3d}  min={min(v):7.1f} "
              f"p50={p50:7.1f} p95={v[int(0.95 * (len(v) - 1))]:7.1f} max={max(v):7.1f}")

print("\n=== boundary values and expected verdicts ===")
for arm in arms:
    for r in rows:
        if r["arm"] == arm and r["case"] == "boundary":
            print(f"  {arm:14s} kind={r['kind']:6s} value={r['value']:>8s} "
                  f"verdict={r['verdict']}")
            break

print("\n=== timing fields elsewhere ===")
run = json.loads((R / "20260920094610-to4" / "run.json").read_text(encoding="utf-8-sig"))
print("  phases with durationMs:")
for p in run["phases"]:
    print(f"    {p['phase']:5s} {p['durationMs']:>8d} ms  {p['status']}")
print("\n  metrics with ms/s units:")
for m in run["metrics"]:
    if m.get("unit") in ("ms", "s") or "latency" in m["key"] or "S" in m["key"]:
        print(f"    {m['section']:11s} {m['key']:26s} {m['value']} {m.get('unit','')}")
