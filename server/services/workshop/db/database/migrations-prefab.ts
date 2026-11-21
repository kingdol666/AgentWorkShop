/**
 * AgentPrefab 附加列迁移（2026-11-21）。
 *
 * 只做固定表/固定列的加列，既有行默认空（无绑定/无快照），不推断权限。
 * 必须在 tasks/channel_agents 既有 rebuild 之后仍保留：加列幂等，open.ts 每次启动调用。
 */
import type { DatabaseSync } from 'node:sqlite'

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

export function migratePrefabColumns(db: DatabaseSync): void {
  if (!hasColumn(db, 'channel_agents', 'prefab_binding_json')) {
    db.exec('ALTER TABLE channel_agents ADD COLUMN prefab_binding_json TEXT NOT NULL DEFAULT \'\'')
  }
  if (!hasColumn(db, 'channel_sessions', 'prefab_snapshot_json')) {
    db.exec('ALTER TABLE channel_sessions ADD COLUMN prefab_snapshot_json TEXT NOT NULL DEFAULT \'\'')
  }
  if (!hasColumn(db, 'channel_sessions', 'prefab_snapshot_hash')) {
    db.exec('ALTER TABLE channel_sessions ADD COLUMN prefab_snapshot_hash TEXT NOT NULL DEFAULT \'\'')
  }
  if (!hasColumn(db, 'project_work_items', 'prefab_snapshot_json')) {
    db.exec('ALTER TABLE project_work_items ADD COLUMN prefab_snapshot_json TEXT NOT NULL DEFAULT \'\'')
  }
  if (!hasColumn(db, 'project_work_items', 'prefab_snapshot_hash')) {
    db.exec('ALTER TABLE project_work_items ADD COLUMN prefab_snapshot_hash TEXT NOT NULL DEFAULT \'\'')
  }
}
