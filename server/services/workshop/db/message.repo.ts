/**
 * Message 仓储:messages 表(mailbox 持久化队列)。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MessageRow } from './database'

const COLS
  = 'id, channel_id AS channelId, task_id AS taskId, from_agent_id AS fromAgentId, to_agent_id AS toAgentId, role, parts_json AS partsJson, metadata_json AS metadataJson, state, created_at AS createdAt, consumed_at AS consumedAt'

export interface MessageCreateInput {
  /** 落库 id;缺省生成。A2A 入队时传发送方 messageId,保证 API 返回 id 与历史 id 一致 */
  id?: string
  channelId: string
  taskId?: string | null
  fromAgentId?: string | null
  toAgentId?: string | null
  role: string
  parts: unknown[]
  metadata?: Record<string, unknown>
}

export type MessageRepo = ReturnType<typeof createMessageRepo>

export function createMessageRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, task_id, from_agent_id, to_agent_id, role, parts_json, metadata_json, state, created_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectPending = db.prepare(
    `SELECT ${COLS} FROM messages WHERE channel_id = ? AND to_agent_id = ? AND state = 'pending' ORDER BY createdAt ASC`,
  )
  const markConsumingStmt = db.prepare(
    `UPDATE messages SET state = 'consuming' WHERE id = ? AND state = 'pending'`,
  )
  const markConsumedStmt = db.prepare(
    `UPDATE messages SET state = 'consumed', consumed_at = ? WHERE id = ?`,
  )
  const resetConsumingStmt = db.prepare(
    `UPDATE messages SET state = 'pending' WHERE state = 'consuming'`,
  )
  const selectRecent = db.prepare(
    `SELECT ${COLS} FROM messages WHERE channel_id = ? ORDER BY createdAt DESC LIMIT ?`,
  )
  const selectPendingTargets = db.prepare(
    `SELECT DISTINCT channel_id AS channelId, to_agent_id AS toAgentId
     FROM messages WHERE to_agent_id IS NOT NULL AND state = 'pending'`,
  )

  return {
    /** 创建消息(state=pending,parts/metadata 序列化存储) */
    create(input: MessageCreateInput): MessageRow {
      const now = new Date().toISOString()
      const row: MessageRow = {
        id: input.id ?? randomUUID(),
        channelId: input.channelId,
        taskId: input.taskId ?? null,
        fromAgentId: input.fromAgentId ?? null,
        toAgentId: input.toAgentId ?? null,
        role: input.role,
        partsJson: JSON.stringify(input.parts),
        metadataJson: JSON.stringify(input.metadata ?? {}),
        state: 'pending',
        createdAt: now,
        consumedAt: null,
      }
      insert.run(
        row.id, row.channelId, row.taskId, row.fromAgentId, row.toAgentId, row.role, row.partsJson, row.metadataJson, row.state, row.createdAt, row.consumedAt,
      )
      return row
    },

    /** 拉取某 channel 内某 Agent 的未消费消息(FIFO) */
    listPendingByChannelAgent(channelId: string, toAgentId: string): MessageRow[] {
      return selectPending.all(channelId, toAgentId) as unknown as MessageRow[]
    },

    /** pending → consuming(消费中,防重复投递) */
    markConsuming(id: string): void {
      markConsumingStmt.run(id)
    },

    /** consuming → consumed(记录消费时间) */
    markConsumed(id: string): void {
      markConsumedStmt.run(new Date().toISOString(), id)
    },

    /** 启动恢复:所有 consuming 重置回 pending(重新投递) */
    resetConsuming(): void {
      resetConsumingStmt.run()
    },

    /** 按 channel 倒序列出最近消息 */
    listRecentByChannel(channelId: string, limit: number): MessageRow[] {
      return selectRecent.all(channelId, limit) as unknown as MessageRow[]
    },

    /** 启动恢复:全部未消费消息的目标 agent(供 restore 唤醒,重投的 assign 才能被消费) */
    listPendingTargets(): Array<{ channelId: string, toAgentId: string }> {
      return selectPendingTargets.all() as unknown as Array<{ channelId: string, toAgentId: string }>
    },
  }
}
