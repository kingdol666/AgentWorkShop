/**
 * RSI 经验注入与检索扩展（WP-A3）：
 *  - 同产线 +0.2 / 同产品 +0.1 排序偏好（不过滤）
 *  - retired 经验不参与任何档位检索
 *  - 注入总预算 ≤500 tok 不因经验行放宽
 *  - 工具/API provenance 暴露 scope/outcome/status
 *  - 频道产线绑定自动解析（channels.line_id）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-inject-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { estimateTokens } = await import('../server/services/workshop/runtime/memory/helpers')
const { handleSearchMemory } = await import('../server/services/workshop/agents/host-tool-bridge/tools/memory')
const { canonicalHash, canonicalJson } = await import('../shared/context/hash')

const now = new Date().toISOString()

function fixture(lineId = 'line-1', productId: string | null = 'prod-9') {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, created_at, updated_at)
    VALUES ('ch-1','C','','','','{}',1,1,?,?,?)`).run(lineId, now, now)
  db.prepare(`INSERT INTO channel_sessions (id, channel_id, title, status, memory_policy, channel_mode, product_id, line_id, binding_snapshot_json, binding_snapshot_hash, binding_snapshot_revision, created_at)
    VALUES ('sess-trusted','ch-1','S','active','shared','production_line_integrated',?,?,?, ?,1,?)`).run(productId, lineId, JSON.stringify({ schemaVersion: 1, channelId: 'ch-1', bindingRevision: 1, productId, lineId, recipes: [], agentBindings: [], executionProfile: {} }), '', now)
  const repo = createMemoryRepo(db)
  const snapshot = { schemaVersion: 1, channelId: 'ch-1', bindingRevision: 1, productId, lineId, recipes: [], agentBindings: [], executionProfile: {} }
  const snapshotJson = canonicalJson(snapshot)
  db.prepare(`UPDATE channel_sessions SET product_id = ?, line_id = ?, binding_snapshot_json = ?, binding_snapshot_hash = ?, binding_snapshot_revision = 1 WHERE id = 'sess-trusted'`).run(productId, lineId, snapshotJson, canonicalHash(snapshot))
  const mem = new AgentMemory(repo, { channelId: 'ch-1', agentId: 'agent-a', industrialScopeEnabled: true, lineId, productId, sessionId: 'sess-trusted' })
  return { db, repo, mem }
}

/** 写一条经验（同标题/内容，只变作用域与重要度，便于纯排序比较；低重要度避免加分饱和到 1.0） */
function exp(repo: ReturnType<typeof createMemoryRepo>, dedupKey: string, opts: { scopeKind: 'line' | 'product' | 'channel', scopeKey?: string, status?: 'active' | 'candidate' | 'validated' | 'retired', importance?: number }): void {
  repo.upsertExperience({
    channelId: 'ch-1',
    agentId: 'agent-a',
    title: '均热段温差整定经验',
    titleFts: '均 热 段 温 差 整 定 经 验',
    content: '温差收窄到 ±3℃ 后 IAE 下降',
    importance: opts.importance ?? 0.2,
    dedupKey,
    evidence: { taskIds: ['t-x'] },
    outcome: 'positive',
    scopeKind: opts.scopeKind,
    scopeKey: opts.scopeKey ?? '',
    status: opts.status ?? 'active',
  })
}

test('频道作用域解析：channels.line_id → scopeContext.lineId', () => {
  const { db, repo } = fixture('line-7')
  try {
    assert.deepEqual(repo.channelScope('ch-1'), { lineId: 'line-7', productId: null })
    assert.deepEqual(repo.channelScope('missing'), { lineId: null, productId: null })
  }
  finally {
    db.close()
  }
})

test('可信 line scope 过滤异产线经验,匹配 scope 仅影响排序', async () => {
  const { db, repo, mem } = fixture('line-1')
  try {
    exp(repo, 'exp:other-line', { scopeKind: 'line', scopeKey: 'line-2' })
    exp(repo, 'exp:same-line', { scopeKind: 'line', scopeKey: 'line-1' })
    const rows = await mem.recallRows('均热段 温差 整定 经验', { limit: 10 })
    const sameIdx = rows.findIndex(r => r.scopeKey === 'line-1')
    assert.ok(sameIdx >= 0, '匹配可信 Session 产线的经验应被召回')
    assert.equal(rows.some(r => r.scopeKey === 'line-2'), false, '异产线经验必须硬隔离')
    assert.ok(rows[sameIdx]!.score > 0)
  }
  finally {
    db.close()
  }
})

test('同产品经验在可信 Session 快照内参与排序', async () => {
  const { db, repo, mem } = fixture('line-1')
  try {
    exp(repo, 'exp:none', { scopeKind: 'channel' })
    exp(repo, 'exp:prod', { scopeKind: 'product', scopeKey: 'prod-9' })
    exp(repo, 'exp:line', { scopeKind: 'line', scopeKey: 'line-1' })
    const rows = await mem.recallRows('均热段 温差 整定 经验', { limit: 10, scopeContext: { lineId: 'line-1', productId: 'prod-9' } })
    const idx = (key: string) => rows.findIndex(r => r.scopeKey === key)
    assert.ok(idx('line-1') < idx('prod-9'), '产线加成 > 产品加成')
    assert.ok(idx('prod-9') < idx(''), '产品加成 > 无匹配')
  }
  finally {
    db.close()
  }
})

test('工具提供的 product scope 不能覆盖 Session 的可信产品绑定', async () => {
  const { db, repo, mem } = fixture('line-1', 'prod-9')
  try {
    exp(repo, 'exp:prod-2', { scopeKind: 'product', scopeKey: 'prod-2' })
    exp(repo, 'exp:x', { scopeKind: 'channel' })
    const rows = await mem.recallRows('均热段 温差 整定 经验', { limit: 10, scopeContext: { productId: 'prod-2' } })
    assert.ok(rows.every(row => row.scopeKind !== 'product' || row.scopeKey === 'prod-9'), '显式参数不得替换 Session 产品锚点')
  }
  finally {
    db.close()
  }
})

test('retired 经验不参与检索（recallRows 与 recall 注入同口径）', async () => {
  const { db, repo, mem } = fixture('line-1')
  try {
    exp(repo, 'exp:retired', { scopeKind: 'line', scopeKey: 'line-1', status: 'retired' })
    const rows = await mem.recallRows('均热段 温差 整定 经验', { limit: 10 })
    assert.equal(rows.length, 0, 'retired 行不可被检索')
    const block = await mem.recall('均热段 温差 整定 经验')
    assert.equal(block, null, 'retired 行不进入注入块')
  }
  finally {
    db.close()
  }
})

test('注入总预算不因经验行放宽（含 L0 简报仍 ≤500 tok）', async () => {
  const { db, repo, mem } = fixture('line-1')
  try {
    for (let i = 0; i < 8; i++) {
      repo.upsertExperience({
        channelId: 'ch-1',
        agentId: 'agent-a',
        title: `经验 ${i} 均热段温差整定`,
        titleFts: `经 验 ${i} 均 热 段 温 差 整 定`,
        content: `第 ${i} 条：温差收窄后 IAE 下降，回读证实，判据通过。`.repeat(6),
        importance: 0.8,
        dedupKey: `exp:bulk-${i}`,
        evidence: { taskIds: [`t-${i}`] },
        outcome: 'positive',
        scopeKind: 'line',
        scopeKey: 'line-1',
        status: 'validated',
      })
    }
    // 简报行（L0 计费进总预算）
    repo.upsert({ channelId: 'ch-1', agentId: 'agent-a', kind: 'brief', title: '会话简报', titleFts: '会 话 简 报', content: '最近完成：整定；团队共享约定：温差阈值', importance: 0.6, dedupKey: 'brief:agent-a' })
    const block = await mem.recall('均热段 温差 整定 经验', { budgetTokens: 500 })!
    assert.ok(block)
    assert.ok(estimateTokens(block!) <= 500, `注入块 ${estimateTokens(block!)} tok 超硬顶`)
    assert.match(block!, /相关记忆/)
  }
  finally {
    db.close()
  }
})

test('工具面 provenance：经验行标注 scope/outcome/status', async () => {
  const { db, repo } = fixture('line-1')
  try {
    exp(repo, 'exp:prov', { scopeKind: 'line', scopeKey: 'line-1', status: 'validated' })
    const mem = new AgentMemory(repo, { channelId: 'ch-1', agentId: 'agent-a', industrialScopeEnabled: true, lineId: 'line-1', productId: 'prod-9', sessionId: 'sess-trusted' })
    const ws = {
      recallMemory: (input: { query: string, scope?: 'auto' | 'private' | 'shared' | 'session', limit?: number, sessionId?: string | null, scopeContext?: { lineId?: string | null, productId?: string | null } }) =>
        mem.recallRows(input.query, { scope: input.scope, limit: input.limit, sessionId: input.sessionId, scopeContext: input.scopeContext }),
    }
    const res = await handleSearchMemory({ query: '均热段 温差 整定 经验', scope: 'auto' }, ws as never, null)
    assert.match(res.text, /kind=experience|experience/)
    assert.match(res.text, /scope=line:line-1/)
    assert.match(res.text, /outcome=positive/)
    assert.match(res.text, /status=validated/)
  }
  finally {
    db.close()
  }
})
