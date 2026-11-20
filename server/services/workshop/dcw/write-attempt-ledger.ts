/**
 * 写尝试账本(Task 8)。
 *
 * 事故形态:进程在 driver.write() 已开始、但结果/写历史尚未落库时退出 —— 批准行
 * 无法证明设备是否执行。这里把「意图 / 已进入驱动 / 结果」三态持久化:
 *  - prepared:已登记但尚未调用驱动 → 重启后可判 not_sent(安全,不重发);
 *  - dispatched:已进入驱动调用、结果未知 → 重启后判 unknown,必须独立对账;
 *  - settle:verified / rejected(由回读或错误明确得出)。
 * 任何状态都不触发自动重发;重发只能由人重新走审批。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type WriteAttemptState = 'prepared' | 'dispatched' | 'verified' | 'rejected' | 'not_sent' | 'unknown'

export interface WriteAttemptIntent {
  nodeId: string
  lineId?: string
  approvalId?: string
  taskId?: string
  executionLeaseId?: string
  /** 本次写入的载荷指纹(值+目标+约束),用于对账比对 */
  payloadHash: string
}

export const payloadHashOf = (input: unknown): string =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex')

export function recordWriteIntent(db: DatabaseSync, intent: WriteAttemptIntent): string {
  const id = `wat-${randomUUID().slice(0, 12)}`
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO dcw_write_attempts
      (id, node_id, line_id, approval_id, task_id, execution_lease_id, payload_hash, state, detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', '', ?, ?)`,
  ).run(id, intent.nodeId, intent.lineId ?? '', intent.approvalId ?? '', intent.taskId ?? '',
    intent.executionLeaseId ?? '', intent.payloadHash, now, now)
  return id
}

export function markWriteDispatched(db: DatabaseSync, attemptId: string): void {
  db.prepare(`UPDATE dcw_write_attempts SET state = 'dispatched', updated_at = ? WHERE id = ? AND state = 'prepared'`)
    .run(new Date().toISOString(), attemptId)
}

export function settleWriteAttempt(db: DatabaseSync, attemptId: string, outcome: 'verified' | 'rejected' | 'unknown', detail = ''): void {
  db.prepare(`UPDATE dcw_write_attempts SET state = ?, detail = ?, updated_at = ? WHERE id = ?`)
    .run(outcome, detail.slice(0, 400), new Date().toISOString(), attemptId)
}

export interface WriteReconcileReport {
  notSent: string[]
  unknown: string[]
}

/**
 * 启动对账:未闭合尝试一律不重发。
 * prepared → not_sent(驱动未被调用);dispatched → unknown(可能已生效,须人工/独立观察核实)。
 */
export function reconcileOpenWriteAttempts(db: DatabaseSync): WriteReconcileReport {
  const rows = db.prepare(
    `SELECT id, state FROM dcw_write_attempts WHERE state IN ('prepared', 'dispatched') ORDER BY created_at`,
  ).all() as Array<{ id: string, state: WriteAttemptState }>
  const report: WriteReconcileReport = { notSent: [], unknown: [] }
  const now = new Date().toISOString()
  for (const row of rows) {
    if (row.state === 'prepared') {
      db.prepare(`UPDATE dcw_write_attempts SET state = 'not_sent', detail = ?, updated_at = ? WHERE id = ?`)
        .run('restart-reconcile: 未进入驱动调用', now, row.id)
      report.notSent.push(row.id)
    }
    else {
      db.prepare(`UPDATE dcw_write_attempts SET state = 'unknown', detail = ?, updated_at = ? WHERE id = ?`)
        .run('restart-reconcile: 已进入驱动但结果未知,禁止自动重发', now, row.id)
      report.unknown.push(row.id)
    }
  }
  return report
}

/** 审批关联完整性:代次/租约/载荷任一不一致即不得复用旧批准 */
export interface StoredApprovalRef {
  approvalId: string
  assignmentGeneration: number | null
  executionLeaseId: string | null
  contextHash: string
  payloadHash: string
  expiresAt: string | null
}

export interface CurrentExecutionContext {
  assignmentGeneration: number
  executionLeaseId: string
  contextHash: string
  payloadHash: string
  now?: number
}

export function approvalReusable(
  stored: StoredApprovalRef,
  current: CurrentExecutionContext,
): { reusable: boolean, reason: string } {
  const now = current.now ?? Date.now()
  if (stored.expiresAt) {
    const expires = Date.parse(stored.expiresAt)
    if (!Number.isFinite(expires) || expires <= now) return { reusable: false, reason: 'APPROVAL_EXPIRED' }
  }
  if (stored.assignmentGeneration !== current.assignmentGeneration) return { reusable: false, reason: 'STALE_ASSIGNMENT_GENERATION' }
  if (stored.executionLeaseId !== current.executionLeaseId) return { reusable: false, reason: 'STALE_EXECUTION_LEASE' }
  if (stored.contextHash !== current.contextHash) return { reusable: false, reason: 'CONTEXT_CHANGED' }
  if (stored.payloadHash !== current.payloadHash) return { reusable: false, reason: 'PAYLOAD_CHANGED' }
  return { reusable: true, reason: 'OK' }
}
