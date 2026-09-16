# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3005 · git=2806e05 · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3005 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 110.3/129.9/125 | 161/156/157.3 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 124.6/127.2/109.5 | 156.4/171.5/156.1 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 133/113.9/122.7 | 170.2/155.1/156.8 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 125.6/124.3/119 | 169.5/155.2/156.1 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)