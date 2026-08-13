/**
 * workshop 持久化层入口(node:sqlite)
 * - openWorkshopDb: 打开(或创建)数据库 → PRAGMA(WAL/foreign_keys)→ 建表
 * - 行类型:repo 返回的原始 sqlite 行(JSON 列以字符串存储,由上层按需 parseJson)
 */
import { DatabaseSync } from 'node:sqlite'

/**
 * 建表 SQL(与 schema.sql 保持同步;内联字符串而非运行时读文件,
 * 避免 Nitro 打包后相对路径失效——schema.sql 保留为源码文档)。
 */
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  lead_agent_id  TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  harness     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'worker',
  token       TEXT NOT NULL,
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
  role          TEXT NOT NULL,
  parts_json    TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'pending',
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
  state          TEXT NOT NULL,
  progress       INTEGER NOT NULL DEFAULT 0,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  history_json   TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, state);`

/** channels 表行 */
export interface ChannelRow {
  id: string
  name: string
  description: string
  leadAgentId: string | null
  enabled: number
  createdAt: string
  updatedAt: string
}

/** agents 表行 */
export interface AgentRow {
  id: string
  channelId: string
  name: string
  harness: string
  role: string
  token: string
  configJson: string
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

/** subscriptions 表行(agent_id + target_agent_id 复合主键) */
export interface SubscriptionRow {
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
  const db = new DatabaseSync(path)
  initWorkshopDb(db)
  return db
}

/** 对已打开的库执行初始化:WAL + 外键约束 + 建表 */
export function initWorkshopDb(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA_SQL)
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
