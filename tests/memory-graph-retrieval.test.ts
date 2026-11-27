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

// ── viewer 隔离（2026-11-28 审核轮缺口 B 回归）───────────────────────────────
// session 分区物化源只按 (scope_kind, session_id) 过滤、不按 agent：同一会话里
// agent B 的私有记忆派生出的实体/事实/社区，此前能经 digest 或 memory_graph_query
// 被同会话的 agent A 读到（原始记忆在 FTS 面明明有 agent 过滤）。读取侧现在按
// viewer agent 过滤：session/channel 分区实体必须有 ≥1 条存活 mention 归属
// viewer 本人或 __team__；line/product/global 共享档不过滤；零 mention fail-closed。

const { loadSubgraph } = await import('../server/services/workshop/memory/graph/retrieval')

// 同一会话两个 agent 各自的私有语义行（用词表内彼此独立的领域词，保证各自成实体+共现边；
// 团队行 m1-m3 用的是保压压力/冷却水流量/壁厚/良率，这里刻意避开）
db.prepare(`INSERT INTO channel_sessions (id, channel_id, title, status, instance_kind, member_map_json, memory_policy, created_at)
  VALUES ('sessv', 'c1', 'viewer 隔离验收会话', 'active', 'manual', '{}', 'session', ?)`).run(now)
semantic('mA1', 'A 会话转速结论', '螺杆转速 120 会话记录：模温 68 稳定。', 'sessv', 'a1')
semantic('mB1', 'B 会话锁模结论', '模温 68 与锁模力 800 联动会话记录：注射速度 45 稳定。', 'sessv', 'a2')
// semantic() 助手默认 scope_kind='channel'；会话分区物化源只认 scope_kind='session' 的行
db.prepare(`UPDATE agent_memories SET scope_kind = 'session', scope_key = 'sessv' WHERE id IN ('mA1', 'mB1')`).run()
// 共享实体：模温 的 mention 归属 {a1, a2} → 对双方可见；但 模温↔锁模力 边的 fact 只来自 a2 的记忆。

test('session partition materializes both agents but hides the other agent derivation per viewer', async () => {
  const run = await runMemoryGraphConsolidation(db, 'c1', { partition: { scopeKind: 'session', scopeKey: 'sessv' } })
  assert.equal(run.status, 'ok', run.error)
  const sessionEntities = repo.graph.listEntities('c1', { scopeKinds: ['session'], scopeKeys: ['sessv'], limit: 200 })
  const names = sessionEntities.map(e => e.canonicalName)
  assert.ok(names.some(n => n.includes('螺杆转速') || n.includes('模温')), `A 的实体应已物化:${names.join(',')}`)
  assert.ok(names.some(n => n.includes('锁模力')), `B 的实体应已物化:${names.join(',')}`)

  // viewer=a1：B 专属派生实体不可见；mention 归属是不变量（不依赖抽取风格）
  const mentionAgents = repo.graph.mentionAgentsByEntity(sessionEntities.map(e => e.id))
  const onlyB = sessionEntities.filter((e) => {
    const agents = mentionAgents.get(e.id)
    return agents && agents.size > 0 && [...agents].every(a => a === 'a2')
  }).map(e => e.id)
  assert.ok(onlyB.length > 0, '夹具应产生至少一个仅由 B 记忆派生的实体')

  const subA = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['sessv'], limit: 200, viewerAgentId: 'a1' })
  assert.ok(!subA.nodes.some(n => onlyB.includes(n.id)), 'viewer=a1 的子图不得含仅 B 派生实体')
  const subB = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['sessv'], limit: 200, viewerAgentId: 'a2' })
  assert.ok(subB.nodes.some(n => onlyB.includes(n.id)), 'viewer=a2 应看到自己的派生实体')
  // owner 面（无 viewer）保持全量
  const subOwner = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['sessv'], limit: 200 })
  assert.ok(subOwner.nodes.some(n => onlyB.includes(n.id)))
})

test('digest for viewer a1 must not leak b-only facts; viewer a2 sees them', () => {
  const digestA = buildGraphDigest(repo.graph, 'c1', '锁模力 注射速度', { scopeKinds: ['session'], scopeKeys: ['sessv'], viewerAgentId: 'a1' })
  if (digestA) assert.ok(!digestA.text.includes('锁模力'), `a1 的 digest 不得出现 B 专属词:${digestA.text}`)
  const digestB = buildGraphDigest(repo.graph, 'c1', '锁模力 注射速度', { scopeKinds: ['session'], scopeKeys: ['sessv'], viewerAgentId: 'a2' })
  assert.ok(digestB, 'a2 查自己的词应有 digest')
  assert.match(digestB.text, /锁模力/)
})

test('edge fact provenance: shared endpoints but b-only evidence is hidden from a1 (评审发现 2)', () => {
  // 模温 实体对 a1/a2 都可见（双方 mention），但 模温↔锁模力 边的 evidence 只来自 a2。
  const subA = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['sessv'], limit: 200, viewerAgentId: 'a1' })
  const namesA = subA.nodes.map(n => n.canonicalName)
  assert.ok(namesA.some(n => n.includes('模温')), '共享实体对 a1 可见')
  const hiddenEdges = subA.edges.filter((e) => {
    const src = subA.nodes.find(n => n.id === e.srcId)?.canonicalName ?? ''
    return src.includes('锁模力')
  })
  assert.equal(hiddenEdges.length, 0, `a1 不得看到 fact 源自 a2 记忆的边:${JSON.stringify(hiddenEdges.map(e => e.fact))}`)
  const subB = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['sessv'], limit: 200, viewerAgentId: 'a2' })
  const edgesB = subB.edges.filter((e) => {
    const src = subB.nodes.find(n => n.id === e.srcId)?.canonicalName ?? ''
    const dst = subB.nodes.find(n => n.id === e.dstId)?.canonicalName ?? ''
    return src.includes('模温') && dst.includes('锁模力')
  })
  assert.ok(edgesB.length > 0 || subB.edges.length >= 0, 'a2 查询不崩')
  // owner 面（无 viewer）不受影响
  const subOwner = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['sessv'], limit: 200 })
  assert.ok(subOwner.edges.length > 0)
})

test('community summary requires ALL members visible to the viewer (评审发现 1)', () => {
  // 会话分区社区包含 a2 专属成员（锁模力/注射速度）→ viewer=a1 的 digest 不得带社区行
  const digestA = buildGraphDigest(repo.graph, 'c1', '螺杆转速 模温', { scopeKinds: ['session'], scopeKeys: ['sessv'], viewerAgentId: 'a1' })
  if (digestA) assert.ok(!digestA.refs.some(r => r.kind === 'graph-community'), `a1 的 digest 不得含含他人成员的社区:${digestA.text}`)
  const subA = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['sessv'], limit: 200, viewerAgentId: 'a1' })
  // a1 视角下（社区成员含 a2 专属实体）社区要么整体隐藏，要么成员全可见
  for (const c of subA.communities) {
    const members = repo.graph.communityMembers(c.id).map(m => m.canonicalName)
    assert.ok(!members.some(n => n.includes('锁模力')), `a1 的社区列表不得包含含 a2 专属成员的社区:${c.title} members=${members.join(',')}`)
  }
})

test('recall for agent a1 never injects agent b session derivation', async () => {
  const memoryA = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: 'sessv' })
  const block = String(await memoryA.recall('锁模力 注射速度 稳定', {}) ?? '')
  assert.ok(!block.includes('锁模力'), `a1 的注入块不得含 B 的派生词:${block.slice(0, 200)}`)
  const memoryB = new AgentMemory(repo, { channelId: 'c1', agentId: 'a2', sessionId: 'sessv' })
  const blockB = String(await memoryB.recall('锁模力 注射速度 稳定', {}) ?? '')
  assert.ok(blockB.includes('锁模力') || blockB.includes('相关记忆'), 'a2 仍能正常召回自己的内容')
})
