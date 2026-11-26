/**
 * Runtime Working Memory（批次 J）：每 runtime/会话/任务独立，每回合落定持久化，TTL 24h。
 * 与 episodic/curated 分离：只服务当前任务跨回合连续性，不参与长期注入排名。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface WorkingMemoryRow {
  runtimeId: string
  sessionId: string
  taskId: string
  key: string
  value: string
  revision: number
  expiresAt: string | null
  updatedAt: string
}

const COLS = `runtime_id AS runtimeId, session_id AS sessionId, task_id AS taskId, key, value, revision,
  expires_at AS expiresAt, updated_at AS updatedAt`

export function upsertWorkingMemory(db: DatabaseSync, input: {
  runtimeId: string
  sessionId?: string | null
  taskId?: string | null
  key: string
  value: string
  ttlHours?: number
}): void {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + (input.ttlHours ?? 24) * 3_600_000).toISOString()
  db.prepare(
    `INSERT INTO runtime_working_memory(runtime_id, session_id, task_id, key, value, revision, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(runtime_id, session_id, task_id, key) DO UPDATE SET value = excluded.value,
       revision = runtime_working_memory.revision + 1, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
  ).run(input.runtimeId, input.sessionId ?? '', input.taskId ?? '', input.key, input.value.slice(0, 4000), expiresAt, now)
}

export function loadWorkingMemory(db: DatabaseSync, runtimeId: string, sessionId?: string | null, taskId?: string | null): WorkingMemoryRow[] {
  return db.prepare(
    `SELECT ${COLS} FROM runtime_working_memory WHERE runtime_id = ? AND session_id = ? AND task_id = ?
       AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 10`,
  ).all(runtimeId, sessionId ?? '', taskId ?? '', new Date().toISOString()) as unknown as WorkingMemoryRow[]
}

export function cleanupWorkingMemory(db: DatabaseSync): number {
  return Number(db.prepare('DELETE FROM runtime_working_memory WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .run(new Date().toISOString()).changes ?? 0)
}
