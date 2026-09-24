/**
 * Task 仓储:tasks 表 CRUD 与根任务幂等/队列。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { TaskRow } from './database'

const COLS
  = 'id, channel_id AS channelId, parent_id AS parentId, root_queue_seq AS rootQueueSeq, assignee_id AS assigneeId, creator_id AS creatorId, title, description, state, progress, retry_count AS retryCount, artifacts_json AS artifactsJson, history_json AS historyJson, route_reason AS routeReason, source_chat_message_id AS sourceChatMessageId, source_chat_delivery_id AS sourceChatDeliveryId, close_reason AS closeReason, deadline_at AS deadlineAt, assignment_generation AS assignmentGeneration, execution_lease_id AS executionLeaseId, execution_lease_agent_id AS executionLeaseAgentId, execution_lease_started_at AS executionLeaseStartedAt, execution_lease_revoked_at AS executionLeaseRevokedAt, created_at AS createdAt, updated_at AS updatedAt'

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
    `INSERT INTO tasks (id, channel_id, parent_id, root_queue_seq, assignee_id, creator_id, title, description, state, progress, retry_count, artifacts_json, history_json, route_reason, source_chat_message_id, source_chat_delivery_id, close_reason, deadline_at, assignment_generation, execution_lease_id, execution_lease_agent_id, execution_lease_started_at, execution_lease_revoked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${COLS} FROM tasks WHERE id = ?`)
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
    = 'id, channel_id AS channelId, parent_id AS parentId, root_queue_seq AS rootQueueSeq, assignee_id AS assigneeId, creator_id AS creatorId, title, description, state, progress, retry_count AS retryCount, route_reason AS routeReason, source_chat_message_id AS sourceChatMessageId, source_chat_delivery_id AS sourceChatDeliveryId, close_reason AS closeReason, deadline_at AS deadlineAt, assignment_generation AS assignmentGeneration, execution_lease_id AS executionLeaseId, execution_lease_agent_id AS executionLeaseAgentId, execution_lease_started_at AS executionLeaseStartedAt, execution_lease_revoked_at AS executionLeaseRevokedAt, created_at AS createdAt, updated_at AS updatedAt'
  const selectByChannelMeta = db.prepare(`SELECT ${META_COLS} FROM tasks WHERE channel_id = ? ORDER BY COALESCE(root_queue_seq, 2147483647) ASC, created_at ASC, rowid ASC`)
  const selectByChannelAssigneeMeta = db.prepare(`SELECT ${META_COLS} FROM tasks WHERE channel_id = ? AND assignee_id = ? ORDER BY created_at ASC, rowid ASC`)
  const selectChildrenMeta = db.prepare(`SELECT ${META_COLS} FROM tasks WHERE channel_id = ? AND parent_id = ? ORDER BY created_at ASC, rowid ASC`)
  const updateStmt = db.prepare(
    `UPDATE tasks SET parent_id = ?, assignee_id = ?, creator_id = ?, title = ?, description = ?, state = ?, progress = ?, retry_count = ?, artifacts_json = ?, history_json = ?, source_chat_message_id = ?, source_chat_delivery_id = ?, close_reason = ?, deadline_at = ?, assignment_generation = ?, execution_lease_id = ?, execution_lease_agent_id = ?, execution_lease_started_at = ?, execution_lease_revoked_at = ?, updated_at = ? WHERE id = ?`,
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
        next.assignmentGeneration, next.executionLeaseId, next.executionLeaseAgentId, next.executionLeaseStartedAt, next.executionLeaseRevokedAt,
        next.updatedAt, id,
      )
      return next
    },
  }
}
