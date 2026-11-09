/**
 * RSI 跨 Channel 共享经验 + memoryPolicy（WP-A4）。
 * 覆盖：策略门矩阵 / line 绑定门 / 证据锚点门 / 同 owner 授权 / 产线隔离负样本 /
 *       candidate 不外泄 / 成员可读（非 lead-only）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-share-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { handleSaveMemory } = await import('../server/services/workshop/agents/host-tool-bridge/tools/memory')
const { ManagerA2A } = await import('../server/services/workshop/runtime/manager/a2a')

const now = new Date().toISOString()

interface ChanSpec { id: string, owner: string | null, lineId?: string, enabled?: number }

function fixture(chans: ChanSpec[]) {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  for (const c of chans) {
    db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, owner_user_id, line_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,1,?,?,?,?)`).run(c.id, c.id, '', '', '', '{}', c.enabled ?? 1, c.owner, c.lineId ?? '', now, now)
  }
  const repo = createMemoryRepo(db)
  return { db, repo }
}

/** 建会话并设定 memoryPolicy（用于写入策略门） */
function session(db: ReturnType<typeof fixture>['db'], id: string, channelId: string, policy: 'session' | 'channel' | 'shared'): void {
  db.prepare(`INSERT INTO channel_sessions (id, channel_id, title, status, memory_policy, created_at)
    VALUES (?,?,?,?,?,?)`).run(id, channelId, 's', 'active', policy, now)
}

function mem(repo: ReturnType<typeof fixture>['repo'], channelId: string, agentId = 'agent-a'): InstanceType<typeof AgentMemory> {
  return new AgentMemory(repo, { channelId, agentId })
}

/** 直接写一条已加固的共享经验（绕过策略门，模拟已被门验证过的存量） */
function seedExp(repo: ReturnType<typeof fixture>['repo'], opts: {
  channelId: string
  scopeKind: 'line' | 'product' | 'global'
  scopeKey?: string
  status?: 'active' | 'candidate' | 'validated'
  dedupKey?: string
  agentId?: string
}): void {
  repo.upsertExperience({
    channelId: opts.channelId,
    agentId: opts.agentId ?? 'agent-a',
    kind: 'experience',
    title: '均热段温差整定经验',
    titleFts: '均 热 段 温 差 整 定 经 验',
    content: '温差收窄到 ±3℃ 后 IAE 下降',
    importance: 0.8,
    dedupKey: opts.dedupKey ?? `exp:seed:${opts.channelId}:${opts.scopeKind}:${opts.scopeKey ?? ''}`,
    evidence: { taskIds: ['t-seed'] },
    outcome: 'positive',
    scopeKind: opts.scopeKind,
    scopeKey: opts.scopeKey ?? '',
    status: opts.status ?? 'validated',
  })
}

// ===== 写入策略门（memoryPolicy）=====

test('memoryPolicy=session：line/global 经验写入被拒（不静默降级）', async () => {
  const { db, repo } = fixture([{ id: 'ch-1', owner: 'u-1', lineId: 'line-1' }])
  try {
    session(db, 'sess-1', 'ch-1', 'session')
    const m = mem(repo, 'ch-1')
    await assert.rejects(
      () => m.save({ title: 'T', content: 'C', scope: 'line', sessionId: 'sess-1', taskId: 't-1' }),
      /memory policy "session" 不允许写入 line 作用域经验/,
    )
    await assert.rejects(
      () => m.save({ title: 'T', content: 'C', scope: 'global', sessionId: 'sess-1', taskId: 't-1' }),
      /memory policy "session"/,
    )
    assert.equal(repo.listByAgentChannel('ch-1', 'agent-a', 10).length, 0, '被拒写入不落行')
  }
  finally {
    db.close()
  }
})

test('memoryPolicy=channel 同样拒绝；=shared 放行（candidate + line 锚点）', async () => {
  const { db, repo } = fixture([{ id: 'ch-1', owner: 'u-1', lineId: 'line-1' }])
  try {
    session(db, 'sess-c', 'ch-1', 'channel')
    const m = mem(repo, 'ch-1')
    await assert.rejects(() => m.save({ title: 'T', content: 'C', scope: 'line', sessionId: 'sess-c', taskId: 't-1' }), /memory policy/)

    session(db, 'sess-s', 'ch-1', 'shared')
    const saved = await m.save({ title: '经验 A', content: '温差 ±3℃ 最优', scope: 'line', sessionId: 'sess-s', taskId: 't-1' })
    assert.equal(saved.scope, 'line')
    const row = repo.listByAgentChannel('ch-1', 'agent-a', 10)[0]!
    assert.equal(row.kind, 'experience')
    assert.equal(row.scopeKind, 'line')
    assert.equal(row.scopeKey, 'line-1', 'line 锚点取频道产线绑定')
    assert.equal(row.status, 'candidate', 'ADR-7：共享经验先候选')
    assert.equal(row.outcome, 'unknown')
    assert.deepEqual(JSON.parse(row.evidenceJson!).taskIds, ['t-1'])
  }
  finally {
    db.close()
  }
})

test('证据锚点门：缺 taskId 一律拒绝；line 档缺产线绑定拒绝', async () => {
  const { db, repo } = fixture([{ id: 'ch-1', owner: 'u-1', lineId: '' }])
  try {
    session(db, 'sess-s', 'ch-1', 'shared')
    const m = mem(repo, 'ch-1')
    await assert.rejects(() => m.save({ title: 'T', content: 'C', scope: 'line', sessionId: 'sess-s' }), /taskId 锚点/)
    await assert.rejects(() => m.save({ title: 'T', content: 'C', scope: 'global', sessionId: 'sess-s' }), /taskId 锚点/)
    await assert.rejects(() => m.save({ title: 'T', content: 'C', scope: 'line', sessionId: 'sess-s', taskId: 't-1' }), /频道已绑定产线/)
    // global 不要求产线绑定
    const ok = await m.save({ title: '全局经验', content: 'C', scope: 'global', sessionId: 'sess-s', taskId: 't-1' })
    assert.equal(ok.scope, 'global')
    assert.equal(repo.listByAgentChannel('ch-1', 'agent-a', 10)[0]!.scopeKey, '')
  }
  finally {
    db.close()
  }
})

test('工具面：策略拒绝回 isError 原文，不伪装成功', async () => {
  const { db, repo } = fixture([{ id: 'ch-1', owner: 'u-1', lineId: 'line-1' }])
  try {
    session(db, 'sess-1', 'ch-1', 'session')
    const m = mem(repo, 'ch-1')
    const res = await handleSaveMemory(
      { title: 'T', content: 'C', scope: 'line', task_id: 't-1' },
      { saveMemory: (input: Parameters<typeof m.save>[0]) => m.save(input) } as never,
      'sess-1',
    )
    assert.equal(res.isError, true)
    assert.match(res.text, /记忆写入被拒绝/)
    assert.match(res.text, /memory policy/)
  }
  finally {
    db.close()
  }
})

// ===== 跨 Channel 读（授权 / 隔离 / 生命周期 / 角色）=====

/** 最小 manager 桩：只提供 searchSharedExperience 依赖的 repos + requireMember */
function shim(db: ReturnType<typeof fixture>['db'], repo: ReturnType<typeof fixture>['repo'], members: Record<string, Array<{ id: string, role: string }>> = {}) {
  const channels = {
    findById: (id: string) => {
      const r = db.prepare('SELECT id, name, enabled, owner_user_id AS ownerUserId, line_id AS lineId FROM channels WHERE id = ?').get(id) as
        { id: string, name: string, enabled: number, ownerUserId: string | null, lineId: string } | undefined
      return r
    },
    list: () => db.prepare('SELECT id, name, enabled, owner_user_id AS ownerUserId, line_id AS lineId FROM channels').all() as
      Array<{ id: string, name: string, enabled: number, ownerUserId: string | null, lineId: string }>,
  }
  const inst = Object.create(ManagerA2A.prototype) as unknown as {
    deps: unknown
    requireMember: (channelId: string, agentId: string) => unknown
    otherSameOwnerChannels: (channelId: string) => unknown[]
    searchSharedExperience: (channelId: string, agentId: string, input: { query: string, scope: 'line' | 'product' | 'global', scopeKey?: string, limit?: number }) => Array<Record<string, unknown>>
  }
  ;(inst as unknown as { deps: unknown }).deps = {
    db,
    repos: {
      channels,
      memories: repo,
      tasks: { findById: () => undefined },
      channelAgents: {
        findByChannelAgent: (channelId: string, agentId: string) => {
          const list = members[channelId] ?? []
          const m = list.find(x => x.id === agentId)
          return m ? { id: m.id, role: m.role, enabled: 1, channelId } : undefined
        },
      },
    },
  }
  ;(inst as unknown as { requireMember: (channelId: string, agentId: string) => unknown }).requireMember = (channelId, agentId) => {
    const list = members[channelId] ?? []
    if (!list.some(x => x.id === agentId)) throw new Error(`not a member: ${agentId}@${channelId}`)
    return {}
  }
  return inst
}

test('跨频道读：同产线命中（成员可读，非 lead-only）', () => {
  const { db, repo } = fixture([
    { id: 'ch-a', owner: 'u-1', lineId: 'line-1' },
    { id: 'ch-b', owner: 'u-1', lineId: 'line-1' },
  ])
  try {
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'line', scopeKey: 'line-1' })
    const mgr = shim(db, repo, { 'ch-b': [{ id: 'worker-1', role: 'worker' }] })
    const rows = mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差 整定', scope: 'line' })
    assert.equal(rows.length, 1, 'worker（非 lead）也能读同产线共享经验')
    assert.equal(rows[0]!['channelId'], 'ch-a')
    assert.equal(rows[0]!['visibility'], 'cross-channel')
    assert.equal(rows[0]!['scopeKey'], 'line-1')
  }
  finally {
    db.close()
  }
})

test('跨频道负样本：不同产线 / 不同 owner / 停用频道 一律零命中', () => {
  const { db, repo } = fixture([
    { id: 'ch-a', owner: 'u-1', lineId: 'line-1' },
    { id: 'ch-b', owner: 'u-1', lineId: 'line-1' },
    { id: 'ch-c', owner: 'u-1', lineId: 'line-2' },
    { id: 'ch-x', owner: 'u-2', lineId: 'line-1' },
    { id: 'ch-off', owner: 'u-1', lineId: 'line-1', enabled: 0 },
  ])
  try {
    seedExp(repo, { channelId: 'ch-c', scopeKind: 'line', scopeKey: 'line-2', dedupKey: 'exp:c' })
    seedExp(repo, { channelId: 'ch-x', scopeKind: 'line', scopeKey: 'line-1', dedupKey: 'exp:x' })
    seedExp(repo, { channelId: 'ch-off', scopeKind: 'line', scopeKey: 'line-1', dedupKey: 'exp:off' })
    const mgr = shim(db, repo, { 'ch-b': [{ id: 'worker-1', role: 'worker' }] })
    const rows = mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差 整定', scope: 'line' })
    assert.equal(rows.length, 0, `异产线/异 owner/停用频道均不得命中（实际 ${rows.length}）`)
  }
  finally {
    db.close()
  }
})

test('生命周期过滤：candidate/retired 不外泄，active/validated 可读', () => {
  const { db, repo } = fixture([
    { id: 'ch-a', owner: 'u-1', lineId: 'line-1' },
    { id: 'ch-b', owner: 'u-1', lineId: 'line-1' },
  ])
  try {
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'line', scopeKey: 'line-1', status: 'candidate', dedupKey: 'exp:cand' })
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'line', scopeKey: 'line-1', status: 'retired', dedupKey: 'exp:ret' })
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'line', scopeKey: 'line-1', status: 'validated', dedupKey: 'exp:val' })
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'line', scopeKey: 'line-1', status: 'active', dedupKey: 'exp:act' })
    const mgr = shim(db, repo, { 'ch-b': [{ id: 'worker-1', role: 'worker' }] })
    const rows = mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差 整定', scope: 'line' })
    const statuses = rows.map(r => r['status']).sort()
    assert.deepEqual(statuses, ['active', 'validated'], '仅 active/validated 外泄')
  }
  finally {
    db.close()
  }
})

test('作用域锚点：product 需 scope_key；global 不需要', () => {
  const { db, repo } = fixture([
    { id: 'ch-a', owner: 'u-1', lineId: 'line-1' },
    { id: 'ch-b', owner: 'u-1', lineId: 'line-1' },
  ])
  try {
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'product', scopeKey: 'prod-9', dedupKey: 'exp:p9' })
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'global', dedupKey: 'exp:g' })
    const mgr = shim(db, repo, { 'ch-b': [{ id: 'worker-1', role: 'worker' }] })
    assert.equal(mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差', scope: 'product' }).length, 0, '无 key → 空集')
    assert.equal(mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差', scope: 'product', scopeKey: 'prod-9' }).length, 1)
    assert.equal(mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差', scope: 'global' }).length, 1)
  }
  finally {
    db.close()
  }
})

// ===== 权限矩阵补充（计划 WP-A4 要求 ≥12 用例）=====

test('memoryPolicy=session：channel 公共域（shared）写入不受影响（策略只管共享作用域经验）', async () => {
  const { db, repo } = fixture([{ id: 'ch-1', owner: 'u-1', lineId: 'line-1' }])
  try {
    session(db, 'sess-1', 'ch-1', 'session')
    const m = mem(repo, 'ch-1')
    const saved = await m.save({ title: '频道经验', content: '仅本频道可见', scope: 'shared', sessionId: 'sess-1', taskId: 't-1' })
    assert.equal(saved.scope, 'shared')
    const row = db.prepare('SELECT kind FROM agent_memories WHERE dedup_key = ?').get(saved.dedupKey) as { kind: string } | undefined
    assert.equal(row?.kind, 'semantic', 'channel 公共域仍走既有语义记忆路径')
  }
  finally {
    db.close()
  }
})

test('跨频道授权：非本频道成员不可读（requireMember 先于检索）', () => {
  const { db, repo } = fixture([
    { id: 'ch-a', owner: 'u-1', lineId: 'line-1' },
    { id: 'ch-b', owner: 'u-1', lineId: 'line-1' },
  ])
  try {
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'line', scopeKey: 'line-1' })
    const mgr = shim(db, repo, { 'ch-b': [{ id: 'worker-1', role: 'worker' }] })
    assert.throws(
      () => mgr.searchSharedExperience('ch-b', 'outsider', { query: '均热段 温差', scope: 'line' }),
      /not a member/,
    )
  }
  finally {
    db.close()
  }
})

test('product 档跨频道：同 product 命中，异 product 零命中', () => {
  const { db, repo } = fixture([
    { id: 'ch-a', owner: 'u-1', lineId: 'line-1' },
    { id: 'ch-b', owner: 'u-1', lineId: 'line-2' },
  ])
  try {
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'product', scopeKey: 'prod-1', dedupKey: 'exp:p1' })
    const mgr = shim(db, repo, { 'ch-b': [{ id: 'worker-1', role: 'worker' }] })
    assert.equal(mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差', scope: 'product', scopeKey: 'prod-1' }).length, 1)
    assert.equal(mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差', scope: 'product', scopeKey: 'prod-2' }).length, 0)
  }
  finally {
    db.close()
  }
})

test('global 档：仅 global 经验跨频道可见，line 经验不受 global 查询污染', () => {
  const { db, repo } = fixture([
    { id: 'ch-a', owner: 'u-1', lineId: 'line-1' },
    { id: 'ch-b', owner: 'u-1', lineId: 'line-2' },
  ])
  try {
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'line', scopeKey: 'line-1', dedupKey: 'exp:line' })
    seedExp(repo, { channelId: 'ch-a', scopeKind: 'global', dedupKey: 'exp:global' })
    const mgr = shim(db, repo, { 'ch-b': [{ id: 'worker-1', role: 'worker' }] })
    const rows = mgr.searchSharedExperience('ch-b', 'worker-1', { query: '均热段 温差', scope: 'global' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!['scopeKind'], 'global')
  }
  finally {
    db.close()
  }
})
