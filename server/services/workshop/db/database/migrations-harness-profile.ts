/**
 * Harness Profile 表（WP-B1）增量迁移。
 *
 * 「可进化外壳」的版本化载体：per-Channel 的经验包选择 + prompt overlay 文本。
 * 状态机 candidate → shadow → active → superseded（晋升/回滚在 WP-B3/B4）。
 * 只建表不重建，幂等。
 */
import type { DatabaseSync } from 'node:sqlite'

/** 建表 DDL（逐条静态语句；不拼接任何运行时输入） */
const DDL: string[] = [
  'CREATE TABLE IF NOT EXISTS channel_harness_profiles ('
  + ' id TEXT PRIMARY KEY,'
  + ' channel_id TEXT NOT NULL,'
  + ' version INTEGER NOT NULL,'
  + ' status TEXT NOT NULL DEFAULT \'candidate\','
  + ' layers_json TEXT NOT NULL DEFAULT \'{}\','
  + ' origin_json TEXT NOT NULL DEFAULT \'{}\','
  + ' created_by TEXT NOT NULL DEFAULT \'\','
  + ' created_at TEXT NOT NULL,'
  + ' updated_at TEXT NOT NULL,'
  + ' UNIQUE(channel_id, version))',
  'CREATE INDEX IF NOT EXISTS idx_harness_profiles_channel ON channel_harness_profiles(channel_id, status)',
]

export function migrateHarnessProfiles(db: DatabaseSync): void {
  for (const sql of DDL) db.prepare(sql).run()
}
