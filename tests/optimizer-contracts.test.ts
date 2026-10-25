/**
 * G1 契约单测:判别联合拒绝未知类型;ProblemIR hash 稳定;建议分级;A2 资格反例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertArtifactKind, assertModelInterfaceId, matchCondition, solverSupportsArtifact, type ProcessModelSpec } from '../server/services/workshop/process-model/contracts'
import { computeProblemIrHash, recommendationLabel, type ProblemIR } from '../server/services/workshop/optimization/contracts'
import { evaluateEligibility, type EligibilitySeries } from '../server/services/workshop/process-model/eligibility'
import { parseProcessModelSpec } from '../server/services/workshop/process-model/spec'
import { classifyRecommendation } from '../server/services/workshop/optimization/recommendation.service'
import { constraintReport, evaluateCandidateCost } from '../server/services/workshop/optimization/problem-builder'

function specFixture(overrides: Partial<ProcessModelSpec> = {}): ProcessModelSpec {
  return {
    schemaVersion: 2, id: 'pms-test', version: 1,
    lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeVersion: 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: 'rc-1' }] }],
    variables: [
      { id: 'mv1', nodeId: 'n-mv', role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: 5000, min: 0, max: 100, maxStep: 5 },
      { id: 'cv1', nodeId: 'n-cv', role: 'cv', field: 'value', unit: 'μm', scale: 1, offset: 0, min: 0, max: 200 },
    ],
    timing: { beatMs: 5000, historySteps: 24, horizonSteps: 10, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 2, inputOrder: 1, ridgeLambda: 0.001, standardize: true } },
    datasetPolicy: { split: { valRatio: 0.2, testRatio: 0.2, seed: 42 } },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv1: { min: 0, max: 100, maxStep: 5 } }, cv: { cv1: { min: 0, max: 200 } } },
    purpose: 'mpc_surrogate',
    ...overrides,
  }
}

test('未知 artifactKind / modelInterface 一律 UNSUPPORTED_ARTIFACT(不回落 ONNX)', () => {
  assert.throws(() => assertArtifactKind('mystery@9'), (err: { code?: string }) => err.code === 'UNSUPPORTED_ARTIFACT')
  assert.throws(() => assertModelInterfaceId('blackbox'), (err: { code?: string }) => err.code === 'UNSUPPORTED_MODEL_INTERFACE')
  assert.equal(assertArtifactKind('linear_state_space@1'), 'linear_state_space@1')
})

test('ONNX 黑箱不能直接交给 OSQP', () => {
  assert.equal(solverSupportsArtifact('osqp_mpc@1', 'onnx_one_step@1'), false)
  assert.equal(solverSupportsArtifact('osqp_mpc@1', 'linear_state_space@1'), true)
  assert.equal(solverSupportsArtifact('scipy_slsqp@1', 'static_response@1'), true)
})

test('工况 exactly-one:零命中与重叠都拒绝', () => {
  const conditions = [
    { id: 'a', match: [{ field: 'recipeId' as const, op: 'eq' as const, value: 'rc-1' }] },
    { id: 'b', match: [{ field: 'recipeId' as const, op: 'eq' as const, value: 'rc-2' }] },
  ]
  assert.equal(matchCondition(conditions, { lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeVersion: 1 }), 'a')
  assert.throws(() => matchCondition(conditions, { lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-9', recipeVersion: 1 }), (err: { code?: string }) => err.code === 'CONDITION_NO_MATCH')
  assert.throws(() => matchCondition([conditions[0]!, { id: 'c', match: [{ field: 'recipeId', op: 'eq', value: 'rc-1' }] }], { lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeVersion: 1 }), (err: { code?: string }) => err.code === 'CONDITION_OVERLAP')
})

test('spec 校验:MV 缺 delayMs 拒绝;接口与训练器不一致拒绝', () => {
  const missingDelay = specFixture()
  delete (missingDelay.variables[0] as { delayMs?: number }).delayMs
  assert.throws(() => parseProcessModelSpec(missingDelay), (err: { code?: string }) => err.code === 'SPEC_DELAY_MISSING')
  const mismatch = specFixture()
  mismatch.modelInterface = { id: 'static_response', version: 1, inputSemantics: 'setpoint', mode: 'static' }
  assert.throws(() => parseProcessModelSpec(mismatch), (err: { code?: string }) => err.code === 'SPEC_INTERFACE_MISMATCH')
  assert.doesNotThrow(() => parseProcessModelSpec(specFixture()))
})

test('ProblemIR hash 稳定:同问题同 hash,上下文时间不影响身份', () => {
  const base: Omit<ProblemIR, 'hash'> = {
    irVersion: 1, profileRef: 'p@1',
    modelRef: { modelId: 'mdl-1', artifactKind: 'linear_state_space@1', artifactHash: 'h', modelInterface: 'linear_state_space', stage: 'production' },
    solverRef: 'osqp_mpc@1',
    conditions: { conditionId: 'c1', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeVersion: 1 },
    horizon: 10, beatMs: 5000,
    scaling: { mv: { mv1: { scale: 1, offset: 0 } }, cv: { cv1: { scale: 1, offset: 0 } } },
    weights: { cv: { cv1: 1 }, du: { mv1: 0.1 }, terminal: 2 },
    context: { capturedAt: '2026-10-22T00:00:00.000Z', eventAsOf: 1, availabilityWatermark: 2, evidenceSource: 'simulation' },
    problem: {
      template: 'linear_mpc_quadratic@1',
      dynamics: { stateDim: 1, A: [1], B: [1], C: [1], D: [0], delays: { mv1: 1 }, x0: [50] },
      cvSetpoints: [50], cvBounds: [{}], mvOrder: ['mv1'], cvOrder: ['cv1'], mvBounds: [{ min: 0, max: 100 }], uPrev: [50],
    },
  }
  const h1 = computeProblemIrHash(base)
  const h2 = computeProblemIrHash({ ...base, context: { ...base.context, capturedAt: '2026-10-23T00:00:00.000Z' } })
  assert.equal(h1, h2)
  assert.equal(h1.length, 64)
  const h3 = computeProblemIrHash({ ...base, horizon: 20 })
  assert.notEqual(h1, h3)
})

test('建议分级:缺 UQ/OOD → unverified;inputDistance 缺失不得当 0', () => {
  assert.equal(classifyRecommendation({ evidenceSource: 'simulation', uqEvidence: null, candidateFeasible: true }).status, 'unverified')
  assert.equal(classifyRecommendation({ evidenceSource: 'real', uqEvidence: { coverage: 0.95, calibrationFresh: true, inputDistance: null as unknown as number }, candidateFeasible: true }).status, 'unverified')
  assert.equal(classifyRecommendation({ evidenceSource: 'real', uqEvidence: { coverage: 0.95, calibrationFresh: true, inputDistance: 0.1 }, candidateFeasible: true }).status, 'verified')
  assert.equal(recommendationLabel('unverified').includes('未验证'), true)
})

test('A2 反例:恒定 U(即使 Y 波动大)不得获得优化资格', () => {
  const spec = specFixture()
  const n = 80
  const series: EligibilitySeries[] = [
    { variableId: 'mv1', role: 'mv', values: new Array(n).fill(50) },
    { variableId: 'cv1', role: 'cv', values: Array.from({ length: n }, (_, i) => 50 + 8 * Math.sin(i / 3)) },
  ]
  const report = evaluateEligibility({ spec, scope: 'simulation', conditionId: 'c1', series, actionEvidence: 'simulation_commanded' })
  assert.equal(report.optimizationEligible, false)
  assert.ok(report.gaps.some(g => g.code === 'MV_CONSTANT'))
  assert.ok(report.gaps.some(g => g.code === 'OPTIMIZATION_BLOCKED_BY_EXCITATION'))
})

test('A2 反例:U 与扰动混杂、多输入共线、仅 ACK 动作均拒绝', () => {
  const spec = specFixture({
    variables: [
      { id: 'mv1', nodeId: 'n-mv1', role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: 5000, min: 0, max: 100 },
      { id: 'mv2', nodeId: 'n-mv2', role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: 5000, min: 0, max: 100 },
      { id: 'md1', nodeId: 'n-md', role: 'md', field: 'value', unit: '℃', scale: 1, offset: 0, min: 0, max: 300 },
      { id: 'cv1', nodeId: 'n-cv', role: 'cv', field: 'value', unit: 'μm', scale: 1, offset: 0, min: 0, max: 200 },
    ],
    effectiveDomain: { mv: { mv1: { min: 0, max: 100 }, mv2: { min: 0, max: 100 } }, cv: { cv1: { min: 0, max: 200 } } },
  })
  const n = 120
  const mv = Array.from({ length: n }, (_, i) => 50 + 20 * Math.sin(i / 7))
  const series: EligibilitySeries[] = [
    { variableId: 'mv1', role: 'mv', values: mv },
    { variableId: 'mv2', role: 'mv', values: mv.map(v => v * 1.01) },
    { variableId: 'md1', role: 'md', values: mv.map(v => v + 100) },
    { variableId: 'cv1', role: 'cv', values: mv.map((v, i) => 50 + 0.4 * (v - 50) + 2 * Math.sin(i / 5)) },
  ]
  const report = evaluateEligibility({ spec, scope: 'real', conditionId: 'c1', series, actionEvidence: 'ack_only' })
  assert.equal(report.optimizationEligible, false)
  assert.ok(report.gaps.some(g => g.code === 'INPUT_COLLINEAR'))
  assert.ok(report.gaps.some(g => g.code === 'CONFOUNDED_DISTURBANCE'))
  assert.ok(report.gaps.some(g => g.code === 'ACTION_ACK_ONLY'))
})

test('同口径代价:候选轨迹的独立重算与约束报告一致', () => {
  const ir = {
    irVersion: 1 as const, hash: 'x', profileRef: 'p@1',
    modelRef: { modelId: 'mdl-1', artifactKind: 'linear_state_space@1' as const, artifactHash: 'h', modelInterface: 'linear_state_space' as const, stage: 'production' as const },
    solverRef: 'osqp_mpc@1' as const,
    conditions: { conditionId: 'c1', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeVersion: 1 },
    horizon: 3, beatMs: 5000,
    scaling: { mv: { mv1: { scale: 1, offset: 0 } }, cv: { cv1: { scale: 1, offset: 0 } } },
    weights: { cv: { cv1: 1 }, du: { mv1: 0.1 }, terminal: 1 },
    context: { capturedAt: '', eventAsOf: 0, availabilityWatermark: null, evidenceSource: 'simulation' as const },
    problem: {
      template: 'linear_mpc_quadratic@1' as const,
      dynamics: { stateDim: 2, A: [1, 0, 1, 0], B: [1, 0], C: [1, 0], D: [0], delays: { mv1: 0 }, x0: [10, 0] },
      cvSetpoints: [0], cvBounds: [{}], mvOrder: ['mv1'], cvOrder: ['cv1'], mvBounds: [{ min: -100, max: 100, maxStep: 100 }], uPrev: [0],
    },
  }
  const controls = [[1], [2], [3]]
  // 与 A/B/C/D 一致的手算轨迹:x1=[10,0]+B*1=[11,1] → y1=11;x2=A*x1+B*2=[13,11] → y2=13;x3=[16,13] → y3=16
  const predicted = [[11], [13], [16]]
  const candidate = { seq: 0, controls, predicted, cost: 0, constraints: [], feasible: true }
  const cost = evaluateCandidateCost(ir, candidate)
  assert.ok(cost > 0)
  const reports = constraintReport(ir, candidate)
  assert.equal(reports.every(r => r.satisfied), true)
  const violating = { ...candidate, controls: [[200], [200], [200]], predicted: [[0], [0], [0]] }
  const bad = constraintReport(ir, violating)
  assert.ok(bad.some(r => !r.satisfied))
})
