/**
 * 会话级 runtime 覆盖（2026-11-26）。
 *
 * 每个 manual session 的 runtime 对象（channel_agents clone 行）可以持久化一份
 * owner/admin 显式编辑的低信任覆盖；没有行 = 完全继承成员基础配置。
 * 不改 SCHEMA_SQL 契约版本（与 migrations-prefab.ts 的增量模式一致），
 * 仅以 CREATE TABLE IF NOT EXISTS 补齐；fresh 库与旧库走同一条迁移。
 */
import type { DatabaseSync } from 'node:sqlite'

export function migrateSessionRuntimeOverrides(db: DatabaseSync): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS session_runtime_overrides (
      session_id TEXT NOT NULL REFERENCES channel_sessions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES channel_agents(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (session_id, agent_id)
    )
  `).run()
  db.prepare('CREATE INDEX IF NOT EXISTS idx_session_runtime_overrides_agent ON session_runtime_overrides(agent_id)').run()
}
