import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../../utils/errors'
import { fenceFromMetadata } from './lease'

export const LEGACY_RECOVERY_MARKER = '[LEGACY_EXECUTION_RECOVERY_REQUIRED]'

export function isLegacyRecoveryHeld(task: { closeReason?: string | null }): boolean {
  return (task.closeReason ?? '').includes(LEGACY_RECOVERY_MARKER)
}

export function assertNotLegacyRecoveryHeld(task: { id: string, closeReason?: string | null }): void {
  if (isLegacyRecoveryHeld(task)) {
    throw new AppError(409, 'LEGACY_EXECUTION_RECOVERY_REQUIRED', `Task ${task.id} requires operator investigation; execution was not replayed`)
  }
}

interface RecoveryTask {
  id: string
  parentId: string | null
  rootQueueSeq: number | null
  closeReason: string | null
}

/** Channel-local FIFO check; malformed ancestry or ordering fails closed when a hold exists. */
export function isChannelRecoveryBlocked(taskId: string, rows: RecoveryTask[]): boolean {
  const held = rows.filter(isLegacyRecoveryHeld)
  if (held.length === 0) return false
  const byId = new Map(rows.map(row => [row.id, row]))
  const rootOf = (id: string): RecoveryTask | undefined => {
    const seen = new Set<string>()
    let current = byId.get(id)
    while (current?.parentId) {
      if (seen.has(current.id)) return undefined
      seen.add(current.id)
      current = byId.get(current.parentId)
    }
    return current
  }
  const root = rootOf(taskId)
  if (!root) return true
  for (const row of held) {
    const heldRoot = rootOf(row.id)
    if (!heldRoot || heldRoot.id === root.id) return true
    if (root.rootQueueSeq == null || heldRoot.rootQueueSeq == null || root.rootQueueSeq >= heldRoot.rootQueueSeq) return true
  }
  return false
}

interface ActiveTask {
  id: string
  channelId: string
  assigneeId: string
  generation: number | null
  leaseId: string | null
  leaseAgentId: string | null
  revokedAt: string | null
}

interface PendingMessage {
  taskId: string | null
  channelId: string
  toAgentId: string | null
  metadataJson: string
}

/** Called before project or channel runtimes start. Never issue a lease or replay work. */
export function holdLegacyActiveTasks(db: DatabaseSync): void {
  db.exec('SAVEPOINT legacy_execution_recovery')
  try {
    const active = db.prepare(`SELECT id, channel_id AS channelId, assignee_id AS assigneeId,
      assignment_generation AS generation, execution_lease_id AS leaseId,
      execution_lease_agent_id AS leaseAgentId, execution_lease_revoked_at AS revokedAt
      FROM tasks WHERE state IN ('SUBMITTED', 'ASSIGNED', 'WORKING', 'WAITING')`).all() as unknown as ActiveTask[]
    const byId = new Map(active.map(task => [task.id, task]))
    const suspect = new Set(active.filter(task => !task.leaseId?.trim()
      || task.leaseAgentId !== task.assigneeId || !!task.revokedAt
      || !Number.isSafeInteger(task.generation) || (task.generation ?? -1) < 0).map(task => task.id))

    const messages = db.prepare(`SELECT task_id AS taskId, channel_id AS channelId,
      to_agent_id AS toAgentId, metadata_json AS metadataJson FROM messages
      WHERE state IN ('pending', 'consuming') AND CASE WHEN json_valid(metadata_json)
        THEN json_type(metadata_json) <> 'object' AND task_id IS NOT NULL
          OR json_extract(metadata_json, '$."x-aw-task-kind"') = 'assign'
        ELSE task_id IS NOT NULL END`)
    for (const message of messages.iterate() as unknown as Iterable<PendingMessage>) {
      let metadata: Record<string, unknown>
      try {
        const value: unknown = JSON.parse(message.metadataJson)
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          if (message.taskId && byId.has(message.taskId)) suspect.add(message.taskId)
          continue
        }
        metadata = value as Record<string, unknown>
      }
      catch {
        if (message.taskId && byId.has(message.taskId)) suspect.add(message.taskId)
        continue
      }
      if (metadata['x-aw-task-kind'] !== 'assign') continue
      const metadataId = typeof metadata['x-aw-task-id'] === 'string' ? metadata['x-aw-task-id'] : null
      const fence = fenceFromMetadata(metadata)
      for (const id of new Set([message.taskId, metadataId])) {
        const task = id ? byId.get(id) : undefined
        if (!task) continue
        if ((message.taskId && message.taskId !== task.id) || (metadataId && metadataId !== task.id)
          || message.channelId !== task.channelId || message.toAgentId !== task.assigneeId
          || !Number.isSafeInteger(fence?.generation) || (fence?.generation ?? -1) < 0
          || fence?.generation !== task.generation || !fence?.leaseId || fence.leaseId !== task.leaseId) {
          suspect.add(task.id)
        }
      }
    }

    const mark = db.prepare(`UPDATE tasks SET close_reason = CASE
      WHEN COALESCE(close_reason, '') = '' THEN ?
      ELSE close_reason || ' ' || ? END
      WHERE id = ? AND instr(COALESCE(close_reason, ''), ?) = 0`)
    for (const id of suspect) mark.run(LEGACY_RECOVERY_MARKER, LEGACY_RECOVERY_MARKER, id, LEGACY_RECOVERY_MARKER)

    // UNION terminates even on malformed cycles and retains holds from prior startups.
    db.prepare(`WITH RECURSIVE held(id) AS (
      SELECT id FROM tasks WHERE instr(COALESCE(close_reason, ''), ?) > 0
      UNION SELECT t.parent_id FROM tasks t JOIN held h ON t.id = h.id WHERE t.parent_id IS NOT NULL
      UNION SELECT t.id FROM tasks t JOIN held h ON t.parent_id = h.id
    ) UPDATE tasks SET close_reason = CASE
      WHEN COALESCE(close_reason, '') = '' THEN ? ELSE close_reason || ' ' || ? END
      WHERE id IN (SELECT id FROM held) AND instr(COALESCE(close_reason, ''), ?) = 0`)
      .run(LEGACY_RECOVERY_MARKER, LEGACY_RECOVERY_MARKER, LEGACY_RECOVERY_MARKER, LEGACY_RECOVERY_MARKER)

    // Preserve normal task-linked chat; malformed or non-object metadata cannot be
    // classified, so retain the raw row as dead-letter evidence instead of replaying it.
    db.prepare(`UPDATE messages SET state = 'dead', claim_token = NULL
      WHERE state IN ('pending', 'consuming') AND CASE WHEN json_valid(messages.metadata_json)
        THEN json_type(messages.metadata_json) <> 'object'
          OR json_type(messages.metadata_json, '$."x-aw-task-kind"') IS NOT NULL ELSE 1 END
      AND EXISTS (
        SELECT 1 FROM tasks t
        WHERE instr(COALESCE(t.close_reason, ''), ?) > 0
          AND (messages.task_id = t.id OR CASE WHEN json_valid(messages.metadata_json)
            THEN json_extract(messages.metadata_json, '$."x-aw-task-id"') = t.id
              OR json_extract(messages.metadata_json, '$."x-aw-child-task-id"') = t.id ELSE 0 END)
      )`).run(LEGACY_RECOVERY_MARKER)
    db.exec('RELEASE legacy_execution_recovery')
  }
  catch (error) {
    db.exec('ROLLBACK TO legacy_execution_recovery; RELEASE legacy_execution_recovery')
    throw error
  }
}
