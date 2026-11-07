# Channel 多会话（Session）独立 Runtime 设计与开发计划

**状态：pending approval（设计评审产物，未批准不实施）**
**日期**：2026-11-06
**定位**：回答"Channel 能否承载多个独立 session、每个 session 独立 runtime/历史/记忆、可并行"——现状核验（代码锚点+实机探针）→ 用户设计可行性评价 → 分阶段开发计划。

---

## 1. 现状核验（是否已实现？——**否，且串行是显式设计**）

| # | 事实 | 代码/实机锚点 |
|---|---|---|
| 1 | **Runtime = Channel 成员单例**：`agentIndex` 以 `(channelId, agentId)` 为键，每成员至多一个 AgentRuntime；无 session 维度 | `runtime/manager/runtime-wiring.ts:139-148`（ensureAgentRuntime/runtimeKey） |
| 2 | **同 runtime 任务严格串行**：消费循环经 `withExecLock`（promise 链互斥，注释明示"供消费循环与 SchedulerLoop 串行化"）；`state='busy'` 期间新消息排队 | `runtime/agent-runtime/supervise.ts:156-167`、`message.ts:17`（processMessage）、`message.ts:42-46`（终态任务投递丢弃） |
| 3 | **omp 每 runtime 单进程单 sessionId**：会话历史=该进程连续对话上下文（跨任务共享，设计意图=同一 agent 的记忆连续性） | `omp-agent/client.ts:102-112`（get_state 取 sessionId）、`lifecycle.ts:35` |
| 4 | **记忆按 agent 归属**：agent_memories 以 agentId 为主键域（+team 域按 channelId），无会话隔离 | `runtime/memory/state.ts:30-38` |
| 5 | 实机探针：同 channel 两个无依赖工作项快速连发——mock 秒完成致采样不可分辨（`bench/results/20261106130656-serialization-probe/`）；串行结论以 #2 代码证据为准 | 探针脚本 `scripts/_audit/channel-serialization-probe.mjs`（已入库备用） |
| 6 | 平台已有"每任务独立执行"的部分形态：TaskEngine 任务/attempt/lease/generation fencing（并发入队、串行执行、互斥防双跑） | `runtime/task-engine/`；此前项目级验收（technical 门实机 409）已证 |

**结论**：多 session 独立 runtime **当前未实现**；单 Channel 内并发"入队"可以、并发"执行"不行（execLock 串行是防同 agent 自我竞争的显式设计）。

## 2. 用户设计评价（Channel=模板，session=runtime 实例，Manager 管理）

**总评：方向正确、与业界一致（Codex/Claude 的 session 模型），但需修正一个概念与四处冲突。**

### 2.1 概念修正
"Channel 是模板"不准确——当前 Channel 是**持久协作空间**（成员/任务/记忆/审批/绑定/HITL 的承载物），不是模板。更准确的表述：**Channel 保持为协作空间；在其下新增一阶实体 Session（会话）**——每个 session = 一次对话/任务流的隔离执行单元，拥有独立 runtime、独立历史、（可选）独立记忆视图。Channel 的"模板性"体现在：频道蓝图（成员/harness/绑定）可以按会话复制出**预装配**的 session。

### 2.2 与当前设计的四个冲突点及缓解
| # | 冲突 | 影响 | 缓解 |
|---|---|---|---|
| C1 | **omp 进程资源**：每 session 一个 omp 进程（各自 32k ctx） | N 会话 × 模型上下文 = 显存/内存线性增长 | Manager 增加每成员 `maxParallelSessions`（默认 2）+ 全局上限；会话空闲超时自动卸载（复用既有 idle 清扫） |
| C2 | **记忆是 agent 域不是 session 域** | 会话 A 的记忆泄漏进会话 B（隔离被破坏） | 记忆行增加 `sessionId` 维度：recall 合并「会话域（本 session）+ 频道 team 域（共享）」；写入时按 `memoryPolicy: 'session' \| 'channel'` 归属 |
| C3 | **TaskEngine/attempt/HITL 绑定 agentId** | 任务归属、write_intent 消费、审批分权都按 agentId——多会话并行时无法区分"哪个会话的任务" | TaskRow/attempt 增加 sessionId；HITL 审批 payload 增加 sessionId；执行门鉴权键从 agentId 升级为 (agentId, sessionId) |
| C4 | **mailbox/审批队列是 runtime 单队列** | 全局 FIFO 被多会话共享 → 顺序语义破坏 | 队列按 session 分道：每 session 独立 mailbox + execLock（会话内串行、会话间并行）；Manager 调度跨会话 |

### 2.3 与既有能力的兼容（好消息）
- TaskEngine 的 generation fencing/attempt/lease 与 session 正交（session 是 runtime 层概念，任务层不变）
- Project 层工作项派发可指定 `sessionId`（不指定 = 默认会话，零迁移）
- 蓝图（P1-1）可直接扩展 `sessions` 段——模板化建会话与"新开会话"语义天然衔接
- 现有单会话使用方（全部存量频道）默认获得 1 个隐式 session，行为零变化

## 3. 目标架构（一句话版）

**`Channel（协作空间）→ member（岗位/角色，权限与绑定不变）→ N × Session（会话，独立 runtime + mailbox + 历史 + 记忆视图）→ Manager 统一注册/调度/回收`**；同一 member 的会话间并行（每会话串行），跨 Channel 天然并行。

## 4. 分阶段开发计划

### Phase S1：Session 实体 + 每-session runtime（核心，~3 天）
- DB：`channel_sessions` 表（id, channel_id, agent_id, title, harness, config_json, status active/idle/closed, memory_policy, created_at, closed_at）
- Manager：`ensureSessionRuntime(sessionId)`（runtimeKey 升级为 (channelId, agentId, sessionId) 三元组索引）、`closeSession`（cancelTree 在飞任务 → 停 runtime → 归档）
- Mailbox：按 session 分道（mailbox 表/队列增加 session_id 列或独立队列）；execLock per session
- 兼容：每个 (channel, agent) 自动挂**默认隐式 session**——存量调用方（scheduler/项目派发/消息路由）不指定 session 时全部落入默认会话，行为零变化
- REST：`GET/POST /channels/:id/sessions`、`POST /channels/:id/sessions/:sid/close`、`POST .../sessions/:sid/messages`
- 验收：同 member 两 session 各自 dispatch 独立任务 → 两 omp 进程并行（/monitor 可见 2 runtime）→ 时间线重叠为真；互不可见对方历史

### Phase S2：路由 + 并发上限 + 可见性（~2 天）
- dispatch/消息路由支持 `sessionId` 目标；Manager 全局调度（每 member 并行上限、排队提示）
- `/monitor` 增加 session runtime 列表；snapshot/observability 透出 session 维度
- 验收：超上限派发 → 明确排队反馈；monitor 显示每 session 进程与状态

### Phase S3：会话记忆与历史（~2 天）
- agent_memories 增加 session_id；recall = 会话域 + team 域合并（MMR 去重既有）；`memoryPolicy` 控制写入归属
- 会话历史独立（omp sessionId per session runtime；session-resume 接入 P1-heavy 的方案复用）
- 验收：会话 A 写入的记忆，会话 B 召回不可见（auto 域按 session 过滤）；team 域双会话可见

### Phase S4：UI + 模板（~2 天）
- /workshop/w/:wsId 会话 tab（多会话并行视图）；蓝图 `sessions` 段（预装配会话随蓝图实例化）
- 验收：蓝图一键 → 多会话就绪 → 各自对话互不串扰（端到端探针）

### Phase S5（可选）：真实 LLM 并发压测
- 同 member 3 × omp 会话并行跑任务 → 验证模型后端并发与上限行为；产生产生并发验收报告

## 5. 风险与缓解
| 风险 | 缓解 |
|---|---|
| 每 session 一个 omp 进程的资源放大 | 并发上限（成员级+全局）+ 空闲卸载（复用 idle 清扫）+ 上限可配 |
| 存量行为回归 | 默认隐式会话（零迁移）；全量单测+api-live 底线不降；无 session 调用方走旧路径 |
| 记忆隔离破坏隐私/连续性权衡 | memoryPolicy 显式声明（session/channel）；team 域仍共享（协作语义保留） |
| HITL/写意图跨会话冒用 | 鉴权键升级 (agentId, sessionId)；P0-5 同款绑定思路 |
| runtime 索引键变更波及面大 | 三元组 key + 兼容函数 `runtimeKey(channelId, agentId)` = 默认会话 key（所有既有调用方零改动） |

## 6. 总体验收（Definition of Done）
1. 同 Channel 同 member：2 会话并行各执行独立任务，时间线重叠为真（探针入库）
2. 会话历史/记忆互不可见（auto 域）；team 域共享可见
3. 默认会话向后兼容：全部存量测试（1161+）不降
4. 终止/暂停级联覆盖 session（closeSession → 在飞任务 cancelTree）
5. /monitor + snapshot 可观测每 session runtime
6. 文档：`docs/multi-session-architecture.md`（目标架构图 + 迁移说明）

## 7. 与现有计划的关系
- 本计划 = P1-heavy（自动 replan 回合 / worker 澄清回路 / session-resume）的**前置底座**：session-resume 直接落在"每 session 独立 runtime"上
- 与 P0/P1 已合并能力（终止级联/终止时 cancelTree/expireAllPending、蓝图、rootTasks 可见面）全部正交叠加
