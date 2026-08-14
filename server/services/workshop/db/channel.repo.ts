/**
 * Channel 仓储:channels 表 CRUD(含 workspace 工作目录)。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelRow } from './database'

/** 查询列(蛇形列名 → 驼峰行字段) */
const COLS = 'id, name, description, lead_agent_id AS leadAgentId, workspace, enabled, created_at AS createdAt, updated_at AS updatedAt'

export interface ChannelCreateInput {
  name: string
  description?: string
  workspace?: string
}

export interface ChannelPatch {
  name?: string
  description?: string
  leadAgentId?: string | null
  workspace?: string
  enabled?: number
}

export type ChannelRepo = ReturnType<typeof createChannelRepo>

export function createChannelRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO channels (id, name, description, lead_agent_id, workspace, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectAll = db.prepare(`SELECT ${COLS} FROM channels ORDER BY createdAt ASC`)
  const selectById = db.prepare(`SELECT ${COLS} FROM channels WHERE id = ?`)
  const updateStmt = db.prepare(
    `UPDATE channels SET name = ?, description = ?, lead_agent_id = ?, workspace = ?, enabled = ?, updated_at = ? WHERE id = ?`,
  )
  const removeStmt = db.prepare(`DELETE FROM channels WHERE id = ?`)

  return {
    /** 创建 channel(description 缺省空串,enabled=1,leadAgentId=null,workspace=空串) */
    create(input: ChannelCreateInput): ChannelRow {
      const now = new Date().toISOString()
      const row: ChannelRow = {
        id: randomUUID(),
        name: input.name,
        description: input.description ?? '',
        leadAgentId: null,
        workspace: input.workspace ?? '',
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      }
      insert.run(row.id, row.name, row.description, row.leadAgentId, row.workspace, row.enabled, row.createdAt, row.updatedAt)
      return row
    },

    list(): ChannelRow[] {
      return selectAll.all() as unknown as ChannelRow[]
    },

    findById(id: string): ChannelRow | undefined {
      return selectById.get(id) as unknown as ChannelRow | undefined
    },

    /** 局部更新;未命中返回 undefined */
    update(id: string, patch: ChannelPatch): ChannelRow | undefined {
      const current = selectById.get(id) as unknown as ChannelRow | undefined
      if (!current) return undefined
      const next: ChannelRow = {
        ...current,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        leadAgentId: patch.leadAgentId !== undefined ? patch.leadAgentId : current.leadAgentId,
        workspace: patch.workspace ?? current.workspace,
        enabled: patch.enabled ?? current.enabled,
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(next.name, next.description, next.leadAgentId, next.workspace, next.enabled, next.updatedAt, id)
      return next
    },

    remove(id: string): void {
      removeStmt.run(id)
    },
  }
}
