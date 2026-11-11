/**
 * Message 仓储:messages 表(mailbox 持久化队列)。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MessageRow } from './database'

const COLS
  = 'id, channel_id AS channelId, task_id AS taskId, session_id AS sessionId, actor_user_id AS actorUserId, client_message_id AS clientMessageId, from_agent_id AS fromAgentId, to_agent_id AS toAgentId, role, parts_json AS partsJson, metadata_json AS metadataJson, state, attempts, created_at AS createdAt, consumed_at AS consumedAt'

export interface MessageCreateInput {
  /** 落库 id;缺省生成。A2A 入队时传发送方 messageId,保证 API 返回 id 与历史 id 一致关联 */
  id?: string
  channelId: string
  taskId?: string | null
  sessionId?: string | null
  /** durable actor/user dimension for session idempotency; non-session mailbox messages remain null */
  actorUserId?: string | null
  /** session 人类消息客户端幂等键;非 session mailbox 消息保持 null */
  clientMessageId?: string | null
  fromAgentId?: string | null
  toAgentId?: string | null
  role: string
  parts: unknown[]
  metadata?: Record<string, unknown>
}

export type MessageRepo = ReturnType<typeof createMessageRepo>

export function createMessageRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, task_id, session_id, actor_user_id, client_message_id, from_agent_id, to_agent_id, role, parts_json, metadata_json, state, created_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectPending = db.prepare(
    // rowid 决胜:同一毫秒内批量入队(连发任务/调度批量派发)也保持严格入队顺序(FIFO)
    `SELECT ${COLS} FROM messages WHERE channel_id = ? AND to_agent_id = ? AND state = 'pending' ORDER BY createdAt ASC, rowid ASC`,
  )
  /** 队头单条(dequeue 热路径;idx_messages_queue 覆盖,LIMIT 1 免全量拉取) */
  const firstPending = db.prepare(
    `SELECT ${COLS} FROM messages WHERE channel_id = ? AND to_agent_id = ? AND state = 'pending' ORDER BY createdAt ASC, rowid ASC LIMIT 1`,
  )
  const markConsumingStmt = db.prepare(
    `UPDATE messages SET state = 'consuming' WHERE id = ? AND state = 'pending'`,
  )
  const markConsumedStmt = db.prepare(
    `UPDATE messages SET state = 'consumed', consumed_at = ? WHERE id = ?`,
  )
  const resetConsumingStmt = db.prepare(
    // P3-4:崩溃恢复重投不复活 dead(重投上限是持久判定,重启不洗白)
    `UPDATE messages SET state = 'pending' WHERE state = 'consuming' AND attempts < 3`,
  )
  const requeueStmt = db.prepare(
    // P3-4(2026-11-01):重投计数上限 —— attempts+1,达 3 次不再回 pending(→ dead)。
    // steer 对忙碌 Agent 的重投之前无上限:坏消息(解析必炸/超长)会在
    // "认领→steer 失败→回 pending"里无限循环,每 250ms 吃掉一个调度拍。
    `UPDATE messages SET attempts = attempts + 1,
       state = CASE WHEN attempts + 1 >= 3 THEN 'dead' ELSE 'pending' END
     WHERE id = ? AND state = 'consuming'`,
  )
  const consumePendingByTaskStmt = db.prepare(
    `UPDATE messages SET state = 'consumed', consumed_at = ? WHERE task_id = ? AND state = 'pending'`,
  )
  const selectRecent = db.prepare(
    `SELECT ${COLS} FROM messages WHERE channel_id = ? ORDER BY createdAt DESC LIMIT ?`,
  )
  const selectPendingTargets = db.prepare(
    `SELECT DISTINCT channel_id AS channelId, to_agent_id AS toAgentId
     FROM messages WHERE to_agent_id IS NOT NULL AND state = 'pending'`,
  )
  const selectByClientMessageId = db.prepare(
    `SELECT ${COLS} FROM messages WHERE channel_id = ? AND session_id = ? AND actor_user_id = ? AND client_message_id = ? LIMIT 1`,
  )
  const existsPendingAssignStmt = db.prepare(
    `SELECT 1 AS hit FROM messages
     WHERE task_id = ? AND state = 'pending' AND metadata_json LIKE '%"x-aw-task-kind":"assign"%'
     LIMIT 1`,
  )

  function buildRow(input: MessageCreateInput): MessageRow {
    const now = new Date().toISOString()
    return {
      id: input.id ?? randomUUID(),
      channelId: input.channelId,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      actorUserId: input.actorUserId ?? null,
      clientMessageId: input.clientMessageId ?? null,
      fromAgentId: input.fromAgentId ?? null,

      toAgentId: input.toAgentId ?? null,
      role: input.role,
      partsJson: JSON.stringify(input.parts),
      metadataJson: JSON.stringify(input.metadata ?? {}),
      state: 'pending',
      attempts: 0,
      createdAt: now,
      consumedAt: null,
    }
  }

  function insertRow(row: MessageRow): void {
    insert.run(
      row.id, row.channelId, row.taskId, row.sessionId, row.actorUserId, row.clientMessageId, row.fromAgentId, row.toAgentId, row.role, row.partsJson, row.metadataJson, row.state, row.createdAt, row.consumedAt,
    )
  }

  function isSessionIdempotencyInput(input: MessageCreateInput): boolean {
    return input.sessionId != null && input.actorUserId != null && input.clientMessageId != null
  }

  function isSessionIdempotencyConflict(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return /UNIQUE constraint failed:\s*messages\.(?:channel_id|session_id|actor_user_id|client_message_id)/i.test(message)
  }

  return {
    /** 创建消息(state=pending,parts/metadata 序列化存储) */
    create(input: MessageCreateInput): MessageRow {
      const row = buildRow(input)
      insertRow(row)
      return row
    },

    /**
     * Session clientMessageId 的原子 INSERT 入口。
     * 先插入、仅在唯一键冲突后回读，绝不依赖先查后插；这也覆盖了跨请求/跨进程并发。
     */
    createSessionIdempotent(input: MessageCreateInput): { row: MessageRow, inserted: boolean } {
      if (!isSessionIdempotencyInput(input)) return { row: this.create(input), inserted: true }
      const row = buildRow(input)
      try {
        insertRow(row)
        return { row, inserted: true }
      }
      catch (err) {
        if (!isSessionIdempotencyConflict(err)) throw err
        const existing = (selectByClientMessageId.get(input.channelId, input.sessionId!, input.actorUserId!, input.clientMessageId!) as MessageRow | undefined) ?? undefined
        // 唯一冲突行理论上必然可回读；若不可见则保留原始 SQLite 错误，避免静默假成功。
        if (!existing) throw err
        return { row: existing, inserted: false }
      }
    },

    /** 判断同一幂等键的不可变消息载荷是否完全一致。 */
    sameSessionPayload(row: MessageRow, input: MessageCreateInput): boolean {
      return row.channelId === input.channelId
        && row.sessionId === (input.sessionId ?? null)
        && row.actorUserId === (input.actorUserId ?? null)
        && row.clientMessageId === (input.clientMessageId ?? null)
        && row.toAgentId === (input.toAgentId ?? null)
        && row.role === input.role
        && row.partsJson === JSON.stringify(input.parts)
        && row.metadataJson === JSON.stringify(input.metadata ?? {})
    },

    findByClientMessageId(channelId: string, sessionId: string, actorUserId: string, clientMessageId: string): MessageRow | undefined {
      return (selectByClientMessageId.get(channelId, sessionId, actorUserId, clientMessageId) as MessageRow | undefined) ?? undefined
    },

    listPendingByChannelAgent(channelId: string, toAgentId: string, limit?: number): MessageRow[] {
      if (limit != null) {
        return db.prepare(
          `SELECT ${COLS} FROM messages WHERE channel_id = ? AND to_agent_id = ? AND state = 'pending' ORDER BY createdAt ASC, rowid ASC LIMIT ?`,
        ).all(channelId, toAgentId, limit) as unknown as MessageRow[]
      }
      return selectPending.all(channelId, toAgentId) as unknown as MessageRow[]
    },

    /** 队头单条(dequeue 热路径:WHERE+ORDER 走 idx_messages_queue,LIMIT 1 免全量) */
    firstPendingByChannelAgent(channelId: string, toAgentId: string): MessageRow | undefined {
      return (firstPending.get(channelId, toAgentId) as MessageRow | undefined) ?? undefined
    },

    /**
     * 原子认领:pending → consuming(WHERE state='pending' 守卫)。
     * 返回是否认领成功——多方竞争(steer 注入 / poll_messages 读即取 / 消费循环
     * dequeue)下只有第一个认领者获得消息所有权,保证恰好一次投递。
     */
    claim(id: string): boolean {
      return markConsumingStmt.run(id).changes > 0
    },

    /** consuming → consumed(记录消费时间) */
    markConsumed(id: string): void {
      markConsumedStmt.run(new Date().toISOString(), id)
    },

    /** 启动恢复:所有 consuming 重置回 pending(重新投递) */
    resetConsuming(): void {
      resetConsumingStmt.run()
    },

    /** 单条重投:consuming → pending(回合失败重试);返回是否实际重投 */
    requeue(id: string): boolean {
      return requeueStmt.run(id).changes > 0
    },

    /** 按 channel 倒序列出最近消息 */
    listRecentByChannel(channelId: string, limit: number): MessageRow[] {
      return selectRecent.all(channelId, limit) as unknown as MessageRow[]
    },

    /** 启动恢复:全部未消费消息的目标 agent(供 restore 唤醒,重投的 assign 才能被消费) */
    listPendingTargets(): Array<{ channelId: string, toAgentId: string }> {
      return selectPendingTargets.all() as Array<{ channelId: string, toAgentId: string }>
    },

    /** 作废某任务的全部 pending 消息(cancel/reassign/update 后清理旧 assignee 队列中的过期投递) */
    consumePendingByTask(taskId: string): void {
      consumePendingByTaskStmt.run(new Date().toISOString(), taskId)
    },

    /** 某任务是否存在未消费的 assign 投递(restore 断线重连判定:无则需重投) */
    hasPendingAssign(taskId: string): boolean {
      return existsPendingAssignStmt.get(taskId) !== undefined
    },
  }
}
