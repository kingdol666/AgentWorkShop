# 复现性判定: NOT REPRODUCIBLE

- A（基线）: `20260914-baseline/run-plc-fx0` → D:\codes\ABO\AgentWorkShop\bench\baselines\20260914-baseline\run-plc-fx0\run.json
- B（新运行）: `D:/codes/ABO/AgentWorkShop/bench/results/20261029171031-uhc` → D:\codes\ABO\AgentWorkShop\bench\results\20261029171031-uhc\run.json
- 契约: 判定类指标逐位一致 = REPRODUCIBLE；时延/新鲜度类只报告不设门槛（bench/compare.mjs JUDGE 契约表）

## 环境

| | A | B |
|---|---|---|
| tier/seed | plc/42 | plc/42 |
| harnessHash | d4946c118317bc50 | 508c2516642ca57e |
| gitCommit | d6c824d | 60fa983e |
| configHash | 61e1a1119d6f3ff2 | 61e1a1119d6f3ff2 |
| 总体评分 | 100.0 | 99.0 |

> NOTE: harnessHash 不同（harness 源码在两次运行之间有改动，须确认改动不影响判定逻辑）: d4946c11 vs 508c2516
> NOTE: gitCommit 不同: d6c824d vs 60fa983e

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
| s1-inventory | pass | warn | FAIL | ok:9→8; tools:10→8 |
| s2-paper-consistency | pass | pass | ok | 3 项判定指标逐位一致 |
| s3-governance-pipeline | pass | pass | FAIL | chainsOk:2→3; chainTotal:2→3 |

## 环境类指标差异（不设门槛，如实记录）

- api-1-fixture.lineId: "ln-3047d2de" → "ln-17e6974a"
- api-5-daq-freshness.points: 17 → 18 (Δ+1.0)
- api-5-daq-freshness.latest_age_s: 17.9 → 1.3 (Δ-16.6)
- api-5-daq-freshness.samples_api_p50_ms: 21 → 44 (Δ+23.0)
- api-5-daq-freshness.samples_api_p95_ms: 39 → 67 (Δ+28.0)
- plc-0-simulator.sim: "http://127.0.0.1:4010" → "http://127.0.0.1:4016"
- plc-2-closedloop.real_samples_first_window: 8 → 8 (Δ+0.0)
- plc-2-closedloop.real_write_latency_ms: 25 → 35 (Δ+10.0)
- plc-2-closedloop.pv_converge_s: 3 → 27 (Δ+24.0)
- plc-2-closedloop.pv_final: 181.1 → 179.3 (Δ-1.8)
- plc-2-closedloop.f2_alarm_latency_s: 2 → 2 (Δ+0.0)
- plc-2-closedloop.pv_trace: [{"t":14,"pv":181.5},{"t":13,"pv":181.1},{"t":12,"pv":181.2},{"t":10,"pv":181.6},{"t":9,"pv":182.1},{"t":8,"pv":182},{"t":7,"pv":182.6},{"t":6,"pv":183.4},{"t":5,"pv":183.9},{"t":4,"pv":184.8},{"t":3,"pv":184.7},{"t":2,"pv":185.2},{"t":1,"pv":185.9},{"t":0,"pv":186.3}] → [{"t":0,"pv":70.7},{"t":1,"pv":91.6},{"t":2,"pv":100.9},{"t":3,"pv":116.4},{"t":5,"pv":129.2},{"t":6,"pv":134.8},{"t":7,"pv":143.5},{"t":8,"pv":147.5},{"t":10,"pv":154.3},{"t":11,"pv":159.3},{"t":12,"pv":161.6},{"t":13,"pv":162.8},{"t":14,"pv":166.1},{"t":15,"pv":167.5},{"t":16,"pv":169.1},{"t":17,"pv":171.1},{"t":19,"pv":171.8},{"t":20,"pv":172.7},{"t":21,"pv":174.1},{"t":22,"pv":175.1},{"t":23,"pv":175.8},{"t":25,"pv":177.4},{"t":26,"pv":177.5},{"t":27,"pv":176.7},{"t":28,"pv":177.1},{"t":30,"pv":177.7},{"t":31,"pv":177.8},{"t":32,"pv":177.9},{"t":33,"pv":177.9},{"t":36,"pv":178.8},{"t":37,"pv":179.3},{"t":38,"pv":150}]
- plc-2-closedloop.daq_points_total: 14 → 32 (Δ+18.0)

## 门槛失败明细

- s1-inventory status: pass → warn
- s1-inventory.ok: 9 → 8
- s1-inventory.tools: 10 → 8
- s3-governance-pipeline.chainsOk: 2 → 3
- s3-governance-pipeline.chainTotal: 2 → 3

## 结论: **NOT REPRODUCIBLE**
