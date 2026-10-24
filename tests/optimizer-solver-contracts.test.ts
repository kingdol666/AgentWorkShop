/**
 * 平台侧求解契约:IR 结构 hash 不变式、Worker 与 TS 独立重算的代价/轨迹/约束一致性、
 * 静态响应面特征展开一致性、solverRef×template 分派矩阵。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertProfileSolverCompatible, computeProblemIrHash, type ProblemIR, type SolveCandidate } from '../server/services/workshop/optimization/contracts'
import { constraintReport, evaluateCandidateCost, evaluateStatic, simulateLinear } from '../server/services/workshop/optimization/problem-builder'

const venvPython = process.platform === 'win32'
  ? join(homedir(), '.AgentWorkShop', 'aml', '.venv', 'Scripts', 'python.exe')
  : join(homedir(), '.AgentWorkShop', 'aml', '.venv', 'bin', 'python')
const skip = !existsSync(venvPython) && 'AML venv 不存在'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = process.env.AW_HOME ?? mkdtempSync(join(tmpdir(), 'aw-solver-contracts-'))
process.env.AW_AML_DIR = process.env.AW_AML_DIR ?? join(homedir(), '.AgentWorkShop', 'aml')
process.env.NO_PROXY = '127.0.0.1,localhost'

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { SolverWorkerPool } = await import('../server/services/workshop/optimization/worker-client')

function mpcIr(): ProblemIR {
  return {
    irVersion: 1, hash: '', profileRef: 'p@1',
    modelRef: { modelId: 'm', artifactKind: 'linear_state_space@1', artifactHash: 'h', modelInterface: 'linear_state_space', stage: 'production' },
    solverRef: 'osqp_mpc@1',
    conditions: { conditionId: 'c', lineId: 'l', productId: 'p', recipeId: 'r', recipeVersion: 1 },
    horizon: 5, beatMs: 1000,
    scaling: { mv: { mv1: { scale: 2, offset: 1 } }, cv: { cv1: { scale: 0.5, offset: 10 } } },
    weights: { cv: { cv1: 1 }, du: { mv1: 0.1 }, terminal: 0.5 },
    context: { capturedAt: '2026-10-23T00:00:00.000Z', eventAsOf: 100, availabilityWatermark: 90, evidenceSource: 'simulation' },
    problem: {
      template: 'linear_mpc_quadratic@1',
      dynamics: { stateDim: 1, A: [0.9], B: [0.1], C: [1], D: [0.05], delays: { mv1: 0 }, x0: [0.4], bias: [0.2] },
      cvSetpoints: [5], cvBounds: [{}], mvOrder: ['mv1'], cvOrder: ['cv1'],
      mvBounds: [{ min: 0, max: 10, maxStep: 2 }], uPrev: [1],
    },
  }
}

function staticIr(): ProblemIR {
  return {
    irVersion: 1, hash: '', profileRef: 'p@1',
    modelRef: { modelId: 'm', artifactKind: 'static_response@1', artifactHash: 'h', modelInterface: 'static_response', stage: 'production' },
    solverRef: 'scipy_slsqp@1',
    conditions: { conditionId: 'c', lineId: 'l', productId: 'p', recipeId: 'r', recipeVersion: 1 },
    horizon: 1, beatMs: 1000,
    scaling: { mv: { a: { scale: 1, offset: 0 }, b: { scale: 1, offset: 0 } }, cv: { c1: { scale: 1, offset: 0 }, c2: { scale: 1, offset: 0 } } },
    weights: { cv: { c1: 2, c2: 1 }, du: {}, terminal: 0, economic: { a: -0.3, b: 0.1 } },
    context: { capturedAt: '2026-10-23T00:00:00.000Z', eventAsOf: 100, availabilityWatermark: null, evidenceSource: 'simulation' },
    problem: {
      template: 'steady_response@1',
      mvOrder: ['a', 'b'], cvOrder: ['c1', 'c2'],
      coefficients: { c1: [1, 2, -1, 0.1, 0.05], c2: [0, 1, 1, -0.2, 0] },
      featureOrder: ['bias', 'a', 'b', 'a*b', 'a^2'],
      cvTargets: [8, 6],
      mvBounds: [{ min: 0, max: 10, maxStep: 3 }, { min: 0, max: 10 }],
      cvBounds: [{}, {}], uPrev: [1, 1],
    },
  }
}

function withHash(ir: ProblemIR): ProblemIR {
  return { ...ir, hash: computeProblemIrHash(ir) }
}

function candidateOf(result: { status: string, controls: number[][], predicted: number[][], cost: number }): SolveCandidate {
  return { seq: 0, controls: result.controls, predicted: result.predicted, cost: result.cost, constraints: [], feasible: true }
}

function relativeDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b))
}

function initRuntime() {
  configureAmlRuntime(openWorkshopDb(join(process.env.AW_HOME!, `solver-contracts-${process.pid}.sqlite`)))
}

test('IR 结构 hash:context/x0/uPrev 不参与;weights/horizon/约束参与;键序稳定', () => {
  const base = mpcIr()
  const h = computeProblemIrHash(base)
  assert.equal(computeProblemIrHash(JSON.parse(JSON.stringify(base)) as ProblemIR), h)
  const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as ProblemIR
  assert.equal(computeProblemIrHash(reordered), h)
  const runtimeOnly = JSON.parse(JSON.stringify(base)) as ProblemIR
  runtimeOnly.context.capturedAt = '2030-01-01T00:00:00.000Z'
  runtimeOnly.context.eventAsOf = 999
  runtimeOnly.context.availabilityWatermark = 1
  runtimeOnly.problem.dynamics.x0 = [123]
  runtimeOnly.problem.uPrev = [9]
  assert.equal(computeProblemIrHash(runtimeOnly), h)

  const weights = JSON.parse(JSON.stringify(base)) as ProblemIR
  weights.weights.cv.cv1 = 2
  assert.notEqual(computeProblemIrHash(weights), h)
  const horizon = JSON.parse(JSON.stringify(base)) as ProblemIR
  horizon.horizon = 6
  assert.notEqual(computeProblemIrHash(horizon), h)
  const bounds = JSON.parse(JSON.stringify(base)) as ProblemIR
  bounds.problem.mvBounds[0]!.max = 9
  assert.notEqual(computeProblemIrHash(bounds), h)
  const template = JSON.parse(JSON.stringify(base)) as ProblemIR
  ;(template.problem as { template: string }).template = 'steady_response@1'
  assert.notEqual(computeProblemIrHash(template), h)
})

test('solverRef×template 分派矩阵:仅允许 osqp×linear 与 scipy×static', () => {
  const profile = (solverRef: 'osqp_mpc@1' | 'scipy_slsqp@1', template: 'linear_mpc_quadratic@1' | 'steady_response@1') => ({
    solverRef,
    problemTemplateRef: template,
    modelRef: { modelId: 'm', artifactKind: solverRef === 'osqp_mpc@1' ? 'linear_state_space@1' as const : 'static_response@1' as const, artifactHash: 'h', modelInterface: (solverRef === 'osqp_mpc@1' ? 'linear_state_space' : 'static_response') as 'linear_state_space' | 'static_response', stage: 'production' as const },
  })
  assert.doesNotThrow(() => assertProfileSolverCompatible(profile('osqp_mpc@1', 'linear_mpc_quadratic@1')))
  assert.doesNotThrow(() => assertProfileSolverCompatible(profile('scipy_slsqp@1', 'steady_response@1')))
  assert.throws(() => assertProfileSolverCompatible(profile('scipy_slsqp@1', 'linear_mpc_quadratic@1')),
    (err: { code?: string, status?: number }) => err.code === 'SOLVER_TEMPLATE_UNSUPPORTED' && err.status === 422)
  assert.throws(() => assertProfileSolverCompatible({ ...profile('osqp_mpc@1', 'steady_response@1'), modelRef: { ...profile('osqp_mpc@1', 'steady_response@1').modelRef, artifactKind: 'static_response@1', modelInterface: 'static_response' } }),
    (err: { code?: string, status?: number }) => err.code === 'UNSUPPORTED_MODEL_SOLVER' && err.status === 422)
})

test('MPC:Worker 结果与 TS 独立重算代价/轨迹/约束一致(≤1e-6)', { skip }, async () => {
  initRuntime()
  const pool = new SolverWorkerPool({ poolSize: 1, requestTimeoutMs: 60_000, threads: 1 })
  try {
    const ir = withHash(mpcIr())
    const solved = await pool.solve(ir)
    const result = solved.result as { status: string, controls: number[][], predicted: number[][], cost: number }
    assert.equal(result.status, 'optimal')
    const candidate = candidateOf(result)
    assert.ok(relativeDiff(result.cost, evaluateCandidateCost(ir, candidate)) <= 1e-6,
      `cost solver=${result.cost} ts=${evaluateCandidateCost(ir, candidate)}`)
    const p = ir.problem as Extract<ProblemIR['problem'], { template: 'linear_mpc_quadratic@1' }>
    const simulated = simulateLinear(p.dynamics, p.mvOrder.length, p.cvOrder.length, p.uPrev, result.controls)
    for (let t = 0; t < simulated.length; t++) {
      for (let j = 0; j < p.cvOrder.length; j++) {
        assert.ok(Math.abs((simulated[t]![j] ?? 0) - (result.predicted[t]![j] ?? 0)) <= 1e-6)
      }
    }
    const reports = constraintReport(ir, candidate)
    for (const report of reports) assert.equal(report.satisfied, true, JSON.stringify(report))
    assert.ok((reports.find(r => r.id === 'dynamics.rollout')?.residual ?? 1) <= 1e-6)
  }
  finally { await pool.shutdown() }
})

test('Static:Worker 预测/代价与 evaluateStatic/独立代价一致(≤1e-6)', { skip }, async () => {
  initRuntime()
  const pool = new SolverWorkerPool({ poolSize: 1, requestTimeoutMs: 60_000, threads: 1 })
  try {
    const ir = withHash(staticIr())
    const solved = await pool.solve(ir)
    const result = solved.result as { status: string, controls: number[][], predicted: number[][], cost: number }
    assert.equal(result.status, 'optimal')
    const p = ir.problem as Extract<ProblemIR['problem'], { template: 'steady_response@1' }>
    const controls = result.controls[0]!
    for (let j = 0; j < p.cvOrder.length; j++) {
      const expected = evaluateStatic(p.coefficients[p.cvOrder[j]!]!, p.featureOrder, p.mvOrder, controls)
      assert.ok(Math.abs(expected - result.predicted[0]![j]!) <= 1e-12, `cv${j}: ${expected} vs ${result.predicted[0]![j]}`)
    }
    const candidate = candidateOf(result)
    assert.ok(relativeDiff(result.cost, evaluateCandidateCost(ir, candidate)) <= 1e-6,
      `cost solver=${result.cost} ts=${evaluateCandidateCost(ir, candidate)}`)
    for (const report of constraintReport(ir, candidate)) assert.equal(report.satisfied, true, JSON.stringify(report))
  }
  finally { await pool.shutdown() }
})

test('Worker 对非法 IR 返回 422 SOLVER_ERROR(不崩溃、不伪造解)', { skip }, async () => {
  initRuntime()
  const pool = new SolverWorkerPool({ poolSize: 1, requestTimeoutMs: 30_000, threads: 1 })
  try {
    const ir = withHash(mpcIr())
    const problem = ir.problem as Extract<ProblemIR['problem'], { template: 'linear_mpc_quadratic@1' }>
    delete (problem.dynamics as Partial<typeof problem.dynamics>).A
    await assert.rejects(() => pool.solve(ir), (err: { status?: number, code?: string }) => err.status === 422 && err.code === 'SOLVER_ERROR')
    const recovered = await pool.solve(withHash(mpcIr()))
    assert.equal((recovered.result as { status: string }).status, 'optimal')
  }
  finally { await pool.shutdown() }
})

test('静态特征展开:evaluateStatic 与 Python 响应面逐特征一致(bias/mv/mv^2/a*b)', { skip }, async () => {
  initRuntime()
  const pool = new SolverWorkerPool({ poolSize: 1, requestTimeoutMs: 60_000, threads: 1 })
  try {
    // 用同一组特征但让求解器落在已知操作点:经济权重把解推到上界,逐特征核对预测
    const ir = withHash({
      ...staticIr(),
      weights: { cv: { c1: 1, c2: 1 }, du: {}, terminal: 0, economic: { a: -1, b: -1 } },
      problem: {
        ...(staticIr().problem as Extract<ProblemIR['problem'], { template: 'steady_response@1' }>),
        cvTargets: [20, 20],
        mvBounds: [{ min: 0, max: 2 }, { min: 0, max: 2 }],
        uPrev: [0, 0],
      },
    })
    const solved = await pool.solve(ir)
    const result = solved.result as { status: string, controls: number[][], predicted: number[][] }
    assert.equal(result.status, 'optimal')
    const p = ir.problem as Extract<ProblemIR['problem'], { template: 'steady_response@1' }>
    for (let j = 0; j < p.cvOrder.length; j++) {
      assert.ok(Math.abs(evaluateStatic(p.coefficients[p.cvOrder[j]!]!, p.featureOrder, p.mvOrder, result.controls[0]!) - result.predicted[0]![j]!) <= 1e-12)
    }
  }
  finally { await pool.shutdown() }
})
