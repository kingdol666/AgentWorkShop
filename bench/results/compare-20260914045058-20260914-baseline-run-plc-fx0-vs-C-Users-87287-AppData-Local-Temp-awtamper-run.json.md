# 复现性判定: NOT REPRODUCIBLE

- A（基线）: `20260914-baseline/run-plc-fx0` → D:\codes\ABO\AgentWorkShop\bench\baselines\20260914-baseline\run-plc-fx0\run.json
- B（新运行）: `C:/Users/87287/AppData/Local/Temp/awtamper-run.json` → C:/Users/87287/AppData/Local/Temp/awtamper-run.json
- 契约: 判定类指标逐位一致 = REPRODUCIBLE；时延/新鲜度类只报告不设门槛（bench/compare.mjs JUDGE 契约表）

## 环境

| | A | B |
|---|---|---|
| tier/seed | plc/42 | plc/42 |
| harnessHash | d4946c118317bc50 | d4946c118317bc50 |
| gitCommit | d6c824d | d6c824d |
| configHash | 61e1a1119d6f3ff2 | 61e1a1119d6f3ff2 |
| 总体评分 | 100.0 | 100.0 |

## 逐检查对比

| 检查 | status A | status B | 判定 | 说明 |
|---|---|---|---|---|
| api-0-preflight | pass | pass | ok | 2 项判定指标逐位一致 |
| api-1-fixture | pass | pass | ok | 3 项判定指标逐位一致 |
| api-2-semantic-card | pass | pass | ok | 2 项判定指标逐位一致 |
| api-3-interlock-f5 | pass | pass | FAIL | intercept_rate:1→0.8333 |
| api-4-attribution-readback | pass | pass | ok | 6 项判定指标逐位一致 |
| api-5-daq-freshness | pass | pass | ok | 0 项判定指标逐位一致 |
| plc-0-simulator | pass | pass | ok | 1 项判定指标逐位一致 |
| plc-1-realpath | pass | pass | ok | 2 项判定指标逐位一致 |
| plc-2-closedloop | pass | pass | ok | 5 项判定指标逐位一致 |
| plc-4-fault | pass | pass | ok | 2 项判定指标逐位一致 |
| s1-inventory | pass | pass | ok | 7 项判定指标逐位一致 |
| s2-paper-consistency | pass | pass | ok | 3 项判定指标逐位一致 |
| s3-governance-pipeline | pass | pass | ok | 2 项判定指标逐位一致 |

## 环境类指标差异（不设门槛，如实记录）

- api-5-daq-freshness.points: 17 → 17 (Δ+0.0)
- api-5-daq-freshness.latest_age_s: 17.9 → 17.9 (Δ+0.0)
- api-5-daq-freshness.samples_api_p50_ms: 21 → 21 (Δ+0.0)
- api-5-daq-freshness.samples_api_p95_ms: 39 → 39 (Δ+0.0)
- plc-2-closedloop.real_samples_first_window: 8 → 8 (Δ+0.0)
- plc-2-closedloop.real_write_latency_ms: 25 → 25 (Δ+0.0)
- plc-2-closedloop.pv_converge_s: 3 → 3 (Δ+0.0)
- plc-2-closedloop.pv_final: 181.1 → 181.1 (Δ+0.0)
- plc-2-closedloop.f2_alarm_latency_s: 2 → 2 (Δ+0.0)
- plc-2-closedloop.daq_points_total: 14 → 14 (Δ+0.0)

## 门槛失败明细

- api-3-interlock-f5.intercept_rate: 1 → 0.8333

## 结论: **NOT REPRODUCIBLE**
