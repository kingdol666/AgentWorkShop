# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3005 · git=60fa983e · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3005 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 126.3/110.5/125.7 | 156.8/164.3/165.4 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 125.7/126.5/122.5 | 166.1/157.4/160.7 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 128.7/125.7/124.8 | 156.7/156/163.5 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 125.3/113.3/132.9 | 172.6/171.1/190.2 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)