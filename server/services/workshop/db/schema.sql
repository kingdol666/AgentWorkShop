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
