# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3001 · git=831e06a · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3001 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 126/124.7/125.8 | 158.5/157.5/171.2 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 124.9/119.6/112 | 157.8/156.9/156.7 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 109.1/124.9/126.9 | 157.1/157.6/157 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 124.8/112.4/125.8 | 156.6/155.5/173.2 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)