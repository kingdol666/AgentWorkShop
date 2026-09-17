# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3001 · git=e14645a · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3001 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 138.7/125.2/126.2 | 155.7/156.7/164.8 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 124.5/139.1/123.3 | 156.4/159/155.9 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 111.3/124.5/127.5 | 155.5/156.1/157.7 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 118.2/122.9/124.2 | 157.2/155.9/155.5 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)