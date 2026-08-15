/**
 * workshop 持久化层入口(node:sqlite)
 * - openWorkshopDb: 打开(或创建)数据库 → PRAGMA(WAL/foreign_keys)→ 建表 + 增量迁移
 * - 行类型:repo 返回的原始 sqlite 行(JSON 列以字符串存储,由上层按需 parseJson)
 *
 * 数据模型(v5:Agent 模板 + AgentTeam 编组 + Channel 实例分离):
 * - agents:         全局可复用 Agent 模板(仅 name/harness/config/enabled,无 channel 绑定)
 * - teams:          AgentTeam(Agent 模板编组,可整体批量部署到 channel)
 * - team_members:   team × agent 模板 成员关系(role 标记部署时采用 lead/worker 角色)
 * - channel_agents: Channel 中的 Agent 实例(每次放入 channel 都克隆出新身份 id,
 *                   name/harness/config 从模板复制,另含独立 role + token)
 * - subscriptions:  订阅按 (channel, 实例, target) 隔离
 * - agent_memories: Agent 持久记忆(FTS5 索引,per-agent 域 + team 共享)
 */
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import type * as sqliteVec from 'sqlite-vec'

const require = createRequire(import.meta.url)

/**
 * 建表 SQL(与 schema.sql 保持同步;内联字符串而非运行时读文件,
 * 避免 Nitro 打包后相对路径失效——schema.sql 保留为源码文档)。
 */
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
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
  assignee_id    TEXT NOT NULL,               -- 实例身份 id(不再 FK 到 agents)
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
END;`

/** channels 表行 */
export interface ChannelRow {
  id: string
  name: string
  description: string
  leadAgentId: string | null
  /** channel 独立工作目录(omp 子进程 cwd;空串表示未设置) */
  workspace: string
  enabled: number
  createdAt: string
  updatedAt: string
}

/** agents 表行(全局 Agent 模板,无 channel 绑定) */
export interface AgentRow {
  id: string
  name: string
  harness: string
  configJson: string
  enabled: number
  createdAt: string
  updatedAt: string
}

/** teams 表行(AgentTeam:Agent 模板的编组,可整体部署到 channel) */
export interface TeamRow {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

/** team_members 表行(team × agent 模板 成员关系;role 为部署时采用的实例角色) */
export interface TeamMemberRow {
  teamId: string
  templateId: string
  role: string
  createdAt: string
}

/** agent_memories 表行(content 为已 CJK 切分存储文本;agentId='__team__' 为团队共享行) */
export interface MemoryRow {
  id: string
  channelId: string
  agentId: string
  kind: 'episodic-task' | 'episodic-peer' | 'semantic'
  title: string
  content: string
  importance: number
  taskId: string | null
  accessCount: number
  lastAccessedAt: string | null
  createdAt: string
}
/** channel_agents 表行(Channel 中的 Agent 实例:独立身份 id + 复制自模板的字段) */
export interface ChannelAgentRow {
  id: string
  channelId: string
  templateId: string | null
  name: string
  harness: string
  configJson: string
  role: string
  token: string
  enabled: number
  createdAt: string
  updatedAt: string
}

/** messages 表行 */
export interface MessageRow {
  id: string
  channelId: string
  taskId: string | null
  fromAgentId: string | null
  toAgentId: string | null
  role: string
  partsJson: string
  metadataJson: string
  state: 'pending' | 'consuming' | 'consumed'
  createdAt: string
  consumedAt: string | null
}

/** subscriptions 表行(channel_id + agent_id + target_agent_id 复合主键) */
export interface SubscriptionRow {
  channelId: string
  agentId: string
  targetAgentId: string
  createdAt: string
}

/** tasks 表行 */
export interface TaskRow {
  id: string
  channelId: string
  parentId: string | null
  assigneeId: string
  creatorId: string | null
  title: string
  description: string | null
  state: string
  progress: number
  retryCount: number
  artifactsJson: string
  historyJson: string
  createdAt: string
  updatedAt: string
}

/**
 * 打开(或创建)workshop 数据库并完成初始化。
 * path 传 ':memory:' 即为内存库(测试用);落盘库由上层决定路径。
 */
export function openWorkshopDb(path: string): DatabaseSync {
  // allowExtension + 尝试加载 sqlite-vec(向量检索);失败静默降级纯 FTS(受控环境可能禁扩展)
  const db = new DatabaseSync(path, { allowExtension: true })
  try {
    const { getLoadablePath } = require('sqlite-vec') as typeof sqliteVec
    db.loadExtension(getLoadablePath())
  }
  catch {
    // 扩展不可用:记忆系统自动退化为 FTS-only(vecInit 将失败并禁用向量)
  }
  initWorkshopDb(db)
  return db
}

/** 对已打开的库执行初始化:WAL + 外键约束 + 建表 + 增量迁移 */
export function initWorkshopDb(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA_SQL)
  migrateLegacySchema(db)
  migrateMissingForeignKeys(db)
}

/** 检测表上是否存在 指向某表的列级外键 */
function hasForeignKey(db: DatabaseSync, table: string, from: string, refTable: string): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string, table: string }>
  return rows.some(r => r.from === from && r.table === refTable)
}

/**
 * v3 → v4 迁移:补齐 tasks/subscriptions 缺失的外键。
 * 早期版本(v1→v3 迁移产物、旧建表脚本)的这两张表没有 REFERENCES ... ON DELETE CASCADE,
 * 而 CREATE TABLE IF NOT EXISTS 不会升级既有表 → channel 删除时 tasks/subscriptions 成孤儿数据。
 * 重建前先清除孤儿行(其 channel 已不存在,不可达;新外键会使 INSERT 失败)。
 */
function migrateMissingForeignKeys(db: DatabaseSync): void {
  const needTasks = !hasForeignKey(db, 'tasks', 'channel_id', 'channels')
  const needSubs = !hasForeignKey(db, 'subscriptions', 'channel_id', 'channels')
  if (!needTasks && !needSubs) return

  db.exec('PRAGMA foreign_keys = OFF;')
  try {
    if (needTasks) {
      db.exec(`DELETE FROM tasks WHERE channel_id NOT IN (SELECT id FROM channels);
      CREATE TABLE tasks_new (
        id             TEXT PRIMARY KEY,
        channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        parent_id      TEXT,
        assignee_id    TEXT NOT NULL,
        creator_id     TEXT,
        title          TEXT NOT NULL,
        description    TEXT,
        state          TEXT NOT NULL,
        progress       INTEGER NOT NULL DEFAULT 0,
        retry_count    INTEGER NOT NULL DEFAULT 0,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        history_json   TEXT NOT NULL DEFAULT '[]',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      INSERT INTO tasks_new SELECT id, channel_id, parent_id, assignee_id, creator_id, title, description, state, progress, retry_count, artifacts_json, history_json, created_at, updated_at FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);`)
    }
    if (needSubs) {
      db.exec(`DELETE FROM subscriptions
        WHERE channel_id NOT IN (SELECT id FROM channels)
           OR agent_id NOT IN (SELECT id FROM channel_agents);
      CREATE TABLE subscriptions_new (
        channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        agent_id        TEXT NOT NULL REFERENCES channel_agents(id) ON DELETE CASCADE,
        target_agent_id TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_id, target_agent_id)
      );
      INSERT INTO subscriptions_new SELECT channel_id, agent_id, target_agent_id, created_at FROM subscriptions;
      DROP TABLE subscriptions;
      ALTER TABLE subscriptions_new RENAME TO subscriptions;`)
    }
  }
  finally {
    db.exec('PRAGMA foreign_keys = ON;')
  }
}

/**
 * 旧库迁移到 v3。仅当 agents 仍含 channel_id 列(v1:agents 内嵌 channel_id/role/token)时执行。
 * 迁移过程临时关闭外键,避免 DROP TABLE 触发级联;v1 的 agent id 保留为实例 id,
 * 使 messages/tasks/subscriptions 对 agent 的既有引用继续有效。
 */
function migrateLegacySchema(db: DatabaseSync): void {
  const channelsCols = db.prepare(`PRAGMA table_info(channels)`).all() as Array<{ name: string }>
  if (!channelsCols.some(c => c.name === 'workspace')) {
    db.exec(`ALTER TABLE channels ADD COLUMN workspace TEXT NOT NULL DEFAULT ''`)
  }

  const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
  const isV1 = agentCols.some(c => c.name === 'channel_id')
  if (!isV1) return

  db.exec('PRAGMA foreign_keys = OFF;')
  try {
    // 1. subscriptions 补 channel_id(从旧 agents.channel_id 推导),agent_id 指向实例
    const subCols = db.prepare(`PRAGMA table_info(subscriptions)`).all() as Array<{ name: string }>
    if (!subCols.some(c => c.name === 'channel_id')) {
      db.exec(`CREATE TABLE subscriptions_new (
        channel_id      TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_id, target_agent_id)
      );
      INSERT INTO subscriptions_new (channel_id, agent_id, target_agent_id, created_at)
        SELECT a.channel_id, s.agent_id, s.target_agent_id, s.created_at
        FROM subscriptions s JOIN agents a ON a.id = s.agent_id
        WHERE s.target_agent_id IS NOT NULL;
      DROP TABLE subscriptions;
      ALTER TABLE subscriptions_new RENAME TO subscriptions;`)
    }

    // 2. channel_agents ← v1 agents(id 保留为实例 id;template_id 置空)
    db.exec(`INSERT INTO channel_agents (id, channel_id, template_id, name, harness, config_json, role, token, enabled, created_at, updated_at)
      SELECT id, channel_id, NULL, name, harness, config_json, role, token, enabled, created_at, updated_at FROM agents;`)

    // 3. tasks 去 assignee_id 的 agents FK(旧库指向 agents,现指向实例 id)
    db.exec(`CREATE TABLE tasks_new (
      id             TEXT PRIMARY KEY,
      channel_id     TEXT NOT NULL,
      parent_id      TEXT,
      assignee_id    TEXT NOT NULL,
      creator_id     TEXT,
      title          TEXT NOT NULL,
      description    TEXT,
      state          TEXT NOT NULL,
      progress       INTEGER NOT NULL DEFAULT 0,
      retry_count    INTEGER NOT NULL DEFAULT 0,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      history_json   TEXT NOT NULL DEFAULT '[]',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    INSERT INTO tasks_new SELECT id, channel_id, parent_id, assignee_id, creator_id, title, description, state, progress, retry_count, artifacts_json, history_json, created_at, updated_at FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);`)

    // 4. agents 重建为模板表(旧数据已迁到 channel_agents,模板表清空)
    db.exec(`CREATE TABLE agents_new (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      harness     TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    DROP TABLE agents;
    ALTER TABLE agents_new RENAME TO agents;`)
  }
  finally {
    db.exec('PRAGMA foreign_keys = ON;')
  }
}

/** 解析 JSON 列;解析失败返回 fallback(默认值) */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback
  try {
    return JSON.parse(text) as T
  }
  catch {
    return fallback
  }
}
