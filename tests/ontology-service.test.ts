/**
 * 服务层:草稿生命周期 / 证据 / 规则状态机 / 第二人批准 / 发布不可变 / 版本比较 / 运行时生效。
 * 每个用例使用独立 ontologyId + 独立产线,互不干扰。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-ontology-service-'))
process.env.AW_ONTOLOGY_SOLO_OPERATOR = '0'

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { resetOntologyRepo, parseDraftRow } = await import('../server/services/workshop/ontology/repo')
const svc = await import('../server/services/workshop/ontology/ontology.service')
const { buildDoc } = await import('./ontology-fixture')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'ontology-service.sqlite'))
configureAmlRuntime(db)
resetOntologyRepo()

const OWNER = { userId: 'u-owner', role: 'editor' as const }
const REVIEWER = { userId: 'u-reviewer', role: 'editor' as const }
const ADMIN = { userId: 'u-admin', role: 'admin' as const }

/** 生命周期文档:一条硬界规则 + 一条不可形式化规则;无绑定(绑定面另有套件) */
function lifecycleDoc(lineId: string) {
  const doc = buildDoc()
  doc.lineId = lineId
  doc.relations = []
  doc.bindings = []
  doc.rules = [
    { ...doc.rules[0]!, status: 'proposed', scope: { lineId, recipeId: 'rc-A', conditionId: '' } },
    { ...doc.rules[4]!, status: 'proposed' },
  ]
  return doc
}

let seq = 0
function makeOntology(prefix: string) {
  seq += 1
  const suffix = `${prefix}${seq}`
  const ontologyId = `ont-${suffix}`
  const lineId = `ln-${suffix}`
  const draft = svc.createDraft(OWNER, { ontologyId, lineId })
  const updated = svc.updateDraft(draft.id, OWNER, { doc: lifecycleDoc(lineId), expectedRev: draft.rev })
  return { ontologyId, lineId, draftId: draft.id, rev: updated.draft.rev }
}

function driveBoundToApproved(draftId: string) {
  svc.transitionRule(draftId, 'R-BOUND', REVIEWER, { to: 'reviewed' })
  svc.transitionRule(draftId, 'R-BOUND', REVIEWER, { to: 'validated' })
  const { approvalId } = svc.requestRuleApproval(draftId, 'R-BOUND', OWNER)
  svc.decideRuleApproval(draftId, approvalId, REVIEWER, { approved: true, comment: '工艺确认' })
  svc.transitionRule(draftId, 'R-BOUND', ADMIN, { to: 'approved_for_control', approvalId })
  return approvalId
}

test('草稿:单活跃 409 / 乐观锁 409 / 非法文档 422 / 跨用户不可改', () => {
  const draft = svc.createDraft(OWNER, { ontologyId: 'ont-draft' })
  assert.equal(draft.rev, 1)
  assert.throws(() => svc.createDraft(OWNER, { ontologyId: 'ont-draft' }), (err: { code?: string }) => err.code === 'DRAFT_ALREADY_ACTIVE')
  assert.throws(() => svc.updateDraft(draft.id, OWNER, { doc: lifecycleDoc('ln-draft'), expectedRev: 99 }),
    (err: { code?: string }) => err.code === 'DRAFT_CONCURRENT_MODIFY')
  assert.throws(() => svc.updateDraft(draft.id, OWNER, { doc: { garbage: true }, expectedRev: 1 }),
    (err: { code?: string }) => err.code === 'ONTOLOGY_INVALID')
  assert.throws(() => svc.updateDraft(draft.id, REVIEWER, { doc: lifecycleDoc('ln-draft'), expectedRev: 1 }),
    (err: { code?: string }) => err.code === 'DRAFT_SCOPE_VIOLATION')
  const updated = svc.updateDraft(draft.id, OWNER, { doc: lifecycleDoc('ln-draft'), expectedRev: 1 })
  assert.equal(updated.draft.rev, 2)
  assert.equal(updated.validation.ok, true)
})

test('规则状态机:跳级 409 / 自审 403 / 缺证据 422 / 第二人批准后才可 control 级', () => {
  const { draftId } = makeOntology('lc')
  // 跳级 proposed → validated
  assert.throws(() => svc.transitionRule(draftId, 'R-BOUND', OWNER, { to: 'validated' }),
    (err: { code?: string }) => err.code === 'RULE_LIFECYCLE_CONFLICT')
  // 自审禁止(属主自己审查)
  assert.throws(() => svc.transitionRule(draftId, 'R-BOUND', OWNER, { to: 'reviewed' }),
    (err: { code?: string }) => err.code === 'SELF_REVIEW_FORBIDDEN')
  // 第二人审查通过
  const reviewed = svc.transitionRule(draftId, 'R-BOUND', REVIEWER, { to: 'reviewed' })
  assert.equal(reviewed.doc.rules.find(r => r.id === 'R-BOUND')!.status, 'reviewed')
  // 无证据规则不得晋级 validated
  svc.transitionRule(draftId, 'R-INFORMAL', REVIEWER, { to: 'reviewed' })
  assert.throws(() => svc.transitionRule(draftId, 'R-INFORMAL', REVIEWER, { to: 'validated' }),
    (err: { code?: string }) => err.code === 'ONTOLOGY_EVIDENCE_INSUFFICIENT')
  // 有 validated_control 证据 → validated
  const validated = svc.transitionRule(draftId, 'R-BOUND', REVIEWER, { to: 'validated' })
  assert.equal(validated.doc.rules.find(r => r.id === 'R-BOUND')!.status, 'validated')
  // 无批准单 → 403
  assert.throws(() => svc.transitionRule(draftId, 'R-BOUND', ADMIN, { to: 'approved_for_control' }),
    (err: { code?: string }) => err.code === 'APPROVAL_REQUIRED')
  // 申请 → 属主不得自我裁决 → 他人批准 → 迁移成功
  const { approvalId } = svc.requestRuleApproval(draftId, 'R-BOUND', OWNER)
  assert.throws(() => svc.decideRuleApproval(draftId, approvalId, OWNER, { approved: true }),
    (err: { code?: string }) => err.code === 'SELF_REVIEW_FORBIDDEN')
  svc.decideRuleApproval(draftId, approvalId, REVIEWER, { approved: true })
  assert.throws(() => svc.decideRuleApproval(draftId, approvalId, REVIEWER, { approved: true }),
    (err: { code?: string }) => err.code === 'APPROVAL_ALREADY_DECIDED')
  const approved = svc.transitionRule(draftId, 'R-BOUND', ADMIN, { to: 'approved_for_control', approvalId })
  assert.equal(approved.doc.rules.find(r => r.id === 'R-BOUND')!.status, 'approved_for_control')
  // 拒绝的批准单不能用来批准
  const { draftId: d2 } = makeOntology('lc-rej')
  svc.transitionRule(d2, 'R-BOUND', REVIEWER, { to: 'reviewed' })
  svc.transitionRule(d2, 'R-BOUND', REVIEWER, { to: 'validated' })
  const rejected = svc.requestRuleApproval(d2, 'R-BOUND', OWNER)
  svc.decideRuleApproval(d2, rejected.approvalId, REVIEWER, { approved: false, comment: '证据不足' })
  assert.throws(() => svc.transitionRule(d2, 'R-BOUND', ADMIN, { to: 'approved_for_control', approvalId: rejected.approvalId }),
    (err: { code?: string }) => err.code === 'APPROVAL_NOT_GRANTED')
})

test('证据登记:落账本 + 写回草稿;非法目标 404', () => {
  const { draftId, ontologyId } = makeOntology('ev')
  const detail = svc.appendEvidence(draftId, OWNER, {
    targetKind: 'rule', targetKey: 'R-BOUND', level: 'observed_correlation',
    source: { type: 'dataset_stats', datasetId: 'ds-e2e', sha256: 'sha' }, sourceRef: 'ds-e2e',
  })
  const rule = detail.doc.rules.find(r => r.id === 'R-BOUND')!
  assert.equal(rule.evidence.length, 2)
  assert.equal(svc.listEvidence(ontologyId, { targetKind: 'rule', targetKey: 'R-BOUND' }).length, 1)
  assert.throws(() => svc.appendEvidence(draftId, OWNER, {
    targetKind: 'rule', targetKey: 'R-NOPE', level: 'candidate_influence', source: { type: 'manual', author: 'x' },
  }), (err: { code?: string }) => err.code === 'RULE_NOT_FOUND')
})

test('发布:仅 admin;快照不可变;运行时可按产线解析', () => {
  const { ontologyId, lineId, draftId } = makeOntology('pub')
  driveBoundToApproved(draftId)
  // editor 不能发布
  assert.throws(() => svc.publishDraft(draftId, OWNER), (err: { code?: string }) => err.code === 'ADMIN_REQUIRED')

  const published = svc.publishDraft(draftId, ADMIN)
  assert.equal(published.version.status, 'published')
  assert.equal(published.version.version, 1)
  assert.equal(published.version.contentHash.length, 64)
  assert.equal(published.packHash.length, 64)
  assert.deepEqual(published.compile.artifacts.problemIr.cvBounds['cv.thickness'], { min: 48, max: 52 })
  // 溯源行 = 规则数
  const doc = parseDraftRow(svc.getDraft(draftId))
  const traces = db.prepare('SELECT COUNT(*) AS n FROM ontology_rule_traces WHERE ontology_id = ? AND version = 1').get(ontologyId) as { n: number }
  assert.equal(traces.n, doc.rules.length)

  // 运行时解析
  const active = svc.resolveActiveOntology(lineId)!
  assert.equal(active.version.version, 1)
  assert.equal(active.packHash, published.packHash)
  assert.deepEqual(active.artifacts.problemIr.cvBounds['cv.thickness'], { min: 48, max: 52 })
  assert.equal(svc.resolveActiveOntology('ln-none'), null)
  // 无守卫 → 放行
  assert.equal(svc.evaluateOntologyGuards(lineId, { values: {}, deltas: { 'st.line_speed': 1 } }).blocked, false)

  // 版本不可变:同 (id,version) 不能再次插入
  assert.throws(() => db.prepare(`INSERT INTO ontology_versions (id, version, name, line_id, content_hash, compiled_json, changelog_json, status, created_at, updated_at)
    VALUES (?, 1, 'x', '', 'other', '{}', '{}', 'published', 'now', 'now')`).run(ontologyId))
})

test('未获批规则拒绝发布(ONTOLOGY_NOT_APPROVED)', () => {
  const { draftId } = makeOntology('unappr')
  svc.transitionRule(draftId, 'R-BOUND', REVIEWER, { to: 'reviewed' })
  svc.transitionRule(draftId, 'R-BOUND', REVIEWER, { to: 'validated' })
  assert.throws(() => svc.publishDraft(draftId, ADMIN),
    (err: { code?: string }) => err.code === 'ONTOLOGY_NOT_APPROVED')
})

test('版本 diff:改界 → rules.changed;退役后不可被 Profile 引用', () => {
  const { ontologyId, lineId, draftId } = makeOntology('diff')
  driveBoundToApproved(draftId)
  const v1 = svc.publishDraft(draftId, ADMIN)
  assert.equal(v1.version.version, 1)

  const doc = parseDraftRow(svc.getDraft(draftId))
  doc.rules = doc.rules.map(r => r.id === 'R-BOUND'
    ? { ...r, dsl: { type: 'bound' as const, variableKey: 'cv.thickness', min: 49, max: 52, unit: 'mm' } }
    : r)
  const current = svc.getDraft(draftId)
  svc.updateDraft(draftId, OWNER, { doc, expectedRev: current.rev })
  const v2 = svc.publishDraft(draftId, ADMIN)
  assert.equal(v2.version.version, 2)
  assert.equal(v2.version.parentVersion, 1)

  const diff = svc.compareVersions(ontologyId, 1, 2)
  assert.deepEqual(diff.rules.changed, ['R-BOUND'])
  assert.deepEqual(diff.rules.added, [])
  assert.deepEqual(diff.entities.added, [])

  // 漂移校验
  svc.assertOntologyUnchanged([{ ontologyId, ontologyVersion: 2, contentHash: v2.version.contentHash }])
  assert.throws(() => svc.assertOntologyUnchanged([{ ontologyId, ontologyVersion: 2, contentHash: 'deadbeef' }]),
    (err: { code?: string }) => err.code === 'ONTOLOGY_PACK_DRIFTED')
  // 退役 → 引用即漂移
  svc.retireVersion(ontologyId, 2, ADMIN)
  assert.throws(() => svc.assertOntologyUnchanged([{ ontologyId, ontologyVersion: 2 }]),
    (err: { code?: string }) => err.code === 'ONTOLOGY_PACK_DRIFTED')
  assert.throws(() => svc.retireVersion(ontologyId, 2, ADMIN), (err: { code?: string }) => err.code === 'VERSION_NOT_PUBLISHED')
  // 退役不影响 v1 的运行时解析
  assert.equal(svc.resolveActiveOntology(lineId)!.version.version, 1)
})

test('发布日志留痕:create/update/transition/approve/publish/retire 均有行', () => {
  const { ontologyId, draftId } = makeOntology('log')
  driveBoundToApproved(draftId)
  svc.publishDraft(draftId, ADMIN)
  svc.retireVersion(ontologyId, 1, ADMIN)
  const actions = (db.prepare('SELECT action FROM ontology_publish_log WHERE ontology_id = ?').all(ontologyId) as Array<{ action: string }>).map(r => r.action)
  for (const expected of ['draft.create', 'draft.update', 'rule.transition', 'rule.approve_request', 'rule.approve', 'publish', 'retire']) {
    assert.ok(actions.includes(expected), `缺少审计动作 ${expected};实际:${[...new Set(actions)].join(',')}`)
  }
})

test('场景子图与 AML 派生:只读已发布版本', () => {
  const { lineId, draftId } = makeOntology('graph')
  driveBoundToApproved(draftId)
  svc.publishDraft(draftId, ADMIN)
  const graph = svc.sceneSubgraph(lineId)!
  assert.equal(graph.version, 1)
  assert.ok(graph.entities.some(e => e.key === 'cv.thickness'))
  assert.ok(graph.rules.some(r => r.id === 'R-BOUND' && r.status === 'approved_for_control'))
  const priors = svc.deriveTrainingPriors(lineId)!
  assert.ok(Array.isArray(priors.featureCandidates))
  assert.equal(svc.sceneSubgraph('ln-none'), null)
  assert.equal(svc.deriveTrainingPriors('ln-none'), null)
})
