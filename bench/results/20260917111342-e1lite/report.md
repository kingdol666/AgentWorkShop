# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3001 · git=736e87c · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3001 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 110.1/139.4/124.5 | 155.8/155.7/155.8 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 109.9/124.2/124.5 | 155.4/155.5/155.5 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 140.3/124.8/109.6 | 170.6/156.2/156.6 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 125/123.8/124.6 | 156.1/155.9/156.4 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)