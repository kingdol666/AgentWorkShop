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
  /** 条件发布(幂等;不改动非 pending 行) */
  const markPublishedIfPending = db.prepare(`UPDATE outbox_events SET status = 'published', published_at = ?, attempts = attempts + 1, last_error = '' WHERE id = ? AND status = 'pending'`)
  const markFailed = db.prepare(`UPDATE outbox_events SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`)
  const reschedule = db.prepare(`UPDATE outbox_events SET status = 'pending', attempts = attempts + 1, last_error = ? WHERE id = ?`)
  const countByStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM outbox_events GROUP BY status`)
  /** 保留期清理:删除已发布且 published_at 早于给定时刻的行 */
  const sweepPublishedStmt = db.prepare(`DELETE FROM outbox_events WHERE status = 'published' AND published_at IS NOT NULL AND published_at < ?`)
  /** 死信保留期清理:failed 行超过保留期后回收(否则毒事件永久占表,§11 需要容量有界) */
  const sweepFailedStmt = db.prepare(`DELETE FROM outbox_events WHERE status = 'failed' AND created_at < ?`)

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

    /**
     * 幂等收敛:pending → published(仅当仍为 pending)。
     *
     * 与 `markPublished` 的差别:这是**条件更新**,重复调用不会把 attempts 越加越大,
     * 也不会覆盖已 failed 的行(发布阶段的"已成功"不应该抹掉失败留痕)。
     * 返回是否真的发生了状态迁移 —— 调用方据此判断"本次发布是否首次成功"。
     */
    markPublishedIfPending(id: string): boolean {
      return Number(markPublishedIfPending.run(new Date().toISOString(), id).changes ?? 0) > 0
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

    /**
     * 保留期清理:删除 `published_at < beforeIso` 的已发布行,返回清理行数。
     *
     * 每次群聊发言都会登记 outbox 行(chat.message + 每条投递),不清理则表随会话线性增长。
     * **只删 published**:pending 是"尚未发布"的欠账,failed 是失败留痕,都不能回收。
     */
    sweepPublished(beforeIso: string): number {
      return Number(sweepPublishedStmt.run(beforeIso).changes ?? 0)
    },

    /**
     * 死信保留期清理:删除 `created_at < beforeIso` 的 failed 行,返回清理行数。
     * pending(**尚未发布**的欠账)永不回收 —— 那是必须收敛的事实源。
     */
    sweepFailed(beforeIso: string): number {
      return Number(sweepFailedStmt.run(beforeIso).changes ?? 0)
    },
  }
}
