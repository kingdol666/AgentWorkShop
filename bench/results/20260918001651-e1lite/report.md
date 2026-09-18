# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3001 · git=904e6e0 · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3001 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 125/124.4/124.8 | 155.8/157.4/157.2 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 125.4/124.9/124.1 | 158.4/157.1/155.9 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 125.8/110.7/115.6 | 156.6/152.7/155.8 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 110/124.4/123.3 | 168.8/156.4/157.2 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)