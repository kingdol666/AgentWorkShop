/**
 * 时序有效性 + 记忆链接（批次 K，2026-11-27）。
 *  - valid_from/valid_to/recorded_at/superseded_by：失效不删除，默认检索排除失效，asOf 可回看；
 *  - memory_links：supports/contradicts/supersedes/derived_from。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'

export function migrateMemoryValidity(db: DatabaseSync): void {
  migrateAddColumn(db, 'agent_memories', 'valid_from', 'TEXT')
  migrateAddColumn(db, 'agent_memories', 'valid_to', 'TEXT')
  migrateAddColumn(db, 'agent_memories', 'recorded_at', 'TEXT')
  migrateAddColumn(db, 'agent_memories', 'superseded_by', 'TEXT')
  // 既有行：valid_from=created_at（幂等；不回填 valid_to）
  db.prepare(`UPDATE agent_memories SET valid_from = created_at WHERE valid_from IS NULL`).run()
  db.prepare(`UPDATE agent_memories SET recorded_at = created_at WHERE recorded_at IS NULL`).run()
  db.prepare('CREATE INDEX IF NOT EXISTS idx_memories_valid ON agent_memories(valid_to, valid_from)').run()

  db.prepare([
    'CREATE TABLE IF NOT EXISTS memory_links (',
    '  id         TEXT PRIMARY KEY,',
    '  src_id     TEXT NOT NULL,',
    '  dst_id     TEXT NOT NULL,',
    '  relation   TEXT NOT NULL,',
    '  created_by TEXT NOT NULL DEFAULT \'\',',
    '  created_at TEXT NOT NULL,',
    '  UNIQUE(src_id, dst_id, relation)',
    ')',
  ].join('\n')).run()
  db.prepare('CREATE INDEX IF NOT EXISTS idx_memory_links_src ON memory_links(src_id, relation)').run()
  db.prepare('CREATE INDEX IF NOT EXISTS idx_memory_links_dst ON memory_links(dst_id, relation)').run()
}
