# 复现性判定: REPRODUCIBLE

- A（基线）: `20260914-baseline/run-e1lite-4arm` → D:\codes\ABO\AgentWorkShop\bench\baselines\20260914-baseline\run-e1lite-4arm\run.json
- B（新运行）: `bench/results/20260918151245-e1lite` → D:\codes\ABO\AgentWorkShop\bench\results\20260918151245-e1lite\run.json
- 契约: 判定类指标逐位一致 = REPRODUCIBLE；时延/新鲜度类只报告不设门槛（bench/compare.mjs JUDGE 契约表）

## 环境

| | A | B |
|---|---|---|
| tier/seed | e1-lite/42 | e1-lite/42 |
| harnessHash | — | — |
| gitCommit | d6c824d | 00679bb |
| configHash | 3a57e722d4764b98 | 3a57e722d4764b98 |

## 逐检查对比

| 检查 | status A | status B | 判定 | 说明 |
|---|---|---|---|---|
| e1lite:full | pass | pass | ok | intercept_rates =, window_breach_total =, false_block_total =, boundary_ok_total =, p50 ≠(env), p95 ≠(env) |
| e1lite:no-interlock | pass | pass | ok | intercept_rates =, window_breach_total =, false_block_total =, boundary_ok_total =, p50 ≠(env), p95 ≠(env) |
| e1lite:no-readback | pass | pass | ok | intercept_rates =, window_breach_total =, false_block_total =, boundary_ok_total =, p50 ≠(env), p95 ≠(env) |
| e1lite:ungated | pass | pass | ok | intercept_rates =, window_breach_total =, false_block_total =, boundary_ok_total =, p50 ≠(env), p95 ≠(env) |

## 环境类指标差异（不设门槛，如实记录）

- e1-lite.full.p50: [125.4,140.9,125.8] → [123.9,140.5,125.6]
- e1-lite.full.p95: [158.9,158.6,158.2] → [156.3,156.6,157.7]
- e1-lite.no-interlock.p50: [125.5,140.6,126.4] → [125.4,141.6,141.6]
- e1-lite.no-interlock.p95: [158.2,159.3,150.2] → [158.4,171.6,180.1]
- e1-lite.no-readback.p50: [125.4,124.7,125.1] → [123.3,140.8,124.9]
- e1-lite.no-readback.p95: [156.5,156.4,156.7] → [157.5,157.7,158.1]
- e1-lite.ungated.p50: [112.4,110.9,125] → [126,126.4,111.8]
- e1-lite.ungated.p95: [156.2,155.5,156.4] → [172.3,156.1,157.6]

## 结论: **REPRODUCIBLE**
