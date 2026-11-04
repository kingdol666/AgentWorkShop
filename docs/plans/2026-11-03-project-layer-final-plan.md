# Project 层最终执行计划（v3.0，可下发版）

日期：2026-11-03。状态：**待用户批准后实施**。
输入：`2026-11-03-project-layer-design-draft.md`（Draft）+ `2026-11-03-project-layer-plan.md`（v2.0 设计参考）+ 五席评审 + 五路 v2.0 审计（架构/安全/测试审计/产品运维/反方）+ Deep Research 一手资料。
本文件是**唯一执行账本**；v2.0 保留为设计参考，冲突以本文件为准。

---

## 0. 结论与范围

### 0.1 一句话

**V1 用"项目办公室频道 + project_leader AgentRuntime + 确定性 ProjectService + 交付物/工作项/成果台账"实现你要的 Project 总工；不引入第二个调度器、不隐藏频道、不让 LLM 直接改库。V1 薄版 10–12 周可验收，完整版 13–16 周；V1.1 再加 Mandate/双账本/看门狗；V2 才做自主 replan 与 leader 自建频道。**

### 0.2 为什么从 v2.0 收敛

五路审计一致认为 v2.0 有 4 类问题：

| 问题 | 证据 | v3.0 决策 |
|---|---|---|
| 隐藏控制频道泄漏面大 | `getChannelForUser`/list/A2A/schedules/templates/WS 等 14 处需过滤；`channels.kind` 未进 COLS 会 fail-open | **改为普通"项目办公室"频道**：`agent_kind='project_leader'`，`projects.office_channel_id`；不引入 `channels.kind`，不做隐藏谓词 |
| 第二个调度器双写/双监督 | `SchedulerLoop` ~1,100 行；`ensureChannelActive`/`revive`/`stop` 无 kind 分支 | **V1 不建 ProjectSchedulerLoop**：确定性 `ProjectService` + `ProjectReconciler` 定时器 + mailbox 唤醒；V2 再评估 |
| Mandate/双账本/Watchdog/effects 过重 | 14 张表、~40 端点；单工程师 14–18 周 | **V1 只保留 9 张表**；Mandate/Progress Ledger/Watchdog/effects 放 V1.1；V2 做自主环 |
| 审计框架不可执行 | 191 个验收项 vs 106–138 用例；MAST L1–L14 多为复述；SQL 断言只查约束 | **V1 用 6 个 gate + E0–E4 + 每项命令/工件/签署**；MAST 重写为 Given/When/Then；SQL 改为行为断言 |

**v3.0 最后一轮门禁复核已修**：派发改为 plan 级批准（不再逐条审批）；迁移列在 rebuild 前添加并写入 rebuild；审计 SQL 只统计 root（`parent_id IS NULL`）；write-intent 增加 Channel Lead 请求工具、`payload_json`、一次性消费；`project_decisions`/`project_events` 为 fail-closed 权威记录，`audit_log` 仅镜像；办公室频道删除/禁用/换 lead 409；工时修正为薄版 10–12 周、完整版 13–16 周。

### 0.3 V1 交付什么 / 不交付什么

| V1 交付 | V1 不交付（V1.1/V2） |
|---|---|
| Project 实体、项目办公室频道、project_leader | 自主 replan / ProjectSchedulerLoop |
| 交付物台账、项目工作项、派发到 Channel root task | leader 自建/删除 Channel |
| 版本化成果、自动 draft、提交、leader 复核、owner 验收 | Mandate 不可变授权（V1 用 plan_version + approval + args_digest） |
| 项目内 pull 共享成果 | push 订阅 |
| 项目审批、HITL 分离、审计/决策/事件 | 多用户项目成员（V1.1 可选 viewer/approver） |
| 只读/基本操作项目页、计划编辑/diff/评论、周报 | 双账本、Watchdog、effects/outbox 独立表 |
| MAST 14 类失败模式的可复现测试 | program-of-projects / 层级 supervisor |

### 0.4 成功/失败标准

**V1 成功**：在一个真实项目（1 个 Project + 3 个 Channel + 5 个交付物）上，owner 能完成"创建→绑定→leader 提案→owner 批准→派发→Channel 执行→成果提交→leader 复核→owner 验收→项目完成"，全程无手工改库；所有破坏性动作有审批/审计；无安全违规。

**V1 失败（任一即不可发布）**：
- 任何越权写/自批/用户绑定 Channel 被 leader 删除；
- 重复派发/重复 approved/同 source key 双 root；
- 项目完成没有 owner 签署；
- 审计链缺 trace/decision/approval；
- 现有 1017 基线单测出现 fail。

---

## 1. 需求追溯

| 用户意图 | V1 落地 | 验收 |
|---|---|---|
| Project 管理多个 Channel | `projects` + `project_channels`；用户绑定/项目创建双轨（V1 只用户绑定 + owner 代建） | C1–C6 |
| 每个 Project 一个 leader（总工） | 项目办公室频道 lead，`agent_kind='project_leader'` | C7–C10 |
| Project 是服务业务，复用 AgentRuntime/harness/元数据 | 普通 Channel + `channel_agents` + `config_json` + project prompts | H1–H6 |
| 与其他 Channel 区分 | `agent_kind` + 能力矩阵 + 执行层 denylist | C4–C6 |
| 按目标拆给 Channel | `project_deliverables` + `project_work_items` + 项目级依赖 | E1–E6 |
| 下发 Task / mailbox | `submitProjectRoot` + lead→lead 消息 | F1–F6 |
| Channel 执行完把成果放共享层 | 自动 draft + `project_submit_result` + 版本化 | G1–G12 |
| Project leader 与其他 Channel 查看成果 | `project_read_results` pull；项目内可见、项目外 403 | G9–G12 |
| Channel 之间共享进度 | 成果 pull + 依赖引用；V1 不做 push | G9/G10 |
| Project 对整体进度负责 | 交付物完成率 + 执行进度 + 逾期/阻塞 + 周报 | E7–E9 |
| Channel leader 对模块负责 | Channel 内任务树/重试/租约/HITL 不变 | J2 |
| 用户绑定 Channel 不可删 | `user_bound` 硬 403 | C11–C13 |
| Project 自建 Channel 可管理 | **V2**；V1 只允许 owner 代建并绑定 | 明确非目标 |
| 可审计/可回滚 | `project_decisions`/`project_events`/trace + 回滚演练 | M1–M10 |

---

## 2. V1 架构

```
Owner ──REST/UI──> ProjectService (唯一项目状态写者)
                     │
                     ├── projects / project_channels / deliverables
                     ├── project_work_items / attempts / results
                     ├── project_decisions / events / approvals
                     ├── ProjectReconciler (30s 定时 + task change 唤醒)
                     └── mailbox wake ──> 项目办公室频道
                                              │
                                      project_leader (AgentRuntime)
                                      role=lead, agent_kind=project_leader
                                      工具：只读 + 提案 + 复核 + 申请审批
                                              │
                                      propose/plan/dispatch/review
                                              │
                               Owner 批准 ──> ProjectService 执行
                                              │
                        成员 Channel A/B/C  root task（source='project'）
                                              │
                              Channel SchedulerLoop（不变）
                                              │
                          root 终态 ──> 自动 draft ──> leader 复核提案
                                              │
                                   owner 验收 ──> 成果 Map / 项目完成
```

### 2.1 项目办公室频道（替代隐藏控制频道）

- 普通 `channels` 行，`visibility='private'`，`owner_user_id=project owner`，`chat_enabled=1`。
- `channel_agents` 一行：`role='lead'`, `agent_kind='project_leader'`。
- `projects.office_channel_id` 指向它；`projects.lead_agent_id` 指向该实例。
- **不引入 `channels.kind`**；不隐藏频道；项目页显示"项目办公室"并链接到它。
- `ensureChannelActive`/`reviveScheduler`/`wireMember`/`attachScheduler`：如果 lead 的 `agent_kind='project_leader'`，只装配 AgentRuntime，不挂 `SchedulerLoop`；`attachScheduler` 对此类频道直接拒绝；这是**唯一**的特殊分支。
- 办公室频道不加入 `project_channels`，不承载项目 root task；`submitChannelTask`/`dispatchTask` 对办公室频道返回 409 `PROJECT_OFFICE_NO_TASKS`；项目消息只走 mailbox/chat。
- `unloadAgent`：project leader 在项目 active 期间不因 idle 卸载（显式豁免）。
- 生命周期保护：active 项目的办公室频道 `DELETE`/`PATCH enabled=0`/替换 lead → 409；必须先 pause/archive 项目。`removeAgentFromChannel` 同步清理 `projects.lead_agent_id` 或拒绝。

**为什么这样更安全**：隐藏控制频道需要在 list/detail/A2A/schedule/mount/template/WS/HITL 等 14 处过滤，任何一处漏掉就是泄漏；普通办公室频道沿用现有权限，只有"不挂 channel scheduler"一个分支。

### 2.2 project_leader 运行模型（V1 无第二调度器）

- leader 的 `AgentRuntime` 由正常 mailbox 驱动：收到消息 → `run` 回合 → 读项目快照 → 调提案工具。
- **没有 `ProjectSchedulerLoop`**；没有 LLM 周期 tick。
- 唤醒来源：
  1. `ProjectReconciler` 检测到需要 leader 判断（root 终态、blocked、result submitted、逾期）→ 向办公室频道 lead 投递一条 `x-aw-project-event` 消息（`fromLabel='project-service'`，服务端生成，不接受模型伪造）。
  2. Owner 在项目页/聊天中的指令 → 同样投递。
  3. 每日 09:00 项目摘要（`scheduled_tasks` 或 Reconciler）。
- leader 的工具只写 `project_decisions(state='proposed')`；**计划经 owner 批准后，ProjectService 按批准的 `plan_version` 派发工作项，逐条派发不再单独审批**；破坏性动作（成果验收、项目完成、write_intent、归档/解绑）仍需审批。leader 不能直接改项目状态/派发/验收。
- 这样保留"总工"的推理/提案能力，但把执行权和节奏放在确定性服务里。

### 2.3 ProjectService / Reconciler

- `ProjectService`：项目状态唯一写者；所有 REST/UI/tool proposal 都经过它。
- `ProjectReconciler`：单进程定时器（30s）+ `TaskEngine.onTaskChange` 立即触发；只做确定性对账：
  - root 终态 → work item 状态同步；
  - `DISPATCHING` 超时/root 缺失 → BLOCKED；
  - Channel disabled/lead missing → BLOCKED；
  - deadline/overdue → BLOCKED/OVERDUE；
  - result draft/submitted 超时 → 提醒；
  - 审批过期；
  - 需要 leader 判断 → 投递 mailbox。
- 不做 LLM 决策；不做自动 replan；不做自动验收。

---

## 3. 数据模型（V1，9 张表）

### 3.1 表清单

1. `projects`
2. `project_channels`
3. `project_deliverables`
4. `project_work_items`
5. `project_work_item_attempts`
6. `project_results`
7. `project_decisions`
8. `project_events`
9. `project_approvals`

**复用现有表**：`outbox_events`（通知/投递）、`scheduled_tasks`（每日摘要）、`audit_log`（审计）、`channel_events`（办公室频道聊天/事件）、`metrics`。

**V1.1 增加**：`project_plan_versions`（独立计划版本/diff；V1 用 `project_decisions.args_json` 快照）、`project_progress_ledger`、`project_health`、`project_usage`、`project_effects`、`mandate_json`。
**V2 增加**：`project_subscriptions`、`project_members`、`parent_project_id`。

### 3.2 DDL（V1）

```sql
CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  objective           TEXT NOT NULL,
  success_criteria_json TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'draft', -- draft|active|paused|completed|archived
  mode                TEXT NOT NULL DEFAULT 'supervised', -- observe|supervised|auto（V1 只 supervised/observe）
  owner_user_id       TEXT NOT NULL,
  office_channel_id   TEXT REFERENCES channels(id),
  lead_agent_id       TEXT,
  plan_version        INTEGER NOT NULL DEFAULT 0,
  plan_json           TEXT NOT NULL DEFAULT '{}',
  plan_approval_required INTEGER NOT NULL DEFAULT 1,
  config_json         TEXT NOT NULL DEFAULT '{}',
  deadline_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_channels (
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  binding_type      TEXT NOT NULL DEFAULT 'user_bound', -- V1 只 user_bound
  charter           TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active',     -- active|detached|archived
  added_by          TEXT NOT NULL,
  added_at          INTEGER NOT NULL,
  detached_at       INTEGER,
  PRIMARY KEY (project_id, channel_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_channels_active
  ON project_channels(channel_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS project_deliverables (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  owner_channel_id        TEXT,
  required                INTEGER NOT NULL DEFAULT 1,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  due_at                  INTEGER,
  depends_on_json         TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'planned',
                          -- planned|active|submitted|approved|rejected|waived
  waiver_reason           TEXT,
  created_by              TEXT NOT NULL DEFAULT 'project_leader',
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_work_items (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deliverable_id      TEXT NOT NULL REFERENCES project_deliverables(id),
  channel_id          TEXT NOT NULL,
  title               TEXT NOT NULL,
  brief               TEXT NOT NULL DEFAULT '',
  state               TEXT NOT NULL DEFAULT 'DRAFT',
                      -- DRAFT|DISPATCHING|DISPATCHED|RUNNING|BLOCKED|REWORK|
                      -- COMPLETED|FAILED|CANCELED|SUPERSEDED
  state_reason        TEXT,
  priority            INTEGER NOT NULL DEFAULT 0,
  weight              REAL NOT NULL DEFAULT 1,
  depends_on_json     TEXT NOT NULL DEFAULT '[]',
  acceptance_json     TEXT NOT NULL DEFAULT '[]',
  result_key          TEXT NOT NULL DEFAULT 'main',
  current_attempt_id  TEXT,
  plan_version        INTEGER NOT NULL DEFAULT 0,
  contract_json       TEXT NOT NULL DEFAULT '{}',
  exec_budget_minutes INTEGER NOT NULL DEFAULT 60,
  trace_id            TEXT NOT NULL DEFAULT '',
  dedupe_key          TEXT NOT NULL,
  deadline_at         INTEGER,
  rework_count        INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT NOT NULL DEFAULT 'project_leader',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  closed_at           INTEGER,
  close_reason        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_work_dedupe
  ON project_work_items(project_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_project_work_channel
  ON project_work_items(project_id, channel_id, state);

CREATE TABLE IF NOT EXISTS project_work_item_attempts (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  work_item_id      TEXT NOT NULL REFERENCES project_work_items(id) ON DELETE CASCADE,
  attempt_no        INTEGER NOT NULL,
  channel_id        TEXT NOT NULL,
  channel_task_id   TEXT,
  source_key        TEXT NOT NULL,           -- pw:<workItemId>:<attemptNo>
  state             TEXT NOT NULL DEFAULT 'DISPATCHING',
                    -- DISPATCHING|DISPATCHED|RUNNING|BLOCKED|CLOSED
  blocked_reason    TEXT,
  approval_id       TEXT,                    -- write_intent / channel 审批
  args_digest       TEXT NOT NULL DEFAULT '',
  trace_id          TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  closed_at         INTEGER,
  UNIQUE(work_item_id, attempt_no),
  UNIQUE(source_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_attempt_live
  ON project_work_item_attempts(work_item_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_attempt_task
  ON project_work_item_attempts(channel_task_id) WHERE channel_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_results (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deliverable_id    TEXT NOT NULL REFERENCES project_deliverables(id),
  channel_id        TEXT NOT NULL,
  line_id           TEXT NOT NULL DEFAULT '',   -- 结果快照；人类读取按 line grant
  work_item_id      TEXT NOT NULL,
  attempt_no        INTEGER NOT NULL,
  result_key        TEXT NOT NULL DEFAULT 'main',
  version           INTEGER NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  method            TEXT NOT NULL DEFAULT '',
  data_window_json  TEXT NOT NULL DEFAULT '{}',
  sample_count      INTEGER,
  confidence        REAL,
  validity_scope    TEXT NOT NULL DEFAULT '',
  payload_json      TEXT NOT NULL DEFAULT '{}',
  evidence_json     TEXT NOT NULL DEFAULT '[]',
  change_summary    TEXT NOT NULL DEFAULT '',
  open_questions    TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'draft',
                    -- draft|submitted|reviewed|approved|rejected|superseded
  source_task_id    TEXT NOT NULL,
  supersedes_id     TEXT,
  author_agent_id   TEXT,
  author_user_id    TEXT,
  reviewed_by       TEXT,
  reviewed_at       INTEGER,
  approved_by       TEXT,
  approved_at       INTEGER,
  reject_reason     TEXT,
  trace_id          TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  UNIQUE(project_id, deliverable_id, channel_id, result_key, version),
  UNIQUE(work_item_id, attempt_no, result_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_result_approved
  ON project_results(project_id, deliverable_id, result_key)
  WHERE status='approved';

CREATE TABLE IF NOT EXISTS project_decisions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  source            TEXT NOT NULL,            -- leader|owner|service|reconciler
  decision_type     TEXT NOT NULL,
  actor_agent_id    TEXT,
  actor_user_id     TEXT,
  args_json         TEXT NOT NULL DEFAULT '{}',
  args_sha256       TEXT NOT NULL,
  snapshot_sha256   TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL DEFAULT 'proposed',
                    -- proposed|validated|executing|applied|failed|rejected|observed
  outcome           TEXT NOT NULL DEFAULT '',
  reason            TEXT NOT NULL DEFAULT '',
  approval_id       TEXT,
  trace_id          TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  UNIQUE(project_id, seq)
);

CREATE TABLE IF NOT EXISTS project_events (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  event_key     TEXT NOT NULL,
  channel_id    TEXT,
  work_item_id  TEXT,
  deliverable_id TEXT,
  agent_id      TEXT,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  trace_id      TEXT NOT NULL DEFAULT '',
  consumed_at   INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE(project_id, seq),
  UNIQUE(project_id, event_key)
);

CREATE TABLE IF NOT EXISTS project_approvals (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
                    -- plan_approval|deliverable_acceptance|project_complete|
                    -- write_intent|channel_binding
  subject_type      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  subject_version   INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending',
                    -- pending|approved|rejected|expired|canceled|consumed
  requested_by_agent_id TEXT,
  requested_by_user_id  TEXT,
  payload_json      TEXT NOT NULL DEFAULT '{}',   -- write_intent：tool/args/attempt/digest
  args_digest       TEXT NOT NULL DEFAULT '',
  reason            TEXT NOT NULL DEFAULT '',
  decision_reason   TEXT NOT NULL DEFAULT '',
  decided_by_user_id TEXT,
  consumed_at       INTEGER,
  trace_id          TEXT NOT NULL DEFAULT '',
  expires_at        INTEGER,
  created_at        INTEGER NOT NULL,
  decided_at        INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_approval_pending
  ON project_approvals(project_id, kind, subject_id) WHERE status='pending';
```

### 3.3 既有表增量

| 表 | 列 | 用途 |
|---|---|---|
| `channel_agents` | `agent_kind TEXT NOT NULL DEFAULT 'channel_agent'` | `channel_agent|project_leader`；project_leader 只能出现在办公室频道 |
| `tasks` | `source TEXT NOT NULL DEFAULT 'channel'` | `channel|project|chat|schedule` |
| `tasks` | `project_id TEXT` / `project_work_item_id TEXT` / `project_attempt_no INTEGER` | 项目派发溯源；**必须传播到所有子任务** |
| `tasks` | `trace_id TEXT NOT NULL DEFAULT ''` | 链路追踪 |
| `audit_log` | `project_id TEXT` / `trace_id TEXT`（或 detail 索引） | 项目审计 |
| `outbox_events` | 不改 | 项目通知复用 |

**迁移顺序（必须按此实现）**：
1. 新表/新表索引加入 `schema.ts` `SCHEMA_SQL`（`CREATE IF NOT EXISTS`）；不要在这里给旧表的新列建索引。
2. 在 `open.ts` 的**重建之前**执行 `migrateProjectColumns`（幂等 `migrateAddColumn`），先给 `tasks` 加 `source/project_id/project_work_item_id/project_attempt_no/trace_id`，给 `channel_agents` 加 `agent_kind`，给 `audit_log` 加 `project_id/trace_id`。
3. `migrations.ts` 的 `tasks` rebuild DDL/INSERT SELECT（`:173-202`、`:388-416`）包含上述新列；`channels` rebuild（`:273-293`）至少保留现有列（V1 不新增 `channels` 列）。
4. 重建完成后创建新列索引（`project_id`、`(project_id,work_item_id)`、`trace_id` 等）；不要把旧表新列索引放 `SCHEMA_SQL`。
5. 更新 `task.repo.ts` 的 `COLS`/`META_COLS`/`TaskCreateInput`/`TaskPatch`/`buildRow`/`insert`/`update`，`rows.ts`，`types/task.ts`，`helpers.ts`。
6. fixture 覆盖：新库、旧库缺 tasks FK、v7/v8 owner-FK 库、双次 init、`superseded_by_task_id` 与项目列保留。

> 如果某个 legacy rebuild 无法安全复制新列，则在 `INSERT SELECT` 中用字面默认值（`'channel'`、`NULL`、`''`、`0`），不要引用不存在的列。

---

## 4. 角色、工具、提示词

### 4.1 角色

| 角色 | 标识 | 载体 | 能力 |
|---|---|---|---|
| Project Owner | `owner_user_id` | 人 | 建项目/绑 Channel/批计划/验收/完成/暂停/接管 |
| Project Leader | `role='lead'`, `agent_kind='project_leader'` | 项目办公室频道 lead | 读项目、提案、复核、申请审批；**不执行 Channel 任务、不写工业参数、不直接改库** |
| Channel Lead | `role='lead'`, `agent_kind='channel_agent'` | 成员频道 | Channel 内任务、执行、提交成果 |
| Worker | `role='worker'` | 成员频道 | 执行任务、只读成果 |

### 4.2 工具矩阵

| 工具 | worker | channel lead | project leader |
|---|---|---|---|
| `project_read_deliverables` | ❌ | ✅ | ✅ |
| `project_read_results` | ✅（approved） | ✅（approved/submitted） | ✅（含 draft） |
| `project_read_work_items` | ❌ | ✅（本频道） | ✅ |
| `project_submit_result` | ❌ | ✅（本频道/本交付物） | ❌ |
| `project_request_write_intent` | ❌ | ✅（本频道/本 attempt） | ❌ |
| `project_get_status` | ❌ | ❌ | ✅ |
| `project_list_channels` | ❌ | ❌ | ✅ |
| `project_propose_plan` | ❌ | ❌ | ✅（写 proposal） |
| `project_propose_dispatch` | ❌ | ❌ | ✅（写 proposal） |
| `project_propose_replan` | ❌ | ❌ | ✅（写 proposal） |
| `project_review_result` | ❌ | ❌ | ✅（写 review proposal） |
| `project_request_approval` | ❌ | ❌ | ✅（写 approval proposal） |
| 现有 Channel lead 工具 | ❌ | ✅ | ❌ |
| 工业写工具 | 受治理 | 受治理 | ❌ |

**执行层硬门（不能只靠注入过滤）**：
- `dispatchHostToolInner` 与 `invokeHostTool` 都按 `agent_kind/channel` 判定：project_leader 调 `dispatch_task`/`create_team_agent`/`team_grant_nodes`/工业写/插件管理 → 403。
- Channel lead 调项目治理工具 → 403。
- 所有拒绝写 `project_decisions(state='rejected')` + audit。

### 4.3 提示词

| 模板 | 用途 |
|---|---|
| `project-leader.md` | 身份、职责、非目标、决策原则、约束 |
| `project-plan.md` | 计划 schema：交付物/工作项/依赖/验收标准；禁止空泛 |
| `project-review.md` | 成果复核标准：证据、数据窗口、置信度、有效范围 |
| `project-brief.md` | handoff 契约：brief/验收/result schema/deadline/return channel |
| `project-member.md` | 成员频道项目上下文 + 成果提交要求 |

关键约束：不执行 Channel 工作；不写工业参数；不虚构成果；无证据不确认；用户绑定 Channel 不可删；失败要升级；默认摘要 + 引用 ID，不要求全量历史。

---

## 5. 工作项、派发、状态机

### 5.1 状态机

状态：`DRAFT`、`DISPATCHING`、`DISPATCHED`、`RUNNING`、`BLOCKED`、`REWORK`、`COMPLETED`、`FAILED`、`CANCELED`、`SUPERSEDED`。
终态：`COMPLETED`、`FAILED`、`CANCELED`、`SUPERSEDED`。

| 从 | 到 | 触发 |
|---|---|---|
| DRAFT | DISPATCHING | owner 批准派发 proposal；事务内建 attempt |
| DISPATCHING | DISPATCHED | root 创建/按 source key 复用成功 |
| DISPATCHING | DRAFT | root 创建失败且零副作用 |
| DISPATCHING | BLOCKED | 永久前置失败（channel/owner/harness） |
| DISPATCHED | RUNNING | root ASSIGNED/WORKING/WAITING |
| DISPATCHED/RUNNING | COMPLETED | root COMPLETED |
| DISPATCHED/RUNNING | BLOCKED | channel disabled/lead missing/overdue/HITL 超时 |
| DISPATCHED/RUNNING | FAILED | root FAILED 且不可重试/预算耗尽 |
| DISPATCHED/RUNNING | CANCELED | owner 取消，root 已 CANCELED |
| BLOCKED | RUNNING/DISPATCHED/COMPLETED/FAILED/CANCELED | block 解除或 root 终态 |
| BLOCKED | DISPATCHING | 新 attempt；旧 attempt 必须 closed |
| FAILED | DISPATCHING | 重试策略满足；新 attempt |
| FAILED | CANCELED/SUPERSEDED | 放弃/替代 |
| COMPLETED | REWORK | 成果被拒；旧结果 superseded |
| REWORK | DISPATCHING/BLOCKED/CANCELED/SUPERSEDED | 返工/放弃 |
| COMPLETED | SUPERSEDED | 被替代 |
| 任意非终态 | CANCELED/SUPERSEDED | owner/服务显式 |

**投影规则**：`reconcileWorkItem` 只对 `current_attempt_id` 的 root 推导；旧 attempt/root 不覆盖；`REWORK` 在无 live attempt 且最新结果 rejected 时保持；终态 sticky；每次迁移事务内关闭 attempt/清 current_attempt_id。

### 5.2 `submitProjectRoot`

```
输入: projectId, workItemId, channelId, title, brief, execBudgetMinutes?
1. 授权: project active; channel active in project; owner 一致; channel enabled; lead exists;
   deliverable 属于项目; work item plan_version = 当前 approved（plan_approval 已覆盖派发，不逐条审批）
2. 静态门: depends_on 完成; 无 live attempt; 上一 attempt 已 closed; retry/rework 允许
3. ensureChannelActive(channelId); assertHarnessUsable(lead.harness, config)
4. withTransaction:
   INSERT attempt(attempt_no, source_key='pw:<wi>:<n>', state='DISPATCHING')
   CAS work_item → DISPATCHING (WHERE state IN (...))
5. TaskEngine.createOrGetRoot({
     sourceChatMessageId: source_key,
     source:'project', projectId, projectWorkItemId, projectAttemptNo,
     traceId, assigneeId: channel.leadAgentId,
     deadlineAt: now + exec_budget_minutes,
     rootQueueSeq: undefined
   })
6. withTransaction:
   CAS attempt → DISPATCHED, channel_task_id=?
   CAS work_item → DISPATCHED (WHERE state='DISPATCHING' AND current_attempt_id=?)
   INSERT project_events('work.dispatched')
7. 零行 CAS → 取消创建的 root 或交 Reconciler 对账；不得覆盖 CANCELED/SUPERSEDED
```

关键修正（来自审计）：
- 必须调用 `ensureChannelActive` + `assertHarnessUsable`。
- 必须用 `sourceChatMessageId` 槽传 source key（现有唯一索引在 `(channel_id, source_chat_message_id)`）；不要新增同名但未建索引的字段。
- 必须校验上一 attempt 已 closed；否则重试可能双 root。
- 必须传播 `project_id/work_item_id/trace_id` 到 root **及所有子任务**（`TaskEngine.create/dispatch` 继承）；否则 project-origin 写策略无法识别子任务。
- `deadlineAt` 必须被 admission/refresh 尊重：三个 refresh 点（`scheduler-loop/execute.ts:77-81`、`agent-runtime/message.ts:66-71`、`runtime-wiring.ts:407-409`）对 `source='project'` 使用项目预算，不得覆盖为 900s；`refreshDeadline` 不得缩短。
- `task.repo.update` 是无条件读改写；项目字段/进度更新用列级 UPDATE 或事务，避免并发覆盖。
- V1 不做跨频道改派；`channel_id` 派发后不可变；重试同频道新 attempt。

### 5.3 进度与完成

- 执行进度 = Σ(weight × factor)/Σweight；`COMPLETED=1`、`RUNNING=root progress/100`、`BLOCKED/FAILED=0`；`CANCELED/SUPERSEDED` 不计分母。
- 交付物完成率 = `approved|waived` 的 required / required。
- 项目完成门禁：必选交付物全覆盖 + 工作项终态（无未 supersede 的 FAILED）+ 无运行中 root + owner 签署。leader 只能提议，不能完成。

---

## 6. 成果、审批、共享

### 6.1 成果状态机

`draft → submitted → reviewed → approved | rejected → superseded`

- 自动 draft：项目 root COMPLETED 时，从 task artifacts 生成；`work_item_id/attempt_no` 唯一；排除 `input` artifact 和平台 summary。
- Channel lead `project_submit_result`：补 summary/method/data window/confidence/evidence；只能本频道/本交付物。
- Project leader `project_review_result`：只写 `review` proposal；`ProjectService` 应用到 reviewed/rejected；不能 approve。
- Owner `project_approvals(kind='deliverable_acceptance')`：approve/reject；CAS + 过期 + 一次性消费；不能自批。
- 版本：`UNIQUE(project_id, deliverable_id, channel_id, result_key, version)`；每个 deliverable/key 最多一个 approved；`UNIQUE(work_item_id, attempt_no)` 防自动 draft 重复。
- 证据：`evidence_json` 必须引用真实 task/artifact（同项目/同频道）；服务端解析；空证据 UI 标记"缺证据"；不能批准。
- 大小：summary ≤8KB，payload ≤64KB，evidence ≤50 条。
- 人类读取按 line grant；结果行快照 `line_id`（V1 加列）。

### 6.2 审批

- 独立 `project_approvals`，不复用 `hitl_requests`（closed union、phantom sweep、fail-open visibility）。
- 状态：`pending → approved|rejected|expired|canceled|consumed`。
- 决定必须 CAS：`WHERE status='pending' AND (expires_at IS NULL OR expires_at>now)`；校验 `project_id` 路由、owner、project active。
- 审批 subject 约定：`plan_approval` → `subject_id='plan:<projectId>:<planVersion>'`，`subject_version=planVersion`；`deliverable_acceptance` → result id；`project_complete` → project id；`write_intent` → work item id，`payload_json` 存 tool/args/attempt/digest。
- `write_intent` 一次性消费；绑定 `payload_json`（tool/args/attempt/digest）+ `args_digest`；重试/改派不得复用。Channel Lead 通过 `project_request_write_intent` 发起；owner 批准；执行器在真正写之前校验 tool/args 与 digest 一致、approval 未过期/未消费，然后 `consumed_at` + 原子消费。
- 审批默认 TTL 24h（可配）；过期由 Reconciler sweep + 执行前重校验；同 `(project,kind,subject)` 只允许一个 pending（partial unique）。
- 破坏性动作：project complete、deliverable acceptance、write_intent、archive；leader 不能自批。**工作项派发由 `plan_approval` 覆盖，不逐条审批**；若 plan 变更，新 plan 必须重新批准。

### 6.3 共享

- V1 只 pull：`project_read_results`；项目内成员按角色返回 approved/submitted/reviewed；项目外 403；line grant 过滤。
- 不做 push 订阅；不建 `project_subscriptions`。

---

## 7. API 与 UI（V1）

### 7.1 API

```
POST/GET/PATCH /api/workshop/projects
POST /projects/:id/activate|pause|resume|archive|complete
POST /projects/:id/plan/approve          // owner
GET/POST/DELETE /projects/:id/channels
GET/POST/PATCH /projects/:id/deliverables
GET/POST/PATCH /projects/:id/work-items
POST /projects/:id/work-items/:wid/cancel|retry
GET/POST /projects/:id/results
POST /projects/:id/results/:rid/review|approve|reject|supersede
GET /projects/:id/decisions|events|approvals
POST /projects/:id/approvals/:aid/decide
GET /projects/:id/snapshot|status-report|trace/:traceId
```

- 所有端点：user token + owner/admin（V1 仅 owner）；zod；`{code,message,data}`；错误码固定。
- 项目办公室频道不出现在项目成员列表；普通频道 API 可见（private）。
- 项目事件走办公室频道事件流 + `publishToUser`；不新建通用 SSE。

### 7.2 UI

`/projects` 列表；`/projects/:id` 五个 tab：

1. **Overview**：目标/成功标准/模式/进度/阻塞/下一步/leader/预算/操作。
2. **Plan & Work**：计划编辑/评论/批准；**V1 的计划 diff 从 `project_decisions.args_json` 快照生成**（V1.1 再做独立 `project_plan_versions`）；交付物台账；工作项看板（10 状态）；handoff 契约/attempt/阻塞。
3. **Deliverables**：成果 Map（按交付物/按频道）；证据包；版本 diff；复核/验收/驳回/waive；AI 复核标注"摘要级"。
4. **Approvals**：待审批（计划/验收/完成/write_intent）；批准/拒绝/过期；审批历史。
5. **Events/Decisions**：时间线、actor、依据、结果、trace；"为什么"可读。

侧栏：项目办公室聊天（提案 only）、leader 状态、周报/导出、暂停/接管。
保护标识：用户绑定 Channel"受保护"；不能删除/解绑/换 lead。
周报：一页纸（交付物/工作项/阻塞/预算/下一步/本周变化），可导出。

---

## 8. 安全与治理（P0/P1）

### 8.1 P0（M1 前必须完成）

| # | 修复 | 验收 |
|---|---|---|
| P0-1 | spawn 策略下沉到 service 层，带 actor principal | `createChannel`/`updateChannel`/`addAgent`/`createTeamMember`/`instantiateChannelTemplate` 非 admin 传 `command/args/env/cwd/workspace` → 403，零目录 |
| P0-2 | `workspace` 纳入限制；在 `mkdir` 前校验 | 非 admin 只能 `data/workspaces/<channel>` 或 `data/projects/<id>`；`C:\Windows` 403 |
| P0-3 | MCP 管理/设备工具拒绝 agent token | `channel.create/remove`、`agent.create/remove/list/definitions`、`device.control` agent token → 403；响应无 token/config |
| P0-4 | agent-facing DTO 去凭证 | `agent-dto.ts` 统一；`workshop.agent.list` 无 token/config |
| P0-5 | scheduler decision 不含 spawn config | 携带 `command/args/env` 的 decision 拒绝并审计 |

### 8.2 P1（M2/M3 前）

- **执行层 denylist**：project_leader 的 lead-only/工业写/插件管理工具在 `dispatchHostToolInner` 与 `invokeHostTool` 双处拒绝。
- **project-origin 上下文传播**：root → 子任务继承 `project_id/work_item_id/trace_id`；工具执行时解析 root lineage；未知 project 上下文 fail-closed。
- **project-origin 写策略**：`project_may_write=false` 默认；高风险工具需 `write_intent`（owner 批准、args digest、一次性）；重试/改派保持限制。
- **审批 CAS/过期/一次性消费**：见 §6.2。
- **审计 fail-closed**：新增 `appendAuditTx(db, entry)`，破坏性动作在同一事务写 `project_decisions` + `project_events`（权威记录）；失败回滚。`audit_log` 是尽力镜像，不作为唯一审计依据；镜像失败记录告警但不回滚。
- **line grant**：项目成果读取/审批按 line grant；结果行 `line_id`。
- **用户绑定保护**：leader 对 `user_bound` 删除/解绑/换 lead 403；owner 可解绑。
- **预算不被覆盖**：三个 deadline refresh 点尊重项目预算。
- **子任务 project 上下文**：`TaskEngine.create/dispatch` 继承；`reportTask`/artifact 事件保留。

### 8.3 V1 明确不做

- 隐藏控制频道（无 `channels.kind` 过滤）。
- leader 自建/删除 Channel。
- 自动 replan / 自动验收 / 自动完成。
- 多用户项目成员（V1.1 可选 viewer/approver）。
- push 订阅、Mandate、双账本、Watchdog、effects 独立表。

---

## 9. 实施阶段（V1）

| 阶段 | 人日 | 内容 | 出口 |
|---|---:|---|---|
| **P0 安全** | 6–8 | spawn actor/workspace/template；MCP 管理拒绝；DTO；scheduler config | B1–B5；现有 e2e 零回归 |
| **M0 Schema/迁移** | 5–7 | 9 表；tasks/audit/channel_agents 列；迁移顺序；repo 管线 | A1–A12；旧库双 init |
| **M1 Project 核心** | 8–10 | ProjectService；办公室频道；leader 实例；role/capability；pause/resume/archive | C1–C10；D1–D5 |
| **M2 派发** | 9–11 | deliverables；work items；attempt；submitProjectRoot；context 传播；reconciler | E1–E6；F1–F12 |
| **M3 成果/审批** | 8–10 | results；auto-draft；submit/review/approve；approvals；audit | E7–E9；G1–G12；H6 |
| **M4 API/UI** | 9–12 | REST；项目页；计划编辑/diff；成果证据；approvals；周报 | I1–I12 |
| **M5 验收** | 6–8 | 单测/集成/安全/E2E/重启/UI；证据；回滚 | J1b–J10；M1–M10；G0–G6 |

**V1 合计 51–66 人日 ≈ 10–13 周纯人日**（1 名高级工程师，含测试/文档）；加评审、CI、上下文切换 20–30% → **13–16 周**。若只做"后端 + 只读 UI"薄版：P0+M0–M3+M4 只读 ≈ **10–12 周**。
**V1.1**（+2–4 周）：Mandate、plan versions、progress ledger、watchdog-lite、effects/outbox、MAST 全量、周报/项目成员 viewer/approver。
**V2**（可选）：ProjectSchedulerLoop/自主 replan、leader 自建频道、push 订阅、多用户 RBAC、program-of-projects。

> 工时口径按 1 名熟悉仓库的工程师；并行 2 人可压缩 30–40%，但 merge 冲突和评审会增加。

**每阶段 DoD**：代码合并到 `feature/project-layer`；新增/修改测试全绿；迁移 fixture 通过；文档/i18n/docs:check 通过；证据写入 `docs/audit/evidence/2026-11-03-project-layer/<phase>/`；该阶段 gate 清单全勾；无"后续补"的 blocker；P0/G2 需 Security/QA 签字。

---

## 10. 审计与验收标准

### 10.1 证据等级

| 等级 | 含义 | 证据 |
|---|---|---|
| E0 | 静态 | typecheck/lint/zod/DDL |
| E1 | 单元 | `node:test` 纯函数/状态机/repo（内存 DB） |
| E2 | 集成 | 真实 repo + 内存 DB + mock harness + service |
| E3 | Live E2E | 隔离 `aw dev/start` + HTTP/WS + 真实 Channel |
| E4 | 影子/现场 | 真实事件观察 1–2 周（V1 只记录 proposal） |

规则：E1 不能替代 E2；E2 不能替代 E3；安全/破坏性项必须 E2+E3；V1 不声称自主决策质量，E4 只用于 V1.1 晋升评估。

### 10.2 门禁 G0–G6

| Gate | 名称 | 出口（全部满足） |
|---|---|---|
| **G0** | 基线 | 独立 `feature/project-layer`；typecheck/lint；1017 基线 0 fail；基线清单 `baseline-tests.json` |
| **G1** | Schema/迁移 | A1–A12；新库/旧库/双 init/rebuild；索引存在 |
| **G2** | 安全 P0 | B1–B5 + 安全负例；无隐藏控制频道；办公室频道不挂 scheduler；agent token 管理面 403；workspace 403 |
| **G3** | Project 核心 + 派发 | B6–B7；C1–C15；D1–D8；E1–E3；F1–F12；H1–H5；L1–L5/L11；project-origin 传播/写拒绝 |
| **G4** | 成果 + 审批 | B8；C14；E4–E9；G1–G12；H6；L6–L10/L12–L14；审批 CAS/过期/一次性；审计 fail-closed |
| **G5** | API/UI | I1–I12；Playwright 行为断言；周报/证据/trace |
| **G6** | Live + 审计 + 回滚 | J1b–J10；M1–M10；J3 薄版/完整版；回滚演练；两方签署 |

**门禁规则**：G2 不过不得进 G3；G3 不过不得进 G4；G6 不过不得发布。每个 gate 出口必须列 item ID、命令、artifact、最低证据等级、签署人。

### 10.3 追溯矩阵

| 意图 | 设计 | 模块 | 验收 | Gate |
|---|---|---|---|---|
| Project 总工 | 办公室频道 + agent_kind + proposal-only | ProjectService/runtime-wiring/prompts | C1–C10 | G3 |
| 多 Channel | project_channels | admin-channel/access | C11–C13 | G3 |
| 共享成果 | deliverables/results/pull | project-result.repo | G1–G12 | G4 |
| 拆解/派发 | work items/attempt/submitProjectRoot | project-dispatch/task.repo | E/F | G3 |
| 进度责任 | reconciler/progress/completion gate | project-reconcile/rules | E7–E9 | G4 |
| Channel 自治 | 不改 SchedulerLoop | — | J2 | G6 |
| 用户绑定保护 | user_bound 403 | access/admin-channel | C11 | G3 |
| 审计/回滚 | decisions/events/trace/audit | project-decision/audit | M1–M10 | G6 |

### 10.4 测试矩阵

| 层 | 文件/命令 | 目标 | Gate |
|---|---|---|---|
| 单元 | `tests/project-*.test.ts` | 35–45 | G3/G4 |
| 迁移 | `tests/project-migration.test.ts` | 6–8 | G1 |
| 集成 | `tests/project-integration.test.ts` | 25–35 | G3/G4 |
| 安全 | `tests/security/project-*.test.ts` | 20–25 | G2/G3/G4 |
| MAST | `tests/project-mast-*.test.ts` | 14（Given/When/Then） | G3/G4 |
| E2E 薄版 | `scripts/e2e-project-layer.mjs --thin` | 1 套 | G6 |
| E2E 完整版 | `--full` | 1 套 | G6 |
| 重启/混沌 | `scripts/e2e-project-restart.mjs` | 8–10 | G6 |
| UI 行为 | Playwright + `ui:shots` | 12–16 | G5 |
| 性能 | `scripts/acceptance-project-perf.mjs` | 3–4 | G6 |

**总计 ≥130 个新用例**；M7 不再单独承担测试编写，测试随阶段完成。

#### 10.4.1 验收清单（V1）

> 每项格式：ID / 通过标准 / 最低证据等级 / 主要证据 / Gate。所有命令必须可复现；证据写入 `docs/audit/evidence/2026-11-03-project-layer/`。

**A. Schema 与迁移**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| A1 | 新库启动创建 9 张项目表 + 索引 | E1/E2 `tests/project-migration.test.ts` | G1 |
| A2 | 旧库升级幂等；`channel_agents.agent_kind`、`tasks.source/project_id/work_item_id/attempt_no/trace_id` 存在 | E2 fixture | G1 |
| A3 | `tasks` rebuild（FK/legacy）后新列与 `superseded_by_task_id` 不丢 | E2 | G1 |
| A4 | `channels` rebuild 不丢现有列；不需要 `channels.kind` | E2 | G1 |
| A5 | 同一 Channel 只能一个 active project binding | E1/E2 | G1 |
| A6 | work item 必须 `deliverable_id`；缺 → 拒绝 | E1 | G1 |
| A7 | 每个 work item 最多一个 live attempt；`channel_task_id` 唯一 | E1/E2 | G1 |
| A8 | results：`work_item_id/attempt_no/result_key` 唯一；每 deliverable/key 最多一个 approved；`line_id` 存在 | E1 | G1 |
| A9 | decisions/events 的 `(project,seq)` 与 `event_key` 唯一 | E1 | G1 |
| A10 | approvals 状态/`consumed_at`/`expires_at`/`payload_json` 存在；`(project,kind,subject)` pending 唯一 | E1 | G1 |
| A11 | 迁移顺序：建表→rebuild 补列→post-add 列→索引；双次 init 幂等 | E2 | G1 |
| A12 | 旧库 fixture 升级后行数/关键数据保留 | E2 | G1 |

**B. 安全 P0/P1**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| B1 | 非 admin 通过 REST/service/MCP/scheduler 传 `command/args/env/cwd/workspace` → 403，零副作用 | E2/E3 | G2 |
| B2 | `workspace` 限制在 `data/workspaces/<channel>`/`data/projects/<id>`；`C:\Windows` 拒绝 | E2/E3 | G2 |
| B3 | agent token 调管理/设备工具全部 403 | E2/E3 | G2 |
| B4 | agent-facing DTO 无 token/config/command/env | E1/E2 | G2 |
| B5 | scheduler decision 带 spawn 键 → 拒绝并审计 | E2 | G2 |
| B6 | project_leader 调 lead-only/工业写/插件管理 → 403；正常项目工具通过 | E2/E3 | G3 |
| B7 | project root 的子任务继承 `project_id/work_item_id/trace_id`；缺失 fail-closed | E2 | G3 |
| B8 | 破坏性动作审计写失败 → 事务回滚；拒绝决策仍有审计 | E2 | G4 |

**C. 角色、工具、项目核心**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| C1 | `agent_kind=project_leader` 只能出现在办公室频道 | E1/E2 | G3 |
| C2 | 办公室频道只有一个 project_leader；role=lead | E1 | G3 |
| C3 | project_leader 工具快照：只读 + 提案 + 复核 + 申请审批；无执行/工业写 | E1/E2 | G3 |
| C4 | Channel lead 有 `project_read_*`/`project_submit_result`；worker 只读 | E1 | G3 |
| C5 | 非项目 Channel 0 个 project 工具 | E1 | G3 |
| C6 | 直接 REST/MCP 调 project 工具：非成员/错项目 → 403，零副作用 | E2/E3 | G3 |
| C7 | `project_submit_result` 只能本频道/本交付物/本 task | E2 | G4 |
| C8 | leader 不能 approve 成果/项目；只能 review proposal | E2 | G4 |
| C9 | user_bound Channel 删除/解绑/换 lead → 403；owner 可解绑 | E2/E3 | G3 |
| C10 | 跨 owner 绑定 → 403；Channel 同时只能一个 active project | E2 | G3 |
| C11 | line grant：无 grant 读成果/审批 → 403；结果 `line_id` 快照 | E2/E3 | G4 |
| C12 | active 项目 leader 不被 idle 卸载；paused/archived 可卸载 | E2 | G3 |
| C13 | 办公室频道可见（private），项目页可打开；不挂 Channel SchedulerLoop；提交普通任务 → 409 `PROJECT_OFFICE_NO_TASKS` | E1/E2 | G3 |
| C14 | Channel lead 可请求 `write_intent`；owner 批准；执行器一次性消费；tool/args/digest 不匹配、过期、复用 → 403 | E2/E3 | G4 |
| C15 | active 项目的办公室频道删除/禁用/替换 lead → 409；项目不因此变砖 | E2 | G3 |

**D. 生命周期**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| D1 | create Project → office channel + leader + pointers 原子写入 | E2 | G3 |
| D2 | activate 校验成员 Channel + required 交付物 + approved plan（observe 允许 draft） | E2 | G3 |
| D3 | pause 停 Reconciler 派发/提醒；在飞 root 继续；resume 对账 | E2 | G3 |
| D4 | archive 要求无运行中工作项；只读；可恢复 | E2 | G3 |
| D5 | complete 门禁：交付物/工作项/无运行 root/owner 审批；缺一拒绝 | E2/E3 | G4 |
| D6 | 归档/完成时绑定 `detached/archived`，不占 active 唯一槽 | E2 | G3 |
| D7 | 重启恢复 active/paused 项目；无重复派发/审批 | E3 | G6 |
| D8 | 办公室频道不进入成员列表；普通频道 API 可见但 private | E2/E3 | G3 |

**E. 交付物 / 工作项 / 进度**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| E1 | 交付物 CRUD；required/owner channel/验收/due/depends 生效 | E2 | G3 |
| E2 | 无交付物的工作项创建 → 400 | E1 | G3 |
| E3 | 依赖未满足 → 拒绝派发；依赖 FAILED/CANCELED → 下游 BLOCKED | E2 | G3 |
| E4 | 进度：权重/分母/root progress；canceled/superseded 不计分母 | E1 | G4 |
| E5 | 项目 root COMPLETED → 自动 draft；排除 input/goal summary | E2 | G4 |
| E6 | 逾期/阻塞/频道禁用 → BLOCKED + 事件 + 提醒 | E2 | G4 |
| E7 | 交付物完成率 + 执行进度分开显示；不出现"完成但无验收" | E2/E3 | G5 |
| E8 | 周报数字与 DB 一致（交付物/工作项/预算/阻塞） | E2/E3 | G5 |
| E9 | 项目完成 100% 仅在所有必选交付物 approved/waived 后出现 | E2/E3 | G4 |

**F. 派发 / 状态机**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| F1 | `submitProjectRoot` 创建 root：source/project/work_item/attempt/trace 正确 | E2 | G3 |
| F2 | 同 source key 重放 → 一个 root；同标题不同 key → 两个 root | E2 | G3 |
| F3 | 并发派发 → 一个 live attempt；零行 CAS 不产生副作用 | E2 | G3 |
| F4 | 上一 attempt 未关闭 → 拒绝重试 | E2 | G3 |
| F5 | 频道禁用/harness 不可用 → 拒绝，不留幽灵 root | E2 | G3 |
| F6 | 子任务继承项目上下文；正常 Channel 任务不受影响 | E2 | G3 |
| F7 | 状态机全边（10 状态）表驱动测试 | E1 | G3 |
| F8 | root 失败分类：HARNESS/LEAD_MISSING/CHANNEL_DISABLED/ROOT_TIMEOUT → BLOCKED；不可重试 → FAILED | E2 | G3 |
| F9 | 60 分钟项目预算不被 admission/refresh 改成 900s；queue 不计 | E2/E3 | G3 |
| F10 | 重试创建新 attempt；旧 attempt/root 保留 | E2 | G3 |
| F11 | cancel/supersede 关闭 attempt；旧 root 不覆盖新状态 | E2 | G3 |
| F12 | 重启：DISPATCHING 找回/回退；RUNNING 按 root 回填；无重复 | E3 | G6 |

**G. 成果 / 审批**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| G1 | 结果状态机 draft→submitted→reviewed→approved/rejected→superseded | E1 | G4 |
| G2 | 自动 draft 幂等：同 work item/attempt/key 不重复 | E2 | G4 |
| G3 | 版本递增；每 deliverable/key 最多一个 approved | E2 | G4 |
| G4 | evidence 解析真实 task/artifact；伪造/跨项目 → 400 | E2 | G4 |
| G5 | submit 只能本频道/本交付物/本 task | E2 | G4 |
| G6 | leader review 只写 proposal；执行器应用 reviewed/rejected | E2 | G4 |
| G7 | owner approve/reject；过期/重放/跨项目 → 409/403 | E2/E3 | G4 |
| G8 | self-approve（作者=批准人）→ 拒绝 | E2 | G4 |
| G9 | pull 读取：worker approved、lead approved/submitted、leader 全部；项目外 403 | E2/E3 | G4 |
| G10 | line grant 撤销后 API/SSE 立即隐藏 | E3 | G4 |
| G11 | 驳回后 REWORK；旧结果 superseded；新版本 diff 可读 | E2/E3 | G5 |
| G12 | 项目完成必须 owner 签署；leader 不能完成 | E2/E3 | G4 |

**H. Prompt / Harness**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| H1 | `project-*.md` 加载/变量渲染正确 | E1 | G3 |
| H2 | 办公室频道 scenario prompt = 项目章程 + leader 约束 | E2 | G3 |
| H3 | 成员频道追加 Project Charter，不覆盖用户 scenarioPrompt | E2 | G3 |
| H4 | mock + omp + 至少一种其他 harness 可跑 project leader | E3 | G6 |
| H5 | project 工具 schema 严格；缺参/多参 → 400 | E1/E2 | G3 |
| H6 | 快照超预算裁剪（L0–L5）；默认摘要 + 引用 ID | E1/E2 | G4 |

**I. API / UI**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| I1 | Project CRUD/activate/pause/resume/archive/complete API | E2 | G5 |
| I2 | 权限负例：非 owner/非项目成员 403/404 | E2/E3 | G5 |
| I3 | `/projects` 列表字段与 DB 一致；空态/错误态 | E3 Playwright | G5 |
| I4 | Overview：目标/进度/阻塞/下一步/leader/预算/操作 | E3 | G5 |
| I5 | Plan & Work：计划编辑/diff/评论/批准；工作项 10 状态 | E3 | G5 |
| I6 | Deliverables：Map 双视图/证据包/版本 diff/验收按钮状态 | E3 | G5 |
| I7 | Approvals：待审批/批准/拒绝/过期/历史 | E3 | G5 |
| I8 | Decisions/Events：actor/依据/结果/trace；"为什么"可读 | E3 | G5 |
| I9 | 办公室聊天/提案标识/owner 指令记录 | E3 | G5 |
| I10 | SSE/WS：项目事件实时；断线重连不丢关键状态 | E3 | G5 |
| I11 | 周报导出：数字与 DB 一致 | E3 | G5 |
| I12 | 中英文案/术语一致；无 i18n 缺失 | E0/E1 | G5 |

**J. 回归 / Live / 发布**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| J1a | 基线 1017 单测 0 fail；基线清单 `baseline-tests.json` | E1/E2 | G0 |
| J1b | 新增 ≥130 用例全绿；无 flaky | E1/E2 | G6 |
| J2 | e2e-line/channel/task/chat/HITL 全绿 | E3 | G6 |
| J3 | Live 薄版：1 Project + 3 user_bound + 5 交付物全链 | E3 | G6 |
| J4 | Live 负例：越权/用户绑定删除/自批/伪造证据/项目完成门禁 | E3 | G6 |
| J5 | 重启：运行中重启继续完成；无重复 root/成果/审批 | E3 | G6 |
| J6 | 失败恢复：频道故障/lead 移除/预算超时 → BLOCKED + 提醒 | E3 | G6 |
| J7 | 审计：破坏性动作有 `project_decisions` + `project_events` + `trace`；`audit_log` 镜像可缺省但记录原因 | E2/E3 | G6 |
| J8 | 性能：100 工作项/10 频道 P95 <500ms；tick/reconciler <50ms | E3 | G6 |
| J9 | docs:check/README/changelog/计划归档 | E0 | G6 |
| J10 | 回滚演练：flag off → 在飞继续 → project-origin 写 fail-closed → 数据保留 | E3 | G6 |

**M. 审计证据**

| ID | 通过标准 | 证据 | Gate |
|---|---|---|---|
| M1 | 每个验收项有 ID/证据等级/命令/artifact/pass/owner/gate | `summary.json` schema | G6 |
| M2 | trace 串 decision→approval→attempt→root→result→acceptance | SQL/导出 | G6 |
| M3 | 无重复 root/live attempt/approved（SQL 在坏 fixture 失败） | SQL | G6 |
| M4 | 无 self-approve；无未签收 completed；无未审批高风险写 | SQL | G6 |
| M5 | user_bound 删除/解绑/换 lead 全 403 + 审计 | E2/E3 | G6 |
| M6 | `project_decisions`/`project_events` 写失败 → 破坏性动作回滚；`audit_log` 镜像失败只告警 | E2 | G6 |
| M7 | outbox/通知无长期 pending；重试/死信有记录 | E2 | G6 |
| M8 | 回滚演练记录完整 | E3 | G6 |
| M9 | 证据索引可复现；命令/环境/版本记录 | E0 | G6 |
| M10 | Owner + Security/QA 两方签署（不足记录限制） | 文档 | G6 |

#### 10.4.2 验收清单的单一事实来源

V1 实施时，把 §10.4.1 的每一行落成机器可读文件 `docs/plans/project-acceptance.json`：

```json
{
  "id": "F9",
  "criterion": "60 分钟项目预算不被 admission/refresh 改成 900s",
  "evidence_level": "E2/E3",
  "command": "npx tsx --tsconfig .nuxt/tsconfig.server.json --test tests/project-budget.test.ts",
  "artifact": "docs/audit/evidence/2026-11-03-project-layer/G3/F9/output.log",
  "pass": "test exits 0; task deadline >= now+60m after admission",
  "owner": "backend",
  "gate": "G3"
}
```

规则：
- Gate 状态从该文件自动推导；`summary.json` 由它生成，不手工维护。
- CI 检查：每个 gate 引用的 ID 存在；每个 ID 有 evidence_level/command/artifact；破坏性/安全项至少 E2。
- 任何"G?"、未映射 ID、gate 引用不存在 → CI 失败。
- 这不是额外流程；它是把上面的表变成可执行清单。

### 10.5 MAST 14（V1 版，Given/When/Then）

> 每项必须有 fixture、注入、断言、清理；至少一个正向控制，防止"永远拒绝"也能过。

| # | 失败模式 | 测试要点 | 证据 |
|---|---|---|---|
| L1 | 不遵守任务规格 | 派发缺 acceptance/result_schema → 拒绝；合法派发成功 | E2 |
| L2 | 不遵守角色规格 | PL 调 `dispatch_task`/工业写/插件管理 → 403；正常项目工具成功 | E2/E3 |
| L3 | 步骤重复 | 重复 tick/事件 → 1 root/1 decision；合法重试 → 新 attempt | E2 |
| L4 | 历史丢失 | 重启后 plan/decisions/results 可恢复；不重开题 | E3 |
| L5 | 不知道终止 | 缺交付物/工作项未终态/owner 未签 → complete 拒绝；齐全 → 成功 | E2/E3 |
| L6 | 对话重置 | 重启/replan 不丢 approved plan；旧版本可查 | E2 |
| L7 | 不澄清 | 模糊/越界派发 → 1 个 proposal/approval，不建 root | E2 |
| L8 | 任务漂移 | 越 plan_version 派发 → 拒绝；Reconciler 报 blocked/drift 事件 | E2 |
| L9 | 信息隐瞒 | Channel A approved 成果被 B pull 读取；项目外 403 | E3 |
| L10 | 忽略输入 | 上游 FAILED → 下游不可派发；上游 result id 进 handoff | E2 |
| L11 | 推理-行动不一致 | proposal args 与执行 args 一致；篡改 → 拒绝 | E2 |
| L12 | 过早终止 | leader 不能 complete；owner 审批后才完成 | E2/E3 |
| L13 | 验证不完整 | 只有 artifact 不能 approve；需 evidence + review + owner | E2 |
| L14 | 验证错误 | 伪造/跨项目 evidence、self-approve → 拒绝；合法证据 → 通过 | E2/E3 |

### 10.6 审计 SQL（行为断言）

```sql
-- 1. 同 project/work_item/attempt 只能一个 root（只看 root，子任务允许继承 project_id）
SELECT project_id, project_work_item_id, project_attempt_no, COUNT(*)
FROM tasks WHERE project_id IS NOT NULL AND parent_id IS NULL
GROUP BY 1,2,3 HAVING COUNT(*) > 1;

-- 2. 每个 work item 最多一个 live attempt
SELECT work_item_id, COUNT(*) FROM project_work_item_attempts
WHERE closed_at IS NULL GROUP BY 1 HAVING COUNT(*) > 1;

-- 3. 每个 deliverable/key 最多一个 approved
SELECT project_id, deliverable_id, result_key, COUNT(*) FROM project_results
WHERE status='approved' GROUP BY 1,2,3 HAVING COUNT(*) > 1;

-- 4. approved 必须有 owner 决策，且批准人 != 作者
SELECT r.id FROM project_results r
JOIN project_approvals a ON a.subject_id=r.id AND a.kind='deliverable_acceptance'
WHERE r.status='approved' AND (a.status!='approved' OR a.decided_by_user_id IS NULL
  OR a.decided_by_user_id = r.author_user_id);

-- 5. completed 项目必须有 approved project_complete
SELECT p.id FROM projects p
WHERE p.status='completed' AND NOT EXISTS (
  SELECT 1 FROM project_approvals a
  WHERE a.project_id=p.id AND a.kind='project_complete' AND a.status='approved');

-- 6. project-origin 子任务必须继承项目上下文
SELECT t.id FROM tasks t
WHERE t.parent_id IS NOT NULL AND t.project_id IS NULL
  AND EXISTS (SELECT 1 FROM tasks p WHERE p.id=t.parent_id AND p.project_id IS NOT NULL);

-- 7. 破坏性决策必须有 trace_id
SELECT id, decision_type FROM project_decisions
WHERE decision_type IN ('channel_binding','project_complete','result_supersede','write_intent')
  AND trace_id='';

-- 8. 高风险写必须有 write_intent
SELECT a.id FROM project_work_item_attempts a
JOIN project_work_items w ON w.id=a.work_item_id
WHERE w.contract_json LIKE '%writeIntent%' AND a.approval_id IS NULL;
```

每条 SQL 必须在一个"故意坏"的 fixture 上失败、在修复后通过；空库通过不算。

### 10.7 签署

| 角色 | 责任 | 签署物 |
|---|---|---|
| Project Owner | 产品验收、交付物批准、项目完成 | `owner-signoff.md` |
| Security/QA（可同一人但需记录独立性） | 安全负例、审计 fail-closed、测试证据 | `security-qa-signoff.md` |
| Ops/Release（可由 owner 兼任并记录） | 迁移/回滚/灰度/监控 | `ops-signoff.md` |

V1 最低 **2 个独立签署**（Owner + Security/QA）；不足 2 人时必须在 `README.md` 记录"独立评审受限"，不得假装四方签署。

### 10.8 V1.1 晋升评估（不阻塞 V1）

V1 不声称自主调度。V1.1 是否上 `ProjectSchedulerLoop`/Mandate/双账本，依据"proposal log"：
- 记录 leader 的 proposal 与 owner 实际决策；
- 至少 30 个派发/重规划决策、2 个项目；
- 计划接受率 ≥70%、重复派发 0、安全违规 0、人工干预不高于纯人工 120%；
- 达标才进 V1.1；否则保持 proposal-only。

---

## 11. 风险与回滚

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 项目办公室频道被误当普通工作频道 | 命名"项目办公室"；`agent_kind` 标识；项目页说明；不加入 project_channels |
| R2 | project leader 被 idle 卸载 | active 项目显式豁免；`hasActiveSupervisionAttempt` 不适用时用项目 active 判断 |
| R3 | 子任务丢失项目上下文 | `TaskEngine.create/dispatch` 继承 + SQL 断言 + 执行层 fail-closed |
| R4 | 900s 覆盖项目预算 | 三个 refresh 点按 `source='project'` 使用项目预算；测试 60 分钟任务 |
| R5 | 重复 root/成果 | source key + attempt unique + result unique + CAS；审计 SQL |
| R6 | 审批重放/过期 | CAS + expires_at + consumed_at + 一次性 write_intent |
| R7 | 审计 fail-open | `appendAuditTx` 同事务写 decisions/events；失败回滚；`audit_log` 镜像告警 |
| R8 | 隐藏频道泄漏 | V1 不隐藏；办公室频道沿用现有权限；不引入 kind 过滤 |
| R9 | 计划审批体验差 | 计划编辑/diff/评论/批准；拒绝必须给理由 |
| R10 | 结果自报/伪造 | evidence 服务端解析；leader 只 review；owner approve；line grant |
| R11 | 工时低估 | V1 13–16 周；薄版 10–12；V1.1 +2–4 |
| R12 | 回滚不彻底 | flag off → stop reconciler → 在飞 root 继续 → project-origin 写 fail-closed → 数据保留 |
| R13 | 多进程部署导致 Reconciler 双跑 | V1 假定单服务进程；启动时获取 DB 锁/单例；多进程部署需 V2 的 leader election |

**回滚演练**：
1. 关 `workshop.projects.enabled`；API 404、工具不注入、Reconciler 停。
2. 在飞 Channel root 继续；项目层不再派发/验收。
3. 带 `project_id` 的任务仍拒绝高风险写。
4. 备份恢复演练：复制 DB → 旧版本启动 → 项目表存在但 UI 不显示；办公室频道作为普通频道可见。
5. 记录 `ops-signoff.md`。

---

## 12. V1.1 / V2 扩展（保留 v2.0 设计）

### V1.1（+2–4 周，按 proposal log 决定）

- `project_plan_versions`（版本化计划/diff）
- `project_progress_ledger`（Task/Progress Ledger）
- `project_health` + `ProjectWatchdog`（心跳/无进展/重复决策/预算）
- `project_effects`（outbox；或复用 `outbox_events`）
- `mandate_json` + 重校验（不可变授权）
- `project_members` viewer/approver（最小多用户）
- 周报/交班摘要、计划评论、审批提醒
- MAST 全量回归、更多 harness

### V2（可选）

- `ProjectSchedulerLoop` + `ProjectEventIngress`（自主 replan；先 observe 影子）
- leader 自建/删除 Channel（P0 红队 + 审批 + 白名单）
- `project_subscriptions` push
- 多用户 RBAC、program-of-projects、外部 Trigger

---

## 13. ADR

**Decision**：V1 采用"普通项目办公室频道 + project_leader AgentRuntime + 确定性 ProjectService/Reconciler + 9 张表"的薄版；V1.1/V2 再加 Mandate/双账本/Watchdog/自主环/建频道。

**Drivers**：用户要 Project 总工/共享成果/跨频道派发；现有 Channel 隔离不能破坏；隐藏控制频道泄漏面大；第二调度器双写风险高；审计必须可执行；单工程师 10–12 周薄版可交付。

**Alternatives**：
- 隐藏控制频道 + ProjectSchedulerLoop（v2.0）：设计完整但 14 表/40 端点/14 处隐藏过滤，v1 风险过高 → 否决为 v1，保留 V2。
- 只做 Workspace/模板/消息：满足不了交付物契约与验收 → 否决。
- 全局跨频道 TaskEngine：破坏 Channel 不变量 → 否决。

**Consequences**：V1 没有自主 replan/leader 建频道；项目 leader 是 proposal-only；多用户/共享频道留 V1.1/V2；但可以在 10–12 周内交付可验收的"总工 + 交付物契约 + 审计"。

## 14. Changelog

| 版本 | 变更 |
|---|---|
| v1.0 | 五席评审首版 |
| v1.1 | Superagent 模式（Router/Worker、事件、账本、Watchdog、Guardrail/Trace、上下文预算） |
| v1.2 | 修状态机/枚举/trace/预算/交付物/J3/工时 |
| v2.0 | Deep Research：Mandate、执行槽、MAST 14、审计 G0–G9/E0–E4 |
| v3.0 | 五路 v2.0 审计后收敛：普通项目办公室频道替代隐藏控制频道；V1 不建第二调度器；9 表；proposal-only leader；6 gate；MAST Given/When/Then；V1.1/V2 保留完整扩展 |
