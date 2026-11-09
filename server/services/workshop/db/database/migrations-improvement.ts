/**
 * RSI 改进提案表（WP-D2）增量迁移。
 *
 * 「提案」是学习环与写治理之间的**唯一交接面**：反射器只产出带证据的候选，
 * 真正的写动作仍必须走既有 HITL（recipe_update / kb_agent ingest）。
 * 表只加不重建；既有库无该表 → 直接建（幂等）。
 */
import type { DatabaseSync } from 'node:sqlite'

/** 建表 DDL（逐条静态语句；不拼接任何运行时输入） */
const DDL: string[] = [
  'CREATE TABLE IF NOT EXISTS improvement_proposals ('
  + ' id TEXT PRIMARY KEY,'
  + ' kind TEXT NOT NULL,'
  + ' channel_id TEXT NOT NULL DEFAULT \'\','
  + ' line_id TEXT NOT NULL DEFAULT \'\','
  + ' recipe_id TEXT NOT NULL DEFAULT \'\','
  + ' source_kind TEXT NOT NULL,'
  + ' source_id TEXT NOT NULL,'
  + ' dedup_key TEXT NOT NULL UNIQUE,'
  + ' title TEXT NOT NULL,'
  + ' detail TEXT NOT NULL DEFAULT \'\','
  + ' evidence_json TEXT NOT NULL DEFAULT \'\','
  + ' status TEXT NOT NULL DEFAULT \'pending\','
  + ' decided_by TEXT NOT NULL DEFAULT \'\','
  + ' decided_at TEXT,'
  + ' created_at TEXT NOT NULL,'
  + ' updated_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_improvement_status ON improvement_proposals(status, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_improvement_channel ON improvement_proposals(channel_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_improvement_recipe ON improvement_proposals(recipe_id, status)',
]

export function migrateImprovementProposals(db: DatabaseSync): void {
  for (const sql of DDL) db.prepare(sql).run()
}
