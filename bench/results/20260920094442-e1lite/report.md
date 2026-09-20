# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3005 · git=1585948 · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3005 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 140.7/110.6/141 | 159.5/160.2/162 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 114.8/125.2/127.2 | 157.7/157.9/157.8 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 111.9/125.1/127.1 | 156.6/158/157.4 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 125.4/139.9/124.8 | 157/156.4/156.7 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)