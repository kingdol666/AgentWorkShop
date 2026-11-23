# Session / Runtime 设计与实现核查（2026-11-23）

核查对象：`D:\codes\ABO\AgentWorkShop`，分支 `feat/session-runtime-verify-20261123`，基线 `b4ebd866`（= `origin/main`）。
本文只记录**在代码里能直接读到的事实**；实机验证结果见同目录 `E2E-RESULTS.md`。

## 1. 结论速览

| 用户提出的设计点 | 代码事实 | 判定 |
|---|---|---|
| 会话隔离 | 每个会话 = 一组克隆成员 + `channel_sessions` 行（`member_map_json` base→clone）；消息/任务/记忆都带 `session_id`；跨会话 A2A 直接 403 | 成立 |
| 每个会话是独立 Runtime 实例 | 每个**克隆成员**一个 `AgentRuntime`（`agentIndex` 键 = `channelId + agentId`），自带 Mailbox、execLock、harness 进程、记忆作用域 | 成立（粒度是"每成员"，不是"每会话一个"） |
| Runtime 元数据持久化 | 元数据在 SQLite 行里（`channel_sessions` / `channel_agents` / `channel.llm_json` / prefab 绑定快照）；**运行时对象本身不持久化** | 部分成立：持久化的是元数据，对象每次按需重建 |
| 元数据存"对象存储" | 对象存储适配器只服务 DAQ 帧与 MES（`daq/objectstore/*`）；会话/运行时元数据在 SQLite 单文件库 | **不成立**（设计前提需修正） |
| 启动对话 → activate Runtime 并按元数据注入 | `ensureAgentRuntime` 懒装配 → `wireMember` 从 DB 行重建 → `runtime.start()`；会话关闭/频道停用/空闲清扫都会卸载 | 成立 |
| 持久层按 session + Agent 保存实时对话/记忆/经验 | `messages.session_id`、`tasks.session_id`、`agent_memories.session_id`+`scope_kind/scope_key`、`experience_versions` | 成立 |
| 工具按自身元数据自动注入记忆/经验/本会话记忆 | 工具桥的 `sessionId` 来自运行时注入的 `trustedSessionId`（不是模型自报）；`save_memory` 默认落会话作用域 | 成立 |
| ChannelRuntime 控频道生命周期、AgentRuntime 控单 Agent 执行 | ChannelRuntime：路由/守卫/调度器/停机屏障；AgentRuntime：消费循环/回合/中止/停机 | 成立 |
| 每个运行对话都是独立实例（ChannelRuntime + 其下的 AgentRuntime） | 频道一个 `ChannelRuntime`；**同一频道下所有会话共用它**，每个克隆成员各有 `AgentRuntime` | 需按此口径理解 |

## 2. 会话隔离

- **会话实体**：`server/services/workshop/db/database/schema.ts:250` `channel_sessions`（`status` active/closing/closed、`memory_policy`、`member_map_json`、`instance_kind` manual/task/project、`summary`/`brief_json`、`last_active_at`、`generation`）；后补列见 `db/channel-session.repo.ts:51`（`channel_mode`/`product_id`/`line_id`/`binding_snapshot_*`/`prefab_snapshot_*`）。
- **创建**：`agents/session-clone.ts:88-219` `createChannelSession()`——克隆频道全部基础成员（clone 统一 `role=worker`，名字 `基础名·session·N` 且跨会话唯一），`member_map_json` 记 base→clone，克隆行与会话行**同一事务**落库；prefab 绑定在会话创建时快照（`prefabSnapshotHash`），工业绑定在事务提交后复制（JSON 存储不参与 SQLite 事务），失败即补偿。
- **关闭**：`session-clone.ts:260-297` `closeChannelSession()`——先持久化 `closing` 意图 → 取消 clone 名下任务树并打断在飞回合 → 停用成员行 → 强制摘除运行时 → `closed`；崩溃中断由 `session-clone.ts:306-335` `reconcileClosingSessions()` 在启动时收敛。
- **访问隔离**：
  - Agent 间投递：`runtime/manager/a2a.ts:26-37` 用 `activeSessionOfMember()` 判定双方会话，跨会话抛 `403 SESSION_MEMBER_SCOPE_MISMATCH`；并对 metadata 里的 `x-aw-session-id` **先删后盖**（服务端权威，调用方伪造无效）。
  - 广播：`runtime/manager/broadcast-targets.ts:14-29`——克隆成员广播只覆盖"基础成员 + 本会话 clone"，跨会话不扇出；解析不到会话时 fail-closed。
  - 装配守卫：`runtime/manager/runtime-wiring.ts:312-327`——名字含 `·session·` 的克隆只有在"恰好一个 active 会话引用它"时可装配，否则拒绝（查库异常也拒绝）。
  - REST 记忆检索：`server/api/workshop/channels/[id]/agents/[agentId]/memories/search.post.ts`——`scope=session` 必须给本频道 active 会话 id 且该 agent 是该会话成员，否则 403。

## 3. Runtime 实例结构

- `runtime/manager/state.ts:88-90`：
  ```ts
  protected channels = new Map<string, ChannelRuntime>()          // 每频道一个
  protected agentIndex = new Map<string, AgentRuntime>()          // runtimeKey(channelId, 实例 id)
  ```
  `runtime/manager/helpers.ts:119` `runtimeKey(channelId, agentId)`。
- `runtime/channel-runtime.ts`（298 行）：`agents: Map<agentId, AgentRuntimeLike>`、`route()`（信箱投递 + 实时 steer）、`resolveRecipients()`、`ensureAgent()`（懒装配回调）、`scheduler` 挂载与 `stopSchedulersAndWait()` 停机屏障。**一个 ChannelRuntime 服务该频道下的全部会话**——会话不是 ChannelRuntime 的粒度。
- `runtime/agent-runtime/*`：`AgentRuntimeState`（`state` idle/busy/stopped、`execLock` 每实例串行、`abortController`、`sessionContexts`）、`AgentRuntimeLifecycle`（`start()` 起消费循环、`stop()` 收敛审批→abort→关信箱→dispose）、`message.ts`（单回合：记忆召回 → Session Context → `impl.run()` → 回执/任务联动）。
- 因此"每个运行中的对话是独立运行时实例"的准确表述是：**每个会话的每个成员各自一个 AgentRuntime**；同一频道多个会话共享同一个 ChannelRuntime（频道级路由/调度/守卫）。

## 4. 元数据持久化与激活

- 持久化的元数据（SQLite）：
  - `channel_agents`（`schema.ts:33`）：实例 id、`template_id`、`name`、`harness`、`config_json`、`role`、`agent_kind`、`token`、`enabled` —— 这是"运行时元数据"的真实载体。
  - `channel_sessions`：会话 id、成员映射、记忆策略、状态、brief/summary 缓存、`generation`、产品/产线/绑定快照、prefab 快照。
  - `channels`：场景 prompt、`llm_json`（频道默认模型）、工作目录、`line_id`。
- 装配（`runtime-wiring.ts:117-289` `wireMember`）按以上行重建：`Mailbox` → `AgentMemory`（带 `sessionId`/`lineId`/`productId`/`industrialScopeEnabled`）→ `buildWorkspace` → 场景 prompt + 产线简报 + 频道 LLM + prefab 能力/提示 → `implFactory` → `setChannelSessionScope` / `setTrustedSessionId` → `new AgentRuntime(...)` → `cr.addAgent` + `agentIndex.set` → `runtime.start()`。
- 激活时机：`ensureChannelActive()`（`runtime-wiring.ts:336-354`）与懒装配 `ensureAgentRuntime()`（`:292-329`）；lead 装配后 `reviveScheduler()`/`attachScheduler()`（`:369-427`）挂调度循环。
- **没有**"运行时对象序列化到对象存储"实现：进程重启后运行时为空（`GET /api/workshop/runtime` 反映），首个消息/任务触发重新装配；harness 侧会话（如 omp 原生 session）由 harness 自己续接，平台只记 `trustedSessionId`。

## 5. 持久层：会话数据 / 记忆 / 经验

- 实时对话：`messages`（`schema.ts:53`，`session_id` + `client_message_id` 幂等 + `state` pending/consuming/consumed/dead + `claim_token`）；任务：`tasks.session_id`（迁移见 `db/database/migrations-session.ts`）。
- 记忆：`agent_memories`（`schema.ts:151`）——`agent_id` + `channel_id` + `session_id` + `kind` + `dedup_key`（`UNIQUE(agent_id, dedup_key, channel_id)`）+ `scope_kind`（session/channel/line/product/global）/`scope_key` + `status`（active/candidate/validated/contested/retired）+ `expires_at`；FTS/向量辅助表 `agent_memories_fts`、`agent_memories_vec`。
- 经验：`experience_versions` / `experience_heads` / `experience_*_outbox`（`schema.ts:1701+`）——版本化、内容哈希、证据快照哈希、生命周期 candidate→validated/retired。
- 写入策略：`db/memory.repo.ts` 的 `upsertExperience` 对 `validated`/`retired` 行保护正文/标题/结论/范围；会话记忆策略（`memory_policy=shared` 才允许写 line/global）在 `memory.repo.ts:454-460` 读取。
- 检索作用域：`runtime/memory/recall.ts` 的 `collectHits/inScope`（会话/频道/团队域过滤 + 同产线/同产品经验加分 + 会话行加分）。

## 6. 工具按自身元数据注入

- 工具桥会话态：`agents/base-agent.ts:139`
  ```ts
  state.sessionId = channelScope?.sessionId ?? this.bridgeCtx.trustedSessionId ?? null
  ```
  `trustedSessionId` 来自 `wireMember` 写入的会话行 id（`runtime-wiring.ts:209`），`channelScope` 来自会话绑定快照。
- 记忆工具：`agents/host-tool-bridge/tools/memory.ts:54-87`——`save_memory` 默认 `session_scope=true`，把**当前回合会话 id** 盖到记忆行；`search_memory` 的 `scope=session` 在无会话上下文时直接拒绝，而不是悄悄放宽。
- workspace 面：`runtime/manager/workspace.ts:44-84`——`recallMemory`/`saveMemory` 委托**该运行时自己的** `AgentMemory`；`recordSessionMemory`（压缩摘要入库）按 `memberMap` 反查所属会话，避免 omp 内部 session 与平台会话错配。
- 因此"工具能自动拿到自己的记忆/经验/本 Channel 会话记忆"成立，且**会话身份由平台注入、模型无法自报替代**。

## 7. 生命周期归属

- 频道级（ChannelRuntime + manager）：路由守卫、调度循环挂载/停机、频道停用即卸载全部成员运行时（`admin-channel.ts:196-231` 的 `updateChannel`，disabling 分支立即 `unloadChannelAgents`）、配置变更延迟回收（`recycleChannelAgents`，忙时排队到空闲）。
- 成员级（AgentRuntime）：回合消费、`execLock` 串行、steer 注入、中止（`abortCurrent`/`abortTask`）、停机屏障（`stop()` 等消费循环 + execLock + steer 收尾 + harness dispose）。
- 会话级（session-clone + manager）：创建/关闭/启动对账；关闭时按 clone 取消任务树并强停运行时。

## 8. 与设计意图不一致处（如实记录）

1. **运行时元数据不在对象存储**：对象存储（MinIO/磁盘）只用于 DAQ 帧/MES 载荷；运行时会话元数据在 SQLite。如果目标是"运行时元数据对象存储化"，那是未实现的设计变更，不是既有能力。
2. **会话不是 Runtime 的容器**：`ChannelRuntime` 按频道存在，会话是成员克隆 + 记忆/消息的隔离维度。若要"每会话一个控制器"，需要新的容器层。
3. 会话历史 DTO 的 `name` 字段返回 `from_agent_id`（`sessions/context.ts:382`），前端要自己映射显示名；对 API 使用者不友好。
4. 群聊可 @ 会话克隆（`runtime/manager/chat.ts:37-45` 的可提及名单包含克隆），克隆按自己绑定的会话回答——频道成员因此能问出会话内容（实机 R15 观测）。这符合"会话对频道成员可见"的产品口径，但需要明确记录。
