/**
 * Memory Fabric：Core Blocks / 记忆文件 / Runtime Working Memory（批次 J，2026-11-27）。
 * 只建表/索引，不改 SCHEMA_SQL。
 */
import type { DatabaseSync } from 'node:sqlite'

const BLOCKS_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_blocks (',
  '  id           TEXT PRIMARY KEY,',
  '  scope_id     TEXT NOT NULL,',
  '  scope_kind   TEXT NOT NULL DEFAULT \'channel\',',
  '  scope_key    TEXT NOT NULL DEFAULT \'\',',
  '  runtime_id   TEXT NOT NULL DEFAULT \'\',',
  '  agent_id     TEXT NOT NULL DEFAULT \'\',',
  '  session_id   TEXT NOT NULL DEFAULT \'\',',
  '  channel_id   TEXT NOT NULL DEFAULT \'\',',
  '  label        TEXT NOT NULL,',
  '  value        TEXT NOT NULL DEFAULT \'\',',
  '  limit_chars  INTEGER NOT NULL DEFAULT 2000,',
  '  description  TEXT NOT NULL DEFAULT \'\',',
  '  locked       INTEGER NOT NULL DEFAULT 0,',
  '  revision     INTEGER NOT NULL DEFAULT 1,',
  '  updated_by   TEXT NOT NULL DEFAULT \'\',',
  '  updated_at   TEXT NOT NULL,',
  '  UNIQUE(scope_id, label)',
  ')',
].join('\n')

const BLOCK_REV_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_block_revisions (',
  '  id         TEXT PRIMARY KEY,',
  '  block_id   TEXT NOT NULL,',
  '  revision   INTEGER NOT NULL,',
  '  value      TEXT NOT NULL,',
  '  updated_by TEXT NOT NULL DEFAULT \'\',',
  '  created_at TEXT NOT NULL,',
  '  UNIQUE(block_id, revision)',
  ')',
].join('\n')

const DOCS_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_documents (',
  '  id           TEXT PRIMARY KEY,',
  '  scope_id     TEXT NOT NULL,',
  '  scope_kind   TEXT NOT NULL DEFAULT \'channel\',',
  '  scope_key    TEXT NOT NULL DEFAULT \'\',',
  '  runtime_id   TEXT NOT NULL DEFAULT \'\',',
  '  session_id   TEXT NOT NULL DEFAULT \'\',',
  '  channel_id   TEXT NOT NULL DEFAULT \'\',',
  '  path         TEXT NOT NULL,',
  '  content      TEXT NOT NULL DEFAULT \'\',',
  '  content_hash TEXT NOT NULL DEFAULT \'\',',
  '  size         INTEGER NOT NULL DEFAULT 0,',
  '  revision     INTEGER NOT NULL DEFAULT 1,',
  '  author_kind  TEXT NOT NULL DEFAULT \'agent\',',
  '  author_id    TEXT NOT NULL DEFAULT \'\',',
  '  deleted_at   TEXT,',
  '  created_at   TEXT NOT NULL,',
  '  updated_at   TEXT NOT NULL,',
  '  UNIQUE(scope_id, path)',
  ')',
].join('\n')

const DOC_REV_DDL = [
  'CREATE TABLE IF NOT EXISTS memory_document_revisions (',
  '  id           TEXT PRIMARY KEY,',
  '  document_id  TEXT NOT NULL,',
  '  revision     INTEGER NOT NULL,',
  '  content      TEXT NOT NULL,',
  '  content_hash TEXT NOT NULL,',
  '  author_kind  TEXT NOT NULL DEFAULT \'agent\',',
  '  author_id    TEXT NOT NULL DEFAULT \'\',',
  '  deleted_at   TEXT,',
  '  created_at   TEXT NOT NULL,',
  '  UNIQUE(document_id, revision)',
  ')',
].join('\n')

const WORKING_DDL = [
  'CREATE TABLE IF NOT EXISTS runtime_working_memory (',
  '  runtime_id TEXT NOT NULL,',
  '  session_id TEXT NOT NULL DEFAULT \'\',',
  '  task_id    TEXT NOT NULL DEFAULT \'\',',
  '  key        TEXT NOT NULL,',
  '  value      TEXT NOT NULL DEFAULT \'\',',
  '  revision   INTEGER NOT NULL DEFAULT 1,',
  '  expires_at TEXT,',
  '  updated_at TEXT NOT NULL,',
  '  PRIMARY KEY(runtime_id, session_id, task_id, key)',
  ')',
].join('\n')

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memory_blocks_scope ON memory_blocks(scope_id, label)',
  'CREATE INDEX IF NOT EXISTS idx_memory_docs_scope ON memory_documents(scope_id, path)',
  'CREATE INDEX IF NOT EXISTS idx_memory_docs_channel ON memory_documents(channel_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_runtime_working_scope ON runtime_working_memory(runtime_id, session_id, task_id)',
  'CREATE INDEX IF NOT EXISTS idx_runtime_working_expire ON runtime_working_memory(expires_at)',
]

export function migrateMemoryBlocks(db: DatabaseSync): void {
  db.prepare(BLOCKS_DDL).run()
  db.prepare(BLOCK_REV_DDL).run()
  db.prepare(DOCS_DDL).run()
  db.prepare(DOC_REV_DDL).run()
  db.prepare(WORKING_DDL).run()
  for (const sql of INDEXES) db.prepare(sql).run()
}
