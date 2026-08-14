/**
 * ChannelAgent 仓储:channel_agents 表(Channel 中的 Agent 实例)。
 * 每次把 Agent 模板放入 channel 都创建一个全新实例:独立身份 id + 复制自模板的
 * name/harness/config + 独立 role + token。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelAgentRow } from './database'

export interface ChannelAgentCreateInput {
  channelId: string
  templateId: string | null
  name: string
  harness: string
  config?: Record<string, unknown>
  role: 'lead' | 'worker'
  token?: string
}

export interface ChannelAgentPatch {
  name?: string
  harness?: string
  config?: Record<string, unknown>
  role?: 'lead' | 'worker'
  enabled?: number
}

export type ChannelAgentRepo = ReturnType<typeof createChannelAgentRepo>

const COLS
  = 'id, channel_id AS channelId, template_id AS templateId, name, harness, config_json AS configJson, role, token, enabled, created_at AS createdAt, updated_at AS updatedAt'

export function createChannelAgentRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO channel_agents (id, channel_id, template_id, name, harness, config_json, role, token, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectByChannel = db.prepare(`SELECT ${COLS} FROM channel_agents WHERE channel_id = ? ORDER BY created_at ASC`)
  const selectById = db.prepare(`SELECT ${COLS} FROM channel_agents WHERE id = ?`)
  const selectByChannelAgent = db.prepare(`SELECT ${COLS} FROM channel_agents WHERE channel_id = ? AND id = ?`)
  const selectByToken = db.prepare(`SELECT ${COLS} FROM channel_agents WHERE token = ?`)
  const selectByTemplate = db.prepare(`SELECT ${COLS} FROM channel_agents WHERE template_id = ? ORDER BY created_at ASC`)
  const updateStmt = db.prepare(
    `UPDATE channel_agents SET name = ?, harness = ?, config_json = ?, role = ?, enabled = ?, updated_at = ? WHERE id = ?`,
  )
  const removeStmt = db.prepare(`DELETE FROM channel_agents WHERE channel_id = ? AND id = ?`)

  return {
    /** 创建实例(独立身份 id;token 缺省自动生成 UUIDv4) */
    create(input: ChannelAgentCreateInput): ChannelAgentRow {
      const now = new Date().toISOString()
      const row: ChannelAgentRow = {
        id: randomUUID(),
        channelId: input.channelId,
        templateId: input.templateId,
        name: input.name,
        harness: input.harness,
        configJson: JSON.stringify(input.config ?? {}),
        role: input.role,
        token: input.token ?? randomUUID(),
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      }
      insert.run(
        row.id, row.channelId, row.templateId, row.name, row.harness, row.configJson, row.role, row.token, row.enabled, row.createdAt, row.updatedAt,
      )
      return row
    },

    /** channel 内全部实例 */
    listByChannel(channelId: string): ChannelAgentRow[] {
      return selectByChannel.all(channelId) as unknown as ChannelAgentRow[]
    },

    /** 按实例 id 查找 */
    findById(id: string): ChannelAgentRow | undefined {
      return selectById.get(id) as unknown as ChannelAgentRow | undefined
    },

    /** channel 内的某个实例 */
    findByChannelAgent(channelId: string, id: string): ChannelAgentRow | undefined {
      return selectByChannelAgent.get(channelId, id) as unknown as ChannelAgentRow | undefined
    },

    /** 实例级 token → 实例(MCP/REST caller 解析) */
    findByToken(token: string): ChannelAgentRow | undefined {
      return selectByToken.get(token) as unknown as ChannelAgentRow | undefined
    },

    /** 某模板克隆出的全部实例(跨 channel) */
    listByTemplate(templateId: string): ChannelAgentRow[] {
      return selectByTemplate.all(templateId) as unknown as ChannelAgentRow[]
    },

    /** 局部更新;config 提供时重新序列化;未命中返回 undefined */
    update(id: string, patch: ChannelAgentPatch): ChannelAgentRow | undefined {
      const current = selectById.get(id) as unknown as ChannelAgentRow | undefined
      if (!current) return undefined
      const next: ChannelAgentRow = {
        ...current,
        name: patch.name ?? current.name,
        harness: patch.harness ?? current.harness,
        configJson: patch.config !== undefined ? JSON.stringify(patch.config) : current.configJson,
        role: patch.role ?? current.role,
        enabled: patch.enabled ?? current.enabled,
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(next.name, next.harness, next.configJson, next.role, next.enabled, next.updatedAt, id)
      return next
    },

    /** 移除实例(仅删实例,不删模板) */
    remove(channelId: string, id: string): void {
      removeStmt.run(channelId, id)
    },
  }
}
