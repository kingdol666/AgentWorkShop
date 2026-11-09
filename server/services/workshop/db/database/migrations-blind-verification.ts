/**
 * 独立回读验证表（WP-C1）增量迁移。
 * 一行 = 一条写入台账的独立验证结论（match/mismatch/inconclusive）。
 * 只建表不重建，幂等。
 */
import type { DatabaseSync } from 'node:sqlite'

/** 建表 DDL（逐条静态语句；不拼接任何运行时输入） */
const DDL: string[] = [
  'CREATE TABLE IF NOT EXISTS blind_verifications ('
  + ' id TEXT PRIMARY KEY,'
  + ' event_id TEXT NOT NULL UNIQUE,'
  + ' channel_id TEXT NOT NULL DEFAULT \'\','
  + ' line_id TEXT NOT NULL DEFAULT \'\','
  + ' verdict TEXT NOT NULL,'
  + ' detail TEXT NOT NULL DEFAULT \'\','
  + ' probe_json TEXT NOT NULL DEFAULT \'{}\','
  + ' created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_blind_verifications_channel ON blind_verifications(channel_id, verdict, created_at DESC)',
]

export function migrateBlindVerifications(db: DatabaseSync): void {
  for (const sql of DDL) db.prepare(sql).run()
}
