/**
 * 本体九表建出 + 草稿/版本仓储不变量。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-ontology-schema-'))
process.env.AW_ONTOLOGY_SOLO_OPERATOR = '0'

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createOntologyRepo, resetOntologyRepo } = await import('../server/services/workshop/ontology/repo')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'ontology-schema.sqlite'))
configureAmlRuntime(db)
resetOntologyRepo()

const TABLES = [
  'ontology_versions', 'ontology_entities', 'ontology_relations', 'ontology_rules', 'ontology_evidence',
  'ontology_drafts', 'ontology_semantic_bindings', 'ontology_publish_log', 'ontology_rule_traces',
]

test('九张 ontology 表全部由 schema.ts 建出(启动即存在)', () => {
  const names = new Set((db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all() as Array<{ name: string }>).map(r => r.name))
  for (const table of TABLES) assert.ok(names.has(table), `缺表 ${table}`)
})

test('publish_log 预留 actor_kind 与 solo_operator(设计期一次到位)', () => {
  const cols = (db.prepare('PRAGMA table_info(ontology_publish_log)').all() as Array<{ name: string }>).map(c => c.name)
  assert.ok(cols.includes('actor_kind'))
  assert.ok(cols.includes('solo_operator'))
  assert.ok(cols.includes('approval_id'))
})

test('草稿单活跃 + 乐观锁 + 删除', () => {
  const repo = createOntologyRepo(db)
  const doc = JSON.stringify({ schemaVersion: 1, name: 'n', lineId: '', entities: [], relations: [], rules: [], bindings: [], note: '' })
  const row = repo.insertDraft({ id: 'd1', ontologyId: 'ont-a', baseVersion: null, draftJson: doc, ownerUserId: 'u1' })
  assert.equal(row.rev, 1)
  assert.throws(() => repo.insertDraft({ id: 'd2', ontologyId: 'ont-a', baseVersion: null, draftJson: doc, ownerUserId: 'u1' }),
    (err: { code?: string }) => err.code === 'DRAFT_ALREADY_ACTIVE')
  // 不同 owner 可各自起草
  assert.ok(repo.insertDraft({ id: 'd3', ontologyId: 'ont-a', baseVersion: null, draftJson: doc, ownerUserId: 'u2' }))
  // 乐观锁
  const updated = repo.updateDraft('d1', doc, 1)
  assert.equal(updated.rev, 2)
  assert.throws(() => repo.updateDraft('d1', doc, 1), (err: { code?: string }) => err.code === 'DRAFT_CONCURRENT_MODIFY')
  assert.equal(repo.deleteDraft('d1'), true)
  assert.equal(repo.getDraft('d1'), undefined)
})

test('版本号单调递增;实体/规则/绑定快照可读回', () => {
  const repo = createOntologyRepo(db)
  assert.equal(repo.nextVersionNumber('ont-snap'), 1)
  const version = repo.publishSnapshot({
    version: {
      id: 'ont-snap', version: 1, name: 'snap', lineId: 'ln-1', parentVersion: null,
      contentHash: 'ch1', compiledJson: '{"artifacts":{}}', changelogJson: '{}',
      status: 'published', ownerUserId: 'u1', publishedBy: 'u1', createdAt: '', updatedAt: '',
    },
    entities: [{ key: 'pv.temp', kind: 'process_variable', name: '温度', description: '', unit: '℃', dimension: 'temperature', role: 'guard', attrs: {} }],
    relations: [{
      id: 'r1', kind: 'influences', srcKey: 'pv.temp', dstKey: 'pv.temp', status: 'reviewed',
      evidence: [], properties: { evidenceTier: 'candidate_influence', variabilityChecked: false },
    }],
    rules: [{
      id: 'R1', key: 'r1', kind: 'bound', dsl: { type: 'bound', variableKey: 'pv.temp', min: 0, max: 250 },
      constraintLevel: 'soft', severity: 'error', status: 'proposed',
      evidence: [], description: '', scope: { lineId: 'ln-1', recipeId: '', conditionId: '' },
    }],
    bindings: [{
      id: 'b1', entityKey: 'pv.temp', platformKind: 'daq_node', platformId: 'n1', targetSub: '',
      scope: 'line:ln-1', direction: 'read', unitDeclared: '℃', unitTarget: '℃', scale: 1, offset: 0,
    }],
    traces: [],
    guards: [],
    createdBy: 'u1',
  })
  assert.equal(version.version, 1)
  assert.equal(repo.nextVersionNumber('ont-snap'), 2)
  const entities = repo.listEntities('ont-snap', 1)
  assert.equal(entities[0]!.key, 'pv.temp')
  assert.equal(entities[0]!.unit, '℃')
  const rules = repo.listRules('ont-snap', 1)
  assert.equal(rules[0]!.id, 'R1')
  assert.deepEqual((rules[0]!.dsl as { max: number }).max, 250)
  const bindings = repo.listBindings('ont-snap', 1)
  assert.equal(bindings.length, 1)
  assert.equal(bindings[0]!.direction, 'read')
  // 同 (id,version) 二次插入必须失败(不可变)
  assert.throws(() => repo.publishSnapshot({
    version: {
      id: 'ont-snap', version: 1, name: 'snap2', lineId: '', parentVersion: null,
      contentHash: 'ch2', compiledJson: '{}', changelogJson: '{}',
      status: 'published', ownerUserId: 'u1', publishedBy: 'u1', createdAt: '', updatedAt: '',
    },
    entities: [], relations: [], rules: [], bindings: [], traces: [], guards: [], createdBy: 'u1',
  }))
})

test('状态原子转移:条件不满足返回 false(由服务层转 409)', () => {
  const repo = createOntologyRepo(db)
  assert.equal(repo.transitionVersion('ont-snap', 1, 'retired', 'published'), true)
  assert.equal(repo.transitionVersion('ont-snap', 1, 'retired', 'published'), false)
  assert.equal(repo.getVersion('ont-snap', 1)!.status, 'retired')
})

test('证据/发布日志追加行可读回(append-only)', () => {
  const repo = createOntologyRepo(db)
  repo.appendEvidence({
    id: 'ev1', ontologyId: 'ont-ev', targetKind: 'rule', targetKey: 'R1', level: 'observed_correlation',
    sourceType: 'dataset_stats', sourceRef: 'ds-1', sourceRefHash: 'h', detailJson: '{}',
    createdBy: 'u1', createdAt: new Date().toISOString(),
  })
  const evidence = repo.listEvidence('ont-ev', { targetKind: 'rule' })
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0]!.level, 'observed_correlation')

  repo.appendPublishLog({
    id: 'pl1', ontologyId: 'ont-ev', version: 1, action: 'publish', actor: 'u1',
    actorKind: 'user', soloOperator: 0, approvalId: null, detailJson: '{}', createdAt: new Date().toISOString(),
  })
  assert.equal(repo.listPublishLog('ont-ev').length, 1)
})
