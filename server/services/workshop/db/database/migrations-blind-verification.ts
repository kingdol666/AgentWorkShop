/**
 * 独立回读验证表（WP-C1）增量迁移。
 * 一行 = 一条写入台账的独立验证结论（match/mismatch/inconclusive）。
 * task_id 非空时把验证归属到触发它的任务（供 L1 复核与 C4 判据取数）。
 * 只建表/加列不重建，幂等。
 */
import type { DatabaseSync } from 'node:sqlite'

/** 建表 DDL（逐条静态语句；不拼接任何运行时输入） */
const DDL: string[] = [
  'CREATE TABLE IF NOT EXISTS blind_verifications ('
  + ' id TEXT PRIMARY KEY,'
  + ' event_id TEXT NOT NULL UNIQUE,'
  + ' channel_id TEXT NOT NULL DEFAULT \'\','
  + ' line_id TEXT NOT NULL DEFAULT \'\','
  + ' task_id TEXT NOT NULL DEFAULT \'\','
  + ' verdict TEXT NOT NULL,'
  + ' detail TEXT NOT NULL DEFAULT \'\','
  + ' probe_json TEXT NOT NULL DEFAULT \'{}\','
  + ' created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_blind_verifications_channel ON blind_verifications(channel_id, verdict, created_at DESC)',
]

export function migrateBlindVerifications(db: DatabaseSync): void {
  for (const sql of DDL) db.prepare(sql).run()
  // 既有库（表已建但缺 task_id）补列；PRAGMA 检查保证幂等。
  // 补列必须早于 task_id 索引创建（旧表无该列时建索引会 SQL logic error）。
  const cols = db.prepare('PRAGMA table_info(blind_verifications)').all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'task_id')) {
    db.prepare(`ALTER TABLE blind_verifications ADD COLUMN task_id TEXT NOT NULL DEFAULT ''`).run()
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_blind_verifications_task ON blind_verifications(task_id, verdict, created_at DESC)').run()
}
