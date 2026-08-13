/**
 * Agent 仓储:agents 表 CRUD。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentRow } from './database'

const COLS
  = 'id, channel_id AS channelId, name, harness, role, token, config_json AS configJson, enabled, created_at AS createdAt, updated_at AS updatedAt'

export interface AgentCreateInput {
  channelId: string
  name: string
  harness: string
  role: 'lead' | 'worker'
  token?: string
  config?: Record<string, unknown>
}

export interface AgentPatch {
  name?: string
  harness?: string
  role?: string
  token?: string
  config?: Record<string, unknown>
  enabled?: number
}

export type AgentRepo = ReturnType<typeof createAgentRepo>

export function createAgentRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO agents (id, channel_id, name, harness, role, token, config_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectByChannel = db.prepare(`SELECT ${COLS} FROM agents WHERE channel_id = ? ORDER BY createdAt ASC`)
  const selectById = db.prepare(`SELECT ${COLS} FROM agents WHERE id = ?`)
  const selectByToken = db.prepare(`SELECT ${COLS} FROM agents WHERE token = ?`)
  const updateStmt = db.prepare(
    `UPDATE agents SET name = ?, harness = ?, role = ?, token = ?, config_json = ?, enabled = ?, updated_at = ? WHERE id = ?`,
  )
  const removeStmt = db.prepare(`DELETE FROM agents WHERE id = ?`)

  return {
    /** 创建 agent;token 缺省自动生成 UUIDv4,config 缺省 {} */
    create(input: AgentCreateInput): AgentRow {
      const now = new Date().toISOString()
      const row: AgentRow = {
        id: randomUUID(),
        channelId: input.channelId,
        name: input.name,
        harness: input.harness,
        role: input.role,
        token: input.token ?? randomUUID(),
        configJson: JSON.stringify(input.config ?? {}),
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      }
      insert.run(
        row.id, row.channelId, row.name, row.harness, row.role, row.token, row.configJson, row.enabled, row.createdAt, row.updatedAt,
      )
      return row
    },

    listByChannel(channelId: string): AgentRow[] {
      return selectByChannel.all(channelId) as unknown as AgentRow[]
    },

    findById(id: string): AgentRow | undefined {
      return selectById.get(id) as unknown as AgentRow | undefined
    },

    findByToken(token: string): AgentRow | undefined {
      return selectByToken.get(token) as unknown as AgentRow | undefined
    },

    /** 局部更新;config 提供时重新序列化;未命中返回 undefined */
    update(id: string, patch: AgentPatch): AgentRow | undefined {
      const current = selectById.get(id) as unknown as AgentRow | undefined
      if (!current) return undefined
      const next: AgentRow = {
        ...current,
        name: patch.name ?? current.name,
        harness: patch.harness ?? current.harness,
        role: patch.role ?? current.role,
        token: patch.token ?? current.token,
        configJson: patch.config !== undefined ? JSON.stringify(patch.config) : current.configJson,
        enabled: patch.enabled ?? current.enabled,
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(next.name, next.harness, next.role, next.token, next.configJson, next.enabled, next.updatedAt, id)
      return next
    },

    remove(id: string): void {
      removeStmt.run(id)
    },
  }
}
