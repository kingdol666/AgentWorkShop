/**
 * Memory Graph 持久层（Phase 1）：
 * - 迁移建表/FTS/索引/幂等；
 * - 实体唯一键与别名/FTS 同步；
 * - episode 节点与增量来源选择；
 * - 边必须有证据（agent）、locked/human 保护、失效不删除 + asOf；
 * - 社区/运行/状态最小闭环。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-graph-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { migrateMemoryGraph } = await import('../server/services/workshop/db/database/migrations-memory-graph')
const { createMemoryGraphRepo } = await import('../server/services/workshop/memory/graph/repo')
const { createMemory } = await import('../server/services/workshop/memory/memory-admin')
const { buildMatchQuery } = await import('../server/services/workshop/runtime/memory/helpers')

const db = openWorkshopDb(':memory:')
const repo = createMemoryGraphRepo(db)
const now = new Date().toISOString()

db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','注塑一线','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)

test('migration creates graph tables/FTS and is idempotent', () => {
  const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','trigger')`).all() as Array<{ name: string }>
  const set = new Set(names.map(n => n.name))
  for (const t of [
    'memory_entities', 'memory_entity_aliases', 'memory_entity_mentions', 'memory_edges',
    'memory_edge_evidence', 'memory_communities', 'memory_community_members',
    'memory_graph_runs', 'memory_graph_state', 'memory_graph_revisions',
    'memory_merge_candidates', 'memory_entities_fts',
    'trg_memory_entities_ai', 'trg_memory_entities_au', 'trg_memory_entities_ad',
  ]) assert.ok(set.has(t), `缺少 ${t}`)
  assert.doesNotThrow(() => migrateMemoryGraph(db))
  assert.doesNotThrow(() => migrateMemoryGraph(db))
  assert.equal(repo.available, true)
})

test('entity upsert is deduped, aliases and FTS stay in sync', () => {
  const first = repo.upsertEntity({
    channelId: 'c1', entityType: 'parameter', canonicalName: '保压压力',
    aliases: ['保压', '保压压力SP'], summary: '注塑保压参数', confidence: 0.9,
  })
  assert.equal(first.outcome, 'inserted')
  const second = repo.upsertEntity({
    channelId: 'c1', entityType: 'parameter', canonicalName: '保压压力', summary: '更长的说明：保压压力设定',
  })
  assert.equal(second.outcome, 'updated')
  assert.equal(second.entity.id, first.entity.id)
  assert.ok(second.entity.aliases.includes('保压'))

  const hits = repo.searchEntitiesFts('c1', buildMatchQuery('保压')!)
  assert.ok(hits.some(e => e.id === first.entity.id), 'FTS 应命中实体')

  const byAlias = repo.findEntitiesByAlias('c1', ['保压'])
  assert.ok(byAlias.some(e => e.id === first.entity.id))

  const renamed = repo.updateEntity(first.entity.id, {
    canonicalName: '保压压力SP', aliases: ['保压'], expectedRevision: second.entity.revision,
  }, { kind: 'human', id: 'u1' })
  assert.equal(renamed.canonicalName, '保压压力SP')
  const oldHits = repo.searchEntitiesFts('c1', buildMatchQuery('保压压力SP')!)
  assert.ok(oldHits.some(e => e.id === first.entity.id))
})

test('episode nodes make source selection incremental', () => {
  db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
      session_id, dedup_key, scope_kind, scope_key, status, created_at, updated_at)
    VALUES ('m1','c1','__team__','semantic','保压经验','保 压 经 验','保压压力 60→62 后壁厚提升','0.7','','sem:m1','channel','','active',?,?)`)
    .run(now, now)
  const pending = repo.selectPendingSources('c1')
  assert.ok(pending.some(m => m.id === 'm1'))
  const ep = repo.markSourceEpisode('c1', pending.find(m => m.id === 'm1')!)
  assert.equal(ep.entityType, 'episode')
  assert.equal(ep.memoryId, 'm1')
  const after = repo.selectPendingSources('c1')
  assert.ok(!after.some(m => m.id === 'm1'), '已建 episode 的来源不再待处理')
})

test('agent edges require evidence; human/locked rows are protected; invalidation keeps history', () => {
  const a = repo.upsertEntity({ channelId: 'c1', entityType: 'parameter', canonicalName: '模温' }).entity
  const b = repo.upsertEntity({ channelId: 'c1', entityType: 'metric', canonicalName: '壁厚' }).entity
  const noEvidence = repo.upsertEdge({
    channelId: 'c1', srcId: a.id, dstId: b.id, relation: 'affects', fact: '模温 85 度时壁厚稳定',
    status: 'active', authorKind: 'agent',
  })
  assert.equal(noEvidence, null, 'agent 边无证据必须拒收')

  const created = repo.upsertEdge({
    channelId: 'c1', srcId: a.id, dstId: b.id, relation: 'affects', fact: '模温 85 度时壁厚稳定',
    status: 'active', authorKind: 'agent', confidence: 0.8,
    evidence: [{ memoryId: 'm1', quote: '模温 85 度', confidence: 0.8 }],
    validFrom: '2026-01-01T00:00:00.000Z',
  })!
  assert.ok(created)
  assert.equal(created.outcome, 'inserted')
  assert.equal(repo.evidenceCount(created.edge.id), 1)

  const lockedEntity = repo.updateEntity(a.id, { locked: true, expectedRevision: a.revision }, { kind: 'human', id: 'u1' })
  const protectedEntity = repo.upsertEntity({
    channelId: 'c1', entityType: 'parameter', canonicalName: '模温', summary: 'agent 不应覆盖',
  })
  assert.equal(protectedEntity.outcome, 'protected')
  assert.equal(protectedEntity.entity.summary, lockedEntity.summary)

  assert.equal(repo.invalidateEdge(created.edge.id, '', '2026-06-01T00:00:00.000Z'), true)
  const superseded = repo.getEdge(created.edge.id)!
  assert.equal(superseded.status, 'superseded')
  assert.equal(superseded.validTo, '2026-06-01T00:00:00.000Z')
  const current = repo.listEdges('c1', { statuses: ['active'] })
  assert.ok(!current.some(e => e.id === created.edge.id))
  const historical = repo.listEdges('c1', {
    asOf: '2026-03-01T00:00:00.000Z', statuses: ['active', 'provisional', 'superseded'],
  })
  assert.ok(historical.some(e => e.id === created.edge.id), 'asOf 应能回看失效前事实')
})

test('communities/runs/state are durable and counts are queryable', () => {
  const entities = repo.listEntities('c1')
  assert.ok(entities.length >= 2)
  const communityId = 'com-test'
  repo.replaceCommunities('c1', [{
    id: communityId, level: 0, title: '注塑参数', summary: '模温/保压/壁厚',
    memberIds: entities.slice(0, 2).map(e => e.id), edgeCount: 1,
  }])
  assert.ok(repo.listCommunities('c1').some(c => c.id === communityId))
  assert.ok(repo.communityMembers(communityId).length >= 1)

  const runId = repo.startRun('c1', 'incremental')
  repo.finishRun(runId, { status: 'ok', scanned: 1, entitiesNew: 2, edgesNew: 1 })
  const run = repo.getRun(runId)!
  assert.equal(run.status, 'ok')
  assert.equal(run.entitiesNew, 2)
  assert.equal(repo.listRuns('c1').length, 1)

  const state = repo.ensureState('c1')
  repo.updateState('c1', { lastSourceHash: 'h1', entityCount: 2, edgeCount: 1 })
  const next = repo.getState('c1')!
  assert.equal(next.id, state.id)
  assert.equal(next.lastSourceHash, 'h1')
  assert.ok(repo.bumpRevision('c1') >= 1)

  const stats = repo.graphStats('c1')
  assert.equal(stats.entities >= 2, true)
  assert.equal(stats.edges >= 1, true)
})

test('manual memory create persists declared scope', () => {
  const created = createMemory(db, {
    channelId: 'c1', scopeKind: 'channel', scopeKey: 'L1',
    title: '手工频道记忆', content: '手工创建的频道级记忆', ownerUserId: 'u1',
    actor: { kind: 'human', id: 'u1' },
  })
  const row = db.prepare('SELECT scope_kind AS scopeKind, scope_key AS scopeKey, owner_user_id AS owner FROM agent_memories WHERE id = ?')
    .get(created.id) as { scopeKind: string, scopeKey: string, owner: string | null }
  assert.equal(row.scopeKind, 'channel')
  assert.equal(row.scopeKey, 'L1')
  assert.equal(row.owner, 'u1')
})
