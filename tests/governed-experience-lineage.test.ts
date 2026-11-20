/**
 * Task 3:可信上下文 + 独立证据 + 主张簇 + Beta/时间窗约束。
 *
 * 真问题(准入阻断):重试/分片/同一运行被计成独立样本;主张形成前的观测被用来
 * 支持主张;复述曾注入的主张被当成新外部证据;Beta 派生物经摘要后失去限制。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-governed-lineage-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { buildTrustedLearningContext, advanceLearningAuthorizationEpoch, readLearningAuthorizationEpoch }
  = await import('../server/services/workshop/experience/trusted-context')
const { classifyEvidence, hasIndependentSupport } = await import('../server/services/workshop/experience/evidence-ledger')
const { createExperienceVersion } = await import('../server/services/workshop/experience/versions')
const { proposeClaimCluster } = await import('../server/services/workshop/experience/claim-cluster')

const context = {
  actor: 'user-1',
  channelId: 'ch-1',
  sessionId: 's-1',
  authorizationEpoch: 3,
  subjectRef: 'product:PP-面板',
  environment: 'simulation' as const,
  industrial: { lineId: 'ln-1', productId: 'prod-a', recipeRevision: 'rev-1', runId: 'run-9' },
}

const ref = (over: Record<string, unknown>) => ({
  id: 'r', sourceKind: 'task' as const, environment: 'simulation' as const,
  observedAt: '2026-11-20T10:30:00.000Z', supportUnitId: 'run-1', polarity: 'support' as const,
  ...over,
})

test('rejects_retries_and_incompatible_claims', () => {
  // 同一运行的不同 attempt:只能算 1 个支持单元
  const retried = classifyEvidence([
    ref({ id: 'a', taskId: 't-1', attempt: 1 }),
    ref({ id: 'b', taskId: 't-2', attempt: 2 }),
  ], context)
  assert.equal(retried.supportUnitIds.length, 1)

  // 同 taskId 但不同运行 → 仍是同一支持单元(按宿主单元,不按任务 id 数)
  const shared = classifyEvidence([
    ref({ id: 'c', taskId: 't-1', supportUnitId: 'batch-7' }),
    ref({ id: 'd', taskId: 't-1', supportUnitId: 'batch-7' }),
  ], context)
  assert.equal(shared.supportUnitIds.length, 1)
})

test('evidence before claim origin and replayed injections do not count', () => {
  const decision = classifyEvidence([
    ref({ id: 'early', observedAt: '2026-11-20T09:00:00.000Z' }),
    ref({ id: 'replayed', restatesVersionIds: ['ev-1'] }),
    ref({ id: 'unknown', polarity: 'unknown' }),
    ref({ id: 'ok', supportUnitId: 'run-2' }),
  ], context, { claimOriginTime: '2026-11-20T10:00:00.000Z' })
  assert.deepEqual(decision.supportUnitIds, ['run-2'])
  assert.ok(decision.excludedReasons.some(r => r.includes('BEFORE_CLAIM_ORIGIN')))
  assert.ok(decision.excludedReasons.some(r => r.includes('REPEATED_INJECTED_CLAIM')))
  assert.ok(decision.excludedReasons.some(r => r.includes('UNKNOWN_POLARITY')))
})

test('beta evidence and environment mismatch are excluded from support', () => {
  const decision = classifyEvidence([
    ref({ id: 'beta', betaAncestors: ['beta-src'] }),
    ref({ id: 'prod', environment: 'production' }),
    ref({ id: 'keep', supportUnitId: 'run-3' }),
  ], context)
  assert.deepEqual(decision.supportUnitIds, ['run-3'])
  assert.ok(decision.excludedReasons.some(r => r.includes('BETA_ANCESTOR')))
  assert.ok(decision.excludedReasons.some(r => r.includes('ENVIRONMENT_MISMATCH')))
})

test('two independent compatible supports pass; a refutation blocks', () => {
  const two = classifyEvidence([
    ref({ id: 'a', supportUnitId: 'run-a' }),
    ref({ id: 'b', supportUnitId: 'run-b' }),
  ], context)
  assert.equal(hasIndependentSupport(two), true)
  const withRefute = classifyEvidence([
    ref({ id: 'a', supportUnitId: 'run-a' }),
    ref({ id: 'b', supportUnitId: 'run-b' }),
    ref({ id: 'c', supportUnitId: 'run-c', polarity: 'refute' }),
  ], context)
  assert.equal(hasIndependentSupport(withRefute), false)
})

test('incompatible claims cannot be merged regardless of task ids', () => {
  const db = openWorkshopDb(':memory:')
  const base = {
    experienceId: 'e1', scope: { kind: 'line' as const, key: 'ln-1' },
    content: 'c', observedAt: '2026-11-20T10:00:00.000Z', evidence: [], idempotencyKey: 'k1',
    claim: {
      productId: 'prod-a', recipeRevision: 'rev-1', variable: '保压压力SP', unit: 'MPa',
      direction: 'increase' as const, condition: '', polarity: 'support' as const,
    },
  }
  const a = createExperienceVersion(db, base, null)
  const otherVariable = createExperienceVersion(db, { ...base, idempotencyKey: 'k2', claim: { ...base.claim, variable: '保压时间SP', unit: 's' } }, a.versionId)
  const otherProduct = createExperienceVersion(db, { ...base, idempotencyKey: 'k3', claim: { ...base.claim, productId: 'prod-b' } }, otherVariable.versionId)
  assert.equal(proposeClaimCluster([a, otherVariable]).compatible, false)
  assert.equal(proposeClaimCluster([a, otherProduct]).compatible, false)
  const same = createExperienceVersion(db, { ...base, idempotencyKey: 'k4', experienceId: 'e2' }, null)
  const twin = createExperienceVersion(db, { ...base, idempotencyKey: 'k5', experienceId: 'e2', content: 'c2' }, same.versionId)
  assert.equal(proposeClaimCluster([same, twin]).compatible, true)
})

test('trusted context fails closed without host actor or subject', () => {
  assert.equal(buildTrustedLearningContext({ ...context, actor: '' }).ok, false)
  assert.equal(buildTrustedLearningContext({ ...context, subjectRef: null }).ok, false)
  assert.equal(buildTrustedLearningContext({ ...context, authorizationEpoch: -1 }).ok, false)
  assert.equal(buildTrustedLearningContext({ ...context, industrial: { lineId: '', productId: 'p' } }).ok, false)
  const ok = buildTrustedLearningContext(context)
  assert.equal(ok.ok, true)
})

test('authorization epoch advances monotonically and is persisted', () => {
  const db = openWorkshopDb(':memory:')
  assert.equal(readLearningAuthorizationEpoch(db), 0)
  assert.equal(advanceLearningAuthorizationEpoch(db, 'admin', 'membership changed'), 1)
  assert.equal(advanceLearningAuthorizationEpoch(db, 'admin', 'product switched'), 2)
  assert.equal(readLearningAuthorizationEpoch(db), 2)
})
