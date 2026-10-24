/**
 * ChannelAgent 仓储:channel_agents 表(Channel 中的 Agent 实例)。
 * 每次把 Agent 模板放入 channel 都创建一个全新实例:独立身份 id + 复制自模板的
 * name/harness/config + 独立 role + token。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelAgentRow } from './database'

/**
 * token 比对(定长归一 + 常量时间):长度不同直接 false,不抛异常。
 * WP3 单点:所有 JS 侧 token 比较必须走本函数(或在 repo.findByToken 内同口径)。
 */
export function safeTokenEqual(a: string, b: string): boolean {
  if (!a || !b) return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  try {
    return timingSafeEqual(ab, bb)
  }
  catch {
    return false
  }
}

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
  /** WP3 宽限窗:旧 token 在 prev_token_until 之前仍然有效(桥进程重连过渡) */
  const selectByPrevToken = db.prepare(`SELECT ${COLS} FROM channel_agents WHERE prev_token = ? AND prev_token_until > ?`)
  const selectGrace = db.prepare(`SELECT prev_token AS prevToken, prev_token_until AS prevTokenUntil FROM channel_agents WHERE id = ?`)
  const rotateStmt = db.prepare(`UPDATE channel_agents SET prev_token = token, prev_token_until = ?, token = ?, updated_at = ? WHERE id = ?`)
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

    /**
     * 实例级 token → 实例(MCP/REST caller 解析)。
     * WP3:宽限窗内旧 token 同样命中 —— 四路调用点(invoke/list/面A/manager)共用本方法,
     * 因此「轮换后桥 60s 内可用」在全部路径成立,而不是只改某一处比较。
     */
    findByToken(token: string): ChannelAgentRow | undefined {
      if (!token) return undefined
      const current = selectByToken.get(token) as unknown as ChannelAgentRow | undefined
      if (current) return current
      return selectByPrevToken.get(token, new Date().toISOString()) as unknown as ChannelAgentRow | undefined
    },

    /**
     * 单点 token 校验(常量时间):当前 token 命中,或旧 token 仍在宽限窗内。
     * 供已持有行对象、不想再查一次库的调用点使用(host-tools 等)。
     */
    isTokenValid(row: ChannelAgentRow, token: string): boolean {
      if (!token) return false
      if (safeTokenEqual(row.token, token)) return true
      const grace = selectGrace.get(row.id) as { prevToken: string, prevTokenUntil: string } | undefined
      if (!grace?.prevToken || !grace.prevTokenUntil) return false
      if (grace.prevTokenUntil <= new Date().toISOString()) return false
      return safeTokenEqual(grace.prevToken, token)
    },

    /**
     * 轮换 token(WP3):旧 token 写入宽限列,新 token 立即生效。
     * 未命中返回 undefined;宽限窗缺省 60s(env AW_TOKEN_GRACE_MS 可调,上限 1h)。
     */
    rotateToken(id: string, graceMs?: number): { id: string, token: string, prevTokenUntil: string } | undefined {
      const row = selectById.get(id) as unknown as ChannelAgentRow | undefined
      if (!row) return undefined
      const window = Math.min(Math.max(Number(graceMs ?? process.env.AW_TOKEN_GRACE_MS ?? 60_000), 0), 3600_000)
      const until = new Date(Date.now() + window).toISOString()
      const next = randomUUID()
      rotateStmt.run(until, next, new Date().toISOString(), id)
      return { id, token: next, prevTokenUntil: until }
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
