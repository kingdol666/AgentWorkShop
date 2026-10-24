/**
 * 编译器:四类产物 + Rule Trace + 只收紧 + fail-closed。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseDraftDoc, RULE_ERROR_CODES } = await import('../server/services/workshop/ontology/contracts')
const { compileOntology, ontologyPackHash } = await import('../server/services/workshop/ontology/compiler')
const { buildDoc, docWithRule } = await import('./ontology-fixture')

const OPTS = { ontologyId: 'ont-pva', version: 1, scope: { lineId: 'ln-pva-01', recipeId: 'rc-A' }, createdAt: '2026-10-24T00:00:00.000Z' }

function compile(overrides: Record<string, unknown> = {}) {
  return compileOntology(parseDraftDoc(buildDoc()), { ...OPTS, ...overrides })
}

test('编译产物:bound→problem_ir / rate→problem_ir / state_condition→guard / interlock+informal→explained / coupling→rejected', () => {
  const result = compile()
  assert.equal(result.status, 'warning')
  // 硬界与步限落 mv/cv
  assert.deepEqual(result.artifacts.problemIr.cvBounds['cv.thickness'], { min: 48, max: 52 })
  assert.deepEqual(result.artifacts.problemIr.mvBounds['pv.melt_pressure'], { maxStep: 3 })
  // 守卫:温区未稳禁提速
  assert.equal(result.artifacts.controlGuard.guards.length, 1)
  const guard = result.artifacts.controlGuard.guards[0]!
  assert.equal(guard.ruleId, 'R-GUARD')
  assert.equal(guard.when.variableKey, 'st.thermal_ready')
  assert.equal(guard.onViolate, 'block_recommendation')
  // 决策分布
  assert.equal(result.compiledCount, 2)
  assert.equal(result.guardCount, 1)
  assert.equal(result.explainedCount, 2) // interlock + informal
  assert.equal(result.rejectedCount, 1) // linear_coupling
  const coupling = result.issues.find(i => i.ruleId === 'R-COUPLING')!
  assert.equal(coupling.code, RULE_ERROR_CODES.UNSUPPORTED_FORM)
  const interlock = result.traces.find(t => t.ruleId === 'R-INTERLOCK')!
  assert.equal(interlock.decision, 'explained')
  assert.equal(interlock.decisionCode, RULE_ERROR_CODES.PLC_LAYER)
})

test('每条规则必留一条 trace(fail-closed:禁止静默丢弃)', () => {
  const result = compile()
  const doc = buildDoc()
  assert.equal(result.traces.length, doc.rules.length)
  for (const rule of doc.rules) {
    assert.ok(result.traces.some(t => t.ruleId === rule.id), `规则 ${rule.id} 没有 trace`)
  }
  // trace 的 rowHash 非空且互不相同
  const hashes = new Set(result.traces.map(t => t.rowHash))
  assert.equal(hashes.size, result.traces.length)
  assert.ok(result.traces.every(t => t.rowHash.length === 64))
})

test('只收紧:放宽现行下界/上界/步限 → TIGHTEN_ONLY_VIOLATED', () => {
  // 现行下界 49 > 建议 48 → 放宽
  const looserMin = compile({ currentBounds: { cv: { 'cv.thickness': { min: 49, max: 52 } } } })
  assert.ok(looserMin.traces.find(t => t.ruleId === 'R-BOUND')!.decisionCode === RULE_ERROR_CODES.TIGHTEN_ONLY)

  const looserMax = compile({ currentBounds: { cv: { 'cv.thickness': { min: 48, max: 50 } } } })
  assert.equal(looserMax.traces.find(t => t.ruleId === 'R-BOUND')!.decision, 'rejected')

  const looserRate = compile({ currentBounds: { mv: { 'pv.melt_pressure': { maxStep: 1 } } } })
  assert.equal(looserRate.traces.find(t => t.ruleId === 'R-RATE')!.decisionCode, RULE_ERROR_CODES.TIGHTEN_ONLY)

  // 收紧(更严格)通过
  const tighter = compile({ currentBounds: { cv: { 'cv.thickness': { min: 40, max: 60 } }, mv: { 'pv.melt_pressure': { maxStep: 10 } } } })
  assert.equal(tighter.traces.find(t => t.ruleId === 'R-BOUND')!.decision, 'compiled')
  assert.equal(tighter.traces.find(t => t.ruleId === 'R-RATE')!.decision, 'compiled')
})

test('硬约束缺 validated_control 证据 → 结构校验直接拒绝(EVIDENCE_INSUFFICIENT)', () => {
  const doc = buildDoc()
  doc.rules[0]!.evidence = [{ id: 'e', level: 'candidate_influence', source: { type: 'expert_note', author: 'a', noteId: 'n' }, sourceRefHash: '', createdAt: '2026-10-24T00:00:00.000Z' }]
  const result = compileOntology(parseDraftDoc(doc), OPTS)
  assert.equal(result.status, 'rejected')
  assert.ok(result.issues.some(i => i.code === RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT && i.severity === 'error'))
})

test('approvedOnly(发布路径):未获批的硬约束 → ONTOLOGY_NOT_APPROVED;守卫降为 annotate', () => {
  const doc = buildDoc()
  doc.rules = doc.rules.map(r => ({ ...r, status: r.status === 'approved_for_control' ? 'reviewed' as const : r.status }))
  const result = compileOntology(parseDraftDoc(doc), { ...OPTS, approvedOnly: true })
  // 守卫仍产出(非阻断),但硬界/步限被拒 → 发布层据 NOT_APPROVED 拒绝
  assert.ok(result.issues.some(i => i.code === RULE_ERROR_CODES.NOT_APPROVED))
  assert.equal(result.artifacts.problemIr.cvBounds['cv.thickness'], undefined)
  assert.equal(result.artifacts.problemIr.mvBounds['pv.melt_pressure'], undefined)
  const guard = result.artifacts.controlGuard.guards.find(g => g.ruleId === 'R-GUARD')!
  assert.equal(guard.onViolate, 'annotate')
})

test('软约束不进数值域,只进 softRegularization(经验关系不得硬约束)', () => {
  const doc = docWithRule(0)
  doc.rules[0]!.constraintLevel = 'soft'
  const result = compileOntology(parseDraftDoc(doc), OPTS)
  assert.equal(result.artifacts.problemIr.cvBounds['cv.thickness'], undefined)
  assert.equal(result.artifacts.problemIr.softRegularization.length, 1)
  assert.equal(result.traces[0]!.decision, 'explained')
})

test('关系派生训练先验:特征候选 / 时滞(relation_lag + τ=D/v) / 单调性', () => {
  const result = compile()
  const pm = result.artifacts.processModel
  // 两条 influences 都指向 target → 两个特征候选
  assert.equal(pm.featureCandidates.length, 2)
  const pressure = pm.featureCandidates.find(f => f.entityKey === 'pv.melt_pressure')!
  assert.equal(pressure.evidenceLevel, 'validated_control')
  assert.equal(pressure.priorDelayMs, 45000)
  // 时滞:显式 lagMs 一条 + τ=D/v 一条(10m / 0.5m/s = 20s)
  const lag = pm.delayPriors.find(d => d.entityKey === 'pv.melt_pressure')!
  assert.equal(lag.delayMs, 45000)
  assert.equal(lag.basis, 'relation_lag')
  const tau = pm.delayPriors.find(d => d.entityKey === 'st.line_speed')!
  assert.equal(tau.delayMs, 20000)
  assert.equal(tau.basis, 'tau_eq_D_over_v')
  assert.equal(tau.variabilityChecked, false)
  // 单调性
  assert.equal(pm.monotonicity.length, 1)
  assert.deepEqual(pm.monotonicity[0], { output: 'cv.thickness', input: 'pv.melt_pressure', direction: 'decreasing' })
})

test('场景补丁:变量/约束/推断关系齐备', () => {
  const result = compile()
  const scene = result.artifacts.sceneContract
  assert.ok(scene.variables.some(v => v.id === 'cv.thickness' && v.min === 48 && v.max === 52))
  assert.ok(scene.constraints.some(c => c.kind === 'rate' && c.max === 3))
  assert.equal(scene.inferredRelations.length, 2)
})

test('确定性:同一文档重复编译产出相同 hash 与 trace', () => {
  const a = compile()
  const b = compile()
  assert.equal(a.rulePackHash, b.rulePackHash)
  assert.equal(a.contentHash, b.contentHash)
  assert.deepEqual(a.artifacts, b.artifacts)
})

test('结构非法文档 → status rejected 且不产产物', () => {
  const doc = buildDoc()
  doc.relations[0]!.dstKey = 'ghost'
  const result = compileOntology(parseDraftDoc(doc), OPTS)
  assert.equal(result.status, 'rejected')
  assert.deepEqual(result.artifacts.problemIr.cvBounds, {})
  assert.equal(result.traces.length, 0)
})

test('packHash 由 rulePackHash+contentHash 决定(Profile 漂移比对口径)', () => {
  const a = compile()
  const packA = ontologyPackHash({ rulePackHash: a.rulePackHash, contentHash: a.contentHash })
  const b = compile()
  assert.equal(packA, ontologyPackHash({ rulePackHash: b.rulePackHash, contentHash: b.contentHash }))
  const doc = buildDoc()
  doc.rules[0]!.dsl = { type: 'bound', variableKey: 'cv.thickness', min: 49, max: 52 }
  const c = compileOntology(parseDraftDoc(doc), OPTS)
  assert.notEqual(packA, ontologyPackHash({ rulePackHash: c.rulePackHash, contentHash: c.contentHash }))
})

test('非线性阈值形态编译为守卫;复杂表达式拒绝', () => {
  const doc = buildDoc()
  doc.rules = [{
    id: 'R-NL', key: 'nl', kind: 'nonlinear',
    dsl: { type: 'nonlinear', variableKey: 'cv.thickness', expression: 'cv.thickness <= 52' },
    constraintLevel: 'soft', severity: 'warn', status: 'approved_for_control',
    evidence: [{ id: 'e', level: 'observed_correlation', source: { type: 'dataset_stats', datasetId: 'd', sha256: 's' }, sourceRefHash: '', createdAt: '2026-10-24T00:00:00.000Z' }],
    description: '', scope: { lineId: '', recipeId: '', conditionId: '' },
  }]
  const ok = compileOntology(parseDraftDoc(doc), OPTS)
  assert.equal(ok.traces[0]!.decision, 'guard')
  assert.deepEqual(ok.artifacts.controlGuard.guards[0]!.when, { variableKey: 'cv.thickness', op: 'gt', value: 52 })
  assert.equal(ok.artifacts.controlGuard.guards[0]!.forbid.kind, 'nonzero_increment')

  doc.rules[0]!.dsl = { type: 'nonlinear', variableKey: 'cv.thickness', expression: 'a*b/c' }
  const bad = compileOntology(parseDraftDoc(doc), OPTS)
  assert.equal(bad.traces[0]!.decisionCode, RULE_ERROR_CODES.UNSUPPORTED_FORM)
})
