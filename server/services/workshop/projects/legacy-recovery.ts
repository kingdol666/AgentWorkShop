import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { isChannelRecoveryBlocked } from '../runtime/task-engine/legacy-recovery'

/** Include the whole task tree, even when legacy descendants lack project metadata. */
export function projectHasLegacyRecoveryHold(db: DatabaseSync, projectId: string): boolean {
  const rows = db.prepare(`WITH RECURSIVE related(id, channel_id, parent_id, close_reason) AS (
    SELECT t.id, t.channel_id, t.parent_id, t.close_reason FROM tasks t
    WHERE t.project_id = ?
      OR EXISTS (SELECT 1 FROM project_work_items w WHERE w.project_id = ? AND w.id = t.project_work_item_id)
      OR EXISTS (SELECT 1 FROM project_work_item_attempts a WHERE a.project_id = ?
        AND (a.channel_task_id = t.id OR a.source_key = t.source_chat_message_id))
    UNION
    SELECT t.id, t.channel_id, t.parent_id, t.close_reason FROM tasks t
    JOIN related r ON t.channel_id = r.channel_id AND (t.parent_id = r.id OR t.id = r.parent_id)
  ) SELECT id, channel_id AS channelId FROM related`).all(projectId, projectId, projectId) as Array<{ id: string, channelId: string }>
  const channelRows = db.prepare(`SELECT id, parent_id AS parentId, root_queue_seq AS rootQueueSeq,
    close_reason AS closeReason FROM tasks WHERE channel_id = ?`)
  type RecoveryRow = { id: string, parentId: string | null, rootQueueSeq: number | null, closeReason: string | null }
  const byChannel = new Map<string, RecoveryRow[]>()
  for (const task of rows) {
    let tasks = byChannel.get(task.channelId)
    if (!tasks) {
      tasks = channelRows.all(task.channelId) as unknown as RecoveryRow[]
      byChannel.set(task.channelId, tasks)
    }
    if (isChannelRecoveryBlocked(task.id, tasks)) return true
  }
  return false
}

export function assertProjectRecoveryClear(db: DatabaseSync, projectId: string): void {
  if (projectHasLegacyRecoveryHold(db, projectId)) {
    throw new AppError(409, 'LEGACY_EXECUTION_RECOVERY_REQUIRED', `Project ${projectId} contains a task requiring operator investigation`)
  }
}
