# Session Context（A 方案 M1）实施与验收报告

> 日期：2026-11-07
> 基线：`origin/main` `f4358085`
> 分支：`feat/session-context-20261107`
> 结论：**Channel manual session 可对话可回执；Project project/task session 上下文贯通；API 20/20、UI 7/7、全量门禁通过。**
> 说明：M1 不包含 per-session harness resume / memory session 过滤 / manual session 并行 root（见 §6）。

## 1. 交付内容

### 1.1 数据模型

- `channel_sessions` 增加 `summary`、`brief_json`、`last_active_at`、`generation`；`instance_kind` 扩展 `manual|task|project`。
- `tasks`、`messages`、`agent_memories`、`project_work_item_attempts` 增加 `session_id`。
- 迁移：`server/services/workshop/db/database/migrations-session.ts`，在 tasks legacy rebuild 之前补列；两处 tasks rebuild 的列清单与 SELECT 已同步带 `session_id`。
- 索引在 rebuild 后创建（`ensureSessionIndexes`）。

### 1.2 Session Context Service

- `server/services/workshop/sessions/context.ts`
  - 确定性 brief：session 元数据、project/work item、任务树、交付物、最近消息、决策、未决、下一步。
  - project session 用 Project 的工作项/交付物作为上下文（不是办公室 Channel 的 tasks）。
  - `catalog`、`projectCatalog`、`history`（messages + tasks，有界）。
  - 5 秒缓存；刷新回写 summary/brief_json/last_active_at。

### 1.3 Runtime 与 Prompt

- `AgentRuntime` 内 `Map<sessionId, RuntimeSessionContext>`；按消息 metadata / task.sessionId 取 session。
- `AgentRunRequest/AgentRunContext` 增加 session；`BaseAgent.contextPrefix` 统一注入 `## Session Context` + boundary。
- `mock-agent` 支持人类 session 消息（from-label 无 fromAgentId）走 chatScript 回执。
- `platformReply`、`sendImmediateMessage`、`deliverTaskMessage`、`Mailbox.enqueue` 贯通 session_id / `x-aw-session-id`。

### 1.4 Channel / Project

- `POST /channels/:id/sessions/:sid/messages`：投给 session clone（优先基础 lead 的 clone），requireReply，回执落同一 session。
- Session UI：brief 卡 + history + composer（manual session）；task/project session 只读。
- Project：
  - 创建项目时生成 `instance_kind='project'` session（办公室 Channel + Project Leader）。
  - 任务实例 Channel 的 sessionId 传入 `submitProjectRoot`，root/子树/assign 消息继承。
  - `project_work_item_attempts.session_id` 记录 attempt → session。
  - Project 页新增“项目会话”卡；Project Leader prompt 增加 session 目录。
- 窄屏：Session 视图列表/详情纵向堆叠；sessions 视图隐藏全局任务 composer，避免遮挡。

## 2. 实测

### 2.1 API 验收（`acceptance.json`）

`scripts/session-context-acceptance.mjs`：**20/20 PASS，0 fail**。

覆盖：
- 注册 owner；创建 Channel + mock lead/worker。
- 创建 manual session → 发送消息 → clone 回执 metadata.session_id 正确 → brief/history 可读。
- 创建 Project → 绑定 Channel → 交付物 → 工作项 → 激活 → plan 审批 → 派发。
- Project sessions 目录含 project + task；task session brief kind=task 且关联工作项。

### 2.2 UI 验收（`ui-acceptance.json`）

`scripts/session-context-ui-acceptance.mjs`：**7/7 PASS，0 fail**。

覆盖：
- Channel sessions 视图渲染、brief 卡、composer 发送、clone 回执。
- 移动端 390×844 无横向溢出；session composer/send 在视口内。
- Project 页“项目会话”卡渲染 project/task session。

截图：
- `channel-session-desktop.png`
- `channel-session-mobile.png`
- `project-sessions-desktop.png`

### 2.3 门禁

- `typecheck` ✅
- `eslint`（全部改动文件）✅
- `i18n:check` **3291/3291 PARITY OK**
- unit **1171 tests / 1169 pass / 0 fail / 2 skipped**（一次并行 http-drivers flake，重跑通过）
- `build` ✅

## 3. 关键行为

### 3.1 Channel manual session

- 创建时 clone 基础成员；clone 统一 worker（与既有设计一致），因此 session 消息是 peer 对话，不是自动任务派发。
- UI composer 调 `sendSessionMessage`；消息/回执都带 session_id。
- brief 显示当前任务/交付物/未决/下一步；history 合并 messages + tasks。

### 3.2 Project task session

- 每个 work item 派发创建任务实例 Channel（既有能力）+ `instance_kind='task'` session。
- root task 与所有子任务继承 session_id；assign 消息 metadata 带 `x-aw-session-id`。
- 任务实例 Channel 自带独立 SchedulerLoop/成员 runtime/workspace，因此 project task 的 session 执行是真隔离通道。
- Project session（办公室）使用项目工作项/交付物作为 brief，不读取成员 Channel 原始 transcript。

## 4. 迁移兼容

- 新库由 `SCHEMA_SQL` 直建新列。
- 旧库启动：`migrateSessionContextColumns` 在 tasks rebuild 前补列；两处 rebuild 已带 session_id；索引 rebuild 后创建。
- 旧数据 `session_id=NULL`：legacy 消息不注入 session block；task session 可按实例 Channel 回退读取（已测）。
- `agent_memories.session_id` 列已预留，但 M1 不改变 recall 过滤（clone 实例本身按 agentId 隔离）。

## 5. 证据

- `docs/audit/evidence/2026-11-07-session-context/acceptance.json`
- `docs/audit/evidence/2026-11-07-session-context/ui-acceptance.json`
- `channel-session-desktop.png` / `channel-session-mobile.png` / `project-sessions-desktop.png`
- `server.log` / `ui-server.log`
- 计划：`docs/plans/2026-11-07-session-context-platform-plan.md`

## 6. 未完成 / 后续（M2/M3）

1. **per-session harness resume**：omp/dsh/hermes 无 load/resume；claude 可试点持久化 sessionId + `options.resume`。
2. **memory session 过滤**：列已预留；M2 做 session/private/shared/project 排序与晋升门禁。
3. **manual session 并行 root**：当前 manual session 是对话；任务并行仍依赖 project task instance Channel；如要 manual session 跑任务，需 session 级 activeRoot/发号开关。
4. **session_turns/summaries 全量投影**：M1 从现有 messages/tasks 有界查询；M2 可物化 turns 以支持长期 transcript/压缩。
5. **跨 session 搜索工具**：API/UI 目录已有；Agent 工具面 `list_sessions/search_sessions` 留待 M2。
