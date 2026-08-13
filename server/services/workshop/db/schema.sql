-- AgentWorkShop 持久化层建表脚本(node:sqlite)
-- 严格对应设计文档 §7 的 5 张表 + 3 个索引。

CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  lead_agent_id  TEXT,                        -- 主理人
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  harness     TEXT NOT NULL,                  -- 'mock' | 'claude' | 'omp'
  role        TEXT NOT NULL DEFAULT 'worker', -- 'lead' | 'worker'
  token       TEXT NOT NULL,                  -- MCP 身份凭证(UUIDv4,创建时生成)
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

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
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  target_agent_id TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (agent_id, target_agent_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  parent_id      TEXT,
  assignee_id    TEXT NOT NULL REFERENCES agents(id),
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
