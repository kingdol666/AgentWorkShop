# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3005 · git=da627d21 · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3005 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 139.7/110.3/140.3 | 162.6/156.2/160.8 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 140.2/112.8/125 | 160.5/155.5/158 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 125.5/124.8/134.3 | 156.7/159.2/156.8 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 124.6/139.5/124.7 | 156/171.5/156 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)