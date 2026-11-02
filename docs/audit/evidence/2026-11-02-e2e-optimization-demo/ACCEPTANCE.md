# 端到端优化作业演示 · 验收记录(2026-11-02/03)

> 场景:PLC 模拟器孪生(modbus-tcp)+ 平台隔离实例,真实 REST + 真实写咽喉 + 真实 DoE 执行器。
> 设备层说明:**模拟孪生**,不是物理 PLC;割接真实设备只需替换 `driverConfig` 端点,治理面零改动。

## 作业场景

| 项 | 配置 |
|---|---|
| 产线 | 演示注塑优化线(`simulated=false`,走真实线治理档) |
| 控制量 | 保压压力SP,50–90 bar,stepLimit 10,保写心跳 0(见下"演示中发现的产品问题") |
| 观测 | 制品重量PV(g),模腔压力PV(bar);孪生动力学:重量 = 31.75 + 0.055×(SP−50),τ=8s,噪声 ±0.01 |
| 目标窗 | **32.00–32.30 g**;初始 SP=50 → ≈31.75 g(窗外) |
| 优化任务 | DoE 3 水平(50/55/60)×1 轮,真实线单卡 HITL;由实测增益反算目标 SP 并下发 |

## 验收标准与结果(15/15 PASS)

| ID | 验收标准 | 实测 |
|---|---|---|
| D1a | 基线重量可观测 | **31.736 g** |
| D1b | 基线低于目标窗(需要优化) | 31.736 < 32.00 |
| D2a | 计划创建即待批准(真实线 HITL) | `awaiting_approval` |
| D2b | 成本前置核算 | 3 步 × 61s,总时长 ≈0.05h,含真实线 60s 下限 |
| D3 | 未批准执行被拒 | `EXPERIMENT_APPROVAL_REQUIRED` |
| D4a | 人工批准转 planned | `planned` |
| D4b | 随机化执行完成 | **done 3/3,183s** |
| D5a | 台账 3 行且判定已回填 | `identifiable_effect, underpowered, underpowered` |
| D5b | 判定回灌本体证据(可追溯) | **3 条**(source_ref = 干预 id) |
| D6a | 可从实验数据估出增益 | **0.0407 g/bar**(注入真值 0.055,窗口噪声内偏低) |
| D6b | 增益方向正确 | > 0 |
| D7a | 目标 SP 在安全量程 | **60.6 bar** |
| D7b | 参数下发受理 | `ok=true` |
| D7c | 回读一致 | **60.6 = 60.6** |
| D8 | 重量进入目标窗(控得好) | **32.088 g ∈ [32.0, 32.3],Δ = +0.352 g** |

## 运行中发现并修复的产品问题(3)

1. **首步写间隔失败**:刚开线的节点被 60s 写间隔拦住,整份计划白失败。
   → 执行器在真实线首步前等待间隔(`experiment-runner.ts`)。
2. **间隔拒绝即失败**:写间隔是安全联锁,不该让计划失败。
   → 同一试验步按"还需 Ns"等待后**有上限重试**(最多 4 次)。
3. **保写心跳与 60s 间隔活锁**(系统性):`holdIntervalMs` 心跳每 60s 用同值保活,
   却推进了 60s 间隔基准,导致 Agent/试验步永远"还需 60s"。
   → 节点新增 `lastChangeAt`(只有**值变化**才推进间隔基准,心跳不推进);
   → 计划校验拒绝带心跳的控制节点(要求先置 0),避免静默无效试验。

## 复现

```bash
# 1) 模拟器孪生(影子端口,不碰 4010)
node scripts/onboarding/sim-twin.mjs --blueprint docs/audit/evidence/2026-11-02-e2e-optimization-demo/blueprint.json --sim-port 4055
# 2) 生成接入配置(取 export driverConfig)
node scripts/demo/build-provision-config.mjs --sim http://127.0.0.1:4055 --device demo-injection --out <cfg>
# 3) 平台实例(隔离 home) + 供给
node scripts/onboarding/provision-line.mjs <cfg>
# 4) 端到端作业
node scripts/demo/e2e-optimization-demo.mjs --base http://127.0.0.1:PORT --home <AW_HOME> \
  --line <lineId> --dcw <dcwId> --daq <daqId> --email <admin> --pass <pass>
```

证据:`report.json`(结构化)、`run.log`(控制台)、`blueprint.json` / `provision-config.json`(可复现夹具)。
