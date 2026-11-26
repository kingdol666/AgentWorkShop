/**
 * 会话绑定范围覆盖（product / line / recipes）—— 运行期可改，不再冻结。
 *
 * 创建快照（channel_sessions.binding_snapshot_*）保留为初始/审计基线；
 * 有覆盖行时，执行面以覆盖行为准，并按当前 recipe 定义实时解析版本/hash，
 * 因此新增/删除/改版 recipe 都能在下一回合热切换生效。
 */
export function migrateSessionBindingOverrides(db: { prepare: (sql: string) => { run: () => unknown } }): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS session_binding_overrides (
      session_id TEXT PRIMARY KEY REFERENCES channel_sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0,
      binding_json TEXT NOT NULL,
      binding_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )
  `).run()
}
