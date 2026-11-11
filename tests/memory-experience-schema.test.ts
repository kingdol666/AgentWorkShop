/**
 * RSI 经验层数据模型（WP-A1）：迁移补列 / 证据锚点校验 / 生命周期与作用域检索。
 * 纯内存 DB；验证「非法证据拒绝写入（fail-closed）」与「既有行按默认值解释」两条不变量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-exp-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb, initWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { migrateExperienceColumns, ensureExperienceIndexes } = await import('../server/services/workshop/db/database/migrations-experience')

function fixture() {
  const db = openWorkshopDb(':memory:')
  const repo = createMemoryRepo(db)
  return { db, repo }
}

const baseExp = {
  channelId: 'ch-1',
  agentId: 'agent-a',
  title: '锻造温区收窄经验',
  titleFts: '锻造温区收窄经验',
  content: '在 WWTP-4 产线，均热段温差收窄到 ±3℃ 后 IAE 下降 12%',
  importance: 0.8,
  dedupKey: 'exp:task:t-1',
  evidence: { taskIds: ['t-1'], metrics: { iae: 12 } },
}

test('迁移：新列齐备且默认值符合口径（老行等价的语义）', () => {
  const { db } = fixture()
  try {
    const cols = db.prepare(`PRAGMA table_info(agent_memories)`).all() as Array<{ name: string, dflt_value: string | null }>
    const byName = new Map(cols.map(c => [c.name, c]))
    for (const name of ['outcome', 'evidence_json', 'scope_kind', 'scope_key', 'status', 'expires_at']) {
      assert.ok(byName.has(name), `agent_memories 缺列 ${name}`)
    }
    assert.match(String(byName.get('outcome')?.dflt_value), /'neutral'/)
    assert.match(String(byName.get('scope_kind')?.dflt_value), /'session'/)
    assert.match(String(byName.get('status')?.dflt_value), /'active'/)
    // 既有写入路径（普通 upsert）不传经验字段 → 落默认值，不抛错
    const repo = createMemoryRepo(db)
    repo.upsert({ ...baseExp, kind: 'episodic-task', dedupKey: 'task:t-old' })
    const row = repo.listByAgentChannel('ch-1', 'agent-a', 5)[0]!
    assert.equal(row.outcome, 'neutral')
    assert.equal(row.scopeKind, 'session')
    assert.equal(row.scopeKey, '')
    assert.equal(row.status, 'active')
    assert.equal(row.evidenceJson, '')
    assert.equal(row.expiresAt, null)
  }
  finally {
    db.close()
  }
})

test('迁移幂等：重复执行 migrateExperienceColumns / ensureExperienceIndexes 不报错', () => {
  const { db } = fixture()
  try {
    migrateExperienceColumns(db)
    ensureExperienceIndexes(db)
    migrateExperienceColumns(db)
    ensureExperienceIndexes(db)
    // analysis_reports.recipe_run_id 同时就位（WP-D1 前置）
    const cols = db.prepare(`PRAGMA table_info(analysis_reports)`).all() as Array<{ name: string }>
    assert.ok(cols.some(c => c.name === 'recipe_run_id'))
  }
  finally {
    db.close()
  }
})

test('证据校验 fail-closed：缺失/非法 JSON/无锚点一律拒绝且不落行', () => {
  const { db, repo } = fixture()
  try {
    assert.throws(() => repo.upsertExperience({ ...baseExp, evidence: undefined as never }), /evidence required/)
    assert.throws(() => repo.upsertExperience({ ...baseExp, evidence: '{not json' }), /not valid JSON/)
    assert.throws(() => repo.upsertExperience({ ...baseExp, evidence: '[]' }), /expected object/)
    assert.throws(() => repo.upsertExperience({ ...baseExp, evidence: { metrics: { x: 1 } } }), /no anchor/)
    assert.equal(repo.listByAgentChannel('ch-1', 'agent-a', 10).length, 0, '拒绝的写入不得落行')
  }
  finally {
    db.close()
  }
})

test('经验写入：证据落库 + 默认作用域/状态 + 幂等刷新（access_count 保留）', () => {
  const { db, repo } = fixture()
  try {
    const first = repo.upsertExperience({ ...baseExp, outcome: 'positive', scopeKind: 'line', scopeKey: 'line-1', status: 'candidate' })
    assert.ok(first.id)
    const row = repo.getById(first.id)!
    assert.equal(row.kind, 'experience')
    assert.equal(row.outcome, 'positive')
    assert.equal(row.scopeKind, 'line')
    assert.equal(row.scopeKey, 'line-1')
    assert.equal(row.status, 'candidate')
    assert.deepEqual(JSON.parse(row.evidenceJson ?? '{}'), { taskIds: ['t-1'], metrics: { iae: 12 } })

    repo.touch(first.id)
    repo.touch(first.id)
    const again = repo.upsertExperience({ ...baseExp, outcome: 'negative', evidence: { resultId: 'r-9' }, scopeKind: 'line', scopeKey: 'line-1' })
    assert.equal(again.id, first.id, '同 dedupKey 幂等：不新增行')
    const refreshed = repo.getById(first.id)!
    assert.equal(refreshed.outcome, 'negative', '证据刷新覆盖极性')
    assert.equal(refreshed.accessCount, 2, 'access_count 不被写入重置')
    assert.equal(repo.listByAgentChannel('ch-1', 'agent-a', 10).length, 1)
  }
  finally {
    db.close()
  }
})

test('作用域检索：line/product 分档隔离 + retired 缺省排除 + channelIds 收窄', () => {
  const { db, repo } = fixture()
  try {
    repo.upsertExperience({ ...baseExp, dedupKey: 'exp:l1-a', channelId: 'ch-1', scopeKind: 'line', scopeKey: 'line-1', status: 'validated' })
    repo.upsertExperience({ ...baseExp, dedupKey: 'exp:l1-b', channelId: 'ch-2', scopeKind: 'line', scopeKey: 'line-1', status: 'active' })
    repo.upsertExperience({ ...baseExp, dedupKey: 'exp:l2', channelId: 'ch-3', scopeKind: 'line', scopeKey: 'line-2' })
    repo.upsertExperience({ ...baseExp, dedupKey: 'exp:p1', channelId: 'ch-1', scopeKind: 'product', scopeKey: 'prod-1' })
    repo.upsertExperience({ ...baseExp, dedupKey: 'exp:retired', channelId: 'ch-1', scopeKind: 'line', scopeKey: 'line-1', status: 'retired' })

    const line1 = repo.listByScope({ scopeKind: 'line', scopeKey: 'line-1' })
    assert.equal(line1.length, 2, '同产线跨频道命中 2 条；retired 缺省排除')
    assert.ok(line1.every(r => r.scopeKey === 'line-1'))

    const onlyCh1 = repo.listByScope({ scopeKind: 'line', scopeKey: 'line-1', channelIds: ['ch-1'] })
    assert.equal(onlyCh1.length, 1)

    assert.equal(repo.listByScope({ scopeKind: 'line', scopeKey: 'line-2' }).length, 1)
    assert.equal(repo.listByScope({ scopeKind: 'product', scopeKey: 'prod-1' }).length, 1)
    assert.equal(repo.listByScope({ scopeKind: 'product', scopeKey: 'line-1' }).length, 0, '作用域键不串味')

    // 显式包含 retired 才能取到
    assert.equal(repo.listByScope({ scopeKind: 'line', scopeKey: 'line-1', statuses: ['retired'] }).length, 1)
    assert.equal(repo.listByScope({ scopeKind: 'line', scopeKey: 'line-1', channelIds: [] }).length, 0, '空 channel 集 = 空集')

    // 回归：普通记忆（episodic/semantic）即便 scope_kind 命中也不得计入经验域
    // （实测 live 看板曾把 25 条 episodic 计入 → 29 vs 真实 4）
    repo.upsert({
      channelId: 'ch-1', agentId: 'agent-a', kind: 'episodic-task',
      title: '普通任务记忆', titleFts: '普 通 任 务 记 忆', content: 'x', importance: 0.8,
      dedupKey: 'task:ep-1',
    })
    assert.equal(
      repo.listByScope({ scopeKind: 'line', scopeKey: 'line-1', channelIds: ['ch-1'] }).length,
      1,
      '非经验行不得计入经验域（会话默认 scope_kind 会误命中）',
    )
    assert.equal(repo.listByScope({ scopeKind: 'session', channelIds: ['ch-1'] }).length, 0, 'session 档同样只取经验行')
  }
  finally {
    db.close()
  }
})

test('生命周期：markStatus 迁移 + expireSweep 退休过期行', () => {
  const { db, repo } = fixture()
  try {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const a = repo.upsertExperience({ ...baseExp, dedupKey: 'exp:a', expiresAt: past })
    const b = repo.upsertExperience({ ...baseExp, dedupKey: 'exp:b', status: 'candidate', expiresAt: future })
    assert.equal(repo.getById(a.id)!.status, 'active', '写入不自动退休')

    assert.equal(repo.expireSweep(), 1, '仅过期行迁移')
    assert.equal(repo.getById(a.id)!.status, 'retired')
    assert.equal(repo.getById(b.id)!.status, 'candidate')
    assert.equal(repo.expireSweep(), 0, '幂等：已退休行不再计数')

    assert.equal(repo.markStatus(b.id, 'validated', 'active'), false, 'validated 只能从 candidate 迁移')
    assert.equal(repo.markStatus(b.id, 'validated', 'candidate'), true)
    assert.equal(repo.getById(b.id)!.status, 'validated')
    assert.equal(repo.markStatus('missing-id', 'validated', 'candidate'), false)

    const stats = repo.experienceStats()
    const byStatus = new Map(stats.map(s => [s.status, s.n]))
    assert.equal(byStatus.get('retired'), 1)
    assert.equal(byStatus.get('validated'), 1)
  }
  finally {
    db.close()
  }
})

test('证据锚点：traceId/resultId/recipeRunId 任一即可入库，metrics 原样保留', () => {
  const { db, repo } = fixture()
  try {
    for (const [dedup, evidence] of [
      ['exp:trace', { traceId: 'tr-1' }],
      ['exp:result', { resultId: 'r-1' }],
      ['exp:recipe', { recipeRunId: 'run-1', metrics: { iae: -12.5 } }],
    ] as const) {
      const row = repo.upsertExperience({ ...baseExp, dedupKey: dedup, evidence })
      const stored = JSON.parse(repo.getById(row.id)!.evidenceJson ?? '{}') as Record<string, unknown>
      assert.deepEqual(stored, evidence)
    }
  }
  finally {
    db.close()
  }
})

test('既有库升级：先建旧表结构再迁移，行数不变且新列按默认值解释', () => {
  const db = openWorkshopDb(':memory:')
  try {
    // 模拟"迁移前"的既有行：显式写一份不含经验列的行（columns 缺省 → 由 DB 默认值补齐）
    db.prepare(
      `INSERT INTO agent_memories (id, channel_id, agent_id, kind, title, title_fts, content, importance, task_id, session_id, dedup_key, access_count, last_accessed_at, created_at)
       VALUES ('legacy-1','ch-x','agent-x','episodic-task','旧任务','旧任务','内容',0.8,NULL,'','task:legacy',0,NULL,?)`,
    ).run(new Date().toISOString())
    const before = Number((db.prepare('SELECT COUNT(*) AS c FROM agent_memories').get() as { c: number }).c)
    initWorkshopDb(db)
    const after = Number((db.prepare('SELECT COUNT(*) AS c FROM agent_memories').get() as { c: number }).c)
    assert.equal(after, before, '迁移不得丢行')
    const repo = createMemoryRepo(db)
    const row = repo.getById('legacy-1')!
    assert.equal(row.outcome, 'neutral')
    assert.equal(row.scopeKind, 'session')
    assert.equal(row.status, 'active')
  }
  finally {
    db.close()
  }
})
