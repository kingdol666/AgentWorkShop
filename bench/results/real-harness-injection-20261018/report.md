# 注塑真实场景实机验收：PLC 模拟器 + 真实 omp（deepseek-flash）

- 时间：2026-10-18 20:25–20:39（本地）
- 平台：AgentWorkShop 0.7.66，隔离实例 `http://127.0.0.1:3000`（直接运行 `.output/server/index.mjs`，无启动器 watchdog）
- PLC 模拟器：`http://127.0.0.1:4010`（仓库内 `plc-node-simulator`，注塑场景）
- 产线：`ln-45b71cb7`「注塑OPCUA实机线」
- 配方：`rc-9f476d3d`「注塑配方-1cb7」v1 → v2
- 真实协议：OPC UA（保压压力/时间、注射压力）+ HTTP（克重/飞边/缩痕）；不使用 Modbus

## 1. 真实 Harness 场景作业（通过）

- 真实 omp worker：`注塑OPC分析员-1cb7`（harness=omp，provider=deepseek，model=**deepseek-flash**）
- GOAL-1：
  - 父任务 `74b2523a-951f-447b-90fd-23617befec58`：**COMPLETED / 100**
  - 子任务 `40d7a619-ad7d-4088-a3e3-786ee44809ba`：**COMPLETED**，assignee 为上述 omp worker
  - 链路：任务引擎派发 → 真实 omp 读取 DAQ → 生成分析报告 → `send_message_to_agent` 汇报 Lead → 任务收口
- 真实分析结论（worker 产出，节选）：
  - 克重均值 **31.291 g**（规格 32.15–32.85，低于 LSL 0.859 g）
  - 缩痕均值 **2.149%**（规格 ≤1.5%，超 43%）
  - 飞边均值 0.008%、峰值 0.049%（≤0.4%，余量充足）
  - 注射压力均值 51.78 bar，无爬升；根因：欠保压/补缩不足
  - 单变量方案：`hold-pressure-sp` 45 → 50 bar；保压时间 6 s 保持不动
  - 明确指出熔体温度无绑定节点，属证据缺口（诚实披露）
- 证据：`goal1-flash-evidence.json`

## 2. 闭环优化控制（通过，9/9）

使用当前权限模型 v2 支持的 `recipe_trial`：

`recipe_trial` → HITL 人工批准 → 整批下发 → 逐参数设备证实 → 65 s 工艺响应 → DAQ 复测

| 步骤 | 保压 (bar) | 克重 (g) | 缩痕 (%) | 飞边 (%) |
|---|---:|---:|---:|---:|
| 基线 | 45 | 31.28 | 1.977 | 0.000 |
| +5 | 50 | 31.49 | 1.956 | — |
| +10 | 55 | 31.74 | 1.760 | — |
| +15 | 60 | 32.05 | 1.534 | — |
| +20 | 65 | **32.30** | **1.277** | **0.019** |

- 最终质量：克重 32.30 g、缩痕 1.277%、飞边 0.019% → 全部入窗
- 每次 `recipe_trial` 回执均为「已整批下发并全部设备证实」
- 达标后 `recipe_update` 经 HITL 固化：配方 v1 → **v2**，保压 45 → 65 bar
- 执行断言：**PASS 9/9**（P1–P7）
- 证据：`closedloop-summary.json`

## 3. 工具 Verify（真实场景）

同一真实场景、同一频道成员 Agent：

- 他线未绑定节点 `dn-9574b7df`（line `ln-386d7d88`）查询 → **isError**：
  「工具调用被拒(引用校验,daq_query)…不在你的授权范围内」，并列出绑定节点与频道绑线只读节点
- 本线已绑定节点 `dn-dbfee129`（制品克重）查询 → 成功，返回活动批次真实统计
- 同线但未直接绑定的节点经频道绑线只读面可读（v28 语义）；跨线仍拒绝
- 工具调用统一预检隔离 E2E：**PASS 13/13**
- 产线治理 E2E：**PASS 44/44**

## 4. 本轮发现并修复/确认的问题

1. **`AW_TRIAL_INTERVAL_MS=0` 被 falsy 默认值翻回 300000**
   - 已修复为显式解析（0=关闭，空/非法=默认 300000），并加启动告警。
   - 单测覆盖 0/1/空/非法；实测 65 s 节拍闭环使用 0 生效。
2. **旧 `real-injection-closed-loop.mjs` 落后于权限模型 v2**
   - 仍调用已禁用的 `dcw_control/dcw_judge`，已标注 `@deprecated` 并加运行时警告；
   - 新路径：`scripts/e2e-injection-recipe-closedloop.mjs`（`npm run test:e2e-injection`）。
3. **完整注塑线（含 Modbus TCP/RTU）在模拟器重启后出现 Modbus 半开连接**
   - 现象：平台日志反复 `TCP/TcpRTUBufferedPort Connection Timed Out` / `ERR_STREAM_WRITE_AFTER_END`，事件循环被拖慢，启动器健康探针判定僵死并重启子进程。
   - 处置：本轮验收改走同一注塑场景的 OPC UA + HTTP 真实协议端点，规避 Modbus 半开连接；Modbus 驱动重连/关闭阻塞问题作为独立生产稳定性问题保留，未在本轮改动。
4. **omp 默认模型 `ustc/deepseek-flash` 返回空文本**
   - 改用 `deepseek/deepseek-flash` 后真实任务正常完成；部署应固定可用 provider/model。

## 5. 未覆盖边界

- PLC 为仓库内模拟器（真实 OPC UA/HTTP 端点），非物理 PLC。
- 本轮 OPC UA/HTTP 子场景未建熔体温度节点，GOAL-1 已明确标注该证据缺口。
- 完整 Modbus 注塑线因上述连接稳定性问题未在本轮闭环中跑通；该问题已如实记录，不能宣称 Modbus 实机链路全绿。
