/**
 * PR-D 运行韧性回归:写尝试账本、旧批准拒绝、计划进度与待批防重、
 * 依赖健康决策、批次质量与外部终态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-pr-d-resilience-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const {
  recordWriteIntent, markWriteDispatched, reconcileOpenWriteAttempts,
  approvalReusable, payloadHashOf,
} = await import('../server/services/workshop/dcw/write-attempt-ledger')
const { decideDependencyAction } = await import('../server/services/workshop/runtime/manager/dependency-health')
const { assessBatchQuality, projectExternalJob } = await import('../server/services/workshop/daq/batch-quality')
const { derivePlanProgress, conflictsWithPendingPlan } = await import('../server/services/workshop/projects/plan-progress')

test('old_approval_and_unknown_effect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-wat-'))
  const path = join(dir, 'workshop.db')
  const db = openWorkshopDb(path)
  db.exec('PRAGMA foreign_keys = OFF')
  // 模拟:prepared 后进程退出(驱动未调用)/ dispatched 后退出(结果未知)
  const prepared = recordWriteIntent(db, { nodeId: 'dw-1', payloadHash: payloadHashOf({ v: 1 }) })
  const dispatched = recordWriteIntent(db, { nodeId: 'dw-1', payloadHash: payloadHashOf({ v: 2 }) })
  markWriteDispatched(db, dispatched)
  db.close()

  const restarted = openWorkshopDb(path)
  restarted.exec('PRAGMA foreign_keys = OFF')
  const driverCalls = 0
  void driverCalls
  const report = reconcileOpenWriteAttempts(restarted)
  assert.deepEqual(report.notSent, [prepared])
  assert.deepEqual(report.unknown, [dispatched])
  assert.equal(driverCalls, 0, '对账不得触发任何驱动调用')
  const row = restarted.prepare('SELECT state FROM dcw_write_attempts WHERE id = ?').get(dispatched) as { state: string }
  assert.equal(row.state, 'unknown')
  restarted.close()

  // 旧批准:代次/租约/载荷任一变化即不可复用
  const stored = { approvalId: 'ap-1', assignmentGeneration: 1, executionLeaseId: 'lease-a', contextHash: 'c1', payloadHash: 'p1', expiresAt: null }
  assert.equal(approvalReusable(stored, { assignmentGeneration: 2, executionLeaseId: 'lease-a', contextHash: 'c1', payloadHash: 'p1' }).reason, 'STALE_ASSIGNMENT_GENERATION')
  assert.equal(approvalReusable(stored, { assignmentGeneration: 1, executionLeaseId: 'lease-b', contextHash: 'c1', payloadHash: 'p1' }).reason, 'STALE_EXECUTION_LEASE')
  assert.equal(approvalReusable(stored, { assignmentGeneration: 1, executionLeaseId: 'lease-a', contextHash: 'c2', payloadHash: 'p1' }).reason, 'CONTEXT_CHANGED')
  assert.equal(approvalReusable(stored, { assignmentGeneration: 1, executionLeaseId: 'lease-a', contextHash: 'c1', payloadHash: 'p2' }).reason, 'PAYLOAD_CHANGED')
  assert.equal(approvalReusable(stored, { assignmentGeneration: 1, executionLeaseId: 'lease-a', contextHash: 'c1', payloadHash: 'p1' }).reusable, true)
})

test('unknown_write_does_not_use_model_fallback', () => {
  const base = {
    provider: 'down' as const, rpc: 'closed' as const, process: 'exited' as const,
    budget: 'ok' as const, rateLimited: false, queueDepth: 0, lastProgressAt: null,
    waitingForApproval: false, effectUnknown: true,
  }
  const decision = decideDependencyAction(base, { effectful: true, readonlyFallbackAllowed: true })
  assert.equal(decision.action, 'attention_required')
  assert.ok(decision.reasons.some(r => r.startsWith('EFFECT_UNKNOWN')))

  // 只读步骤允许批准的能力等价降级
  const readonly = decideDependencyAction({ ...base, effectUnknown: false }, { effectful: false, readonlyFallbackAllowed: true })
  assert.equal(readonly.action, 'fallback_readonly')
  // 预算耗尽优先失败,不靠延长超时
  const budget = decideDependencyAction({ ...base, effectUnknown: false, budget: 'exhausted' }, { effectful: false, readonlyFallbackAllowed: false })
  assert.equal(budget.action, 'failed')
  // 等待审批不得被无活动时钟误杀
  const waiting = decideDependencyAction({ ...base, effectUnknown: false, waitingForApproval: true }, { effectful: true, readonlyFallbackAllowed: false })
  assert.equal(waiting.action, 'wait')
  // 慢但有进展继续;无进展才重试
  const progress = decideDependencyAction({
    ...base, provider: 'degraded', rpc: 'ready', process: 'alive', effectUnknown: false, lastProgressAt: new Date().toISOString(),
  }, { effectful: true, readonlyFallbackAllowed: false })
  assert.equal(progress.action, 'continue')
})

test('critical_sample_gap_blocks_use', () => {
  const gap = assessBatchQuality({ expectedCount: 100, validCount: 60, droppedCount: 10, gapWindows: [{ from: 0, to: 120_000 }] })
  assert.equal(gap.eligibleForControlEvidence, false)
  assert.equal(gap.eligibleForTraining, false)
  const healthy = assessBatchQuality({ expectedCount: 100, validCount: 100, droppedCount: 0 })
  assert.equal(healthy.eligibleForControlEvidence, true)
  assert.equal(healthy.eligibleForTraining, true)
  const degraded = assessBatchQuality({ expectedCount: 100, validCount: 96, droppedCount: 1 })
  assert.equal(degraded.eligibleForControlEvidence, true)
  assert.equal(degraded.eligibleForTraining, false)
})

test('accepted_or_missing_artifact_is_not_completed', () => {
  const accepted = projectExternalJob({ accepted: true, terminal: null, overdue: false, artifact: 'missing' })
  assert.notEqual(accepted.outcome, 'completed')
  assert.equal(accepted.acceptanceEligible, false)
  const done = projectExternalJob({ accepted: true, terminal: 'completed', overdue: false, artifact: 'missing' })
  assert.equal(done.outcome, 'completed', '上游终态必须忠实记录')
  assert.equal(done.artifactStatus, 'missing')
  assert.equal(done.acceptanceEligible, false)
  const okJob = projectExternalJob({ accepted: true, terminal: 'completed', overdue: false, artifact: 'present' })
  assert.equal(okJob.acceptanceEligible, true)
  const fallback = projectExternalJob({ accepted: true, terminal: null, overdue: true, artifact: 'unverified', agentUnavailable: true })
  assert.equal(fallback.outcome, 'overdue')
  assert.equal(fallback.documentFallbackMode, 'readonly')
})

test('pending_plan_blocks_conflicting_manual_item', () => {
  const approval = {
    id: 'ap-plan-1', projectId: 'p-1', kind: 'plan_approval', subjectType: 'plan', subjectId: 'plan:p-1:2',
    subjectVersion: 2, status: 'pending', requestedByAgentId: null, requestedByUserId: null,
    payloadJson: JSON.stringify({
      deliverables: [{ key: 'd1', name: 'shift-mid-analysis' }],
      work_items: [{ key: 'w1', title: 'R2 目标带差距量化', dedupeKey: 'r2-gap-20261119' }],
    }),
    argsDigest: '', reason: '', decisionReason: '', decidedByUserId: null, consumedAt: null,
    traceId: 'plan:p-1:2', expiresAt: null, createdAt: '2026-11-20T01:08:54.000Z', decidedAt: null,
  } as never

  const snapshot = derivePlanProgress({ planVersion: 1, approvals: [approval as never], materializedAt: null, lastDecision: null })
  assert.equal(snapshot.state, 'pending_approval')
  assert.equal(snapshot.pendingApprovalId, 'ap-plan-1')

  const conflictingCreate = conflictsWithPendingPlan([approval as never], { title: 'R2 目标带差距量化', dedupeKey: 'r2-gap-20261119' })
  assert.equal(conflictingCreate.conflict, true)
  assert.equal(conflictingCreate.reason, 'PLAN_CHANGE_PENDING')

  const unrelated = conflictsWithPendingPlan([approval as never], { title: '独立设备巡检', dedupeKey: 'device-check-1' })
  assert.equal(unrelated.conflict, false)

  const applied = derivePlanProgress({ planVersion: 2, approvals: [], materializedAt: '2026-11-20T01:24:41.000Z', lastDecision: null })
  assert.equal(applied.state, 'applied')
  assert.equal(applied.materializedAt, '2026-11-20T01:24:41.000Z')

  const rejected = derivePlanProgress({
    planVersion: 1, approvals: [], materializedAt: null,
    lastDecision: { status: 'rejected', decidedAt: '2026-11-20T01:30:00.000Z' },
  })
  assert.equal(rejected.state, 'rejected')
})
