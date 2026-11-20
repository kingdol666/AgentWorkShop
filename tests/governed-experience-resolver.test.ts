/**
 * Task 4:统一解析器 + 自动注入闸 + 撤权/换产品/epoch。
 *
 * 真问题(准入阻断):自动注入面曾把未验证/未部署内容送进提示;产品切换或撤权后
 * 旧内容仍可从缓存/召回面返回。断言覆盖:解析器三种用途、epoch 失效、产品隔离、
 * 自动召回只认 validated+已部署。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-governed-resolver-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createExperienceVersion, setVersionState } = await import('../server/services/workshop/experience/versions')
const { resolveExperience, isAutoInjectable } = await import('../server/services/workshop/experience/resolve')
const { advanceLearningAuthorizationEpoch, readLearningAuthorizationEpoch }
  = await import('../server/services/workshop/experience/trusted-context')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')

const context = (product: string, epoch = 0) => ({
  actor: 'user-1', channelId: 'ch-1', sessionId: 's-1', authorizationEpoch: epoch,
  subjectRef: `product:${product}`, environment: 'simulation' as const,
  industrial: { lineId: 'ln-1', productId: product, recipeRevision: 'rev-1', runId: 'run-1' },
})

const seed = (db: ReturnType<typeof openWorkshopDb>, opts: {
  id: string
  product: string
  content: string
  status: 'validated' | 'candidate' | 'legacy-unverified'
  deployment: 'none' | 'shadow' | 'canary' | 'active'
}) => {
  const repo = createMemoryRepo(db)
  repo.upsertExperience({
    channelId: 'ch-1', agentId: 'ag-1', kind: 'experience', title: opts.id, titleFts: opts.id, content: opts.content,
    importance: 0.9, taskId: 't-1', sessionId: '', dedupKey: `dedup-${opts.id}`, outcome: 'positive',
    evidence: { taskIds: ['t-1'] }, scopeKind: 'product', scopeKey: opts.product,
    status: opts.status === 'validated' ? 'validated' : 'candidate', expiresAt: null,
  })
  const memoryId = repo.listByAgentChannel('ch-1', 'ag-1', 50).find(r => r.title === opts.id)!.id
  const evidence = [{
    id: `${opts.id}-ev`, sourceKind: 'task' as const, environment: 'simulation' as const,
    observedAt: '2026-11-20T10:00:00.000Z', supportUnitId: 'run-1', polarity: 'support' as const,
  }]
  const version = createExperienceVersion(db, {
    experienceId: memoryId, scope: { kind: 'product', key: opts.product },
    claim: {
      productId: opts.product, recipeRevision: 'rev-1', variable: '保压压力SP', unit: 'MPa',
      direction: 'increase', condition: '', polarity: 'support',
    },
    content: opts.content, observedAt: '2026-11-20T10:00:00.000Z', evidence,
    idempotencyKey: `seed:${opts.id}`, evidenceSnapshotHash: undefined as never,
  } as never, null)
  setVersionState(db, version.versionId, { lifecycle: opts.status, deployment: opts.deployment }, 'seed')
  return { memoryId, versionId: version.versionId }
}

test('product switch revokes all read paths', () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  const a = seed(db, { id: 'A', product: 'prod-a', content: '保压压力 +1MPa 提升克重', status: 'validated', deployment: 'active' })
  const b = seed(db, { id: 'B', product: 'prod-b', content: '保压压力 +2MPa 提升克重', status: 'validated', deployment: 'active' })

  const onA = resolveExperience(db, context('prod-a', readLearningAuthorizationEpoch(db)), { text: '保压压力', purpose: 'automatic', limit: 5 })
  assert.deepEqual(onA.items.map(i => i.versionId), [a.versionId])
  const onB = resolveExperience(db, context('prod-b', readLearningAuthorizationEpoch(db)), { text: '保压压力', purpose: 'automatic', limit: 5 })
  assert.equal(onB.items.some(i => i.versionId === a.versionId), false)
  assert.equal(onB.items.some(i => i.versionId === b.versionId), true)
})

test('only validated and deployed versions are auto-injectable', () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  const undeployed = seed(db, { id: 'U', product: 'prod-a', content: '未部署的已验证', status: 'validated', deployment: 'none' })
  const shadow = seed(db, { id: 'S', product: 'prod-a', content: '影子中的验证', status: 'validated', deployment: 'shadow' })
  const legacy = seed(db, { id: 'L', product: 'prod-a', content: '旧行无来源', status: 'legacy-unverified', deployment: 'none' })
  const active = seed(db, { id: 'X', product: 'prod-a', content: '已部署的经验', status: 'validated', deployment: 'active' })

  const auto = resolveExperience(db, context('prod-a', readLearningAuthorizationEpoch(db)), { text: '', purpose: 'automatic', limit: 10 })
  const ids = auto.items.map(i => i.versionId)
  assert.equal(ids.includes(active.versionId), true)
  assert.equal(ids.includes(undeployed.versionId), false)
  assert.equal(ids.includes(shadow.versionId), false)
  assert.equal(ids.includes(legacy.versionId), false)
  assert.equal(isAutoInjectable('shadow', 'validated'), false)
  assert.equal(isAutoInjectable('active', 'candidate'), false)

  // 显式获取:未部署的 validated 可见但标记为参考
  const explicit = resolveExperience(db, context('prod-a', readLearningAuthorizationEpoch(db)), { text: '未部署', purpose: 'explicit', limit: 10 })
  const ref = explicit.items.find(i => i.versionId === undeployed.versionId)
  assert.equal(ref?.referenceOnly, true)
  // 候选只在 review 面可见
  const review = resolveExperience(db, context('prod-a', readLearningAuthorizationEpoch(db)), { text: '', purpose: 'review', limit: 10 })
  assert.equal(review.items.every(i => i.lifecycle !== 'legacy-unverified'), true)
})

test('stale authorization epoch blocks resolution and native session reuse', () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  const a = seed(db, { id: 'A', product: 'prod-a', content: '已部署经验', status: 'validated', deployment: 'active' })
  const epoch = readLearningAuthorizationEpoch(db)
  const before = resolveExperience(db, context('prod-a', epoch), { text: '', purpose: 'automatic', limit: 5 })
  assert.equal(before.items.length, 1)
  advanceLearningAuthorizationEpoch(db, 'admin', 'membership revoked')
  const after = resolveExperience(db, context('prod-a', epoch), { text: '', purpose: 'automatic', limit: 5 })
  assert.equal(after.items.length, 0)
  assert.match(after.decision.reason, /EPOCH_STALE/)
  assert.equal(a.versionId, before.items[0]!.versionId)
})

test('automatic recall excludes validated-but-undeployed experience rows', async () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  const repo = createMemoryRepo(db)
  const mem = new AgentMemory(repo, { channelId: 'ch-1', agentId: 'ag-1', industrialScopeEnabled: true, productId: 'prod-a' })
  const row = seed(db, { id: 'R', product: 'prod-a', content: '召回面经验条目 阈值 42', status: 'validated', deployment: 'none' })
  // recall() 是自动注入面(内部 automatic: true)
  const before = await mem.recall('阈值')
  assert.equal(before?.includes('阈值 42') ?? false, false, '未部署经验不得进入自动注入')
  setVersionState(db, row.versionId, { deployment: 'active' }, 'reviewer')
  const after = await mem.recall('阈值')
  assert.equal(after?.includes('阈值 42') ?? false, true, '部署后可进入自动注入')
})
