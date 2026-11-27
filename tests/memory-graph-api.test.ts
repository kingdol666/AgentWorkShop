/**
 * Phase 4：图谱管理服务（人工 CRUD/合并/候选/运行/设置）。
 * HTTP 权限/审计由 graphContext + recordOps 承担；这里验证业务语义与 CAS。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-graph-api-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_MEMORY_GRAPH_LLM_URL
delete process.env.AW_MEMORY_CURATOR_LLM_URL

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryGraphService } = await import('../server/services/workshop/memory/graph/service')
const { runMemoryGraphConsolidation } = await import('../server/services/workshop/memory/graph/agent')

const db = openWorkshopDb(':memory:')
const service = createMemoryGraphService(db)
const actor = { id: 'u1', name: 'Owner' }
const isStatus = (status: number) => (err: unknown): boolean => (err as { status?: number }).status === status
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','注塑一线','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)
db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
    session_id, dedup_key, scope_kind, scope_key, status, valid_from, recorded_at, created_at, updated_at)
  VALUES ('m1','c1','__team__','semantic','保压调整','保 压 调 整','保压压力 60→62 后壁厚提升。',0.7,'','sem:m1','channel','','active',?,?,?,?)`)
  .run(now, now, now, now)

test('service exposes subgraph/list/detail after consolidation', async () => {
  const run = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false })
  assert.equal(run.status, 'ok', run.error)
  const graph = service.subgraph('c1', { limit: 100 })
  assert.ok(graph.nodes.length > 0)
  assert.ok(graph.edges.length > 0)
  const entities = service.listEntities('c1', { limit: 100 })
  assert.ok(entities.total > 0)
  assert.ok(entities.items.length > 0)
  const edges = service.listEdges('c1', { limit: 100 })
  assert.ok(edges.total > 0)
  const detail = service.entityDetail('c1', graph.nodes.find(n => n.entityType !== 'episode')!.id)
  assert.ok(detail.entity)
  assert.ok(Array.isArray(detail.aliases))
  const edge = graph.edges[0]!
  const edgeDetail = service.edgeDetail('c1', edge.id)
  assert.ok(edgeDetail.edge)
  assert.ok(Array.isArray(edgeDetail.evidence))
})

test('human entity create/update CAS/delete/restore', () => {
  const created = service.createEntity('c1', {
    name: '人工模温规则', type: 'concept', summary: '人工补充', aliases: ['模温规则'],
  }, actor)
  assert.equal(created.canonicalName, '人工模温规则')
  assert.equal(created.authorKind, 'human')
  assert.throws(() => service.createEntity('c1', {
    name: '人工模温规则', type: 'concept',
  }, actor), isStatus(409))

  const updated = service.updateEntity('c1', created.id, {
    expectedRevision: created.revision, summary: '人工修改后的说明', locked: true,
  }, actor)
  assert.equal(updated.summary, '人工修改后的说明')
  assert.equal(updated.locked, true)
  assert.throws(() => service.updateEntity('c1', created.id, {
    expectedRevision: created.revision, summary: '过期 CAS',
  }, actor), isStatus(409))

  service.deleteEntity('c1', created.id, actor, 'test')
  const restored = service.restoreEntity('c1', created.id, actor)
  assert.equal(restored.deletedAt, null)
})

test('human edge create/update/reject/restore and merge/unmerge', () => {
  const list = service.listEntities('c1', { limit: 100 }).items.filter(e => e.entityType !== 'episode')
  const a = list[0]!
  const b = list[1]!
  const edge = service.createEdge('c1', {
    srcId: a.id, dstId: b.id, relation: 'relates_to', fact: '人工关系',
  }, actor)
  assert.equal(edge.authorKind, 'human')
  assert.equal(edge.status, 'active')

  const updated = service.updateEdge('c1', edge.id, {
    expectedRevision: edge.revision, fact: '人工关系（修订）', confidence: 0.9,
  }, actor)
  assert.equal(updated.fact, '人工关系（修订）')

  const rejected = service.rejectEdge('c1', edge.id, { expectedRevision: updated.revision, reason: '测试否证' }, actor)
  assert.equal(rejected.status, 'rejected')
  const restored = service.restoreEdge('c1', edge.id, actor)
  assert.equal(restored.status, 'active')

  const merged = service.mergeEntity('c1', b.id, a.id, actor)
  assert.ok(merged)
  const after = service.entityDetail('c1', b.id).entity as { mergedInto?: string | null }
  assert.equal(after.mergedInto, a.id)
  const unmerged = service.unmergeEntity('c1', b.id, actor)
  assert.equal(unmerged.mergedInto, null)
})

test('merge candidates accept/reject', () => {
  const entities = service.listEntities('c1', { limit: 100 }).items.filter(e => e.entityType !== 'episode')
  const source = service.createEntity('c1', { name: '候选源', type: 'concept' }, actor)
  const target = entities[0]!
  db.prepare(`INSERT INTO memory_merge_candidates(id, channel_id, source_entity_id, target_entity_id, score, reason, status, created_at, updated_at)
    VALUES ('mc1','c1',?,?,0.8,'测试候选','proposed',?,?)`).run(source.id, target.id, now, now)
  assert.ok(service.mergeCandidates('c1').some(c => c.id === 'mc1'))
  service.rejectCandidate('c1', 'mc1', actor)
  assert.ok(!service.mergeCandidates('c1').some(c => c.id === 'mc1'))
  db.prepare(`UPDATE memory_merge_candidates SET status='proposed' WHERE id='mc1'`).run()
  const result = service.acceptCandidate('c1', 'mc1', actor)
  assert.ok(result)
})

test('runs/settings/communities are queryable', async () => {
  const { runId } = service.startRun('c1', 'incremental', actor)
  assert.ok(runId)
  let run: Record<string, unknown> | null = null
  for (let i = 0; i < 40; i++) {
    run = service.getRun('c1', runId)
    if (String(run.status) !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.notEqual(run?.status, 'running')
  assert.ok(service.runs('c1').length >= 1)
  const settings = service.settings('c1')
  assert.equal(typeof settings.enabled, 'boolean')
  const next = service.updateSettings('c1', { enabled: false }, actor)
  assert.equal(next.enabled, false)
  assert.ok(Array.isArray(service.communities('c1')))
})
