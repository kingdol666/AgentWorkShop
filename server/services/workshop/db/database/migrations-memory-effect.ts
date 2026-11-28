/**
 * 记忆效果归因持久层（批次 H，2026-11-27）。
 * 只建表/索引，不改 SCHEMA_SQL。
 */
import type { DatabaseSync } from 'node:sqlite'

const LOG_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_injection_log (',
  '  id         TEXT PRIMARY KEY,',
  '  channel_id TEXT NOT NULL,',
  '  agent_id   TEXT NOT NULL,',
  '  session_id TEXT NOT NULL DEFAULT \'\',',
  '  task_id    TEXT NOT NULL DEFAULT \'\',',
  '  refs_json  TEXT NOT NULL DEFAULT \'[]\',',
  '  created_at TEXT NOT NULL',
  ')',
].join('\n')

const STATS_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_effect_stats (',
  '  memory_id   TEXT PRIMARY KEY,',
  '  uses        INTEGER NOT NULL DEFAULT 0,',
  '  successes   INTEGER NOT NULL DEFAULT 0,',
  '  failures    INTEGER NOT NULL DEFAULT 0,',
  '  flagged     INTEGER NOT NULL DEFAULT 0,',
  '  restored_at TEXT,',
  '  updated_at  TEXT NOT NULL',
  ')',
].join('\n')

const ATTR_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_effect_attributions (',
  '  id           TEXT PRIMARY KEY,',
  '  memory_id    TEXT NOT NULL,',
  '  task_id      TEXT NOT NULL,',
  '  injection_id TEXT NOT NULL DEFAULT \'\',',
  '  outcome      TEXT NOT NULL,',
  '  created_at   TEXT NOT NULL,',
  '  UNIQUE(task_id, memory_id)',
  ')',
].join('\n')

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_injection_log_task ON memory_injection_log(task_id)',
  'CREATE INDEX IF NOT EXISTS idx_injection_log_created ON memory_injection_log(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_effect_attributions_memory ON memory_effect_attributions(memory_id)',
]

export function migrateMemoryEffect(db: DatabaseSync): void {
  db.prepare(LOG_DDL).run()
  db.prepare(STATS_DDL).run()
  db.prepare(ATTR_DDL).run()
  for (const sql of INDEXES) db.prepare(sql).run()
}
