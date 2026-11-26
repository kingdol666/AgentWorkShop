/**
 * Curator 汇整层持久化（批次 E，2026-11-27）。
 *
 * 只加表/索引，不改 `SCHEMA_SQL`。三张表各司其职：
 *  - memory_curation_runs：每次运行（扫描/合格/来源数/模式/回退原因）；
 *  - memory_curation_sources：文档 → 来源记忆（可追溯，不复制正文）；
 *  - memory_curation_state：作用域水位（来源 hash / 上次 run），用于增量幂等。
 */
import type { DatabaseSync } from 'node:sqlite'

const RUNS_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_curation_runs (',
  '  id             TEXT PRIMARY KEY,',
  '  channel_id     TEXT NOT NULL,',
  '  scope_kind     TEXT NOT NULL DEFAULT \'channel\',',
  '  scope_key      TEXT NOT NULL DEFAULT \'\',',
  '  product_id     TEXT NOT NULL DEFAULT \'\',',
  '  mode           TEXT NOT NULL DEFAULT \'template\',',
  '  status         TEXT NOT NULL DEFAULT \'running\',',
  '  scanned        INTEGER NOT NULL DEFAULT 0,',
  '  eligible       INTEGER NOT NULL DEFAULT 0,',
  '  source_count   INTEGER NOT NULL DEFAULT 0,',
  '  revision       INTEGER NOT NULL DEFAULT 0,',
  '  fallback_reason TEXT NOT NULL DEFAULT \'\',',
  '  error          TEXT NOT NULL DEFAULT \'\',',
  '  started_at     TEXT NOT NULL,',
  '  finished_at    TEXT',
  ')',
].join('\n')

const SOURCES_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_curation_sources (',
  '  id               TEXT PRIMARY KEY,',
  '  curated_id       TEXT NOT NULL,',
  '  source_memory_id TEXT NOT NULL,',
  '  run_id           TEXT NOT NULL DEFAULT \'\',',
  '  relation         TEXT NOT NULL DEFAULT \'derived_from\',',
  '  created_at       TEXT NOT NULL',
  ')',
].join('\n')

const STATE_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_curation_state (',
  '  curated_id        TEXT PRIMARY KEY,',
  '  channel_id        TEXT NOT NULL,',
  '  scope_kind        TEXT NOT NULL DEFAULT \'channel\',',
  '  scope_key         TEXT NOT NULL DEFAULT \'\',',
  '  last_source_hash  TEXT NOT NULL DEFAULT \'\',',
  '  last_source_count INTEGER NOT NULL DEFAULT 0,',
  '  last_run_id       TEXT NOT NULL DEFAULT \'\',',
  '  revision          INTEGER NOT NULL DEFAULT 0,',
  '  updated_at        TEXT NOT NULL',
  ')',
].join('\n')

const INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_curation_sources ON memory_curation_sources(curated_id, source_memory_id)',
  'CREATE INDEX IF NOT EXISTS idx_curation_sources_run ON memory_curation_sources(run_id)',
  'CREATE INDEX IF NOT EXISTS idx_curation_runs_scope ON memory_curation_runs(channel_id, started_at DESC)',
]

export function migrateMemoryCuration(db: DatabaseSync): void {
  db.prepare(RUNS_DDL).run()
  db.prepare(SOURCES_DDL).run()
  db.prepare(STATE_DDL).run()
  for (const sql of INDEXES) db.prepare(sql).run()
}
