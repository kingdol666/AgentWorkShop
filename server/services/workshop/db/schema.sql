-- AgentWorkShop 持久化层建表脚本(node:sqlite)
-- v3:Agent 模板(agents)+ Channel 实例(channel_agents)分离。
-- 每次把模板放入 channel 都克隆出独立身份 id 的实例。
-- v5:AgentTeam(teams)编组 Agent 模板,可整体批量部署(克隆)到 channel。

CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  lead_agent_id  TEXT,                        -- 主理人(实例 id)
  workspace      TEXT NOT NULL DEFAULT '',    -- channel 独立工作目录(omp cwd)
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  harness     TEXT NOT NULL,                  -- 'mock' | 'claude' | 'omp'
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_agents (
  id          TEXT PRIMARY KEY,               -- 实例身份 id(每次放入 channel 独立生成)
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES agents(id) ON DELETE SET NULL,  -- 来源模板(可空)
  name        TEXT NOT NULL,                  -- 从模板复制
  harness     TEXT NOT NULL,                  -- 从模板复制
  config_json TEXT NOT NULL DEFAULT '{}',     -- 从模板复制
  role        TEXT NOT NULL DEFAULT 'worker', -- 'lead' | 'worker'(按 channel 独立)
  token       TEXT NOT NULL,                  -- MCP 身份凭证(实例级 UUIDv4)
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
  assignee_id    TEXT NOT NULL,               -- 实例身份 id
  creator_id     TEXT,
  title          TEXT NOT NULL,
  description    TEXT,
  state          TEXT NOT NULL,               -- SUBMITTED|ASSIGNED|WORKING|WAITING|COMPLETED|FAILED|CANCELED
  progress       INTEGER NOT NULL DEFAULT 0,  -- 0-100
  retry_count    INTEGER NOT NULL DEFAULT 0,  -- 重派次数(SchedulerLoop reassign 时 +1,>=3 停止重派)
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  history_json   TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);

-- v5:AgentTeam(teams)+ 成员编组(team_members)。
-- 把多个 Agent 模板编成一队,可整体批量部署(克隆)到 channel,免逐个放置。

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
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

-- v16:定时任务(绑定 Channel 的周期任务编排;权威 DDL 在 database.ts SCHEMA_SQL)
-- mode='interval' 固定间隔 / mode='daily' 每日定点(HH:MM 本地时区);
-- state: idle|waiting|running|disabled|failed(runtime 视图状态)。
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  mode            TEXT NOT NULL DEFAULT 'interval',
  interval_ms     INTEGER NOT NULL DEFAULT 0,
  daily_time      TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  state           TEXT NOT NULL DEFAULT 'idle',
  last_run_at     TEXT,
  next_run_at     TEXT,
  last_task_id    TEXT,
  run_count       INTEGER NOT NULL DEFAULT 0,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  max_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  owner_user_id   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_channel ON scheduled_tasks(channel_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled, next_run_at);

-- v16:定时任务运行历史(每次触发留痕;repo 层按 schedule 裁剪至最近 50 条)
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id            TEXT PRIMARY KEY,
  schedule_id   TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  trigger_kind  TEXT NOT NULL DEFAULT 'timer',   -- 'timer' | 'manual'
  task_id       TEXT,
  state         TEXT NOT NULL DEFAULT 'RUNNING', -- RUNNING|COMPLETED|FAILED
  error         TEXT NOT NULL DEFAULT '',
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_schedule ON scheduled_task_runs(schedule_id, started_at DESC);

-- ============================================================================
-- v17:人类群聊 / 成员权限 / 用户级通知 / 可靠投递 / HITL 持久化
-- 权威 DDL 在 database.ts 的 SCHEMA_SQL(内联字符串);本文件为源码文档,两处必须同步。
-- 约定:user_id 一律为「全局用户系统」的 id,不是本库遗留 users 表;跨库不加外键。
-- ============================================================================

-- channel_members:登录用户作为 Channel 群成员(owner 亦有一条 active 记录)。
-- status: active | left | removed | pending(owner_approve 待批准)
-- generation: 反复加入/退出时递增;旧审批资格不因重新加入而恢复。
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

-- chat_messages:群聊事实表(与 Agent mailbox 双轨,共享关联 ID)。
CREATE TABLE IF NOT EXISTS chat_messages (
  id                     TEXT PRIMARY KEY,
  channel_id             TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_type            TEXT NOT NULL,          -- user | agent | system
  sender_id              TEXT NOT NULL,
  sender_name            TEXT NOT NULL DEFAULT '',
  text                   TEXT NOT NULL,
  mentions_json          TEXT NOT NULL DEFAULT '[]',
  reply_to_id            TEXT,
  requester_user_id      TEXT,
  source_chat_message_id TEXT,
  client_message_id      TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  UNIQUE(channel_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_source ON chat_messages(source_chat_message_id);

-- chat_deliveries:群聊 → Agent mailbox 投递台账(同消息同 Agent 唯一)。
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
-- Agent 回复关联链热路径:按 mailboxMessageId 反查群聊来源
CREATE INDEX IF NOT EXISTS idx_chat_deliveries_mailbox ON chat_deliveries(mailbox_message_id);
-- 成员撤权:按 (channel, agent) 批量取消 pending 投递
CREATE INDEX IF NOT EXISTS idx_chat_deliveries_channel_agent ON chat_deliveries(channel_id, target_agent_id, status);

-- user_notifications:按 recipientUserId 定向的用户通知事实源(游标补发)。
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

-- outbox_events:事务内待发布事件(消息落库与投递同事务;广播失败不回滚消息)。
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

-- hitl_requests:HITL 持久化事实源(registry 降级为缓存门面)。
CREATE TABLE IF NOT EXISTS hitl_requests (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL,
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
  policy                 TEXT NOT NULL DEFAULT 'owner_only',
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
CREATE INDEX IF NOT EXISTS idx_hitl_requests_agent ON hitl_requests(agent_id, status);
