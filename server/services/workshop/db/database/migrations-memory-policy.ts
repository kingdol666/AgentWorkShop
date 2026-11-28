/**
 * Memory Fabric 访问策略（批次 I，2026-11-27）。
 *
 * `memory_access_mode`：
 *  - inherit（默认）：沿用现状（channel 档 session/shared 语义不变）；
 *  - isolated：不读 workspace/line/product 记忆（只读本频道/本会话）；
 *  - disabled：不读不写（incognito）；
 *  - readonly：可读、不写。
 *
 * 与既有 `channel_sessions.memory_policy(session|shared)` 分栏：后者是写入作用域，
 * 本列是访问策略，不复用/改写旧列。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'

export function migrateMemoryAccessMode(db: DatabaseSync): void {
  migrateAddColumn(db, 'channels', 'memory_access_mode', 'TEXT NOT NULL DEFAULT \'inherit\'')
  migrateAddColumn(db, 'channel_sessions', 'memory_access_mode', 'TEXT NOT NULL DEFAULT \'inherit\'')
  db.prepare(`UPDATE channels SET memory_access_mode = 'inherit' WHERE memory_access_mode NOT IN ('inherit','isolated','disabled','readonly')`).run()
  db.prepare(`UPDATE channel_sessions SET memory_access_mode = 'inherit' WHERE memory_access_mode NOT IN ('inherit','isolated','disabled','readonly')`).run()
}
