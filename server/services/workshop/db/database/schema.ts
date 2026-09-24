/**
 * 建表 SQL(SCHEMA_SQL:全部表/索引/触发器)
 * (由 server/services/workshop/db/database.ts 按职责拆出;内容逐行原文搬运)
 */

/**
 * 建表 SQL(与 schema.sql 保持同步;内联字符串而非运行时读文件,
 * 避免 Nitro 打包后相对路径失效——schema.sql 保留为源码文档)。
 */
export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  scenario_prompt TEXT NOT NULL DEFAULT '',  -- v6:channel 级作业场景 prompt(全员注入)
  llm_json       TEXT NOT NULL DEFAULT '',  -- v11:channel 级默认 LLM({provider,model,effort};空=用引擎默认)
  lead_agent_id  TEXT,
  workspace      TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  harness     TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  visibility  TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'public'(owner_user_id NULL = 内置公共,不可变更)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_agents (
  id          TEXT PRIMARY KEY,                -- 实例身份 id(每次放入 channel 独立生成)
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES agents(id) ON DELETE SET NULL,  -- 来源模板(可空)
  name        TEXT NOT NULL,                   -- 从模板复制
  harness     TEXT NOT NULL,                   -- 从模板复制
  config_json TEXT NOT NULL DEFAULT '{}',      -- 从模板复制
  role        TEXT NOT NULL DEFAULT 'worker',  -- 'lead' | 'worker'(按 channel 独立)
  token       TEXT NOT NULL,                   -- MCP 身份凭证(实例级 UUIDv4)
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_agents_token ON channel_agents(token);
CREATE INDEX IF NOT EXISTS idx_channel_agents_channel ON channel_agents(channel_id);
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  task_id       TEXT,
  from_agent_id TEXT,
  to_agent_id   TEXT,
  role          TEXT NOT NULL,                -- 'ROLE_USER' | 'ROLE_AGENT'
  parts_json    TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',   -- x-aw-target-agent / x-aw-task-kind
  state         TEXT NOT NULL DEFAULT 'pending',  -- pending|consuming|consumed
  created_at    TEXT NOT NULL,
  consumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_queue ON messages(channel_id, to_agent_id, state, created_at);
CREATE TABLE IF NOT EXISTS subscriptions (
  channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES channel_agents(id) ON DELETE CASCADE,
  target_agent_id TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (channel_id, agent_id, target_agent_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  parent_id      TEXT,
  root_queue_seq INTEGER,              -- root FIFO sequence; NULL for children
  assignee_id    TEXT NOT NULL,               -- 实例身份 id(不再 FK 到 agents)
  creator_id     TEXT,
  title          TEXT NOT NULL,
  description    TEXT,
  state          TEXT NOT NULL,               -- SUBMITTED|ASSIGNED|WORKING|WAITING|COMPLETED|FAILED|CANCELED
  progress       INTEGER NOT NULL DEFAULT 0,  -- 0-100
  retry_count    INTEGER NOT NULL DEFAULT 0,  -- 重派次数(SchedulerLoop reassign 时 +1,>=3 停止重派)
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  history_json   TEXT NOT NULL DEFAULT '[]',
  source_chat_message_id  TEXT,
  source_chat_delivery_id TEXT,
  close_reason   TEXT,
  deadline_at    TEXT,
  -- 执行交接栅栏(§2.1/§5.1):每次新分配/重分配 generation+1 并换新 lease;
  -- worker 的 message/artifact/progress/complete/failed 事件携带 generation+lease,
  -- 与当前值不符的迟到事件被丢弃,避免旧 worker 覆盖重分配后的新执行结果。
  assignment_generation      INTEGER NOT NULL DEFAULT 0,
  execution_lease_id         TEXT,
  execution_lease_agent_id   TEXT,
  execution_lease_started_at TEXT,
  execution_lease_revoked_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);
-- 调度快照/队列视图热查询:listByChannelAssignee(channel+assignee ORDER BY created_at)
CREATE INDEX IF NOT EXISTS idx_tasks_channel_assignee ON tasks(channel_id, assignee_id, state, created_at);
-- 子任务聚合(dispatch 判重/complete 闸门/onChildCompleted 统计;childrenOf 热查询)
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility  TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'public'(owner_user_id NULL = 内置公共,不可变更)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'worker',  -- 'lead' | 'worker'(部署到 channel 时采用的实例角色)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, template_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

-- v6:Agent 持久记忆(agent_memories)+ FTS5 全文索引。
-- per-agent 记忆域(agent_id 过滤隔离);团队共享行 agent_id='__team__'(常量 TEAM_AGENT_ID)。
-- dedup_key 唯一约束去重(含 channel_id:team 哨兵行跨 channel 各自独立):任务 'task:<id>' / 协作 'peer:<msgId>' / 策展 'manual:<uuid>' / 团队任意。
-- kind:episodic-task/episodic-peer(harvest)/semantic(REST 人工策展,衰减豁免)。
-- vec0 向量表不在此建:需 sqlite-vec 扩展且维度运行时才知(P1 Task 7 延迟建)。

CREATE TABLE IF NOT EXISTS agent_memories (
  id               TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,               -- 原文,供展示
  title_fts        TEXT NOT NULL DEFAULT '',    -- CJK 切分副本,FTS 索引用(V8)
  content          TEXT NOT NULL,               -- 已 CJK 切分的存储文本
  importance       REAL NOT NULL DEFAULT 0.5,
  task_id          TEXT,
  dedup_key        TEXT NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE(agent_id, dedup_key, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON agent_memories(agent_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
  title, content, agent_id UNINDEXED, memory_rowid UNINDEXED
);
CREATE TRIGGER IF NOT EXISTS trg_agent_memories_ai AFTER INSERT ON agent_memories BEGIN
  INSERT INTO agent_memories_fts(title, content, agent_id, memory_rowid)
  VALUES (new.title_fts, new.content, new.agent_id, new.rowid);
END;
CREATE TRIGGER IF NOT EXISTS trg_agent_memories_ad AFTER DELETE ON agent_memories BEGIN
  DELETE FROM agent_memories_fts WHERE memory_rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_agent_memories_au AFTER UPDATE ON agent_memories BEGIN
  DELETE FROM agent_memories_fts WHERE memory_rowid = old.rowid;
  INSERT INTO agent_memories_fts(title, content, agent_id, memory_rowid)
  VALUES (new.title_fts, new.content, new.agent_id, new.rowid);
END;

-- v7:用户级隔离(users + workspaces + 资源 owner 列)。
-- owner_user_id 为 NULL 的资源 = 遗留数据(对所有已认证用户只读可见,变更需 owner 匹配)。
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  token       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,  -- 归属用户(全局用户系统 id;原 FK 已随全局用户集成移除)
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);
-- v8:AEP 事件持久化(hub publish 同步落库;时间线历史由 server 驱动,与 client 无关)
CREATE TABLE IF NOT EXISTS channel_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  at           TEXT NOT NULL,
  agent_id     TEXT,
  task_id      TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE(channel_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_channel_events_channel ON channel_events(channel_id, seq DESC);

CREATE TABLE IF NOT EXISTS workspace_channels (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, channel_id)
);
-- v10:Channel 模板(场景 + 工作目录 + 团队编组的可复用组合;实例化 = 一键建 channel 并装配成员)。
-- lead_json:内联 lead 定义 {name,harness,config}(空串 = 无 lead);
-- members_json:[{templateId,role}](引用 Agent 模板)或 [{inline:{name,harness,config},role}](内联成员)。
-- owner_user_id NULL = 内置公共模板(visibility 恒 public,任何人不可修改删除)。
CREATE TABLE IF NOT EXISTS channel_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  scenario_prompt TEXT NOT NULL DEFAULT '',
  workspace       TEXT NOT NULL DEFAULT '',
  lead_json       TEXT NOT NULL DEFAULT '',
  members_json    TEXT NOT NULL DEFAULT '[]',
  visibility      TEXT NOT NULL DEFAULT 'private',
  owner_user_id   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_templates_owner ON channel_templates(owner_user_id);
-- v11:工具审批历史(S4:HITL 裁决留痕——进程内 pending 之外的持久化,重启可查)
CREATE TABLE IF NOT EXISTS approval_history (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,               -- 'dcw' | 'daq'
  detail       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,               -- pending|approved|denied|expired
  comment      TEXT NOT NULL DEFAULT '',
  decided_by   TEXT NOT NULL DEFAULT '',    -- 裁决人(用户 id;空 = 超时/系统收敛)
  decided_name TEXT NOT NULL DEFAULT '',    -- 裁决人名(呈现用)
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_history_created ON approval_history(created_at DESC);
-- v12:DAQ 报警事件 + ack 闭环(S5:报警持久化/确认/升级)
CREATE TABLE IF NOT EXISTS alarm_events (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL,
  node_name     TEXT NOT NULL DEFAULT '',
  metric        TEXT NOT NULL DEFAULT '',   -- 触发量名(如 temp)
  value         REAL,
  rule          TEXT NOT NULL DEFAULT '',   -- 'lt-min' | 'gt-max'
  threshold     REAL,
  acked_by      TEXT NOT NULL DEFAULT '',
  acked_at      TEXT,
  escalation    INTEGER NOT NULL DEFAULT 0, -- 未确认升级通知次数
  notified_json TEXT NOT NULL DEFAULT '[]', -- 外送记录 [{url,ok,at,attempt}]
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alarm_events_created ON alarm_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_events_open ON alarm_events(created_at DESC) WHERE acked_at IS NULL;
-- v13:结构化审计日志(R1:谁/何时/对什么/做了什么)
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL DEFAULT '',
  actor_name  TEXT NOT NULL DEFAULT '',
  actor_kind  TEXT NOT NULL DEFAULT 'user', -- 'user' | 'agent' | 'system'
  action      TEXT NOT NULL,
  target_kind TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  at          TEXT NOT NULL,
  -- 运维日志(OpsLog)维度列:按产线/产品/Recipe 隔离查询 + 分类 + 人读摘要
  line_id     TEXT NOT NULL DEFAULT '',
  product_id  TEXT NOT NULL DEFAULT '',
  recipe_id   TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',     -- write|manual|alarm|line|recipe|rollback|daq|system
  summary     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);
-- v14:高危管理操作双人复核(R3:maker-checker;config 开关默认关)
CREATE TABLE IF NOT EXISTS approval_requests (
  id            TEXT PRIMARY KEY,
  action        TEXT NOT NULL,              -- 'recipe.apply' | 'controller.toggle' | 'node.delete'
  target_id     TEXT NOT NULL,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  summary       TEXT NOT NULL DEFAULT '',
  requested_by  TEXT NOT NULL,
  requested_name TEXT NOT NULL DEFAULT '',
  requested_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied
  decided_by    TEXT NOT NULL DEFAULT '',
  decided_name  TEXT NOT NULL DEFAULT '',
  decided_at    TEXT,
  comment       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status, requested_at DESC);
-- v15:AML 自动建模平台(数据集快照 / 训练作业 / 实验谱系 / 模型注册表)
-- 级联:删数据集连带作业与实验行(模型挂实验下随之消失);GC 删除前代码层先查引用,
-- CASCADE 仅作 FK 兜底(杜绝 ws.ts FK 毒化式永久错误)。
CREATE TABLE IF NOT EXISTS aml_datasets (
  id            TEXT PRIMARY KEY,
  line_id       TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  recipe_id     TEXT NOT NULL,
  run_ids_json  TEXT NOT NULL DEFAULT '[]',
  spec_json     TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  row_count     INTEGER NOT NULL DEFAULT 0,
  from_ms       INTEGER,
  to_ms         INTEGER,
  path          TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT '',
  created_by_kind TEXT NOT NULL DEFAULT 'user',
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aml_datasets_recipe ON aml_datasets(recipe_id, created_at DESC);
CREATE TABLE IF NOT EXISTS aml_jobs (
  id            TEXT PRIMARY KEY,
  dataset_id    TEXT NOT NULL REFERENCES aml_datasets(id) ON DELETE CASCADE,
  purpose       TEXT NOT NULL DEFAULT 'mpc_surrogate',
  status        TEXT NOT NULL DEFAULT 'queued', -- queued|provisioning|training|evaluating|done|failed|cancelled|timeout|interrupted
  stage         TEXT NOT NULL DEFAULT '',
  progress      INTEGER NOT NULL DEFAULT 0,
  budget_json   TEXT NOT NULL DEFAULT '{}',
  metrics_json  TEXT,
  gates_json    TEXT,
  artifacts_path TEXT,
  error         TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  agent_id      TEXT NOT NULL DEFAULT '',
  channel_id    TEXT NOT NULL DEFAULT '',
  task_id       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_aml_jobs_status ON aml_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aml_jobs_dataset ON aml_jobs(dataset_id, created_at DESC);
CREATE TABLE IF NOT EXISTS aml_experiments (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES aml_jobs(id) ON DELETE CASCADE,
  dataset_id    TEXT NOT NULL REFERENCES aml_datasets(id) ON DELETE CASCADE,
  parent_experiment_id TEXT,
  change_note   TEXT NOT NULL DEFAULT '',
  config_json   TEXT NOT NULL DEFAULT '{}',
  metrics_json  TEXT NOT NULL DEFAULT '{}',
  gates_json    TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'running', -- running|gates_passed|gates_failed|failed
  seed          INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aml_experiments_dataset ON aml_experiments(dataset_id, created_at DESC);
CREATE TABLE IF NOT EXISTS aml_models (
  id            TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES aml_experiments(id) ON DELETE CASCADE,
  dataset_id    TEXT NOT NULL REFERENCES aml_datasets(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL,
  recipe_id     TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT 'mpc_surrogate',
  stage         TEXT NOT NULL DEFAULT 'candidate', -- candidate|shadow|production|retired
  io_spec_json  TEXT NOT NULL DEFAULT '{}',
  metrics_json  TEXT NOT NULL DEFAULT '{}',
  path          TEXT NOT NULL DEFAULT '',
  artifacts_pruned INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL DEFAULT '',
  promoted_by   TEXT,
  promoted_at   TEXT,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aml_models_lookup ON aml_models(product_id, recipe_id, purpose, stage);
-- v16:定时任务(scheduled_tasks)—— 绑定 Channel 的周期任务编排。
-- mode='interval' 按 interval_ms 固定间隔触发;mode='daily' 按 daily_time(HH:MM,本地时区)每日定点触发。
-- state 为 runtime 视图状态:idle 待命 / waiting Channel 忙等手中任务收口 / running 触发在途 /
-- disabled 已停用 / failed 连续失败熔断。next_run_at 持久化:重启后按此判定补跑(catch-up 一次)。
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                  -- 计划名(列表呈现)
  title           TEXT NOT NULL,                  -- 到点提交给 Channel 的任务标题
  description     TEXT NOT NULL DEFAULT '',       -- 到点提交的任务描述
  mode            TEXT NOT NULL DEFAULT 'interval',  -- 'interval' | 'daily'
  interval_ms     INTEGER NOT NULL DEFAULT 0,     -- interval 模式:触发间隔(毫秒;下限 60s)
  daily_time      TEXT NOT NULL DEFAULT '',       -- daily 模式:每日触发时刻 'HH:MM'(本地时区)
  enabled         INTEGER NOT NULL DEFAULT 1,
  state           TEXT NOT NULL DEFAULT 'idle',   -- idle|waiting|running|disabled|failed
  last_run_at     TEXT,
  next_run_at     TEXT,
  last_task_id    TEXT,
  run_count       INTEGER NOT NULL DEFAULT 0,     -- 累计触发次数(成功+失败)
  fail_count      INTEGER NOT NULL DEFAULT 0,     -- 累计失败次数
  consecutive_failures INTEGER NOT NULL DEFAULT 0,  -- 当前连续失败计数(成功即清零)
  max_consecutive_failures INTEGER NOT NULL DEFAULT 0,  -- 熔断阈值(0 = 不自动停用)
  owner_user_id   TEXT,                           -- 创建者(全局用户系统 id)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_channel ON scheduled_tasks(channel_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled, next_run_at);
-- v16:定时任务运行历史(每次触发的留痕;保留策略由 repo 层按 schedule 裁剪至最近 50 条)
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id            TEXT PRIMARY KEY,
  schedule_id   TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  trigger_kind  TEXT NOT NULL DEFAULT 'timer',    -- 'timer' | 'manual'
  task_id       TEXT,                             -- 提交成功的 channel 任务 id(提交失败为 NULL)
  state         TEXT NOT NULL DEFAULT 'RUNNING',  -- RUNNING|COMPLETED|FAILED
  error         TEXT NOT NULL DEFAULT '',
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_schedule ON scheduled_task_runs(schedule_id, started_at DESC);
-- v17:人类群聊 / 成员权限 / 用户级通知 / 可靠投递 / HITL 持久化。
-- 约定:user_id 一律为「全局用户系统」的 id(server/repositories/user.repository),
-- 不是本库遗留 users 表。跨库不加外键(见主计划迁移注记),仅建索引。

-- v17.1 channel_members:登录用户作为 Channel 群成员(owner 亦有一条 active 记录)。
-- status: active | left | removed | pending(owner_approve 待批准)
-- generation: 同一用户反复加入/退出时递增;旧审批资格不因重新加入而恢复(§13.7)
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',   -- owner | member
  status      TEXT NOT NULL DEFAULT 'active',   -- active | left | removed | pending
  generation  INTEGER NOT NULL DEFAULT 1,
  joined_at   TEXT NOT NULL,
  left_at     TEXT,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id, status);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel ON channel_members(channel_id, status);

-- v17.2 chat_messages:群聊事实表(与 Agent mailbox 双轨,共享关联 ID)。
-- client_message_id 幂等键(同一 channel 内唯一);requester_user_id 为提问者稳定用户 id。
CREATE TABLE IF NOT EXISTS chat_messages (
  id                    TEXT PRIMARY KEY,
  channel_id            TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_type           TEXT NOT NULL,          -- user | agent | system
  sender_id             TEXT NOT NULL,
  sender_name           TEXT NOT NULL DEFAULT '',
  text                  TEXT NOT NULL,
  mentions_json         TEXT NOT NULL DEFAULT '[]',
  reply_to_id           TEXT,
  requester_user_id     TEXT,
  source_chat_message_id TEXT,
  client_message_id     TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE(channel_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_source ON chat_messages(source_chat_message_id);

-- v17.3 chat_deliveries:群聊 → Agent mailbox 投递台账(同消息同 Agent 唯一)。
CREATE TABLE IF NOT EXISTS chat_deliveries (
  id                  TEXT PRIMARY KEY,
  chat_message_id     TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  channel_id          TEXT NOT NULL,
  target_agent_id     TEXT NOT NULL,
  mailbox_message_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|consumed|failed|cancelled
  error               TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(chat_message_id, target_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_deliveries_message ON chat_deliveries(chat_message_id);
CREATE INDEX IF NOT EXISTS idx_chat_deliveries_agent ON chat_deliveries(target_agent_id, status);
-- Agent 回复关联链热路径:agentReplyToChat 按 mailboxMessageId 反查群聊来源
CREATE INDEX IF NOT EXISTS idx_chat_deliveries_mailbox ON chat_deliveries(mailbox_message_id);
-- 成员撤权:按 (channel, agent) 批量取消 pending 投递
CREATE INDEX IF NOT EXISTS idx_chat_deliveries_channel_agent ON chat_deliveries(channel_id, target_agent_id, status);

-- v17.4 user_notifications:按 recipientUserId 定向的用户通知事实源(游标补发)。
-- event_id 幂等键:同 (recipient, event) 只落一行。
CREATE TABLE IF NOT EXISTS user_notifications (
  id                 TEXT PRIMARY KEY,
  recipient_user_id  TEXT NOT NULL,
  channel_id         TEXT REFERENCES channels(id) ON DELETE CASCADE,
  chat_message_id    TEXT,
  hitl_kind          TEXT,
  hitl_id            TEXT,
  event_id           TEXT NOT NULL,
  type               TEXT NOT NULL,             -- mention | agent_reply | hitl_request | hitl_resolved | member
  title              TEXT NOT NULL DEFAULT '',
  body               TEXT NOT NULL DEFAULT '',
  payload_json       TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  read_at            TEXT,
  UNIQUE(recipient_user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_recipient ON user_notifications(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread ON user_notifications(recipient_user_id, read_at);
-- 发布路径按 eventId 反查刚写入的通知;撤权时按 (channel, recipient) 清理
CREATE INDEX IF NOT EXISTS idx_user_notifications_event ON user_notifications(event_id);
CREATE INDEX IF NOT EXISTS idx_user_notifications_channel ON user_notifications(channel_id, recipient_user_id);

-- v17.5 outbox_events:事务内待发布事件(消息落库与投递同事务;广播失败不回滚消息)。
CREATE TABLE IF NOT EXISTS outbox_events (
  id              TEXT PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | published | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  published_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status, created_at);

-- v17.6 hitl_requests:HITL 持久化事实源(registry 降级为缓存门面)。
-- status: pending|resolving|answered|approved|rejected|cancelled|expired|failed|delivery_unknown|reconciling
-- policy_snapshot_json:创建时策略快照(资格判定 = 创建时资格 ∩ 当前资格,§13.4)
CREATE TABLE IF NOT EXISTS hitl_requests (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL,          -- providerKind:omp-dialog|dcw-approval|codex-approval|...
  request_type           TEXT NOT NULL DEFAULT 'approval', -- question | approval
  native_request_id      TEXT NOT NULL DEFAULT '',
  channel_id             TEXT NOT NULL,
  agent_id               TEXT NOT NULL,
  agent_name             TEXT NOT NULL DEFAULT '',
  session_id             TEXT NOT NULL DEFAULT '',
  harness                TEXT NOT NULL DEFAULT '',
  mode                   TEXT NOT NULL DEFAULT 'approval',
  title                  TEXT NOT NULL DEFAULT '',
  detail                 TEXT NOT NULL DEFAULT '',
  options_json           TEXT NOT NULL DEFAULT '[]',
  questions_json         TEXT NOT NULL DEFAULT '[]',
  schema_json            TEXT NOT NULL DEFAULT '{}',
  status                 TEXT NOT NULL DEFAULT 'pending',
  policy                 TEXT NOT NULL DEFAULT 'owner_only', -- owner_only | any_member
  policy_snapshot_json   TEXT NOT NULL DEFAULT '{}',
  policy_version         INTEGER NOT NULL DEFAULT 0,
  decision_id            TEXT,
  responder_user_id      TEXT,
  decision_json          TEXT NOT NULL DEFAULT '{}',
  native_confirmed       INTEGER NOT NULL DEFAULT 0,
  error                  TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  resolved_at            TEXT,
  expires_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_hitl_requests_status ON hitl_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hitl_requests_channel ON hitl_requests(channel_id, status);
CREATE INDEX IF NOT EXISTS idx_hitl_requests_agent ON hitl_requests(agent_id, status);`

// ===== 默认种子数据(首轮初始化注入;owner NULL = 公共资源,所有登录用户只读共享) =====

/** 默认 Agent 模板(id 固定,幂等) */
