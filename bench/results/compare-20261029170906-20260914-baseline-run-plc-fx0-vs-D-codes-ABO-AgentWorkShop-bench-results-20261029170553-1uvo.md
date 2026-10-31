# 复现性判定: NOT REPRODUCIBLE

- A（基线）: `20260914-baseline/run-plc-fx0` → D:\codes\ABO\AgentWorkShop\bench\baselines\20260914-baseline\run-plc-fx0\run.json
- B（新运行）: `D:/codes/ABO/AgentWorkShop/bench/results/20261029170553-1uvo` → D:\codes\ABO\AgentWorkShop\bench\results\20261029170553-1uvo\run.json
- 契约: 判定类指标逐位一致 = REPRODUCIBLE；时延/新鲜度类只报告不设门槛（bench/compare.mjs JUDGE 契约表）

## 环境

| | A | B |
|---|---|---|
| tier/seed | plc/42 | plc/42 |
| harnessHash | d4946c118317bc50 | b05579f45eae1396 |
| gitCommit | d6c824d | 60fa983e |
| configHash | 61e1a1119d6f3ff2 | 61e1a1119d6f3ff2 |
| 总体评分 | 100.0 | 96.1 |

> NOTE: harnessHash 不同（harness 源码在两次运行之间有改动，须确认改动不影响判定逻辑）: d4946c11 vs b05579f4
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
| s1-inventory | pass | warn | FAIL | ok:9→8; tools:10→7 |
| s2-paper-consistency | pass | pass | ok | 3 项判定指标逐位一致 |
| s3-governance-pipeline | pass | warn | FAIL | chainTotal:2→3 |

## 环境类指标差异（不设门槛，如实记录）

- api-1-fixture.lineId: "ln-3047d2de" → "ln-bfe15653"
- api-5-daq-freshness.points: 17 → 17 (Δ+0.0)
- api-5-daq-freshness.latest_age_s: 17.9 → 1.6 (Δ-16.3)
- api-5-daq-freshness.samples_api_p50_ms: 21 → 48 (Δ+27.0)
- api-5-daq-freshness.samples_api_p95_ms: 39 → 90 (Δ+51.0)
- plc-0-simulator.sim: "http://127.0.0.1:4010" → "http://127.0.0.1:4016"
- plc-2-closedloop.real_samples_first_window: 8 → 8 (Δ+0.0)
- plc-2-closedloop.real_write_latency_ms: 25 → 35 (Δ+10.0)
- plc-2-closedloop.pv_converge_s: 3 → 24 (Δ+21.0)
- plc-2-closedloop.pv_final: 181.1 → 179.7 (Δ-1.4)
- plc-2-closedloop.f2_alarm_latency_s: 2 → 2 (Δ+0.0)
- plc-2-closedloop.pv_trace: [{"t":14,"pv":181.5},{"t":13,"pv":181.1},{"t":12,"pv":181.2},{"t":10,"pv":181.6},{"t":9,"pv":182.1},{"t":8,"pv":182},{"t":7,"pv":182.6},{"t":6,"pv":183.4},{"t":5,"pv":183.9},{"t":4,"pv":184.8},{"t":3,"pv":184.7},{"t":2,"pv":185.2},{"t":1,"pv":185.9},{"t":0,"pv":186.3}] → [{"t":0,"pv":81},{"t":1,"pv":99.8},{"t":2,"pv":107.8},{"t":3,"pv":115.6},{"t":5,"pv":134.7},{"t":6,"pv":139.9},{"t":7,"pv":144.4},{"t":8,"pv":148.8},{"t":10,"pv":158},{"t":11,"pv":160.5},{"t":12,"pv":163.3},{"t":13,"pv":164.5},{"t":15,"pv":168.7},{"t":16,"pv":169.7},{"t":17,"pv":170.7},{"t":18,"pv":171.7},{"t":20,"pv":173.5},{"t":21,"pv":174.5},{"t":22,"pv":175.5},{"t":24,"pv":176.7},{"t":26,"pv":177.6},{"t":27,"pv":178.2},{"t":28,"pv":178.4},{"t":29,"pv":178.6},{"t":31,"pv":178.9},{"t":32,"pv":178.7},{"t":33,"pv":178.8},{"t":34,"pv":150},{"t":35,"pv":150}]
- plc-2-closedloop.daq_points_total: 14 → 29 (Δ+15.0)

## 门槛失败明细

- s1-inventory status: pass → warn
- s1-inventory.ok: 9 → 8
- s1-inventory.tools: 10 → 7
- s3-governance-pipeline status: pass → warn
- s3-governance-pipeline.chainTotal: 2 → 3

## 结论: **NOT REPRODUCIBLE**
