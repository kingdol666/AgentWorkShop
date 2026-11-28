/**
 * RSI 记忆/图谱加固回归（2026-11-27 二审）：
 * - 私有记忆不进频道图谱/知识手册；
 * - 任务过程记忆落对作用域并可被频道图消费；
 * - 软删边可恢复、否证实体不参与检索、人工否证不被整理复活；
 * - 已验证经验禁止回滚正文；
 * - 跨频道块导入被拒；repair 后恢复实体仍可检索。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-memory-rsi-hardening-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_MEMORY_GRAPH_LLM_URL
delete process.env.AW_MEMORY_CURATOR_LLM_URL
delete process.env.AW_MEMORY_GRAPH_RETRIEVAL

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createMemoryGraphRepo } = await import('../server/services/workshop/memory/graph/repo')
const { createMemoryGraphService } = await import('../server/services/workshop/memory/graph/service')
const { runMemoryGraphConsolidation } = await import('../server/services/workshop/memory/graph/agent')
const { graphRetrieve } = await import('../server/services/workshop/memory/graph/retrieval')
const { runCuratorForChannel, selectCuratorSources } = await import('../server/services/workshop/memory/curator')
const { rollbackMemory, MemoryAdminError } = await import('../server/services/workshop/memory/memory-admin')
const { exportMemoryJsonl, importMemoryJsonl, repairMemory, purgeGraphResidue } = await import('../server/services/workshop/memory/export')
const { upsertBlock, listBlocks, scopeIdOfChannel } = await import('../server/services/workshop/memory/blocks')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')

const db = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const graph = createMemoryGraphRepo(db)
const service = createMemoryGraphService(db)
const now = new Date().toISOString()
for (const id of ['c1', 'c2']) {
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
    VALUES (?, ?, '', '', '', '{}', 1, 1, 'L1', 'u1', 'inherit', ?, ?)`).run(id, id, now, now)
}

function memory(id: string, title: string, content: string, agent = '__team__', kind = 'semantic', channel = 'c1') {
  db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
      session_id, dedup_key, scope_kind, scope_key, status, created_at, updated_at, valid_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0.7, '', ?, 'channel', '', 'active', ?, ?, ?)`)
    .run(id, channel, agent, kind, title, title.replace(/\s+/g, ' '), content, `h:${id}`, now, now, now)
}

memory('shared1', '共享保压', '共享保压压力 60 的团队约定')
memory('shared2', '共享冷却', '共享冷却水流量 32 L/min 的团队约定')
// 存储层真实形态：CJK 单字切分正文，抽取器必须还原后才能匹配领域术语
memory('segmented1', '切分正文冷却', '冷 却 水 流 量 32 升 每 分 钟 时 良 率 98%')
memory('private1', '私有模温', '私有 PRIVATESECRET 模温 85 的私人记录', 'a1')
memory('task1', '任务完成记录', '任务过程 TASKSECRET 保压压力 62 完成', 'a1', 'episodic-task')

test('channel graph consumes team semantics + channel task rows, excludes agent-private semantics', async () => {
  const run = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false, partition: { scopeKind: 'channel' } })
  assert.equal(run.status, 'ok', run.error)
  assert.ok(run.scanned >= 2, `scanned=${run.scanned}`)
  const entities = graph.listEntities('c1', { limit: 300 })
  assert.ok(entities.some(e => e.memoryId === 'shared1'))
  assert.ok(entities.some(e => e.memoryId === 'task1'), '任务过程记忆应进入频道图')
  assert.ok(entities.some(e => e.canonicalName === '冷却水流量' && e.memoryId === 'segmented1'), '切分正文必须还原后才能抽出领域术语')
  assert.ok(!entities.some(e => e.memoryId === 'private1'), '私有语义记忆不得进入频道图')
  assert.ok(!entities.some(e => e.canonicalName.includes('PRIVATESECRET')))
})

test('curator sources exclude private semantics while keeping team + task process rows', async () => {
  const sources = selectCuratorSources(db, 'c1')
  assert.ok(sources.some(s => s.id === 'shared1'))
  assert.ok(sources.some(s => s.id === 'task1'))
  assert.ok(!sources.some(s => s.id === 'private1'))
  // 3 个来源即可成册
  const run = await runCuratorForChannel(db, 'c1')
  assert.equal(run.status, 'ok', run.error)
  assert.ok(run.markdown && run.markdown.includes('共享保压'))
  assert.ok(!run.markdown!.includes('PRIVATESECRET'), '知识手册不得泄露私有记忆正文')
})

test('task outcome persists channel scope so the graph can index it', async () => {
  const mem = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: null })
  const task = {
    id: 'task-scope-1', channelId: 'c1', title: '作用域验收任务', description: '无会话任务', state: 'COMPLETED',
    artifacts: [], sessionId: '', assigneeId: 'a1', parentId: null,
  } as never
  await mem.recordTaskOutcome(task)
  const row = db.prepare(`SELECT scope_kind AS scopeKind, scope_key AS scopeKey, session_id AS sessionId
    FROM agent_memories WHERE task_id = 'task-scope-1'`).get() as { scopeKind?: string, scopeKey?: string, sessionId?: string } | undefined
  assert.ok(row)
  assert.equal(row!.scopeKind, 'channel')
  assert.equal(row!.sessionId, '')
  assert.ok(graph.selectPendingSources('c1', 50, { scopeKind: 'channel', scopeKey: '' }).some(s => s.taskId === 'task-scope-1'))
})

test('soft-deleted edge is visible again after restore', () => {
  const a = service.createEntity('c1', { name: '恢复边源', type: 'concept' }, { id: 'u1', name: 'U' })
  const b = service.createEntity('c1', { name: '恢复边目标', type: 'concept' }, { id: 'u1', name: 'U' })
  const edge = service.createEdge('c1', { srcId: a.id, dstId: b.id, relation: 'relates_to', fact: '恢复边验收' }, { id: 'u1', name: 'U' })
  service.deleteEdge('c1', edge.id, { id: 'u1', name: 'U' }, 'test')
  assert.ok(!service.listEdges('c1', { limit: 500 }).items.some(e => e.id === edge.id))
  const restored = service.restoreEdge('c1', edge.id, { id: 'u1', name: 'U' })
  assert.equal(restored.status, 'active')
  assert.ok(service.listEdges('c1', { limit: 500 }).items.some(e => e.id === edge.id), '恢复后必须重新可见')
})

test('rejected entity and its edge no longer project memories into graph retrieval', () => {
  const entity = service.createEntity('c1', { name: '否证实体', type: 'concept' }, { id: 'u1', name: 'U' })
  const other = service.createEntity('c1', { name: '否证邻居', type: 'concept' }, { id: 'u1', name: 'U' })
  const edge = service.createEdge('c1', {
    srcId: entity.id, dstId: other.id, relation: 'relates_to', fact: '否证实体关系',
    evidenceMemoryIds: ['shared1'],
  }, { id: 'u1', name: 'U' })
  assert.ok(edge)
  const before = graphRetrieve(graph, 'c1', '否证实体 否证邻居', { scopeKinds: ['channel'], scopeKeys: [''] })
  assert.ok(before.memoryScores.has('shared1'))
  service.updateEntity('c1', entity.id, {
    expectedRevision: entity.revision, status: 'rejected',
  }, { id: 'u1', name: 'U' })
  const after = graphRetrieve(graph, 'c1', '否证实体 否证邻居', { scopeKinds: ['channel'], scopeKeys: [''] })
  assert.ok(!after.memoryScores.has('shared1'), '否证实体不得继续投影记忆')
})

test('agent consolidation cannot resurrect a human-rejected edge', () => {
  const a = service.createEntity('c1', { name: '墓碑源', type: 'concept' }, { id: 'u1', name: 'U' })
  const b = service.createEntity('c1', { name: '墓碑目标', type: 'concept' }, { id: 'u1', name: 'U' })
  const edge = service.createEdge('c1', { srcId: a.id, dstId: b.id, relation: 'relates_to', fact: '人工否证事实' }, { id: 'u1', name: 'U' })
  service.rejectEdge('c1', edge.id, { expectedRevision: edge.revision, reason: '人工否证' }, { id: 'u1', name: 'U' })
  const recreated = graph.upsertEdge({
    channelId: 'c1', srcId: a.id, dstId: b.id, relation: 'relates_to', fact: '人工否证事实',
    authorKind: 'agent', sourceKind: 'memory', evidence: [{ memoryId: 'shared1', confidence: 0.5 }],
  })
  assert.equal(recreated?.outcome, 'protected')
  assert.equal(graph.getEdge(edge.id)?.status, 'rejected')
})

test('validated experience cannot be rolled back to historical text', () => {
  const { id } = repo.upsertExperience({
    channelId: 'c1', agentId: 'a1', title: '不可回滚经验', titleFts: '不 可 回 滚 经 验',
    content: '已验证正文', importance: 0.8, dedupKey: 'exp:immutable',
    evidence: { taskIds: ['t1'] }, scopeKind: 'line', scopeKey: 'L1', status: 'validated',
  })
  db.prepare(`INSERT INTO memory_revisions(id, memory_id, revision, title, content, evidence_json, author_kind, author_id, reason, created_at)
    VALUES ('rev-immutable-1', ?, 1, '旧版', '历史正文', '[]', 'agent', 'a1', 'old', ?)`).run(id, now)
  assert.throws(
    () => rollbackMemory(db, { id, revision: 1, expectedRevision: 1, reason: 'test', actor: { kind: 'human', id: 'u1' } }),
    (err: unknown) => err instanceof MemoryAdminError && err.code === 'MEMORY_IMMUTABLE',
  )
})

test('cross-channel block import is skipped and does not write the source scope', () => {
  upsertBlock(db, { scopeId: scopeIdOfChannel('c1'), channelId: 'c1', label: '跨频道块', value: 'SOURCEBLOCK', actor: 'u1' })
  const jsonl = exportMemoryJsonl(db, { channelId: 'c1' })
  const report = importMemoryJsonl(db, 'c2', jsonl, 'u1')
  assert.equal(report.blocks, 0, '跨频道 block 必须跳过')
  assert.ok(!listBlocks(db, [scopeIdOfChannel('c2')]).some(b => b.label === '跨频道块'))
  assert.ok(listBlocks(db, [scopeIdOfChannel('c1')]).some(b => b.label === '跨频道块'))
})

test('repair keeps entity FTS for later restore', () => {
  const e = service.createEntity('c1', { name: '修复后可检索实体', type: 'concept' }, { id: 'u1', name: 'U' })
  service.deleteEntity('c1', e.id, { id: 'u1', name: 'U' }, 'test')
  repairMemory(db)
  service.restoreEntity('c1', e.id, { id: 'u1', name: 'U' })
  const hits = graph.searchEntitiesFts('c1', '"修 复 后 可 检 索 实 体"')
  assert.ok(hits.some(h => h.id === e.id), 'restore 后实体必须仍可被 FTS 命中')
})

test('repair purges old-WIP graph residue while keeping legitimate, human and anchored rows', () => {
  // 模拟旧库残留:私有语义行/带会话戳过程行被物化进频道图(agent 创建,收紧前口径)
  const insEntity = db.prepare(`INSERT INTO memory_entities(id, channel_id, scope_kind, scope_key, entity_type, canonical_name, canonical_key, search_text, status, author_kind, author_id, source_kind, memory_id, created_at, updated_at)
    VALUES (?, 'c1', 'channel', '', 'concept', ?, ?, ?, 'active', 'agent', 'a1', 'memory', ?, ?, ?)`)
  const insEdge = db.prepare(`INSERT INTO memory_edges(id, channel_id, scope_kind, scope_key, src_id, dst_id, relation, fact, status, author_kind, author_id, source_kind, created_at, updated_at)
    VALUES (?, 'c1', 'channel', '', ?, ?, 'affects', ?, 'active', 'agent', 'a1', 'memory', ?, ?)`)
  const insEvidence = db.prepare(`INSERT INTO memory_edge_evidence(id, edge_id, memory_id, created_at) VALUES (?, ?, ?, ?)`)
  const insMention = db.prepare(`INSERT INTO memory_entity_mentions(id, entity_id, memory_id, created_at) VALUES (?, ?, ?, ?)`)
  const t = now
  // 残留:私有行来源 / 带会话戳过程行来源
  insEntity.run('res-private', '私有残留实体', '私有残留实体', '私 有 残 留 实 体', 'private1', t, t)
  db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance, session_id, dedup_key, scope_kind, scope_key, status, created_at, updated_at, valid_from)
    VALUES ('sessiontask', 'c1', 'a1', 'episodic-task', '会话任务行', '会 话 任 务 行', '会话过程', 0.5, 's9', 'h:sessiontask', 'session', 's9', 'active', ?, ?, ?)`).run(t, t, t)
  insEntity.run('res-session', '会话残留实体', '会话残留实体', '会 话 残 留 实 体', 'sessiontask', t, t)
  // 合法:团队行来源 + 提及
  insEntity.run('res-team', '团队存活实体', '团队存活实体', '团 队 存 活 实 体', 'shared1', t, t)
  insMention.run('men-team', 'res-team', 'shared1', t)
  insEntity.run('res-team2', '团队存活实体二', '团队存活实体二', '团 队 存 活 实 体 二', 'shared2', t, t)
  insMention.run('men-team2', 'res-team2', 'shared2', t)
  // 人工锁定行(即使来源已不合法也保留)
  insEntity.run('res-locked', '人工锁定残留', '人工锁定残留', '人 工 锁 定 残 留', 'private1', t, t)
  db.prepare(`UPDATE memory_entities SET locked = 1 WHERE id = 'res-locked'`).run()
  // 人工否证墓碑(清理不得清掉墓碑,否则整理可按同名复活)
  insEntity.run('res-rejected', '人工否证残留', '人工否证残留', '人 工 否 证 残 留', 'private1', t, t)
  db.prepare(`UPDATE memory_entities SET status = 'rejected' WHERE id = 'res-rejected'`).run()
  // 边:残留证据(私有) / 合法证据(团队) / ontology 锚点
  insEdge.run('res-edge-bad', 'res-private', 'res-team', '私有证据边', t, t)
  insEvidence.run('ev-bad', 'res-edge-bad', 'private1', t)
  insEdge.run('res-edge-ok', 'res-team', 'res-team2', '团队证据边', t, t)
  insEvidence.run('ev-ok', 'res-edge-ok', 'shared1', t)
  insEdge.run('res-edge-anchor', 'res-session', 'res-team2', '锚点边', t, t)
  insEvidence.run('ev-anchor', 'res-edge-anchor', 'ontology:ont-1', t)

  const counts = purgeGraphResidue(db)
  assert.ok(counts.edgesPurged >= 1 && counts.entitiesPurged >= 1, `清理计数异常: ${JSON.stringify(counts)}`)
  const ids = new Set((graph.listEntities('c1', { limit: 500 }) as Array<{ id: string }>).map(e => e.id))
  const edgeIds = new Set(service.listEdges('c1', { limit: 500 }).items.map(e => e.id))
  assert.ok(!ids.has('res-private'), '私有来源残留实体必须清除(其唯一边证据同样非法,连带清除)')
  assert.ok(ids.has('res-session'), '会话行来源实体因存活锚点边支撑而保留(与 edgeEvidenceLive 同语义,不产生悬挂边)')
  assert.ok(ids.has('res-team') && ids.has('res-team2'), '团队来源实体必须保留')
  assert.ok(ids.has('res-locked'), '人工锁定行必须保留')
  assert.ok(ids.has('res-rejected'), '人工否证墓碑必须保留(防同名复活)')
  assert.ok(!edgeIds.has('res-edge-bad'), '私有证据边必须清除')
  assert.ok(edgeIds.has('res-edge-ok'), '团队证据边必须保留')
  assert.ok(edgeIds.has('res-edge-anchor'), 'ontology 锚点边必须保留')
  // mention 孤儿清理
  const orphanMentions = (db.prepare(`SELECT COUNT(*) AS n FROM memory_entity_mentions WHERE entity_id NOT IN (SELECT id FROM memory_entities)`).get() as { n: number }).n
  assert.equal(orphanMentions, 0, '孤儿 mention 必须清零')
})
