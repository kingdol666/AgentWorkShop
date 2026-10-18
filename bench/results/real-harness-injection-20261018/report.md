# 注塑真实场景实机验收（PLC 模拟器 + 真实 omp Harness）

- 时间：2026-10-18 19:09–19:40（本地）
- 平台：AgentWorkShop 0.7.66，隔离实例 `http://127.0.0.1:3000`，`AW_HOME=D:/tmp/aw-real-injection-home`
- PLC 模拟器：`http://127.0.0.1:4010`（仓库内 `plc-node-simulator`，注塑场景）
- 产线：`ln-bea81ffa`「注塑成型质量窗口寻优 injection-real20261018」
- 配方：`rc-205e29f4`「scen-injection-recipe-real20261018」v1 → v2
- 活动批次：`rr-dcfc8dc5`

## 1. 真实 Harness 场景作业（通过）

- 真实 omp worker：`注塑数据分析 worker live-mvdqd330`（harness=omp，provider=deepseek，model=deepseek-v4-pro）
- GOAL-1：`009a8eb6-9fb0-4fb1-9db3-0ead3071de6d`，**COMPLETED / progress 100**
- GOAL-1 真实分析结论（worker 产出）：
  - 克重均值 **31.25 g**（规格 32.15–32.85，欠重约 0.9 g）
  - 缩痕均值 **2.15%**（规格 ≤1.5%），5 分钟平坦 → 真实过程异常（保压不足），非滞后
  - 飞边 0.011%（余量极大）；熔体温度 246.7℃、注射压力 52.0 bar、模温 40.0℃ 均安全
  - 建议：`hold-pressure-sp` +5 bar
- 说明：首次使用 omp 默认模型 `ustc/deepseek-flash` 时模型返回空文本，任务超时；切换 `deepseek/deepseek-v4-pro` 后 GOAL-1 正常完成。这是 harness 模型配置问题，不是平台任务引擎问题。

## 2. 闭环优化控制（通过）

使用当前权限模型 v2 支持的 `recipe_trial`（不再使用已禁用的 `dcw_control`），每一步均：
`recipe_trial` → HITL 人工批准 → 整批下发 → 设备证实 → 65 s 工艺响应 → DAQ 复测。

| 步骤 | 保压 (bar) | 克重 (g) | 缩痕 (%) | 飞边 (%) | 熔温 (℃) |
|---|---:|---:|---:|---:|---:|
| 基线 | 45 | 31.23 | 2.176 | 0.048 | 246.3 |
| +5 | 50 | 31.57 | 1.970 | — | — |
| +10 | 55 | 31.75 | 1.638 | — | — |
| +15 | 60 | 31.97 | 1.596 | — | — |
| +20 | 65 | **32.26** | **1.369** | **0.034** | **246.6** |

- 最终质量：克重 32.26 g、缩痕 1.369%、飞边 0.034%、熔温 246.6℃ → **全部入窗**
- 每次 `recipe_trial` 回执均为「已整批下发并全部设备证实」
- 达标后 `recipe_update` 经 HITL 固化：配方 v1 → **v2**，保压 45 → 65 bar
- 证据：`bench/results/injection-pressure-loop-2026-10-18T11-32-50-286Z/summary.json`
- 执行断言：**PASS 9/9**

## 3. 工具 Verify（真实场景负向/正向）

在同一真实场景、同一 Agent 身份下：

- 工艺优化 worker 查询**未绑定**节点 `dn-432c9a45`（cycle-time）→ **isError**，回包含可访问节点清单
- 工艺优化 worker 查询**已绑定**节点 `dn-4d103091`（part-weight）→ 成功返回真实 DAQ 统计
- 分析 worker 绑定的 6 个 DAQ 读取均成功（GOAL-1 证据）
- 产线管理/审批/换线/批次 TOCTOU 由已入库 `scripts/e2e-line-governance.mjs` 覆盖：**PASS 44/44**
- 工具调用统一预检隔离实例 E2E：**PASS 13/13**

## 4. 数据采集与参数下发

- DAQ：注塑产线活动批次内真实采样持续增长（GOAL-1 读取 5 分钟窗口；基线阶段 `taggedSamples` 已 >200）
- DCW：`recipe_trial` 逐参数写入由写控制网关执行，回执逐参数设备证实（`[证实✓]`）
- 参数限界：由 `recipe_trial` 的四层限界检查和写后 ACK 鉴定执行；非法/未证实会在回执中 `isError`
- HITL：每次 trial/update 均生成审批卡并由独立审批 API 批准，未绕过人工闸门

## 5. 本轮发现并修复的真实问题

1. **`AW_TRIAL_INTERVAL_MS=0` 无法关闭试验节拍**
   - 原实现 `Math.max(0, Number(env) || 300000)` 把显式 0 当作 falsy 翻回 5 分钟，与“0=关闭”的注释/语义不符。
   - 已修复为显式解析：空值才用默认 300000，显式 0 保持 0。
2. **旧 `real-injection-closed-loop.mjs` 已落后于权限模型 v2**
   - 脚本仍调用 `dcw_control`/`dcw_judge`，平台正确拒绝“直接节点写控已禁用”。
   - 新场景测试改用 `recipe_trial` + `recipe_update`；建议把旧脚本迁移到配方面路径，避免以后误判为平台故障。
3. **omp 默认模型 `ustc/deepseek-flash` 返回空文本**
   - 真实 worker 任务因此长时间 WORKING；切 `deepseek/deepseek-v4-pro` 后正常。部署时应固定可用模型。

## 6. 未覆盖边界

- PLC 使用仓库内模拟器（OPC UA/Modbus/MQTT/HTTP 真实协议端点），非物理 PLC。
- 本轮未启动真实 IDD/RAG 外部服务；插件生命周期由 fake-backend 单测覆盖。
- 完整 `real-injection-closed-loop.mjs` 的旧写控脚本未改造成配方面版本；本轮以 `recipe_trial` 完成闭环控制验收。
