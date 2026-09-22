# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3005 · git=e692df1 · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3005 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 126.1/127/125.3 | 158/165.6/164 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 123.8/125.1/125.7 | 162.7/155.4/157.4 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 109.9/125/125 | 157.3/156.1/155.3 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 125.9/123.7/138.7 | 161.1/157.6/156 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)