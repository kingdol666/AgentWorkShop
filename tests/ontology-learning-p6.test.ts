/**
 * P6 本体证据回灌 + 因果断言防污染单测(科学探索计划):
 *  - A6-1 一次带 verdict 的干预 → ontology_evidence 自动追加(support/refute 计数正确),重复回灌幂等
 *  - A6-2 无证据锚的因果断言被标 anecdotal;带 intervention:/ontology: 引用则不标
 *  - A6-3 通道 B 三值:有边→true;已发布本体无边→false(可证伪的一等事实);无本体→null
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-p6-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const ledger = await import('../server/services/workshop/aml/intervention-ledger')
const learning = await import('../server/services/workshop/aml/ontology-learning')
const { assessCausalClaim, causalClaimLines } = await import('../server/services/workshop/aml/causal-claim')
const { getOntologyRepo } = await import('../server/services/workshop/ontology/repo')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'p6.sqlite'))
configureAmlRuntime(db)

/** 直接插一条已发布本体版本(测试夹具;发布链本身由既有 ontology 套件覆盖) */
function seedPublishedOntology(ontologyId: string, lineId: string, version = 1): { versionId: string, version: number } {
  void getOntologyRepo
  const now = new Date().toISOString()
  // 约定:version_id 列 = 本体 id 本身(repo.insertContent 用 input.version.id)
  db.prepare(`INSERT INTO ontology_versions (id, version, name, line_id, parent_version, content_hash, compiled_json, changelog_json, status, owner_user_id, published_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, '', '{}', '{}', 'published', 'u1', 'u1', ?, ?)`)
    .run(ontologyId, version, ontologyId, lineId, now, now)
  return { versionId: ontologyId, version }
}

function addRelation(versionId: string, version: number, id: string, src: string, dst: string, predicate = 'influences'): void {
  db.prepare(`INSERT INTO ontology_relations (id, version_id, version, src_key, dst_key, predicate, properties_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 'active', ?)`).run(id, versionId, version, src, dst, predicate, new Date().toISOString())
}

describe('A6-1 干预判定回灌 ontology_evidence', () => {
  it('有已发布本体 → 追加证据;负结论计 refute,正结论计 support;重复回灌幂等', () => {
    const lineId = 'ln-p6-a'
    seedPublishedOntology('ont-p6a', lineId)
    const id = ledger.recordIntervention({
      nodeId: 'dw-sp-a', nodeName: '吹压SP', lineId, fromValue: 2.6, toValue: 2.4, actualValue: 2.4,
      ack: 'readback-verified', path: 'agent', actor: 'ag', targetNodeId: 'daq-th', settleMs: 1000,
    })!
    ledger.attachAssessment(id, { verdict: 'no_resolvable_effect', effect: 0.0004, ciLow: -0.001, ciHigh: 0.002, mde: 0.003, targetNodeId: 'daq-th' })
    const ev = ledger.latestIntervention('dw-sp-a')!
    const r1 = learning.backfillInterventionEvidence(ev)
    assert.equal(r1.appended, true, r1.reason)
    assert.equal(r1.ontologyId, 'ont-p6a')
    // 幂等
    const r2 = learning.backfillInterventionEvidence(ev)
    assert.equal(r2.appended, false)
    assert.match(r2.reason, /幂等/)
    const res = learning.resolveCouplingFromOntology(lineId, 'dw-sp-a', 'daq-th')
    assert.equal(res.hasCouplingPath, false, '已发布本体无边 = 明确无路径')
    assert.equal(res.refuteCount, 1)
    assert.equal(res.supportCount, 0)
    assert.equal(res.version, 1)
  })

  it('无已发布本体 → 不登记(如实说明暂留台账),不抛错', () => {
    const id = ledger.recordIntervention({
      nodeId: 'dw-sp-b', lineId: 'ln-p6-none', fromValue: 1, toValue: 2, actualValue: 2,
      path: 'agent', actor: 'ag', targetNodeId: 'daq-th', settleMs: 1000,
    })!
    ledger.attachAssessment(id, { verdict: 'identifiable_effect', effect: 0.03, ciLow: 0.02, ciHigh: 0.04, mde: 0.003, targetNodeId: 'daq-th' })
    const ev = ledger.latestIntervention('dw-sp-b')!
    const r = learning.backfillInterventionEvidence(ev)
    assert.equal(r.appended, false)
    assert.match(r.reason, /无已发布本体/)
  })

  it('pending/unassessed 不登记(未收口不是证据)', () => {
    ledger.recordIntervention({ nodeId: 'dw-sp-c', lineId: 'ln-p6-a', fromValue: 1, toValue: 2, actualValue: null, path: 'manual', actor: 'u' })
    const ev = ledger.latestIntervention('dw-sp-c')!
    assert.equal(learning.backfillInterventionEvidence(ev).appended, false)
  })
})

describe('A6-3 通道 B 耦合三值解析', () => {
  it('有 influences 边 → true 且带证据摘要', () => {
    const lineId = 'ln-p6-edge'
    seedPublishedOntology('ont-p6edge', lineId)
    addRelation('ont-p6edge', 1, 'rel-1', 'dw-sp-e', 'daq-th-e')
    const res = learning.resolveCouplingFromOntology(lineId, 'dw-sp-e', 'daq-th-e')
    assert.equal(res.hasCouplingPath, true)
    assert.equal(res.evidence.length >= 1, true)
    assert.match(res.evidence[0] ?? '', /influences/)
  })

  it('无已发布本体 → null(unknown 不拦)', () => {
    const res = learning.resolveCouplingFromOntology('ln-not-exist', 'a', 'b')
    assert.equal(res.hasCouplingPath, null)
    assert.deepEqual(res.evidence, [])
  })

  it('语义绑定 entity_key 可命中(节点 id 与本体 key 不同名)', () => {
    const lineId = 'ln-p6-bind'
    seedPublishedOntology('ont-p6bind', lineId)
    addRelation('ont-p6bind', 1, 'rel-b', 'entity-blow-pressure', 'entity-thickness')
    db.prepare(`INSERT INTO ontology_semantic_bindings (id, version_id, version, entity_key, platform_kind, platform_id, target_sub, scope, direction, unit_declared, unit_target, scale, offset, status, last_verified_at, created_at)
      VALUES ('b1','ont-p6bind',1,'entity-blow-pressure','dcw','dw-sp-bind','','line','in','bar','bar',1,0,'active',?,?)`).run(new Date().toISOString(), new Date().toISOString())
    db.prepare(`INSERT INTO ontology_semantic_bindings (id, version_id, version, entity_key, platform_kind, platform_id, target_sub, scope, direction, unit_declared, unit_target, scale, offset, status, last_verified_at, created_at)
      VALUES ('b2','ont-p6bind',1,'entity-thickness','daq','daq-th-bind','','line','in','mm','mm',1,0,'active',?,?)`).run(new Date().toISOString(), new Date().toISOString())
    const res = learning.resolveCouplingFromOntology(lineId, 'dw-sp-bind', 'daq-th-bind')
    assert.equal(res.hasCouplingPath, true, JSON.stringify(res))
  })
})

describe('A6-2 因果断言防污染(anecdotal 标注)', () => {
  it('无证据锚的因果断言 → anecdotal', () => {
    const a = assessCausalClaim('壁厚变厚主要由瓶坯温度和熔体温度驱动,吹压影响很小。')
    assert.equal(a.isCausal, true)
    assert.equal(a.hasEvidenceRef, false)
    assert.equal(a.anecdotal, true)
    assert.match(causalClaimLines(a).join('\n'), /anecdotal|无证据锚/)
  })

  it('带干预/本体引用 → 不算 anecdotal', () => {
    const a = assessCausalClaim('实测:吹压下调 0.2bar 后壁厚无显著变化(intv-abc123,95% CI 含 0,MDE=0.003)。')
    assert.equal(a.isCausal, true, `reasons=${a.reasons.join(';')}`)
    assert.equal(a.hasEvidenceRef, true)
    assert.equal(a.anecdotal, false)
  })

  it('非因果叙述不触发(纯流程说明)', () => {
    const a = assessCausalClaim('本班次共开线 3 次,停机 2 次,参数未变更。')
    assert.equal(a.isCausal, false)
    assert.equal(a.anecdotal, false)
    assert.deepEqual(causalClaimLines(a), [])
  })

  it('英文因果断言同样识别', () => {
    const a = assessCausalClaim('Blow pressure drives wall thickness variation across the run.')
    assert.equal(a.isCausal, true)
    assert.equal(a.anecdotal, true)
  })
})
