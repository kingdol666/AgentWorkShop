/**
 * 图谱分区：Channel / Session / 共享区(global owner) / line-product 分开整理与检索。
 * - 频道图不含 session/global；
 * - session 图只含本会话（s1 不含 s2）；
 * - 共享图只含同 owner 的 global；
 * - 跨分区边拒收；
 * - AgentRuntime auto recall 只注入本会话 session 图 + 频道图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-graph-partition-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_MEMORY_GRAPH_LLM_URL
delete process.env.AW_MEMORY_CURATOR_LLM_URL
delete process.env.AW_MEMORY_GRAPH_RETRIEVAL

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { runMemoryGraphConsolidation } = await import('../server/services/workshop/memory/graph/agent')
const { graphRetrieve, loadSubgraph } = await import('../server/services/workshop/memory/graph/retrieval')

const db = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
  VALUES ('c1','分区频道','','','','{}',1,1,'L1','u1','inherit',?,?)`).run(now, now)
for (const sid of ['s1', 's2']) {
  db.prepare(`INSERT INTO channel_sessions(id, channel_id, title, status, memory_policy, member_map_json, created_at)
    VALUES (?, 'c1', ?, 'active', 'session', '{}', ?)`).run(sid, sid, now)
}

function memory(id: string, title: string, content: string, scopeKind: string, scopeKey = '', sessionId = '', owner = '', agent = 'a1') {
  db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
      session_id, dedup_key, scope_kind, scope_key, status, owner_user_id, created_at, updated_at)
    VALUES (?, 'c1', ?, 'semantic', ?, ?, ?, 0.7, ?, ?, ?, ?, 'active', ?, ?, ?)`)
    .run(id, agent, title, title, content, sessionId, `scope:${id}`, scopeKind, scopeKey, owner, now, now)
}
memory('mchan', '频道保压', '频道 CHANSECRET 保压压力 60', 'channel', '', '', '', '__team__')
memory('ms1', '会话一保压', '会话一 S1SECRET 保压压力 61', 'session', 's1', 's1')
memory('ms2', '会话二保压', '会话二 S2SECRET 保压压力 62', 'session', 's2', 's2')
memory('mg1', '共享保压', '共享 G1SECRET 保压压力 63', 'global', '', '', 'u1')
memory('mg2', '他人共享保压', '他人 G2SECRET 保压压力 64', 'global', '', '', 'u2')

test('channel/session/shared partitions are separately materialized and scoped', async () => {
  const channel = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false, partition: { scopeKind: 'channel' } })
  assert.equal(channel.status, 'ok', channel.error)
  const s1 = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false, partition: { scopeKind: 'session', scopeKey: 's1' } })
  assert.equal(s1.status, 'ok', s1.error)
  const s2 = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false, partition: { scopeKind: 'session', scopeKey: 's2' } })
  assert.equal(s2.status, 'ok', s2.error)
  const shared = await runMemoryGraphConsolidation(db, 'c1', {
    useLlm: false, partition: { scopeKind: 'global', scopeKey: 'u1', ownerUserId: 'u1' },
  })
  assert.equal(shared.status, 'ok', shared.error)

  const channelGraph = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['channel'], scopeKeys: [''] })
  assert.ok(channelGraph.nodes.some(n => n.memoryId === 'mchan'))
  assert.ok(!channelGraph.nodes.some(n => n.memoryId === 'ms1' || n.memoryId === 'ms2' || n.memoryId === 'mg1'))

  const s1Graph = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['s1'] })
  assert.ok(s1Graph.nodes.some(n => n.memoryId === 'ms1'))
  assert.ok(!s1Graph.nodes.some(n => n.memoryId === 'ms2'), 's1 图不得包含 s2')
  assert.ok(!s1Graph.nodes.some(n => n.memoryId === 'mchan' || n.memoryId === 'mg1'))

  const sharedGraph = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['global'], scopeKeys: ['u1'], ownerUserId: 'u1' })
  assert.ok(sharedGraph.nodes.some(n => n.memoryId === 'mg1'))
  assert.ok(!sharedGraph.nodes.some(n => n.memoryId === 'mg2'), '共享图不得包含他人 owner')
  assert.ok(!sharedGraph.nodes.some(n => n.memoryId === 'mchan' || n.memoryId === 'ms1'))
})

test('graph retrieval and runtime injection use the current session partition only', async () => {
  const s1Retrieved = graphRetrieve(repo.graph, 'c1', '会话一保压 S1SECRET', {
    scopeKinds: ['session'], scopeKeys: ['s1'],
  })
  assert.ok(s1Retrieved.memoryScores.has('ms1'))
  assert.ok(!s1Retrieved.memoryScores.has('ms2'))

  const memory = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: 's1' })
  const block = String(await memory.recall('保压 S1SECRET S2SECRET', { trace: { taskId: 'partition-t1' } }) ?? '')
  assert.ok(block.includes('S1SECRET'), '应注入本会话图/记忆')
  assert.ok(!block.includes('S2SECRET'), '不得注入其他会话')
  assert.ok(block.includes('CHANSECRET'), '频道级记忆仍应可注入')
})

test('cross-partition edges are rejected', () => {
  const channelEntity = repo.graph.listEntities('c1', { scopeKinds: ['channel'], scopeKeys: [''] })[0]!
  const sessionEntity = repo.graph.listEntities('c1', { scopeKinds: ['session'], scopeKeys: ['s1'] })[0]!
  const created = repo.graph.upsertEdge({
    channelId: 'c1',
    ownerUserId: 'u1',
    scopeKind: 'channel',
    scopeKey: '',
    srcId: channelEntity.id,
    dstId: sessionEntity.id,
    relation: 'relates_to',
    fact: '跨分区边不应存在',
    status: 'active',
    authorKind: 'human',
    authorId: 'u1',
    evidence: [{ memoryId: 'mchan' }],
  })
  assert.equal(created, null)
  const channelEntities = repo.graph.listEntities('c1', { scopeKinds: ['channel'], scopeKeys: [''] })
  assert.ok(channelEntities.length >= 2, 'channel 分区应至少有两个实体用于同区边测试')
  const mismatched = repo.graph.upsertEdge({
    channelId: 'c1',
    ownerUserId: 'u1',
    scopeKind: 'session',
    scopeKey: 's1',
    srcId: channelEntities[0]!.id,
    dstId: channelEntities[1]!.id,
    relation: 'relates_to',
    fact: '端点同区但调用方谎报 scope 的边不应存在',
    status: 'active',
    authorKind: 'human',
    authorId: 'u1',
    evidence: [{ memoryId: 'mchan' }],
  })
  assert.equal(mismatched, null, '边 scope 必须由端点决定，显式 scope 不一致应拒收')
})

test('community replace re-scopes an id that was previously materialized in another partition', () => {
  const channelEntity = repo.graph.listEntities('c1', { scopeKinds: ['channel'], scopeKeys: [''] })[0]!
  const product = repo.graph.upsertEntity({
    channelId: 'c1', ownerUserId: 'u1', scopeKind: 'product', scopeKey: 'P-REUSE',
    entityType: 'parameter', canonicalName: '复用参数', canonicalKey: 'reuse-param',
    aliases: [], summary: '', confidence: 0.9, salience: 0.5, status: 'active',
    authorKind: 'agent', authorId: 'test', sourceKind: 'memory',
  }).entity
  repo.graph.replaceCommunities('c1', [{
    id: 'com-reuse', level: 0, title: '旧频道社区', summary: '旧', memberIds: [channelEntity.id],
    scopeKind: 'channel', scopeKey: '',
  }], undefined, { scopeKinds: ['channel'], scopeKeys: [''] })
  repo.graph.replaceCommunities('c1', [{
    id: 'com-reuse', level: 0, title: '产品社区', summary: '新', memberIds: [product.id],
    scopeKind: 'product', scopeKey: 'P-REUSE',
  }], undefined, { scopeKinds: ['product'], scopeKeys: ['P-REUSE'] })
  assert.ok(repo.graph.listCommunities('c1', { scopeKinds: ['product'], scopeKeys: ['P-REUSE'] })
    .some(c => c.id === 'com-reuse'), '同 id 社区应归入产品分区')
  assert.ok(!repo.graph.listCommunities('c1', { scopeKinds: ['channel'], scopeKeys: [''] })
    .some(c => c.id === 'com-reuse'), '频道分区不得残留该社区')
})

test('runtime save persists session scope so session graph can consume it', async () => {
  const memory = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: 's1' })
  await memory.save({ title: '运行期会话沉淀', content: 'S1-LIVE 保压压力 65', scope: 'private' })
  const row = db.prepare(`SELECT scope_kind AS scopeKind, scope_key AS scopeKey, session_id AS sessionId
    FROM agent_memories WHERE title = '运行期会话沉淀'`).get() as { scopeKind: string, scopeKey: string, sessionId: string }
  assert.equal(row.scopeKind, 'session')
  assert.equal(row.scopeKey, 's1')
  assert.equal(row.sessionId, 's1')
})

test('manual session-scoped memory persists session_id and only the target session graph sees it', async () => {
  const { createMemory } = await import('../server/services/workshop/memory/memory-admin')
  const created = createMemory(db, {
    channelId: 'c1', scopeKind: 'session', scopeKey: 's2',
    title: '人工会话记忆', content: 'MANUAL-S2 保压压力 66',
    actor: { kind: 'human', id: 'u1' },
  })
  const row = db.prepare('SELECT session_id AS sessionId FROM agent_memories WHERE id = ?')
    .get(created.id) as { sessionId: string }
  assert.equal(row.sessionId, 's2', 'session 档手工记忆必须写 session_id，否则检索/整理两侧都不可见')

  const run = await runMemoryGraphConsolidation(db, 'c1', {
    useLlm: false, partition: { scopeKind: 'session', scopeKey: 's2' },
  })
  assert.equal(run.status, 'ok', run.error)
  const s2Graph = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['s2'] })
  assert.ok(s2Graph.nodes.some(n => n.memoryId === created.id))
  const s1Graph = loadSubgraph(repo.graph, 'c1', { scopeKinds: ['session'], scopeKeys: ['s1'] })
  assert.ok(!s1Graph.nodes.some(n => n.memoryId === created.id), 's1 图不得出现 s2 的人工记忆')

  assert.throws(() => createMemory(db, {
    channelId: 'c1', scopeKind: 'session', scopeKey: '',
    title: '无会话键', content: 'x', actor: { kind: 'human', id: 'u1' },
  }), /scopeKey/)
})
