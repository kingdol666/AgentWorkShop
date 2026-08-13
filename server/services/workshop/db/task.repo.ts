/**
 * Task 仓储:tasks 表 CRUD。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { TaskRow } from './database'

const COLS
  = 'id, channel_id AS channelId, parent_id AS parentId, assignee_id AS assigneeId, creator_id AS creatorId, title, description, state, progress, retry_count AS retryCount, artifacts_json AS artifactsJson, history_json AS historyJson, created_at AS createdAt, updated_at AS updatedAt'

const NON_TERMINAL_STATES = `'SUBMITTED', 'ASSIGNED', 'WORKING', 'WAITING'`

export interface TaskCreateInput {
  channelId: string
  parentId?: string | null
  assigneeId: string
  creatorId?: string | null
  title: string
  description?: string | null
  state?: string
  progress?: number
  retryCount?: number
  artifacts?: unknown[]
  history?: unknown[]
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
}

export type TaskRepo = ReturnType<typeof createTaskRepo>

export function createTaskRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO tasks (id, channel_id, parent_id, assignee_id, creator_id, title, description, state, progress, retry_count, artifacts_json, history_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${COLS} FROM tasks WHERE id = ?`)
  const selectByChannel = db.prepare(`SELECT ${COLS} FROM tasks WHERE channel_id = ? ORDER BY createdAt ASC`)
  const selectByAssignee = db.prepare(`SELECT ${COLS} FROM tasks WHERE assignee_id = ? ORDER BY createdAt ASC`)
  const selectNonTerminal = db.prepare(
    `SELECT ${COLS} FROM tasks WHERE state IN (${NON_TERMINAL_STATES}) ORDER BY createdAt ASC`,
  )
  const updateStmt = db.prepare(
    `UPDATE tasks SET parent_id = ?, assignee_id = ?, creator_id = ?, title = ?, description = ?, state = ?, progress = ?, retry_count = ?, artifacts_json = ?, history_json = ?, updated_at = ? WHERE id = ?`,
  )

  return {
    /** 创建任务(state 缺省 SUBMITTED,artifacts/history 序列化存储) */
    create(input: TaskCreateInput): TaskRow {
      const now = new Date().toISOString()
      const row: TaskRow = {
        id: randomUUID(),
        channelId: input.channelId,
        parentId: input.parentId ?? null,
        assigneeId: input.assigneeId,
        creatorId: input.creatorId ?? null,
        title: input.title,
        description: input.description ?? null,
        state: input.state ?? 'SUBMITTED',
        progress: input.progress ?? 0,
        retryCount: input.retryCount ?? 0,
        artifactsJson: JSON.stringify(input.artifacts ?? []),
        historyJson: JSON.stringify(input.history ?? []),
        createdAt: now,
        updatedAt: now,
      }
      insert.run(
        row.id, row.channelId, row.parentId, row.assigneeId, row.creatorId, row.title, row.description, row.state, row.progress, row.retryCount, row.artifactsJson, row.historyJson, row.createdAt, row.updatedAt,
      )
      return row
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
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(
        next.parentId, next.assigneeId, next.creatorId, next.title, next.description, next.state, next.progress, next.retryCount, next.artifactsJson, next.historyJson, next.updatedAt, id,
      )
      return next
    },

    findById(id: string): TaskRow | undefined {
      return selectById.get(id) as unknown as TaskRow | undefined
    },

    listByChannel(channelId: string): TaskRow[] {
      return selectByChannel.all(channelId) as unknown as TaskRow[]
    },

    listByAssignee(agentId: string): TaskRow[] {
      return selectByAssignee.all(agentId) as unknown as TaskRow[]
    },

    /** 非终态任务(SUBMITTED/ASSIGNED/WORKING/WAITING) */
    listNonTerminal(): TaskRow[] {
      return selectNonTerminal.all() as unknown as TaskRow[]
    },
  }
}
