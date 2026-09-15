"""Fig.4 / Table E1a recomputation from raw e1-lite CSVs — replicates the harness
metric definition exactly (bench/e1-lite.mjs lines 84-101, 132-133).

Canonical definitions (mirrors the harness, not a re-invention):
  * latency population = every ACCEPTED governed write of the evaluation set
    (3 in-window legit writes + the timed in-window probes); boundary probes are
    recorded but deliberately excluded from the latency population.
  * percentile = nearest-rank, no interpolation:  p50 = lat[floor(n/2)],
    p95 = lat[ceil(n*0.95)-1]  on the sorted array.
  * per-arm figure value = mean of the per-repetition p50 over the six repetitions
    (3 reps x 2 released full-tier runs).

Usage: python bench/tools/fig4_analyze.py [--json out.json]
"""
import csv, json, sys, os, statistics as st

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNS = [
    ("20260914023820-e1lite", os.path.join(ROOT, "bench/results/20260914023820-e1lite/e1-lite.csv")),
    ("20260914040054-e1lite", os.path.join(ROOT, "bench/results/20260914040054-e1lite/e1-lite.csv")),
    ("20260914132601-e1lite", os.path.join(ROOT, "bench/results/20260914132601-e1lite/e1-lite.csv")),
]
ARMS = ["full", "no-interlock", "no-readback", "ungated"]
LABEL = {"full": "Full", "no-interlock": "No intl.", "no-readback": "No RB", "ungated": "Ungated"}
# values currently drawn in Fig. 4 (bottom bars) of the manuscript
PAPER_P50 = {"full": 130.5, "no-interlock": 129.7, "no-readback": 127.9, "ungated": 120.6}


def nearest_rank(sorted_vals, q):
    n = len(sorted_vals)
    if n == 0:
        return float("nan")
    if q == 0.5:
        return sorted_vals[n // 2]
    return sorted_vals[min(n - 1, -(-int(n * 100 * q) // 100) - 1)]


def main():
    out = {a: {"reps": []} for a in ARMS}
    for arm in ARMS:
        for run_name, path in RUNS:
            rows = [r for r in csv.DictReader(open(path)) if r["arm"] == arm]
            for rep in sorted({r["rep"] for r in rows}, key=int):
                rr = [r for r in rows if r["rep"] == rep]
                attacks = [r for r in rr if r["case"] == "attack"]
                legit = [r for r in rr if r["case"] == "legit"]
                bnd = [r for r in rr if r["case"] == "boundary"]
                # latency population: accepted writes of {legit, timed} — boundary excluded
                lat = sorted(float(r["latency_ms"]) for r in rr
                             if r["case"] in ("legit", "timed") and r["status"] == "200")
                out[arm]["reps"].append({
                    "run": run_name, "rep": rep, "n_lat": len(lat),
                    "intercepted": sum(1 for r in attacks if r["status"] != "200"),
                    "attacks": len(attacks),
                    "window_breaches": sum(1 for r in attacks if r["verdict"] == "EXECUTED"),
                    "false_blocks": sum(1 for r in legit if r["status"] != "200"),
                    "legit": len(legit),
                    "boundary_ok": sum(1 for r in bnd
                                       if r["verdict"].startswith("accept") == (r["status"] == "200")),
                    "boundary": len(bnd),
                    "p50": nearest_rank(lat, 0.5),
                    "p95": nearest_rank(lat, 0.95),
                })
        reps = out[arm]["reps"]
        p50s = [r["p50"] for r in reps]
        p95s = [r["p95"] for r in reps]
        out[arm].update({
            "intercepted": sum(r["intercepted"] for r in reps),
            "attacks": sum(r["attacks"] for r in reps),
            "breaches_per_rep": sorted({r["window_breaches"] for r in reps}),
            "false_block": f"{sum(r['false_blocks'] for r in reps)}/{sum(r['legit'] for r in reps)}",
            "boundary": f"{sum(r['boundary_ok'] for r in reps)}/{sum(r['boundary'] for r in reps)}",
            # ---- the two numbers that go into Fig. 4 ----
            "intercept_pct": round(100.0 * sum(r["intercepted"] for r in reps)
                                   / sum(r["attacks"] for r in reps), 1),
            "p50_six_rep_mean": round(st.mean(p50s), 2),
            "p50_list": p50s,
            "p50_range": f"{min(p50s):.1f}-{max(p50s):.1f}",
            "p95_range": f"{min(p95s):.1f}-{max(p95s):.1f}",
            "paper_p50": PAPER_P50[arm],
            "delta_vs_paper": round(st.mean(p50s) - PAPER_P50[arm], 3),
        })

    print(f"{'arm':<14}{'intercept':>12}{'breach/rep':>12}{'falseblk':>10}{'bound':>8}"
          f"{'p50(6rep)':>11}{'paper':>8}{'delta':>8}{'p50 range':>16}{'p95 range':>16}")
    for a in ARMS:
        d = out[a]
        print(f"{a:<14}{str(d['intercepted'])+'/'+str(d['attacks']):>12}"
              f"{d['breaches_per_rep'][0]:>12}{d['false_block']:>10}{d['boundary']:>8}"
              f"{d['p50_six_rep_mean']:>11.2f}{d['paper_p50']:>8.1f}{d['delta_vs_paper']:>8.2f}"
              f"{d['p50_range']:>16}{d['p95_range']:>16}")
    print("\nper-rep p50 (canonical definition) — 6 reps/arm:")
    for a in ARMS:
        print(f"  {a:<14}{out[a]['p50_list']}")

    if "--json" in sys.argv:
        p = sys.argv[sys.argv.index("--json") + 1]
        json.dump(out, open(p, "w"), indent=2)
        print("\nwrote", p)


if __name__ == "__main__":
    sys.exit(main())
