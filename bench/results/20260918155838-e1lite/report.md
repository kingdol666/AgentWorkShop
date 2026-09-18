# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3005 · git=48d09ac · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3005 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 125.6/132.7/126.7 | 159.3/171.2/156.8 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 123.5/110.4/110.7 | 156.9/156.6/143.1 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 123.9/125.6/124.7 | 156.9/160.7/155.1 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 110.2/125/126.2 | 156.5/158.2/171.9 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)