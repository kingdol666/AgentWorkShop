/**
 * Task 仓储:tasks 表 CRUD 与根任务幂等/队列。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { TaskRow } from './database'
import { projectHasLegacyRecoveryHold } from '../projects/legacy-recovery'

const COLS
  = 'id, channel_id AS channelId, parent_id AS parentId, root_queue_seq AS rootQueueSeq, assignee_id AS assigneeId, creator_id AS creatorId, title, description, state, progress, retry_count AS retryCount, artifacts_json AS artifactsJson, history_json AS historyJson, route_reason AS routeReason, source_chat_message_id AS sourceChatMessageId, source_chat_delivery_id AS sourceChatDeliveryId, close_reason AS closeReason, deadline_at AS deadlineAt, source, project_id AS projectId, project_work_item_id AS projectWorkItemId, project_attempt_no AS projectAttemptNo, session_id AS sessionId, trace_id AS traceId, superseded_by_task_id AS supersededByTaskId, assignment_generation AS assignmentGeneration, execution_lease_id AS executionLeaseId, execution_lease_agent_id AS executionLeaseAgentId, execution_lease_started_at AS executionLeaseStartedAt, execution_lease_revoked_at AS executionLeaseRevokedAt, created_at AS createdAt, updated_at AS updatedAt'

const NON_TERMINAL_STATES = `'SUBMITTED', 'ASSIGNED', 'WORKING', 'WAITING'`

export interface TaskCreateInput {
  channelId: string
  parentId?: string | null
  rootQueueSeq?: number | null
  assigneeId: string
  creatorId?: string | null
  title: string
  description?: string | null
  state?: string
  progress?: number
  retryCount?: number
  artifacts?: unknown[]
  history?: unknown[]
  routeReason?: string | null
  sourceChatMessageId?: string | null
  sourceChatDeliveryId?: string | null
  closeReason?: string | null
  deadlineAt?: string | null
  source?: string | null
  projectId?: string | null
  projectWorkItemId?: string | null
  projectAttemptNo?: number | null
  sessionId?: string | null
  traceId?: string | null
  supersededByTaskId?: string | null
  assignmentGeneration?: number
  executionLeaseId?: string | null
  executionLeaseAgentId?: string | null
  executionLeaseStartedAt?: string | null
  executionLeaseRevokedAt?: string | null
}

export interface TaskPatch {
  parentId?: string | null
  assigneeId?: string
  creatorId?: string | null
  title?: string
  description?: string | null
  state?: string
  progress?: number
  retryCount?: number
  artifacts?: unknown[]
  history?: unknown[]
  sourceChatMessageId?: string | null
  sourceChatDeliveryId?: string | null
  closeReason?: string | null
  deadlineAt?: string | null
  source?: string | null
  projectId?: string | null
  projectWorkItemId?: string | null
  projectAttemptNo?: number | null
  sessionId?: string | null
  traceId?: string | null
  supersededByTaskId?: string | null
  assignmentGeneration?: number
  executionLeaseId?: string | null
  executionLeaseAgentId?: string | null
  executionLeaseStartedAt?: string | null
  executionLeaseRevokedAt?: string | null
}

/** 任务元数据行(META_COLS 投影;不含 artifactsJson/historyJson 两个 JSON 大列) */
export interface TaskMetaRow {
  id: string
  channelId: string
  parentId: string | null
  rootQueueSeq: number | null
  assigneeId: string
  creatorId: string | null
  title: string
  description: string | null
  state: string
  progress: number
  retryCount: number
  routeReason: string
  sourceChatMessageId: string | null
  sourceChatDeliveryId: string | null
  closeReason: string | null
  deadlineAt: string | null
  source: string
  projectId: string | null
  projectWorkItemId: string | null
  projectAttemptNo: number | null
  sessionId: string | null
  traceId: string
  supersededByTaskId: string | null
  assignmentGeneration: number
  executionLeaseId: string | null
  executionLeaseAgentId: string | null
  executionLeaseStartedAt: string | null
  executionLeaseRevokedAt: string | null
  createdAt: string
  updatedAt: string
}

export type TaskRepo = ReturnType<typeof createTaskRepo>

export function createTaskRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO tasks (id, channel_id, parent_id, root_queue_seq, assignee_id, creator_id, title, description, state, progress, retry_count, artifacts_json, history_json, route_reason, source_chat_message_id, source_chat_delivery_id, close_reason, deadline_at, source, project_id, project_work_item_id, project_attempt_no, session_id, trace_id, assignment_generation, execution_lease_id, execution_lease_agent_id, execution_lease_started_at, execution_lease_revoked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${COLS} FROM tasks WHERE id = ?`)
  const recoveryProjectIds = db.prepare(`WITH RECURSIVE related(id, channel_id, parent_id, project_id, project_work_item_id, source_chat_message_id) AS (
    SELECT id, channel_id, parent_id, project_id, project_work_item_id, source_chat_message_id FROM tasks WHERE id = ?
    UNION SELECT t.id, t.channel_id, t.parent_id, t.project_id, t.project_work_item_id, t.source_chat_message_id
      FROM tasks t JOIN related r ON t.channel_id = r.channel_id AND (t.parent_id = r.id OR t.id = r.parent_id)
  ) SELECT project_id AS projectId FROM related WHERE project_id IS NOT NULL
    UNION SELECT w.project_id FROM project_work_items w JOIN related r ON w.id = r.project_work_item_id
    UNION SELECT a.project_id FROM project_work_item_attempts a JOIN related r
      ON a.channel_task_id = r.id OR a.source_key = r.source_chat_message_id`)
  // ── legacy 恢复保留的审计处置(同一连接树:上溯父/下溯子,同 channel)──
  const holdRowsStmt = db.prepare(`SELECT ${COLS} FROM tasks WHERE instr(COALESCE(close_reason, ''), ?) > 0 ORDER BY channel_id ASC, created_at ASC`)
  const recoveryTreeStmt = db.prepare(`WITH RECURSIVE tree(id, channel_id, parent_id, close_reason) AS (
    SELECT id, channel_id, parent_id, close_reason FROM tasks WHERE id = ?
    UNION SELECT t.id, t.channel_id, t.parent_id, t.close_reason
      FROM tasks t JOIN tree h ON t.channel_id = h.channel_id AND (t.parent_id = h.id OR t.id = h.parent_id)
  ) SELECT id AS id, close_reason AS closeReason FROM tree`)
  const holdClearStmt = db.prepare(`WITH RECURSIVE tree(id, channel_id, parent_id) AS (
    SELECT id, channel_id, parent_id FROM tasks WHERE id = ?
    UNION SELECT t.id, t.channel_id, t.parent_id
      FROM tasks t JOIN tree h ON t.channel_id = h.channel_id AND (t.parent_id = h.id OR t.id = h.parent_id)
  ) UPDATE tasks SET close_reason = CASE
    WHEN TRIM(REPLACE(COALESCE(close_reason, ''), ?, '')) = '' THEN NULL
    ELSE TRIM(REPLACE(COALESCE(close_reason, ''), ?, '')) END
    WHERE id IN (SELECT id FROM tree) AND instr(COALESCE(close_reason, ''), ?) > 0`)
  const holdMsgCountsStmt = db.prepare(`WITH RECURSIVE tree(id, channel_id, parent_id) AS (
    SELECT id, channel_id, parent_id FROM tasks WHERE id = ?
    UNION SELECT t.id, t.channel_id, t.parent_id FROM tasks t JOIN tree h
      ON t.channel_id = h.channel_id AND (t.parent_id = h.id OR t.id = h.parent_id)
  ) SELECT
      SUM(CASE WHEN m.state = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN m.state = 'consuming' THEN 1 ELSE 0 END) AS consuming,
      SUM(CASE WHEN m.state = 'dead' THEN 1 ELSE 0 END) AS dead
    FROM messages m
    WHERE m.state IN ('pending', 'consuming', 'dead')
      AND (m.task_id IN (SELECT id FROM tree)
        OR CASE WHEN json_valid(m.metadata_json) THEN
          json_extract(m.metadata_json, '$."x-aw-task-id"') IN (SELECT id FROM tree)
          OR json_extract(m.metadata_json, '$."x-aw-child-task-id"') IN (SELECT id FROM tree)
        ELSE 0 END)`)
  const holdRequeueStmt = db.prepare(`WITH RECURSIVE tree(id, channel_id, parent_id) AS (
    SELECT id, channel_id, parent_id FROM tasks WHERE id = ?
    UNION SELECT t.id, t.channel_id, t.parent_id FROM tasks t JOIN tree h
      ON t.channel_id = h.channel_id AND (t.parent_id = h.id OR t.id = h.parent_id)
  ) UPDATE messages SET state = CASE WHEN attempts < 3 THEN 'pending' ELSE 'dead' END, claim_token = NULL
    WHERE state = 'consuming'
      AND (task_id IN (SELECT id FROM tree)
        OR CASE WHEN json_valid(metadata_json) THEN
          json_extract(metadata_json, '$."x-aw-task-id"') IN (SELECT id FROM tree)
          OR json_extract(metadata_json, '$."x-aw-child-task-id"') IN (SELECT id FROM tree)
        ELSE 0 END)`)
  const selectByChannel = db.prepare(`SELECT ${COLS} FROM tasks WHERE channel_id = ? ORDER BY COALESCE(root_queue_seq, 2147483647) ASC, created_at ASC, rowid ASC`)
  const selectRoots = db.prepare(`SELECT ${COLS} FROM tasks WHERE channel_id = ? AND parent_id IS NULL AND root_queue_seq IS NOT NULL ORDER BY COALESCE(root_queue_seq, 2147483647) ASC, created_at ASC, rowid ASC`)
  const selectRootBySource = db.prepare(`SELECT ${COLS} FROM tasks WHERE channel_id = ? AND parent_id IS NULL AND source_chat_message_id = ? LIMIT 1`)
  const nextRootSeqStmt = db.prepare(`SELECT COALESCE(MAX(root_queue_seq), 0) + 1 AS nextSeq FROM tasks WHERE channel_id = ? AND parent_id IS NULL`)
  // Supervisor 只需审核未结束父任务下已完成子任务的交付物；不要为此把整条
  // task history_json/所有终态任务 artifacts_json 都加载进每一轮调度快照。
  const selectActiveSupervisionArtifacts = db.prepare(
    `SELECT task.id AS taskId, task.artifacts_json AS artifactsJson
     FROM tasks task
     LEFT JOIN tasks parent ON parent.id = task.parent_id AND parent.channel_id = task.channel_id
     WHERE task.channel_id = ? AND (
       (task.parent_id IS NULL AND task.assignee_id = ? AND task.state IN ('SUBMITTED', 'WORKING')
         AND NOT EXISTS (
           SELECT 1 FROM tasks earlier
           WHERE earlier.channel_id = task.channel_id AND earlier.parent_id IS NULL
             AND earlier.state IN ('SUBMITTED', 'ASSIGNED', 'WORKING', 'WAITING')
             AND (earlier.root_queue_seq < task.root_queue_seq
               OR (earlier.root_queue_seq = task.root_queue_seq AND earlier.rowid < task.rowid))
         ))
       OR (task.parent_id IS NOT NULL AND task.state = 'COMPLETED'
         AND parent.state IN ('SUBMITTED', 'WORKING', 'WAITING')
         AND parent.root_queue_seq = (
           SELECT MIN(active.root_queue_seq) FROM tasks active
           WHERE active.channel_id = task.channel_id AND active.parent_id IS NULL
             AND active.state IN ('SUBMITTED', 'ASSIGNED', 'WORKING', 'WAITING')
         ))
     )
     ORDER BY COALESCE(task.root_queue_seq, 2147483647) ASC, task.created_at ASC, task.rowid ASC
     LIMIT ?`,
  )
  const selectByAssignee = db.prepare(`SELECT ${COLS} FROM tasks WHERE assignee_id = ? ORDER BY createdAt ASC, rowid ASC`)
  const selectByChannelAssignee = db.prepare(
    `SELECT ${COLS} FROM tasks WHERE channel_id = ? AND assignee_id = ? ORDER BY createdAt ASC, rowid ASC`,
  )
  const selectNonTerminal = db.prepare(
    `SELECT ${COLS} FROM tasks WHERE state IN (${NON_TERMINAL_STATES}) ORDER BY createdAt ASC, rowid ASC`,
  )
  const META_COLS
    = 'id, channel_id AS channelId, parent_id AS parentId, root_queue_seq AS rootQueueSeq, assignee_id AS assigneeId, creator_id AS creatorId, title, description, state, progress, retry_count AS retryCount, route_reason AS routeReason, source_chat_message_id AS sourceChatMessageId, source_chat_delivery_id AS sourceChatDeliveryId, close_reason AS closeReason, deadline_at AS deadlineAt, source, project_id AS projectId, project_work_item_id AS projectWorkItemId, project_attempt_no AS projectAttemptNo, session_id AS sessionId, trace_id AS traceId, superseded_by_task_id AS supersededByTaskId, assignment_generation AS assignmentGeneration, execution_lease_id AS executionLeaseId, execution_lease_agent_id AS executionLeaseAgentId, execution_lease_started_at AS executionLeaseStartedAt, execution_lease_revoked_at AS executionLeaseRevokedAt, created_at AS createdAt, updated_at AS updatedAt'
  const selectByChannelMeta = db.prepare(`SELECT ${META_COLS} FROM tasks WHERE channel_id = ? ORDER BY COALESCE(root_queue_seq, 2147483647) ASC, created_at ASC, rowid ASC`)
  const selectByChannelAssigneeMeta = db.prepare(`SELECT ${META_COLS} FROM tasks WHERE channel_id = ? AND assignee_id = ? ORDER BY created_at ASC, rowid ASC`)
  const selectChildrenMeta = db.prepare(`SELECT ${META_COLS} FROM tasks WHERE channel_id = ? AND parent_id = ? ORDER BY created_at ASC, rowid ASC`)
  const updateStmt = db.prepare(
    `UPDATE tasks SET parent_id = ?, assignee_id = ?, creator_id = ?, title = ?, description = ?, state = ?, progress = ?, retry_count = ?, artifacts_json = ?, history_json = ?, source_chat_message_id = ?, source_chat_delivery_id = ?, close_reason = ?, deadline_at = ?, source = ?, project_id = ?, project_work_item_id = ?, project_attempt_no = ?, session_id = ?, trace_id = ?, superseded_by_task_id = ?, assignment_generation = ?, execution_lease_id = ?, execution_lease_agent_id = ?, execution_lease_started_at = ?, execution_lease_revoked_at = ?, updated_at = ? WHERE id = ?`,
  )

  const buildRow = (input: TaskCreateInput, rootQueueSeq: number | null): TaskRow => {
    const now = new Date().toISOString()
    return {
      id: randomUUID(),
      channelId: input.channelId,
      parentId: input.parentId ?? null,
      rootQueueSeq,
      assigneeId: input.assigneeId,
      creatorId: input.creatorId ?? null,
      title: input.title,
      description: input.description ?? null,
      state: input.state ?? 'SUBMITTED',
      progress: input.progress ?? 0,
      retryCount: input.retryCount ?? 0,
      artifactsJson: JSON.stringify(input.artifacts ?? []),
      historyJson: JSON.stringify(input.history ?? []),
      routeReason: input.routeReason ?? '',
      sourceChatMessageId: input.sourceChatMessageId ?? null,
      sourceChatDeliveryId: input.sourceChatDeliveryId ?? null,
      closeReason: input.closeReason ?? null,
      deadlineAt: input.deadlineAt ?? null,
      source: input.source ?? 'channel',
      projectId: input.projectId ?? null,
      projectWorkItemId: input.projectWorkItemId ?? null,
      projectAttemptNo: input.projectAttemptNo ?? null,
      sessionId: input.sessionId ?? null,
      traceId: input.traceId ?? '',
      assignmentGeneration: input.assignmentGeneration ?? 0,
      executionLeaseId: input.executionLeaseId ?? null,
      executionLeaseAgentId: input.executionLeaseAgentId ?? null,
      executionLeaseStartedAt: input.executionLeaseStartedAt ?? null,
      executionLeaseRevokedAt: input.executionLeaseRevokedAt ?? null,
      createdAt: now,
      updatedAt: now,
    }
  }

  const insertRow = (row: TaskRow): TaskRow => {
    insert.run(
      row.id, row.channelId, row.parentId, row.rootQueueSeq, row.assigneeId, row.creatorId, row.title, row.description,
      row.state, row.progress, row.retryCount, row.artifactsJson, row.historyJson, row.routeReason,
      row.sourceChatMessageId, row.sourceChatDeliveryId, row.closeReason, row.deadlineAt,
      row.source, row.projectId, row.projectWorkItemId, row.projectAttemptNo, row.sessionId, row.traceId,
      row.assignmentGeneration, row.executionLeaseId, row.executionLeaseAgentId, row.executionLeaseStartedAt, row.executionLeaseRevokedAt,
      row.createdAt, row.updatedAt,
    )
    return row
  }

  const createRow = (input: TaskCreateInput): TaskRow => {
    // 子任务无队列序号;root 一律发号(即使调用方显式传 null)——
    // rootQueue 的 selectRoots 以 `root_queue_seq IS NOT NULL` 为根任务判据,
    // 漏号会让该 root 从 activeRoot 计算中消失,连带 FIFO 准入闸门失效。
    const rootQueueSeq = input.parentId
      ? null
      : (typeof input.rootQueueSeq === 'number'
          ? input.rootQueueSeq
          : Number((nextRootSeqStmt.get(input.channelId) as { nextSeq?: number } | undefined)?.nextSeq ?? 1))
    return insertRow(buildRow(input, rootQueueSeq))
  }

  return {
    create(input: TaskCreateInput): TaskRow {
      return createRow(input)
    },

    /** 原子根任务创建：同 source 冲突时返回 canonical root，而不是把 UNIQUE 错误暴露给调用方。 */
    createOrGetRoot(input: Omit<TaskCreateInput, 'parentId' | 'state'>): { row: TaskRow, created: boolean } {
      if (!input.sourceChatMessageId) return { row: createRow({ ...input, parentId: null, state: 'SUBMITTED' }), created: true }
      const existing = selectRootBySource.get(input.channelId, input.sourceChatMessageId) as unknown as TaskRow | undefined
      if (existing) return { row: existing, created: false }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const row = createRow({ ...input, parentId: null, state: 'SUBMITTED', rootQueueSeq: undefined })
          return { row, created: true }
        }
        catch (err) {
          const canonical = selectRootBySource.get(input.channelId, input.sourceChatMessageId) as unknown as TaskRow | undefined
          if (canonical) return { row: canonical, created: false }
          if (attempt === 2) throw err
        }
      }
      throw new Error('root create-or-get exhausted')
    },

    findById(id: string): TaskRow | undefined {
      return selectById.get(id) as unknown as TaskRow | undefined
    },
    recoveryProjectIds(id: string): string[] {
      return (recoveryProjectIds.all(id) as Array<{ projectId: string }>).map(row => row.projectId)
    },
    projectRecoveryBlocked(id: string): boolean {
      return this.recoveryProjectIds(id).some(projectId => projectHasLegacyRecoveryHold(db, projectId))
    },
    findRootBySource(channelId: string, sourceChatMessageId: string): TaskRow | undefined {
      return selectRootBySource.get(channelId, sourceChatMessageId) as unknown as TaskRow | undefined
    },
    listByChannel(channelId: string): TaskRow[] {
      return selectByChannel.all(channelId) as unknown as TaskRow[]
    },
    listRoots(channelId: string): TaskRow[] {
      return selectRoots.all(channelId) as unknown as TaskRow[]
    },
    /** 当前 Lead 的未结束 root 输入 + 待验收父任务下已完成子任务的交付物。 */
    listActiveSupervisionArtifacts(channelId: string, leadAgentId: string, limit = 40): Array<{ taskId: string, artifactsJson: string }> {
      return selectActiveSupervisionArtifacts.all(channelId, leadAgentId, limit) as unknown as Array<{ taskId: string, artifactsJson: string }>
    },
    listByAssignee(agentId: string): TaskRow[] {
      return selectByAssignee.all(agentId) as unknown as TaskRow[]
    },
    listByChannelAssignee(channelId: string, assigneeId: string): TaskRow[] {
      return selectByChannelAssignee.all(channelId, assigneeId) as unknown as TaskRow[]
    },
    listNonTerminal(): TaskRow[] {
      return selectNonTerminal.all() as unknown as TaskRow[]
    },
    listByChannelMeta(channelId: string): TaskMetaRow[] {
      return selectByChannelMeta.all(channelId) as unknown as TaskMetaRow[]
    },

    /** 当前处于 legacy 恢复保留的任务行(marker 由 runtime 层常量传入,db 层不反向依赖)。 */
    listRecoveryHolds(marker: string): TaskRow[] {
      return holdRowsStmt.all(marker) as unknown as TaskRow[]
    },

    /** 保留树的成员(上溯父/下溯子,同 channel)及其 hold 状态。 */
    recoveryTreeOf(taskId: string): Array<{ id: string, closeReason: string | null }> {
      return recoveryTreeStmt.all(taskId) as unknown as Array<{ id: string, closeReason: string | null }>
    },

    /** 树内消息分状态计数(pending/consuming/dead;含元数据引用联动)。 */
    recoveryHoldMessageCounts(taskId: string): { pending: number, consuming: number, dead: number } {
      const row = holdMsgCountsStmt.get(taskId) as { pending: number | null, consuming: number | null, dead: number | null }
      return { pending: row.pending ?? 0, consuming: row.consuming ?? 0, dead: row.dead ?? 0 }
    },

    /**
     * 处置:清除本连接树上全部 hold 标记(保留其余 close_reason 内容),并把树内
     * 在飞 consuming 消息按重投预算复位(pending/dead)。任务状态不改动 —— 重新
     * 执行必须走显式 retry/reopen,绝不自动重放。任务不在保留中返回 null。
     */
    disposeLegacyRecoveryHold(taskId: string, marker: string): { released: string[], requeued: number, unblockedPending: number } | null {
      const task = selectById.get(taskId) as unknown as TaskRow | undefined
      if (!task) return null
      const tree = recoveryTreeStmt.all(taskId) as unknown as Array<{ id: string, closeReason: string | null }>
      if (!tree.some(row => (row.closeReason ?? '').includes(marker))) return null
      const before = this.recoveryHoldMessageCounts(taskId)
      db.exec('SAVEPOINT legacy_hold_disposition')
      try {
        holdClearStmt.run(taskId, marker, marker, marker)
        holdRequeueStmt.run(taskId)
        db.exec('RELEASE legacy_hold_disposition')
      }
      catch (error) {
        db.exec('ROLLBACK TO legacy_hold_disposition; RELEASE legacy_hold_disposition')
        throw error
      }
      const after = this.recoveryHoldMessageCounts(taskId)
      return {
        released: tree.filter(row => (row.closeReason ?? '').includes(marker)).map(row => row.id),
        requeued: Math.max(0, before.consuming - after.consuming),
        unblockedPending: before.pending,
      }
    },
    listByChannelAssigneeMeta(channelId: string, assigneeId: string): TaskMetaRow[] {
      return selectByChannelAssigneeMeta.all(channelId, assigneeId) as unknown as TaskMetaRow[]
    },
    listChildrenMeta(channelId: string, parentId: string): TaskMetaRow[] {
      return selectChildrenMeta.all(channelId, parentId) as unknown as TaskMetaRow[]
    },

    /** 局部更新;artifacts/history 提供时重新序列化;未命中返回 undefined */
    update(id: string, patch: TaskPatch): TaskRow | undefined {
      const current = selectById.get(id) as unknown as TaskRow | undefined
      if (!current) return undefined
      const next: TaskRow = {
        ...current,
        parentId: patch.parentId !== undefined ? patch.parentId : current.parentId,
        assigneeId: patch.assigneeId ?? current.assigneeId,
        creatorId: patch.creatorId !== undefined ? patch.creatorId : current.creatorId,
        title: patch.title ?? current.title,
        description: patch.description !== undefined ? patch.description : current.description,
        state: patch.state ?? current.state,
        progress: patch.progress ?? current.progress,
        retryCount: patch.retryCount ?? current.retryCount,
        artifactsJson: patch.artifacts !== undefined ? JSON.stringify(patch.artifacts) : current.artifactsJson,
        historyJson: patch.history !== undefined ? JSON.stringify(patch.history) : current.historyJson,
        sourceChatMessageId: patch.sourceChatMessageId !== undefined ? patch.sourceChatMessageId : current.sourceChatMessageId,
        sourceChatDeliveryId: patch.sourceChatDeliveryId !== undefined ? patch.sourceChatDeliveryId : current.sourceChatDeliveryId,
        closeReason: patch.closeReason !== undefined ? patch.closeReason : current.closeReason,
        deadlineAt: patch.deadlineAt !== undefined ? patch.deadlineAt : current.deadlineAt,
        source: patch.source !== undefined ? (patch.source ?? 'channel') : current.source,
        projectId: patch.projectId !== undefined ? patch.projectId : current.projectId,
        projectWorkItemId: patch.projectWorkItemId !== undefined ? patch.projectWorkItemId : current.projectWorkItemId,
        projectAttemptNo: patch.projectAttemptNo !== undefined ? patch.projectAttemptNo : current.projectAttemptNo,
        traceId: patch.traceId !== undefined ? (patch.traceId ?? '') : current.traceId,
        supersededByTaskId: patch.supersededByTaskId !== undefined ? patch.supersededByTaskId : current.supersededByTaskId,
        assignmentGeneration: patch.assignmentGeneration ?? current.assignmentGeneration,
        executionLeaseId: patch.executionLeaseId !== undefined ? patch.executionLeaseId : current.executionLeaseId,
        executionLeaseAgentId: patch.executionLeaseAgentId !== undefined ? patch.executionLeaseAgentId : current.executionLeaseAgentId,
        executionLeaseStartedAt: patch.executionLeaseStartedAt !== undefined ? patch.executionLeaseStartedAt : current.executionLeaseStartedAt,
        executionLeaseRevokedAt: patch.executionLeaseRevokedAt !== undefined ? patch.executionLeaseRevokedAt : current.executionLeaseRevokedAt,
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(
        next.parentId, next.assigneeId, next.creatorId, next.title, next.description, next.state, next.progress, next.retryCount,
        next.artifactsJson, next.historyJson, next.sourceChatMessageId, next.sourceChatDeliveryId, next.closeReason, next.deadlineAt,
        next.source, next.projectId, next.projectWorkItemId, next.projectAttemptNo, next.sessionId, next.traceId,
        next.supersededByTaskId ?? null,
        next.assignmentGeneration, next.executionLeaseId, next.executionLeaseAgentId, next.executionLeaseStartedAt, next.executionLeaseRevokedAt,
        next.updatedAt, id,
      )
      return next
    },
  }
}
