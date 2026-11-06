/**
 * PR17 M4-1 ProjectEventIngress（plan S2/S3）。
 *
 * 消费 project_events 中未消费事件（service.record() 落库时不消费，入口统一分级）：
 *  - Fast Path（确定性）：直接触发 reconcile（对账幂等），不调 LLM；
 *  - Slow Path（语义）：合并进"每项目至多一个"pending mailbox effect（单飞 ——
 *    推理期到达的事件并入下一批），并有最小间隔退避（busy 时事件留待下轮）。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ProjectKernelRepo } from '../db/project-kernel.repo'

/** 确定性事件：状态迁移事实，reconcile 即可收敛，无需语义判断。 */
const FAST_TYPES = new Set([
  'work.completed', 'work.failed', 'work.canceled', 'work.updated', 'work.plan_aligned',
  'work.dispatched', 'work.dispatch_auto', 'work.retry_scheduled', 'work.started',
  'result.draft', 'result.reviewed', 'result.submitted', 'result.superseded', 'result.rejected',
  'approval.approved', 'approval.rejected', 'approval.expired', 'approval.requested',
  'deliverable.updated', 'deliverable.waived', 'plan.applied', 'plan.requested', 'project.updated',
])

/** 语义事件：需要 leader 评估（是否重规划/是否接受/是否换频道）。 */
const SLOW_TYPES = new Set([
  'work.blocked', 'work.overdue', 'result.submitted', 'channel.proposed', 'channel.apply_failed', 'plan.apply_failed',
])

const EVT_COLS = 'id, project_id AS projectId, seq, type, event_key AS eventKey, payload_json AS payloadJson, trace_id AS traceId, created_at AS createdAt'

export interface IngressOptions {
  nowMs?: () => number
  /** 慢路径最小间隔（退避下限，plan S3 tick 默认 10s）。 */
  minSlowIntervalMs?: number
  slowPathEnabled?: boolean
}

export interface IngressProcessResult {
  consumed: number
  fastCount: number
  slowCount: number
  needsReconcile: boolean
  deferred: number
}

export function createEventIngress(db: DatabaseSync, kernel: ProjectKernelRepo, options: IngressOptions = {}) {
  const nowMs = options.nowMs ?? (() => Date.now())
  const minSlowIntervalMs = options.minSlowIntervalMs ?? 10_000
  const slowPathEnabled = options.slowPathEnabled ?? true
  const consumeStmt = db.prepare('UPDATE project_events SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
  const unconsumedStmt = db.prepare(`SELECT ${EVT_COLS} FROM project_events WHERE project_id = ? AND consumed_at IS NULL ORDER BY seq ASC LIMIT 50`)
  const lastSlowStmt = db.prepare(`SELECT MAX(updated_at) AS at FROM project_effects WHERE project_id = ? AND kind = 'mailbox'`)

  return {
    /** 处理一个项目的未消费事件。返回是否需要 reconcile（fast 有命中）。 */
    process(projectId: string): IngressProcessResult {
      const events = unconsumedStmt.all(projectId) as Array<{
        id: string
        projectId: string
        seq: number
        type: string
        eventKey: string
        payloadJson: string
        traceId: string
        createdAt: string
      }>
      const result: IngressProcessResult = { consumed: 0, fastCount: 0, slowCount: 0, needsReconcile: false, deferred: 0 }
      if (events.length === 0) return result

      const slowIds: string[] = []
      for (const evt of events) {
        // P0-6：FAST/SLOW **非独占**分类。`result.submitted` 同时在两集合——它既需要
        // reconcile 收敛（fast），也需要 leader 语义评估（slow）。旧 if/else-if 让 FAST
        // 独占命中，慢路径对该事件永不触发，leader 对成果提交失聪。
        const isFast = FAST_TYPES.has(evt.type)
        const isSlow = SLOW_TYPES.has(evt.type)
        if (isFast) {
          result.fastCount += 1
          result.needsReconcile = true
        }
        if (isSlow) {
          slowIds.push(evt.id)
        }
        // 未知类型按 fast 兜底（reconcile 幂等，安全）
        if (!isFast && !isSlow) {
          result.fastCount += 1
          result.needsReconcile = true
        }
      }

      // 慢路径：单飞 + 退避。已有 pending mailbox → 事件并入该批；
      // 无 pending 但距上次 mailbox 完成不足 minSlowIntervalMs → 本轮 defer（事件留待下轮）。
      if (slowPathEnabled && slowIds.length > 0) {
        const merged = kernel.effects.mergeIntoPendingMailbox(projectId, slowIds)
        if (!merged) {
          const lastAt = (lastSlowStmt.get(projectId) as { at: string | null }).at
          const quietMs = lastAt ? nowMs() - Date.parse(lastAt) : Number.POSITIVE_INFINITY
          if (quietMs >= minSlowIntervalMs) {
            const minSeq = Math.min(...events.filter(e => slowIds.includes(e.id)).map(e => e.seq))
            kernel.effects.enqueue({
              projectId,
              dedupeKey: `assess:${projectId}:${minSeq}`,
              kind: 'mailbox',
              payload: { events: slowIds, windowSeq: minSeq },
            })
          }
          else {
            result.deferred = slowIds.length
          }
        }
        else {
          result.slowCount = slowIds.length
        }
      }
      else if (slowIds.length > 0) {
        result.deferred = slowIds.length
      }

      // 消费：fast + 已入批 slow 全部标记；仅「慢路径启用且本轮 defer」的 slow 事件
      // 留在队列等下一轮（P0-6 双类事件 defer 时 fast 部分下轮幂等重放，安全）。
      for (const evt of events) {
        const isDeferredSlow = slowPathEnabled && result.deferred > 0 && slowIds.includes(evt.id)
        if (isDeferredSlow) continue
        consumeStmt.run(new Date(nowMs()).toISOString(), evt.id)
        result.consumed += 1
      }
      return result
    },
  }
}
