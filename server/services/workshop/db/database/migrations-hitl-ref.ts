/**
 * HITL 执行关联列(Task 8)。
 *
 * 事实:启动对账可以关闭旧等待,但持久行此前没有 task/代次/lease/载荷关联,
 * 无法还原旧请求所属 attempt 与可能的设备效果。补列后,审批行可以证明
 * 「它属于哪次派发、哪个代次、哪个租约、什么载荷」;旧批准对不上当前执行上下文
 * 即拒绝复用(approvalReusable),不尝试"恢复旧批准"。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'

export function migrateHitlExecutionRefColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'hitl_requests', 'task_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'hitl_requests', 'delivery_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'hitl_requests', 'attempt_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'hitl_requests', 'assignment_generation', 'INTEGER')
  migrateAddColumn(db, 'hitl_requests', 'execution_lease_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'hitl_requests', 'context_hash', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'hitl_requests', 'payload_hash', 'TEXT NOT NULL DEFAULT \'\'')
}
