# 复现性判定: REPRODUCIBLE

- A（基线）: `20260914-baseline/run-plc-fx0` → D:\codes\ABO\AgentWorkShop\bench\baselines\20260914-baseline\run-plc-fx0\run.json
- B（新运行）: `20260915172737-574` → D:\codes\ABO\AgentWorkShop\bench\results\20260915172737-574\run.json
- 契约: 判定类指标逐位一致 = REPRODUCIBLE；时延/新鲜度类只报告不设门槛（bench/compare.mjs JUDGE 契约表）

## 环境

| | A | B |
|---|---|---|
| tier/seed | plc/42 | plc/42 |
| harnessHash | d4946c118317bc50 | 1a008f15e1cf9785 |
| gitCommit | d6c824d | d6c824d |
| configHash | 61e1a1119d6f3ff2 | 61e1a1119d6f3ff2 |
| 总体评分 | 100.0 | 100.0 |

> NOTE: harnessHash 不同（harness 源码在两次运行之间有改动，须确认改动不影响判定逻辑）: d4946c11 vs 1a008f15

## 逐检查对比

| 检查 | status A | status B | 判定 | 说明 |
|---|---|---|---|---|
| api-0-preflight | pass | pass | ok | 2 项判定指标逐位一致 |
| api-1-fixture | pass | pass | ok | 3 项判定指标逐位一致 |
| api-2-semantic-card | pass | pass | ok | 2 项判定指标逐位一致 |
| api-3-interlock-f5 | pass | pass | ok | 9 项判定指标逐位一致 |
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

- api-1-fixture.lineId: "ln-3047d2de" → "ln-157a3132"
- api-5-daq-freshness.points: 17 → 17 (Δ+0.0)
- api-5-daq-freshness.latest_age_s: 17.9 → 17.9 (Δ+0.0)
- api-5-daq-freshness.samples_api_p50_ms: 21 → 20 (Δ-1.0)
- api-5-daq-freshness.samples_api_p95_ms: 39 → 21 (Δ-18.0)
- plc-2-closedloop.real_samples_first_window: 8 → 9 (Δ+1.0)
- plc-2-closedloop.real_write_latency_ms: 25 → 53 (Δ+28.0)
- plc-2-closedloop.pv_converge_s: 3 → 27 (Δ+24.0)
- plc-2-closedloop.pv_final: 181.1 → 179.5 (Δ-1.6)
- plc-2-closedloop.f2_alarm_latency_s: 2 → 2 (Δ+0.0)
- plc-2-closedloop.pv_trace: [{"t":14,"pv":181.5},{"t":13,"pv":181.1},{"t":12,"pv":181.2},{"t":10,"pv":181.6},{"t":9,"pv":182.1},{"t":8,"pv":182},{"t":7,"pv":182.6},{"t":6,"pv":183.4},{"t":5,"pv":183.9},{"t":4,"pv":184.8},{"t":3,"pv":184.7},{"t":2,"pv":185.2},{"t":1,"pv":185.9},{"t":0,"pv":186.3}] → [{"t":39,"pv":150},{"t":38,"pv":150},{"t":37,"pv":179.5},{"t":36,"pv":179.4},{"t":35,"pv":179},{"t":34,"pv":178.4},{"t":33,"pv":178.7},{"t":32,"pv":178.8},{"t":31,"pv":178.6},{"t":30,"pv":178.8},{"t":29,"pv":177.5},{"t":28,"pv":176.4},{"t":27,"pv":176.3},{"t":26,"pv":175.8},{"t":24,"pv":174.8},{"t":23,"pv":174.3},{"t":22,"pv":173.4},{"t":21,"pv":171.6},{"t":20,"pv":170.8},{"t":19,"pv":169.6},{"t":18,"pv":168.9},{"t":17,"pv":166.4},{"t":16,"pv":164.7},{"t":15,"pv":163.1},{"t":14,"pv":159.8},{"t":13,"pv":156.6},{"t":12,"pv":154.3},{"t":11,"pv":151.5},{"t":10,"pv":145.5},{"t":9,"pv":141.9},{"t":8,"pv":138},{"t":7,"pv":128.3},{"t":6,"pv":122.8},{"t":5,"pv":116.5},{"t":4,"pv":109.1},{"t":3,"pv":91.8},{"t":2,"pv":81.7},{"t":1,"pv":70.6},{"t":0,"pv":46.7}]
- plc-2-closedloop.daq_points_total: 14 → 39 (Δ+25.0)

## 结论: **REPRODUCIBLE**
