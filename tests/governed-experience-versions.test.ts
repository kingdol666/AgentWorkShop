/**
 * Task 2:不可变经验版本 + kind 隔离 + 迁移回填。
 *
 * 真问题(准入阻断):同键 upsert 会原地改写正文/scope/结论,已审标签随旧证据留在新主张上。
 * 断言:已审版本哈希不变、变更只能新建 candidate、跨 kind 同键拒绝、CAS 只允许一次推进、
 * 旧行回填为 legacy-unverified 且重跑迁移幂等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-governed-versions-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createExperienceVersion, getVersion, listVersions, setVersionState, headVersionId }
  = await import('../server/services/workshop/experience/versions')
const { proposeClaimCluster } = await import('../server/services/workshop/experience/claim-cluster')
const { migrateExperienceVersionStore } = await import('../server/services/workshop/db/database/migrations-experience-versions')
const { EXPERIENCE_VERSION_CONFLICT } = await import('../server/services/workshop/experience/types')

const draft = (over: Record<string, unknown> = {}) => ({
  experienceId: 'exp-1',
  scope: { kind: 'line' as const, key: 'ln-1' },
  claim: {
    productId: 'prod-a', recipeRevision: 'rev-1', variable: '保压压力SP', unit: 'MPa',
    direction: 'increase' as const, condition: 'mold-temp 55C', polarity: 'support' as const,
  },
  content: '保压压力 +1MPa → 克重 +0.08g',
  observedAt: '2026-11-20T10:00:00.000Z',
  evidence: [{
    id: 'ev-1', sourceKind: 'task' as const, environment: 'simulation' as const,
    observedAt: '2026-11-20T10:00:00.000Z', supportUnitId: 'run-1', polarity: 'support' as const,
  }],
  idempotencyKey: 'claim:exp-1:1',
  ...over,
})

test('replay_does_not_rewrite_validated_claim', () => {
  const db = openWorkshopDb(':memory:')
  const v1 = createExperienceVersion(db, draft(), null)
  setVersionState(db, v1.versionId, { lifecycle: 'validated', deployment: 'active' }, 'reviewer')
  const before = getVersion(db, v1.versionId)!

  // 正文变化 → 必须新建 candidate 版本(而不是原地改)
  const v2 = createExperienceVersion(db, draft({ content: '保压压力 +2MPa → 克重 +0.16g', idempotencyKey: 'claim:exp-1:2' }), v1.versionId)
  const after = getVersion(db, v1.versionId)!
  assert.equal(after.contentHash, before.contentHash)
  assert.equal(after.evidenceSnapshotHash, before.evidenceSnapshotHash)
  assert.equal(after.lifecycle, 'validated')
  assert.notEqual(v2.versionId, before.versionId)
  assert.equal(v2.lifecycle, 'candidate')
  assert.equal(v2.deployment, 'none')

  // 同幂等键 + 同内容重放 → 返回原版本(不是冲突,也不产生新行)
  const replay = createExperienceVersion(db, draft(), null)
  assert.equal(replay.versionId, v1.versionId)
  assert.equal(listVersions(db, 'exp-1').length, 2)
})

test('concurrent head advancement succeeds exactly once', () => {
  const db = openWorkshopDb(':memory:')
  createExperienceVersion(db, draft({ experienceId: 'exp-2' }), null)
  assert.throws(
    () => createExperienceVersion(db, draft({ experienceId: 'exp-2', idempotencyKey: 'k2', content: 'other' }), null),
    (err: unknown) => (err as { code?: string }).code === EXPERIENCE_VERSION_CONFLICT,
  )
})

test('cross-kind same key cannot overwrite experience or plain memory', () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  const repo = createMemoryRepo(db)
  repo.upsertExperience({
    channelId: 'ch-1', agentId: 'ag-1', kind: 'experience', title: '经验', titleFts: '经验', content: '经验正文',
    importance: 0.9, taskId: 't-1', sessionId: '', dedupKey: 'dup-1', outcome: 'positive',
    evidence: { taskIds: ['t-1'] }, scopeKind: 'line', scopeKey: 'ln-1', status: 'candidate', expiresAt: null,
  })
  assert.throws(
    () => repo.upsert({
      channelId: 'ch-1', agentId: 'ag-1', kind: 'semantic', title: '普通', titleFts: '普通', content: '普通正文',
      importance: 0.5, taskId: null, sessionId: '', dedupKey: 'dup-1',
    }),
    (err: unknown) => (err as { code?: string }).code === 'EXPERIENCE_KEY_CONFLICT',
  )
  const rows = repo.listByAgentChannel('ch-1', 'ag-1', 10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.kind, 'experience')
})

test('legacy backfill marks rows legacy-unverified and stays idempotent', () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  const repo = createMemoryRepo(db)
  // 模拟历史行:validated 但无可解析来源
  repo.upsertExperience({
    channelId: 'ch-2', agentId: 'ag-2', kind: 'experience', title: '旧经验', titleFts: '旧经验', content: '旧正文',
    importance: 0.9, taskId: 't-9', sessionId: '', dedupKey: 'legacy-1', outcome: 'positive',
    evidence: { taskIds: ['t-9'] }, scopeKind: 'line', scopeKey: 'ln-9', status: 'validated', expiresAt: null,
  })
  migrateExperienceVersionStore(db)
  const first = listVersions(db, repo.listByAgentChannel('ch-2', 'ag-2', 10)[0]!.id)
  assert.equal(first.length, 1)
  assert.equal(first[0]!.lifecycle, 'legacy-unverified')
  assert.equal(first[0]!.deployment, 'none')

  migrateExperienceVersionStore(db)
  assert.equal(listVersions(db, repo.listByAgentChannel('ch-2', 'ag-2', 10)[0]!.id).length, 1)
})

test('claim clustering rejects different variables and Beta descendants', () => {
  const db = openWorkshopDb(':memory:')
  const a = createExperienceVersion(db, draft({ experienceId: 'exp-3' }), null)
  const pressure = { ...a, versionId: `${a.versionId}-x` }
  const time = { ...a, versionId: `${a.versionId}-y`, claim: { ...a.claim, variable: '保压时间SP', unit: 's' } }
  assert.equal(proposeClaimCluster([pressure, time]).compatible, false)
  assert.ok(proposeClaimCluster([pressure, time]).reasons.some(r => r.startsWith('VARIABLE_MISMATCH')))
  const beta = { ...a, versionId: `${a.versionId}-z`, betaAncestors: ['beta:src'] }
  assert.equal(proposeClaimCluster([pressure, beta]).compatible, false)
  assert.ok(proposeClaimCluster([pressure, beta]).reasons.some(r => r.startsWith('BETA_ANCESTOR_PRESENT')))
})

test('head pointer follows the newest version only', () => {
  const db = openWorkshopDb(':memory:')
  const v1 = createExperienceVersion(db, draft({ experienceId: 'exp-4' }), null)
  const v2 = createExperienceVersion(db, draft({ experienceId: 'exp-4', idempotencyKey: 'k4b', content: 'v2' }), v1.versionId)
  assert.equal(headVersionId(db, 'exp-4'), v2.versionId)
})
