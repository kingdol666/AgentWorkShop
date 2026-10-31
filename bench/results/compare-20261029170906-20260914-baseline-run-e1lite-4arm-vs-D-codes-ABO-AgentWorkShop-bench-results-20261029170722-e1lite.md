# 复现性判定: REPRODUCIBLE

- A（基线）: `20260914-baseline/run-e1lite-4arm` → D:\codes\ABO\AgentWorkShop\bench\baselines\20260914-baseline\run-e1lite-4arm\run.json
- B（新运行）: `D:/codes/ABO/AgentWorkShop/bench/results/20261029170722-e1lite` → D:\codes\ABO\AgentWorkShop\bench\results\20261029170722-e1lite\run.json
- 契约: 判定类指标逐位一致 = REPRODUCIBLE；时延/新鲜度类只报告不设门槛（bench/compare.mjs JUDGE 契约表）

## 环境

| | A | B |
|---|---|---|
| tier/seed | e1-lite/42 | e1-lite/42 |
| harnessHash | — | — |
| gitCommit | d6c824d | 60fa983e |
| configHash | 3a57e722d4764b98 | 3a57e722d4764b98 |

## 逐检查对比

| 检查 | status A | status B | 判定 | 说明 |
|---|---|---|---|---|
| e1lite:full | pass | pass | ok | intercept_rates =, window_breach_total =, false_block_total =, boundary_ok_total =, p50 ≠(env), p95 ≠(env) |
| e1lite:no-interlock | pass | pass | ok | intercept_rates =, window_breach_total =, false_block_total =, boundary_ok_total =, p50 ≠(env), p95 ≠(env) |
| e1lite:no-readback | pass | pass | ok | intercept_rates =, window_breach_total =, false_block_total =, boundary_ok_total =, p50 ≠(env), p95 ≠(env) |
| e1lite:ungated | pass | pass | ok | intercept_rates =, window_breach_total =, false_block_total =, boundary_ok_total =, p50 ≠(env), p95 ≠(env) |

## 环境类指标差异（不设门槛，如实记录）

- e1-lite.full.p50: [125.4,140.9,125.8] → [126.3,110.5,125.7]
- e1-lite.full.p95: [158.9,158.6,158.2] → [156.8,164.3,165.4]
- e1-lite.no-interlock.p50: [125.5,140.6,126.4] → [125.7,126.5,122.5]
- e1-lite.no-interlock.p95: [158.2,159.3,150.2] → [166.1,157.4,160.7]
- e1-lite.no-readback.p50: [125.4,124.7,125.1] → [128.7,125.7,124.8]
- e1-lite.no-readback.p95: [156.5,156.4,156.7] → [156.7,156,163.5]
- e1-lite.ungated.p50: [112.4,110.9,125] → [125.3,113.3,132.9]
- e1-lite.ungated.p95: [156.2,155.5,156.4] → [172.6,171.1,190.2]

## 结论: **REPRODUCIBLE**
