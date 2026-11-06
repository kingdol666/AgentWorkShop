/**
 * ChannelSessionRepo —— Channel 会话持久化（channel_sessions 表）。
 *
 * P2 多会话（plan 2026-11-06-channel-multi-session-runtime-plan.md S1）：
 *   一个 session = 从频道基础成员克隆出的独立 agent 实例组（member_map_json:
 *   baseMemberId → cloneInstanceId），拥有独立 AgentRuntime/mailbox/omp 进程与
 *   session 域记忆。同 member 的会话间并行、会话内串行（既有 execLock 语义按
 *   runtime 成立，runtime=每 clone 一个）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface ChannelSessionRow {
  id: string
  channelId: string
  title: string
  status: 'active' | 'closed'
  memoryPolicy: string
  memberMapJson: string
  createdBy: string | null
  createdAt: string
  closedAt: string | null
}

const SESSION_COLS = 'id, channel_id AS channelId, title, status, memory_policy AS memoryPolicy, member_map_json AS memberMapJson, created_by AS createdBy, created_at AS createdAt, closed_at AS closedAt'

export function createChannelSessionRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    `INSERT INTO channel_sessions (id, channel_id, title, status, memory_policy, member_map_json, created_by, created_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
  )
  const byIdStmt = db.prepare(`SELECT ${SESSION_COLS} FROM channel_sessions WHERE id = ?`)
  const byChannelStmt = db.prepare(`SELECT ${SESSION_COLS} FROM channel_sessions WHERE channel_id = ? ORDER BY created_at DESC`)
  const closeStmt = db.prepare(`UPDATE channel_sessions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'active'`)

  return {
    create(input: { channelId: string, title?: string, memoryPolicy?: string, memberMap: Record<string, string>, createdBy?: string }): ChannelSessionRow {
      const id = `cs-${randomUUID().slice(0, 8)}`
      const now = new Date().toISOString()
      insertStmt.run(id, input.channelId, input.title ?? '', input.memoryPolicy ?? 'session', JSON.stringify(input.memberMap ?? {}), input.createdBy ?? null, now)
      return this.findById(id)!
    },

    findById(id: string): ChannelSessionRow | undefined {
      return byIdStmt.get(id) as unknown as ChannelSessionRow | undefined
    },

    listByChannel(channelId: string): ChannelSessionRow[] {
      return byChannelStmt.all(channelId) as unknown as ChannelSessionRow[]
    },

    listActive(channelId: string): ChannelSessionRow[] {
      return this.listByChannel(channelId).filter(s => s.status === 'active')
    },

    /** 关闭会话（幂等：已 closed 返回 false）。 */
    close(id: string): boolean {
      const result = closeStmt.run(new Date().toISOString(), id)
      return Number(result.changes ?? 0) > 0
    },
  }
}

export type ChannelSessionRepo = ReturnType<typeof createChannelSessionRepo>
