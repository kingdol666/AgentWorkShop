# Session Context Platform（A 方案）实施计划

> 状态：**已选定 A 方案，M1 已实施并验收**（2026-11-07）
> 基线：`origin/main` `f4358085`（已含 Channel clone session + Project task instance session）
> 分支：`feat/session-context-20261107`
> PR 目标：`main`
> 关联设计：`docs/plans/2026-11-07-session-context-architecture.md`

---

## 1. 背景与现状

`origin/main` 已有两套“session 形态”：

1. **Channel 手工会话**：`channel_sessions` + 从基础成员 clone 出的实例组；每个 clone 有独立 runtime/mailbox/omp 进程；UI 可创建/查看/关闭，但**没有 session 消息入口、没有 session_id 贯通、没有上下文包**。
2. **Project 任务会话**：每个 work item 派发时创建任务专属 Channel（`createTaskInstanceChannel`），clone lead + worker、独立 SchedulerLoop/root 队列/workspace，并写 `channel_sessions(instance_kind='task', project_id, project_work_item_id)`；root task 在该实例 Channel 执行。**执行隔离已真实存在**，但 session 只是关联锚点，没有平台上下文/历史/记忆 scope。

平台运行时仍是“每 agent 一个 AgentRuntime + 一个 harness 会话”；`AgentRuntime` 没有 session 维度，`prompt-builder` 没有 session 块，`tasks/messages/chat/agent_memories` 没有 `session_id`。

**A 方案的目标不是推翻 clone/task-instance，而是在其上补“平台 Session 上下文层”**：Session 成为可寻址、可列举、可检索、可恢复的上下文单元；harness 会话继续作为执行 lane。

---

## 1.1 实施结果（2026-11-07）

M1 已落地并通过验收：

- **Session 元数据**：`channel_sessions` 增加 summary/brief_json/last_active_at/generation；project session 在项目创建时生成。
- **session_id 贯通**：tasks/messages/agent_memories/project_work_item_attempts 加列；root/子任务继承；assign/回执/手工会话消息带 `x-aw-session-id`。
- **Session Context Service**：确定性 brief / summary / catalog / history；Project session 使用工作项/交付物作为上下文，而非办公室 Channel 的 tasks。
- **RuntimeSessionContext**：AgentRuntime 内按 sessionId 缓存上下文对象；prompt 注入 `## Session Context` + boundary。
- **Channel session 执行**：`POST /channels/:id/sessions/:sid/messages` 投给 clone 成员；UI composer + brief + 回执。
- **Project session**：project session + task session 目录；Project 页展示；Project Leader prompt 增加 session 目录。
- **验收**：API 20/20、UI 7/7、unit 1171（1169 pass / 2 skipped，另观察到一次 http-drivers 并行 flake，重跑通过）、i18n 3291/3291、typecheck/lint/build 通过。
- **未做（M2/M3）**：per-session harness resume、memory session 过滤（列已预留）、manual session 并行 root、跨 session 搜索工具。

## 2. 本 PR（M1）范围

### 2.1 做

1. **Session 元数据扩展**：`channel_sessions` 增加 `summary`、`brief_json`、`last_active_at`、`generation`；`instance_kind` 扩展 `manual | task | project`。
2. **session_id 贯通**：`tasks`、`messages`、`chat_messages`、`chat_deliveries`、`agent_memories` 加 `session_id`；任务子任务继承；task assign 消息携带 `x-aw-session-id`。
3. **Session Context Service**：按 session 生成确定性 brief（目标/root/任务树/交付物/最近消息/决策/下一步），刷新 `summary`；Channel 目录；Project 目录；history 查询。
4. **RuntimeSessionContext**：`AgentRuntime` 内按 `sessionId` 缓存上下文对象；`AgentRunRequest/AgentRunContext` 增加 session；prompt 注入 `## Session Context` + boundary。
5. **Channel session 执行入口**：`POST /channels/:id/sessions/:sid/messages`，把用户消息投给该 session 的 clone 成员（优先基础 lead 的 clone），requireReply；消息/回执带 session_id；Session UI 增加 composer。
6. **Project session 上下文**：
   - Project 创建时为办公室 Channel 建 `instance_kind='project'` session（memberMap: lead→lead）。
   - Project task instance 的 `sessionId` 传入 `submitProjectRoot`，root/子树/消息带 session_id。
   - Project 页展示 project session + task session brief/status。
7. **记忆追踪**：`agent_memories.session_id` 写入（task/peer/compaction）；clone 实例本身已按 agentId 隔离，本 PR 不改 recall 算法。
8. **API/UI**：session brief/history/catalog、session composer、Project session 展示；不改变现有 clone/任务实例生命周期。
9. **测试/验收/证据**：单测 + API 集成 + 浏览器交互 + 真实 mock harness 会话消息；全量回归。

### 2.2 不做（M2/M3）

- 不为共享 agent 默认创建 per-session 进程；现有 clone/task-instance 已提供强隔离路径。
- 不改 Channel 单 activeRoot；Project task instance 已通过独立 Channel 并行，普通 Channel session 仍串行。
- 不实现 harness session resume 持久化（omp/dsh/hermes 无 load/resume；claude 后续单独立项）。
- 不做 `session_turns` 全量投影；M1 的 history 从现有 tasks/messages/chat 按 session_id + channel 查询。
- 不做跨 Channel session 搜索工具；M1 提供 Channel/Project API + UI。

---

## 3. 数据模型

### 3.1 `channel_sessions` 扩展

| 列 | 类型 | 说明 |
|---|---|---|
| `summary` | TEXT NOT NULL DEFAULT '' | 确定性滚动摘要 |
| `brief_json` | TEXT NOT NULL DEFAULT '{}' | SessionBrief 结构化缓存 |
| `last_active_at` | TEXT | 最近 task/message 活动 |
| `generation` | INTEGER NOT NULL DEFAULT 0 | 关闭/重开/恢复纪元 |

`instance_kind` 允许 `manual | task | project`；project session 与 task session 用 `project_id/project_work_item_id` 关联。

### 3.2 事实表

- `tasks.session_id TEXT`
- `messages.session_id TEXT`
- `chat_messages.session_id TEXT`
- `chat_deliveries.session_id TEXT`
- `agent_memories.session_id TEXT NOT NULL DEFAULT ''`
- 索引：`tasks(channel_id, session_id, state)`、`messages(session_id, created_at)`、`chat_messages(session_id, created_at DESC)`、`agent_memories(session_id, agent_id, created_at DESC)`。

### 3.3 兼容

- 旧数据 `session_id=NULL`（memory 为 `''`）视为 legacy；不强制回填。
- 新写入：task instance / manual session message 必须带 session_id；普通 Channel 任务可空。
- `channel_sessions` 旧行 `instance_kind` 默认 `manual`。

---

## 4. Session Context Service

新模块 `server/services/workshop/sessions/`：

```text
types.ts        SessionBrief / SessionCatalogItem / SessionHistoryItem
context.ts      buildBrief / refresh / catalog / history / formatBrief
service.ts      manager 注入的 session 查询与刷新入口
```

### 4.1 Brief 结构

```json
{
  "sessionId": "cs-...",
  "kind": "manual|task|project",
  "title": "...",
  "status": "active|closed",
  "channelId": "...",
  "projectId": "...",
  "workItemId": "...",
  "objective": "...",
  "rootTaskId": "...",
  "currentTask": { "id": "...", "title": "...", "state": "...", "progress": 0 },
  "taskTree": [{ "id": "...", "title": "...", "state": "..." }],
  "deliverables": [{ "name": "...", "status": "...", "artifactId": "...", "bytes": 0 }],
  "recentMessages": [{ "role": "user|agent", "name": "...", "text": "...", "at": "..." }],
  "decisions": [{ "id": "...", "text": "...", "at": "..." }],
  "openQuestions": [{ "text": "...", "owner": "..." }],
  "nextStep": "...",
  "updatedAt": "..."
}
```

`formatBrief` 输出稳定文本（≤ 400 tok 目标）；`summary` 是同一 brief 的单段压缩。

### 4.2 Catalog

`catalog(channelId, limit)`：active/recent session 一行一项：
`id | kind | status | title | current task | deliveries | lastActiveAt`。
Project catalog 用 `listByProject` 并按 work item 聚合。

### 4.3 History

`history(sessionId, limit)` 合并：
- `messages`（session_id 精确）
- `chat_messages`（session_id 精确）
- `tasks`（session_id 精确）的 title/state/artifacts
按时间排序，返回有界 DTO。M1 不写入新 transcript 表。

### 4.4 刷新时机

- session 创建 / 关闭
- task 创建、状态迁移、artifact、result 提交
- session message 写入
- Project work item/result 更新（project session）
- 读取 brief 时若 `last_active_at` 落后可懒刷新

---

## 5. Runtime 与 Prompt

### 5.1 RuntimeSessionContext

```ts
interface RuntimeSessionContext {
  sessionId: string
  brief: string
  summary: string
  updatedAt: string
  turnCount: number
}
```

- `AgentRuntime` 增加 `sessionContexts = new Map<string, RuntimeSessionContext>()`。
- `getSessionContext(sessionId)`：缓存；通过注入的 `sessionContextProvider` 读取/构建。
- clone agent 一 agent 一 session，通常只有 1 项；base lead/共享 agent 可按 session 多实例。

### 5.2 消息到 session

- `A2AMessage.metadata['x-aw-session-id']` 为权威。
- `AgentRuntime.processMessage` 读取：
  1. metadata；
  2. task.sessionId；
  3. 否则 undefined（legacy）。
- `toRequest` 传入 `sessionId` / `sessionContext`。
- `AgentRunRequest` 增加 `session?: { id, brief, summary }`；`AgentRunContext` 同步。
- `AgentRuntime` 在 `noteHarnessUse`/状态里记录 `lastSessionId`（只读观测）。

### 5.3 Prompt

`prompt-builder` 增加 `sessionBlock`，位置在 `ctxPrefix` 之后、manual/memory 之前：

```text
## Session Context (authoritative)
session_id=cs-...
kind=task | title=...
<formatBrief>

## Session Boundary
- This session is the only authoritative context.
- Do not reuse facts/task ids/artifact paths/decisions from other sessions unless they appear in this brief.
- If you need another session, use the session catalog/API; never guess.
```

- task session 的 brief 包含 project/work item/deliverables/handoff 摘要。
- project session brief 包含项目目标、当前 plan、交付物/工作项状态、最近 project messages/decisions。
- 不对 base agent 的 legacy 消息注入空 session 块（避免 prompt 变化）。

---

## 6. 任务/消息 session 贯通

1. `TaskEngine.create/createOrGetRoot` 接受 `sessionId`；子任务 `dispatch` 继承父任务。
2. `TaskRepo` 读写 `session_id`；`tasks` 两次 rebuild 列清单必须包含。
3. `deliverTaskMessage` 从 task 写 `messages.session_id` + `x-aw-session-id`。
4. `submitProjectRoot` 接受 `sessionId`；ProjectService 从 `createTaskInstance` 返回值传入。
5. `createTaskInstanceChannel` 已返回 sessionId；ProjectService 传给 `submitProjectRoot`。
6. `platformReply`/`agentReplyToChat` 从入站消息 metadata 继承 session_id。
7. `sendChatMessage` 增加可选 `sessionId`；Project office chat 自动使用 project session（按 office channel+project 查 active）。
8. `sendSessionMessage`（manual session）：目标为 memberMap 中基础 lead 的 clone（找不到则第一个 clone）；`sendImmediateMessage` + `requireReply` + `x-aw-session-id`。

---

## 7. Project Session

### 7.1 Project session 创建

ProjectService.create 在办公室 Channel/lead 创建后：
- `sessions.create({ channelId: officeChannelId, title: project.name, memberMap: { [leadAgentId]: leadAgentId }, projectId, createdByKind:'project', instanceKind:'project' })`。
- 幂等：同 project 已有 active project session 则复用。
- 记录 `project.session.created` 事件。

### 7.2 Project task session

- `ensureTaskInstanceChannel` 返回 `created.sessionId`；`submitProjectRoot` 传入。
- `project_work_item_attempts.session_id`（新增列）记录 attempt → session。
- Project observability 的 `sessionId/sessionTitle/sessionStatus/sessionKind` 继续使用；增加 `sessionBrief` 预览。
- Project 页在 work item 行显示 session brief/上下文状态；点击打开 console session。

### 7.3 Project Leader prompt

- `projectPromptSection` 增加 `projectSessionBrief`（若存在），让 Leader 知道本项目的 session 索引与当前状态。
- 不注入成员 Channel 的原始 transcript。

---

## 8. API / UI

### 8.1 API

```text
GET  /api/workshop/channels/:id/sessions                 # 列表 + brief preview + kind/status/lastActive
GET  /api/workshop/channels/:id/sessions/:sid            # detail + brief
GET  /api/workshop/channels/:id/sessions/:sid/history    # 有界 history
POST /api/workshop/channels/:id/sessions/:sid/messages   # manual session 发送消息
GET  /api/workshop/channels/:id/sessions/catalog         # lead/owner 用的目录
GET  /api/workshop/projects/:id/sessions                 # project/task sessions + brief
```

### 8.2 UI

- `SessionManageView`：
  - 列表显示 kind/status/brief preview/last active；
  - 详情显示 brief、task/deliverable、history；
  - manual session 增加 composer（发送到 session clone，requireReply）；
  - task/project session 显示“由项目派发/只读控制”标识。
- Project 页：
  - 现有 task session 行增加 brief/context 预览；
  - 新增 project session 卡（Project Leader 上下文/最近活动）；
  - 保留 `?view=sessions&channel=<instanceChannelId>` 跳转。
- Channel 页：Session list 显示 active 数量；不新增独立 tab（复用现有 sessions 视图）。

---

## 9. 迁移

1. `SCHEMA_SQL` 新表/新列直接建。
2. `open.ts` 在 tasks rebuild 之前执行 `migrateSessionContextColumns`：
   - `channel_sessions` 四列；
   - `tasks/messages/chat_messages/chat_deliveries/agent_memories` session_id；
   - `project_work_item_attempts.session_id`（如启用）。
3. `migrations.ts` 两处 tasks rebuild 的列清单加 `session_id`。
4. 索引在 rebuild 后创建。
5. 旧数据不回填；`channel_sessions` 旧行 `summary=''`、`brief_json='{}'`。
6. Feature flag `workshop.session_context_enabled`（默认 true 可关）：关闭时只写 session_id，不注入 prompt/不刷新 brief。

---

## 10. 测试与验收

### 10.1 单测

- `tests/session-context.test.ts`：brief 结构、catalog、history、无 session 回退。
- `tests/session-task-link.test.ts`：root/child session 继承、deliverTaskMessage 写 session、platformReply 继承。
- `tests/channel-session-message.test.ts`：manual session 发送到 clone lead、session_id 落库、requireReply metadata。
- `tests/project-session-context.test.ts`：project session 创建、task instance session 传给 root、attempt 记录。
- 现有 `project-task-instance.test.ts`、`project-channel-sessions.test.ts` 回归。

### 10.2 集成/浏览器

- 启动隔离 AW_HOME + mock harness：
  1. Channel 创建 manual session → 发送“你好” → clone 回复落库，UI 显示 session 消息与 brief。
  2. Project 创建 → plan/派发 work item → task instance session 生成 → root task `session_id` 一致 → Project 页显示 session brief。
  3. 关闭 session → 在飞任务取消、session closed、历史仍可读。
  4. 刷新/重启后 session/brief/history 可恢复（不是 harness 恢复，而是平台上下文恢复）。
  5. 不同 session 的消息/任务不串（按 session_id/instance channel 断言）。
- 截图：Channel sessions、session 详情/composer、Project session 卡、task session 行。

### 10.3 门禁

- eslint / typecheck / i18n / 全量 unit / build / 浏览器验收。
- 不降低现有测试数量；新增测试计入。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| tasks rebuild 丢 session_id | 两处列清单显式加入；迁移测试覆盖老库升级 |
| agent_memories 不能重建 | 只 `ALTER ADD COLUMN`，不加唯一约束；vec rowid 不变 |
| clone session 无 lead | manual session 只做对话；任务派发走 project task instance（有 lead） |
| Project task session 与 project session 混淆 | `instance_kind` 区分；project page 分组展示 |
| session 消息绕过群聊权限 | `sendSessionMessage` 复用 channel 可写校验 + memberMap 校验；不新增跨 Channel 路由 |
| prompt 体积增长 | brief 有界（≤400 tok）+ history 只取最近 8 条；session block 只对 session 消息注入 |
| 旧数据无 session | legacy 路径不注入 session block；session_id 可空 |
| 并发刷新 brief | 幂等 upsert；同 session 单飞锁（进程内） |

---

## 12. 实施顺序（本 PR 提交粒度）

1. `docs(plan)`：本文件。
2. `feat(db)`：schema/migrations/repos + 单测。
3. `feat(session-context)`：context service + API + 单测。
4. `feat(runtime)`：RuntimeSessionContext + prompt + task/message 贯通 + 单测。
5. `feat(channel)`：manual session message + UI composer。
6. `feat(project)`：project session + task instance session + UI。
7. `test(acceptance)`：集成/浏览器 + 证据。
8. `docs`：验收报告；PR 合并。

---

## 13. 完成定义（DoD）

- Channel manual session 可创建、可发消息、clone 回复、历史可查、brief 可见。
- Project 每个 work item 有独立 task session，root/子任务/消息 `session_id` 一致，Project 页可见 brief。
- Project 有 project session；Project Leader prompt 含项目 session brief。
- 不同 session 的任务/消息按 session_id/实例 Channel 隔离；legacy 行为不变。
- 全量单测/typecheck/lint/i18n/build 通过；浏览器验收通过；证据入库。
- PR 通过 CI，合并 main。
