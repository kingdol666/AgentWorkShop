/**
 * Task 5:冻结评测口径(独立留出、完整分母、臂隔离、宿主来源)。
 *
 * 真问题(准入阻断):客户端逐样本自报不能证明宿主执行;同 run 复用作留出、
 * 只报成功样本、跨臂泄漏都会让"通过"变成假象。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { planExperienceEvaluation, runExperienceEvaluation, recordHostEvaluationEvidence }
  = await import('../server/services/workshop/experience/evaluation-run')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')

const spec = (over: Record<string, unknown> = {}) => ({
  dataVersions: { dataset: 'ds-1' },
  modelVersion: 'm-1',
  policyVersion: 'p-1',
  arms: ['A', 'B', 'C', 'D'] as const,
  primaryEndpoint: 'rework-rate',
  minEffect: 0.05,
  nonInferiorityBound: 0.02,
  maxCostDelta: 0.1,
  alpha: 0.05,
  minSampleSize: 12,
  developmentUnits: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'],
  holdoutUnits: ['h1', 'h2', 'h3'],
  provenance: 'host' as const,
  ...over,
})

const outcomes = (over: Record<string, unknown> = {}) => ([
  { arm: 'A' as const, success: 3, failed: 0, timedOut: 0, interrupted: 0, effect: 0, cost: 1 },
  { arm: 'B' as const, success: 3, failed: 0, timedOut: 0, interrupted: 0, effect: 0, cost: 1 },
  { arm: 'C' as const, success: 3, failed: 0, timedOut: 0, interrupted: 0, effect: 0.08, cost: 1.02 },
  { arm: 'D' as const, success: 3, failed: 0, timedOut: 0, interrupted: 0, effect: 0.09, cost: 1.03 },
  ...(over.extra as never[] ?? []),
])

test('evaluation_requires_independent_holdout', () => {
  const leaked = planExperienceEvaluation(spec({ holdoutUnits: ['u1', 'u2'] }), outcomes())
  assert.equal(leaked.status, 'BLOCKED')
  assert.ok(leaked.blockers.some(b => b.startsWith('HOLDOUT_LEAK')))
  assert.equal(leaked.releaseEligible, false)
})

test('denominator counts every terminal branch', () => {
  const result = planExperienceEvaluation(spec(), outcomes({
    extra: [{ arm: 'C', success: 1, failed: 1, timedOut: 1, interrupted: 1, effect: 0.08, cost: 1.02 }],
  }))
  const c = outcomes({ extra: [{ arm: 'C', success: 1, failed: 1, timedOut: 1, interrupted: 1, effect: 0.08, cost: 1.02 }] })
  const expected = c.reduce((n, o) => n + o.success + o.failed + o.timedOut + o.interrupted, 0)
  assert.equal(result.denominator, expected)
  // 声明分母与逐臂合计不一致 → 拒绝(不允许漏报失败/超时)
  const declared = planExperienceEvaluation(spec({ declaredDenominator: 99 }), outcomes())
  assert.equal(declared.status, 'BLOCKED')
  assert.ok(declared.blockers.some(b => b.startsWith('DENOMINATOR_MISMATCH')))
})

test('client-only bench is never release eligible', () => {
  const client = planExperienceEvaluation(spec({ provenance: 'client' }), outcomes())
  assert.equal(client.releaseEligible, false)
  assert.ok(client.blockers.some(b => b.startsWith('CLIENT_PROVENANCE')))
  const host = planExperienceEvaluation(spec(), outcomes())
  assert.equal(host.status, 'PASS')
  assert.equal(host.releaseEligible, true)
})

test('one arm cannot see another arm updates', () => {
  const leaked = planExperienceEvaluation(spec(), outcomes({
    extra: [{ arm: 'D', success: 3, failed: 0, timedOut: 0, interrupted: 0, effect: 0.09, cost: 1.03, sawOtherArmUpdates: true }],
  }))
  assert.equal(leaked.status, 'BLOCKED')
  assert.ok(leaked.blockers.some(b => b.startsWith('ARM_LEAK')))
})

test('insufficient sample and missing versions block', () => {
  const small = planExperienceEvaluation(spec({ minSampleSize: 100 }), outcomes())
  assert.equal(small.status, 'BLOCKED')
  assert.ok(small.blockers.some(b => b.startsWith('SAMPLE_INSUFFICIENT')))
  const unpinned = planExperienceEvaluation(spec({ dataVersions: {} }), outcomes())
  assert.ok(unpinned.blockers.includes('DATA_VERSION_UNPINNED'))
})

test('runner blocks when an arm cannot execute (no fixture substitution)', async () => {
  const ref = await runExperienceEvaluation(spec(), {
    runArm: async (arm) => {
      if (arm === 'D') throw new Error('quota exhausted')
      return { success: 3, failed: 0, timedOut: 0, interrupted: 0, effect: arm === 'C' ? 0.08 : 0, cost: 1 }
    },
  })
  assert.equal(ref.status, 'BLOCKED')
  assert.ok(ref.blockers.some(b => b.includes('ARM_EXECUTION_FAILED:D')))
  assert.equal(ref.releaseEligible, false)
})

test('host evaluation evidence becomes a promotable host-provenanced run', () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare('INSERT INTO channel_harness_profiles(id, channel_id, status, version, layers_json, created_at, updated_at, promoted_at, bench_run_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('pf-1', 'ch-1', 'shadow', 1, '{}', new Date().toISOString(), new Date().toISOString(), null, null)
  const evidence = planExperienceEvaluation(spec(), outcomes())
  const bad = recordHostEvaluationEvidence(db, { channelId: 'ch-1', profileId: 'pf-1', evidence: planExperienceEvaluation(spec({ provenance: 'client' }), outcomes()), createdBy: 'u-1' })
  assert.equal(bad.ok, false)
  const good = recordHostEvaluationEvidence(db, { channelId: 'ch-1', profileId: 'pf-1', evidence, createdBy: 'u-1' })
  assert.equal(good.ok, true)
  const row = db.prepare('SELECT kind, pairs, artifact_sha256 AS sha FROM harness_bench_runs WHERE id = ?').get(good.benchRunId!) as { kind: string, pairs: number, sha: string }
  assert.equal(row.kind, 'host-evaluation')
  assert.equal(row.pairs, evidence.denominator)
  assert.equal(row.sha, evidence.manifestHash)
})
