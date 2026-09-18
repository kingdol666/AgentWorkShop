# E1a · Pipeline-Tier 4-Arm Governance Ablation Report

> seed=42 · repeats=3 · base=http://127.0.0.1:3001 · git=7d4bfc0 · hash=3a57e722d4764b98
> Reproduce: `node bench/e1-lite.mjs --base http://127.0.0.1:3001 --seed 42 --repeats 3`

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary ok | Write p50 (ms) | Write p95 (ms) |
|---|---|---|---|---|---|---|
| Full | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 124.4/124.8/124.7 | 159.6/158.3/158 |
| No interlock | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 125.4/125.1/110.5 | 155.8/155.5/159.4 |
| No readback | 100.0 / 100.0 / 100.0% | 0 | 0 | 9/9 | 111/124.9/126 | 159.3/158.2/171.6 |
| Ungated | 66.7 / 66.7 / 66.7% | 6 | 0 | 9/9 | 140/140.8/124 | 158.3/156.5/158.5 |

**Paper mapping**: paper/tii §VII-E Table (tab:e1lite). The 4-arm ablation shows: interception is provided by the soft batch-window interlock (full/no-readback 6/6 vs no-interlock/ungated 4/6 — the two window-class attacks execute and are journaled: *attribution ≠ prevention*); the hard engineering range is structurally unbypassable (false blocks 0 in every arm); write latency is statistically indistinguishable across arms (mock in-memory readback; protocol-layer readback cost measured in E6).

Raw rows: e1-lite.csv (384 rows)