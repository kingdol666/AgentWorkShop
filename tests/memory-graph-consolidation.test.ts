/**
 * Phase 2：整理 Agent（规则 + 可选 LLM）。
 * - 本体/claim/记忆 → 实体/边/mentions/episode/社区；
 * - 增量 noop；新记忆增量；
 * - LLM 输出校验/证据绑定/provisional；
 * - access mode 策略；单飞。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GraphLlmClient } from '../server/services/workshop/memory/graph/agent'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-graph-agent-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_MEMORY_GRAPH_LLM_URL
delete process.env.AW_MEMORY_CURATOR_LLM_URL

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryGraphRepo } = await import('../server/services/workshop/memory/graph/repo')
const { runMemoryGraphConsolidation } = await import('../server/services/workshop/memory/graph/agent')
const { detectCommunities } = await import('../server/services/workshop/memory/graph/communities')

const db = openWorkshopDb(':memory:')
const graph = createMemoryGraphRepo(db)
const now = new Date().toISOString()

function channel(id: string, mode = 'inherit') {
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
    VALUES (?, ?, '', '', '', '{}', 1, 1, 'L1', 'u1', ?, ?, ?)`)
    .run(id, id, mode, now, now)
}
channel('c1')
channel('c2')
channel('c3', 'readonly')

function semantic(channelId: string, id: string, title: string, content: string, agent = '__team__') {
  db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
      session_id, dedup_key, scope_kind, scope_key, status, valid_from, recorded_at, created_at, updated_at)
    VALUES (?, ?, ?, 'semantic', ?, ?, ?, 0.7, '', ?, 'channel', '', 'active', ?, ?, ?, ?)`)
    .run(id, channelId, agent, title, title.replace(/\s+/g, ' '), content, `sem:${id}`, now, now, now, now)
}

// 本体：保压压力 -> 壁厚 effects
db.prepare(`INSERT INTO ontology_versions(id, version, name, line_id, product_id, content_hash, compiled_json, changelog_json, status, owner_user_id, published_by, created_at, updated_at)
  VALUES ('ont1', 1, '注塑本体', 'L1', '', 'h', '{}', '{}', 'published', 'u1', 'u1', ?, ?)`).run(now, now)
db.prepare(`INSERT INTO ontology_entities(version_id, version, entity_key, kind, name, description, unit, dimension, role, attributes_json, created_at)
  VALUES ('ont1', 1, 'pv.pressure', 'parameter', '保压压力', '保压设定压力', 'MPa', 'pressure', 'control', '{}', ?)`).run(now)
db.prepare(`INSERT INTO ontology_entities(version_id, version, entity_key, kind, name, description, unit, dimension, role, attributes_json, created_at)
  VALUES ('ont1', 1, 'q.thickness', 'target', '壁厚', '产品壁厚', 'mm', 'length', 'target', '{}', ?)`).run(now)
db.prepare(`INSERT INTO ontology_relations(id, version_id, version, src_key, dst_key, predicate, properties_json, status, created_at)
  VALUES ('rel1', 'ont1', 1, 'pv.pressure', 'q.thickness', 'influences', '{"evidenceTier":"observed_correlation"}', 'approved', ?)`).run(now)

// 经验 + claim
db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
    session_id, dedup_key, scope_kind, scope_key, status, valid_from, recorded_at, created_at, updated_at)
  VALUES ('exp1','c1','a1','experience','保压上调提升壁厚','保 压 上 调 提 升 壁 厚','保压 60→62 后壁厚 3.05→3.14',0.8,'','exp:exp1','line','L1','validated',?,?,?,?)`)
  .run(now, now, now, now)
db.prepare(`INSERT INTO experience_versions(version_id, experience_id, claim_origin_id, scope_kind, scope_key, claim_json,
    content, content_hash, evidence_json, evidence_snapshot_hash, lifecycle, deployment, claim_origin_time, beta_ancestors_json, idempotency_key, created_at)
  VALUES ('ev1','exp1','co1','line','L1','{}','x','h1','[]','h2','validated','active',?,'[]','idem1',?)`).run(now, now)
db.prepare(`INSERT INTO experience_heads(experience_id, version_id, updated_at) VALUES ('exp1','ev1',?)`).run(now)
db.prepare(`INSERT INTO experience_claims(claim_id, event_id, memory_id, version_id, source_kind, domain, line_id, product_id,
    node_id, node_name, variable, unit, recipe_id, recipe_revision, from_value, to_value, direction,
    target_node_id, target_metric, target_direction, effect, ci_low, ci_high, mde, verdict, polarity,
    environment, observed_at, claim_status, intervention_id, valid_from, created_at, updated_at)
  VALUES ('pcl-1','evt-1','exp1','ev1','intervention','parameter','L1','','n1','注塑机','保压压力','MPa','R1','r3',60,62,'up',
    'n1','壁厚','up',0.09,0.05,0.13,0.02,'identifiable_effect','positive','{}',?,'active','iv1',?,?,?)`)
  .run(now, now, now, now)
db.prepare(`INSERT INTO experience_claims(claim_id, event_id, memory_id, version_id, source_kind, domain, line_id, product_id,
    node_id, node_name, variable, unit, recipe_id, recipe_revision, from_value, to_value, direction,
    target_node_id, target_metric, target_direction, effect, ci_low, ci_high, mde, verdict, polarity,
    environment, observed_at, claim_status, intervention_id, valid_from, created_at, updated_at)
  VALUES ('pcl-2','evt-2','exp1','ev1','intervention','parameter','L1','P-ACCEPT-01','n1','注塑机','冷却水流量','L/min','R1','r3',12,14,'up',
    'n1','良率','up',0.01,0.005,0.02,0.005,'identifiable_effect','positive','{}',?,'active','iv2',?,?,?)`)
  .run(now, now, now, now)

semantic('c1', 'm1', '保压调参记录', '保压压力 60→62 后壁厚提升；模温保持 85 度。')
semantic('c1', 'm2', '模温与壁厚', '模温 85 度时壁厚稳定，保压压力不宜过高。')
semantic('c2', 'm3', '会话私有内容', '保压压力 999 的跨会话泄漏测试。')

test('rule consolidation builds entities/edges/episodes/communities', async () => {
  const result = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false })
  assert.equal(result.status, 'ok', result.error)
  assert.ok(result.scanned >= 2)
  const channelEntities = graph.listEntities('c1', { limit: 200, scopeKinds: ['channel'], scopeKeys: [''] })
  assert.ok(channelEntities.some(e => e.canonicalName === '保压压力'), '频道记忆术语应入图')
  assert.ok(channelEntities.some(e => e.canonicalName === '壁厚'), '频道记忆术语应入图')
  assert.ok(channelEntities.some(e => e.entityType === 'episode'), '每条来源应有 episode')
  const channelEdges = graph.listEdges('c1', { limit: 200, scopeKinds: ['channel'], scopeKeys: [''] })
  assert.ok(channelEdges.every(e => e.scopeKind === 'channel'), '频道图不得混入 line/product/session 边')

  // 结构化 claim/本体单独落在 line/product 分区，不与频道图混合。
  const line = await runMemoryGraphConsolidation(db, 'c1', {
    useLlm: false, partition: { scopeKind: 'line', scopeKey: 'L1' },
  })
  assert.equal(line.status, 'ok', line.error)
  const product = await runMemoryGraphConsolidation(db, 'c1', {
    useLlm: false, partition: { scopeKind: 'product', scopeKey: 'P-ACCEPT-01' },
  })
  assert.equal(product.status, 'ok', product.error)
  const structured = graph.listEdges('c1', { limit: 200, scopeKinds: ['line', 'product'] })
  const structuredEntities = graph.listEntities('c1', { limit: 200, scopeKinds: ['line', 'product'] })
  assert.ok(structuredEntities.some(e => e.canonicalName === '保压压力'), '本体/claim 参数应入 line/product 图')
  assert.ok(structuredEntities.some(e => e.canonicalName === '壁厚'), '目标指标应入 line/product 图')
  assert.ok(structured.some(e => e.relation === 'affects'), 'claim 应生成 affects 边')
  assert.ok(structured.some(e => e.relation === 'has_parameter'), '设备-参数边应存在')
  assert.ok(structured.some(e => e.sourceKind === 'ontology'), '本体关系应入图')
  const episodes = channelEntities.filter(e => e.entityType === 'episode')
  assert.ok(episodes.length >= 2)
  assert.ok(graph.listMentionsByMemory('m1').length > 0, '记忆应产生实体提及')
  assert.ok(graph.listMentionsByMemory('m2').length > 0)
})

test('rerun is noop; new memory increments; readonly is skipped', async () => {
  const again = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false })
  assert.equal(again.status, 'skipped_noop')
  assert.equal(again.fallbackReason, 'no_changes')

  semantic('c1', 'm4', '新增保压经验', '保压压力 62 时壁厚 3.14，继续观察。')
  const run = await runMemoryGraphConsolidation(db, 'c1', { useLlm: false })
  assert.equal(run.status, 'ok')
  assert.ok(run.scanned >= 1)

  const blocked = await runMemoryGraphConsolidation(db, 'c3', { useLlm: false })
  assert.equal(blocked.status, 'skipped_noop')
  assert.match(blocked.error, /access_mode_readonly/)
})

test('LLM extraction validates evidence, creates provisional edge, applies invalidation', async () => {
  const a = graph.upsertEntity({ channelId: 'c2', entityType: 'concept', canonicalName: '旧实体', status: 'active' }).entity
  const b = graph.upsertEntity({ channelId: 'c2', entityType: 'concept', canonicalName: '旧目标', status: 'active' }).entity
  const oldEdge = graph.upsertEdge({
    channelId: 'c2', srcId: a.id, dstId: b.id, relation: 'affects', fact: '旧事实 1',
    status: 'active', authorKind: 'claim', sourceKind: 'claim',
    evidence: [{ memoryId: 'm3', confidence: 0.8 }],
  })!.edge

  const llm: GraphLlmClient = {
    async extract(input) {
      const id = input.sources[0].id
      return {
        inputChars: 120,
        result: {
          entities: [{ name: '新实体', type: 'concept', aliases: ['新'], summary: 'LLM 抽取' }],
          relations: [{
            src: '新实体', dst: '旧实体', relation: 'relates_to', fact: '新实体关联旧实体',
            polarity: 'positive' as const, confidence: 0.7, evidence: [id],
          }],
          invalidations: [{ edgeId: oldEdge.id, reason: '被新证据取代', evidence: [id] }],
        },
      }
    },
    async summarize() { return '这是 LLM 生成的社区摘要。' },
  }

  // 新增一条待处理记忆，确保本轮会调用 LLM
  semantic('c2', 'm5', '新实体记录', '新实体与旧实体相关。')
  const result = await runMemoryGraphConsolidation(db, 'c2', { useLlm: true, llm })
  assert.equal(result.status, 'ok', result.error)
  assert.ok(result.llmCalls >= 1)
  const entities = graph.listEntities('c2', { limit: 200 })
  assert.ok(entities.some(e => e.canonicalName === '新实体'))
  const llmEdge = graph.listEdges('c2', { limit: 200 }).find(e => e.sourceKind === 'llm')
  assert.ok(llmEdge, 'LLM 关系应写入')
  assert.equal(llmEdge!.status, 'provisional')
  assert.ok(graph.listEvidence(llmEdge!.id).length >= 1)
  const invalidated = graph.getEdge(oldEdge.id)!
  assert.equal(invalidated.status, 'superseded')
})

test('concurrent consolidation is single-flight', async () => {
  semantic('c2', 'm6', '单飞测试', '并发整理应只跑一轮。')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const llm: GraphLlmClient = {
    async extract() {
      await gate
      return null
    },
    async summarize() { return null },
  }
  const first = runMemoryGraphConsolidation(db, 'c2', { useLlm: true, llm })
  await new Promise(resolve => setTimeout(resolve, 20))
  const second = await runMemoryGraphConsolidation(db, 'c2', { useLlm: true, llm })
  assert.equal(second.status, 'skipped_noop')
  assert.match(second.error, /already_running/)
  release()
  await first
})

test('community detection is deterministic and drops tiny groups', () => {
  const entities = ['a', 'b', 'c', 'd', 'e'].map(id => ({
    id, channelId: 'x', scopeKind: 'channel' as const, scopeKey: '', productId: '',
    entityType: 'concept' as const, canonicalName: id, canonicalKey: id, aliases: [], summary: '',
    confidence: 1, salience: 0.5, status: 'active' as const, mergedInto: null, locked: false,
    authorKind: 'agent' as const, authorId: '', revision: 1, sourceKind: 'memory',
    memoryId: null, validFrom: null, validTo: null, recordedAt: null, supersededBy: null,
    createdAt: now, updatedAt: now, deletedAt: null,
  }))
  const edges = [
    { id: 'e1', channelId: 'x', scopeKind: 'channel' as const, scopeKey: '', productId: '', srcId: 'a', dstId: 'b', relation: 'affects' as const, relationLabel: '', fact: '', factKey: '', polarity: 'positive' as const, confidence: 0.9, weight: 1, status: 'active' as const, locked: false, authorKind: 'agent' as const, authorId: '', revision: 1, sourceKind: 'memory', validFrom: null, validTo: null, recordedAt: null, expiredAt: null, supersededBy: null, createdAt: now, updatedAt: now, deletedAt: null },
    { id: 'e2', channelId: 'x', scopeKind: 'channel' as const, scopeKey: '', productId: '', srcId: 'b', dstId: 'c', relation: 'affects' as const, relationLabel: '', fact: '', factKey: '', polarity: 'positive' as const, confidence: 0.9, weight: 1, status: 'active' as const, locked: false, authorKind: 'agent' as const, authorId: '', revision: 1, sourceKind: 'memory', validFrom: null, validTo: null, recordedAt: null, expiredAt: null, supersededBy: null, createdAt: now, updatedAt: now, deletedAt: null },
    { id: 'e3', channelId: 'x', scopeKind: 'channel' as const, scopeKey: '', productId: '', srcId: 'c', dstId: 'a', relation: 'affects' as const, relationLabel: '', fact: '', factKey: '', polarity: 'positive' as const, confidence: 0.9, weight: 1, status: 'active' as const, locked: false, authorKind: 'agent' as const, authorId: '', revision: 1, sourceKind: 'memory', validFrom: null, validTo: null, recordedAt: null, expiredAt: null, supersededBy: null, createdAt: now, updatedAt: now, deletedAt: null },
  ]
  const first = detectCommunities(entities, edges, { minSize: 3 })
  const second = detectCommunities(entities, edges, { minSize: 3 })
  assert.equal(first.length, 1)
  assert.deepEqual(first[0]!.memberIds.sort(), ['a', 'b', 'c'])
  assert.equal(first[0]!.id, second[0]!.id)
  assert.ok(!first[0]!.memberIds.includes('d'), '孤立节点不成社区')
})

test('line partition keeps line ontology after the channel binds a product', async () => {
  db.prepare(`INSERT INTO channel_product_bindings(channel_id, product_id, revision) VALUES ('c1', 'P-ACCEPT-01', 1)`).run()
  const line = await runMemoryGraphConsolidation(db, 'c1', {
    force: true, useLlm: false, partition: { scopeKind: 'line', scopeKey: 'L1' },
  })
  assert.equal(line.status, 'ok', line.error)
  const lineEntities = graph.listEntities('c1', { limit: 200, scopeKinds: ['line'], scopeKeys: ['L1'] })
  assert.ok(lineEntities.some(e => e.sourceKind === 'ontology'), '绑定产品后 line 分区仍应导入产线级本体')
  assert.ok(lineEntities.every(e => e.productId !== 'P-ACCEPT-01'), '产品本体不得混入 line 分区')
  const product = await runMemoryGraphConsolidation(db, 'c1', {
    force: true, useLlm: false, partition: { scopeKind: 'product', scopeKey: 'P-ACCEPT-01' },
  })
  assert.equal(product.status, 'ok', product.error)
  const productEntities = graph.listEntities('c1', { limit: 200, scopeKinds: ['product'], scopeKeys: ['P-ACCEPT-01'] })
  assert.ok(productEntities.some(e => e.sourceKind === 'claim'), 'product 分区仍应导入产品 claim')
})
