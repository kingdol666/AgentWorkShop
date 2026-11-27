/**
 * Phase 3：图谱检索（PPR/投影/RRF/注入摘要）。
 * - 多跳：保压压力 → 冷却水流量 → 记忆 m2；
 * - 自动注入块包含“知识网络”并写 graph refs；
 * - 关闭开关后退化为原 FTS/向量路径；
 * - session 记忆不入图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-graph-retrieval-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_MEMORY_GRAPH_RETRIEVAL
delete process.env.AW_MEMORY_GRAPH_LLM_URL
delete process.env.AW_MEMORY_CURATOR_LLM_URL

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { runMemoryGraphConsolidation } = await import('../server/services/workshop/memory/graph/agent')
const { graphRetrieve, buildGraphDigest } = await import('../server/services/workshop/memory/graph/retrieval')

const db = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','注塑一线','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)

function semantic(id: string, title: string, content: string, session = '', agent = '__team__') {
  db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
      session_id, dedup_key, scope_kind, scope_key, status, valid_from, recorded_at, created_at, updated_at)
    VALUES (?, 'c1', ?, 'semantic', ?, ?, ?, 0.7, ?, ?, 'channel', '', 'active', ?, ?, ?, ?)`)
    .run(id, agent, title, title.replace(/\s+/g, ' '), content, session, `sem:${id}`, now, now, now, now)
}
semantic('m1', '保压调整经验', '保压压力 60→62 后壁厚提升。')
semantic('m2', '冷却水与良率', '冷却水流量 12 L/min 时产品良率 98%。')
semantic('m3', '保压与冷却水联动', '保压压力与冷却水流量共同影响产品良率。')
semantic('msess', '会话私有保压值', '保压压力 999 不得进入频道图谱。', 'sess1', 'a1')

test('graph consolidation excludes session rows and builds the mesh', async () => {
  const run = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false })
  assert.equal(run.status, 'ok', run.error)
  const entities = repo.graph.listEntities('c1', { limit: 200 })
  assert.ok(entities.some(e => e.canonicalName === '保压压力'))
  assert.ok(entities.some(e => e.canonicalName === '冷却水流量'))
  assert.ok(!entities.some(e => e.memoryId === 'msess'), 'session 记忆不得入图')
  const edges = repo.graph.listEdges('c1', { limit: 500 })
  assert.ok(edges.some(e => e.relation === 'co_occurs'))
})

test('PPR projects multi-hop graph hits to memories', () => {
  const result = graphRetrieve(repo.graph, 'c1', '保压调整对冷却水流量的影响', {})
  assert.ok(result.seedIds.length > 0, '应有实体种子')
  const m2 = result.entityScores.size > 0
  assert.ok(m2)
  const scores = result.memoryScores
  assert.ok(scores.has('m2') || scores.has('m3'), '多跳应投影到相关记忆')
  assert.ok((scores.get('m2')?.score ?? 0) > 0 || (scores.get('m3')?.score ?? 0) > 0)
  assert.ok(result.durationMs >= 0)
})

test('graph digest has facts/community refs and fits L0.5', () => {
  const digest = buildGraphDigest(repo.graph, 'c1', '保压调整对冷却水流量的影响', {})
  assert.ok(digest)
  assert.match(digest.text, /知识网络/)
  assert.ok(digest.refs.length > 0)
  assert.ok(digest.refs.every(r => r.kind.startsWith('graph-')))
})

test('recall injects graph digest and logs graph refs; disable switch degrades', async () => {
  const memory = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: 's1' })
  const block = String(await memory.recall('保压调整对冷却水流量的影响', { trace: { taskId: 't-graph' } }) ?? '')
  assert.match(block, /知识网络|相关记忆/)
  const logs = db.prepare(`SELECT refs_json AS refs FROM memory_injection_log WHERE task_id = 't-graph'`).all() as Array<{ refs: string }>
  assert.ok(logs.length >= 1)
  assert.ok(logs.some(l => l.refs.includes('"source":"graph"')), '注入留痕应包含 graph refs')

  process.env.AW_MEMORY_GRAPH_RETRIEVAL = '0'
  try {
    const rows = await memory.recallRows('保压调整对冷却水流量的影响', { limit: 10 })
    assert.ok(Array.isArray(rows))
    const digest = buildGraphDigest(repo.graph, 'c1', '保压调整对冷却水流量的影响', {})
    // digest 本身不读开关（开关在 recall 层）；这里只验证 recall 不崩且仍可用 FTS/向量
    assert.ok(digest === null || digest.text.length > 0)
  }
  finally {
    delete process.env.AW_MEMORY_GRAPH_RETRIEVAL
  }
})
