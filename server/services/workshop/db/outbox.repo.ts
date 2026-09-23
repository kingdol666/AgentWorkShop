/**
 * Outbox 仓储 —— v17 事务内待发布事件(outbox_events)。
 *
 * 语义(主计划 §3.6):
 * - 消息事实落库与 delivery/outbox 写入必须同一 SQLite 事务;
 * - 广播失败**不能回滚已落库消息**;重试必须幂等(attempts 计数 + status)。
 * - status: pending | published | failed
 *
 * 用途:WS 广播是不可靠副作用(peer 可能断开、进程可能崩溃)。落库成功即事实,
 * 发布失败只影响实时提示,由 listPending 的补偿扫描(或客户端游标补拉)收敛。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { OutboxEventRow } from './database'

const COLS = 'id, aggregate_type AS aggregateType, aggregate_id AS aggregateId, event_type AS eventType, payload_json AS payloadJson, status, attempts, last_error AS lastError, created_at AS createdAt, published_at AS publishedAt'

export type OutboxStatus = 'pending' | 'published' | 'failed'

export interface OutboxEnqueueInput {
  aggregateType: string
  aggregateId: string
  eventType: string
  payload?: Record<string, unknown>
  /** 幂等键(缺省 = `${aggregateType}:${aggregateId}:${eventType}`;同键唯一) */
  eventId?: string
  id?: string
}

export type OutboxRepo = ReturnType<typeof createOutboxRepo>

export function createOutboxRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload_json, status, attempts, last_error, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, '', ?, NULL)`,
  )
  const selectById = db.prepare(`SELECT ${COLS} FROM outbox_events WHERE id = ?`)
  const selectPending = db.prepare(`SELECT ${COLS} FROM outbox_events WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`)
  const selectAll = db.prepare(`SELECT ${COLS} FROM outbox_events ORDER BY created_at ASC LIMIT ?`)
  const markPublished = db.prepare(`UPDATE outbox_events SET status = 'published', published_at = ?, attempts = attempts + 1, last_error = '' WHERE id = ?`)
  const markFailed = db.prepare(`UPDATE outbox_events SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`)
  const reschedule = db.prepare(`UPDATE outbox_events SET status = 'pending', attempts = attempts + 1, last_error = ? WHERE id = ?`)
  const countByStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM outbox_events GROUP BY status`)

  return {
    /**
     * 事务内登记一条待发布事件(幂等:同 id 已存在时不重复插入)。
     * 返回 id 与是否新插入。
     */
    enqueue(input: OutboxEnqueueInput): { id: string, inserted: boolean } {
      const id = input.id ?? input.eventId ?? `${input.aggregateType}:${input.aggregateId}:${input.eventType}:${randomUUID()}`
      const res = insert.run(
        id, input.aggregateType, input.aggregateId, input.eventType,
        JSON.stringify(input.payload ?? {}), new Date().toISOString(),
      )
      return { id, inserted: Number(res.changes ?? 0) > 0 }
    },

    findById(id: string): OutboxEventRow | undefined {
      return (selectById.get(id) as unknown as OutboxEventRow | undefined) ?? undefined
    },

    /** 待发布清单(补偿扫描;升序保序) */
    listPending(limit = 200): OutboxEventRow[] {
      return selectPending.all(limit) as unknown as OutboxEventRow[]
    },

    listAll(limit = 500): OutboxEventRow[] {
      return selectAll.all(limit) as unknown as OutboxEventRow[]
    },

    markPublished(id: string): void {
      markPublished.run(new Date().toISOString(), id)
    },

    markFailed(id: string, error: string): void {
      markFailed.run(error.slice(0, 500), id)
    },

    /** 重试:failed → pending(attempts+1) */
    reschedule(id: string, reason = ''): void {
      reschedule.run(reason.slice(0, 500), id)
    },

    counts(): Record<string, number> {
      const rows = countByStatus.all() as unknown as Array<{ status: string, n: number }>
      const out: Record<string, number> = { pending: 0, published: 0, failed: 0 }
      for (const r of rows) out[r.status] = Number(r.n)
      return out
    },
  }
}
