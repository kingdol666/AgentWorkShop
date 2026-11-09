/**
 * 元层成效表（WP-C3）增量迁移。
 *
 * 「改进的改进」的数据面：每一条改进提案/Profile 晋升的**处理结果**入表，
 * 供 `improvement_stats` 按 action_kind 统计成功率——回答"哪类改进动作有效"。
 * 只建表不重建，幂等。
 */
import type { DatabaseSync } from 'node:sqlite'

/** 建表 DDL（逐条静态语句；不拼接任何运行时输入） */
const DDL: string[] = [
  'CREATE TABLE IF NOT EXISTS improvement_actions ('
  + ' id TEXT PRIMARY KEY,'
  + ' action_kind TEXT NOT NULL,'
  + ' subject_kind TEXT NOT NULL,'
  + ' subject_id TEXT NOT NULL,'
  + ' channel_id TEXT NOT NULL DEFAULT \'\','
  + ' decision TEXT NOT NULL,'
  + ' outcome_delta REAL,'
  + ' detail_json TEXT NOT NULL DEFAULT \'{}\','
  + ' decided_by TEXT NOT NULL DEFAULT \'\','
  + ' decided_at TEXT NOT NULL,'
  + ' UNIQUE(subject_kind, subject_id, decision))',
  'CREATE INDEX IF NOT EXISTS idx_improvement_actions_kind ON improvement_actions(action_kind, decision, decided_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_improvement_actions_channel ON improvement_actions(channel_id, decided_at DESC)',
]

export function migrateImprovementActions(db: DatabaseSync): void {
  for (const sql of DDL) db.prepare(sql).run()
}
