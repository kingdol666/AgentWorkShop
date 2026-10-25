import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DatasetView } from '../server/services/workshop/process-model/trainers/dataset-reader'
import { trainLinearArx } from '../server/services/workshop/process-model/trainers/linear-arx'
import { trainStaticResponse } from '../server/services/workshop/process-model/trainers/static-response'
import { constraintReport, simulateLinear } from '../server/services/workshop/optimization/problem-builder'
import type { ProblemIR, SolverRequestFrame } from '../server/services/workshop/optimization/contracts'
import type { ProcessModelSpec } from '../server/services/workshop/process-model/contracts'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-optimizer-numeric-'))

const { evaluateGates } = await import('../server/services/workshop/aml/gates')
const { acquireEnvReadLease, envLeaseStatus, withEnvExclusiveLock } = await import('../server/services/workshop/aml/env-lease')
const { SolverWorkerPool } = await import('../server/services/workshop/optimization/worker-client')
const { runBuiltinTraining } = await import('../server/services/workshop/process-model/trainers')

const config = { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-9, standardize: true }

function spec(delay: number) {
  return { variables: [{ id: 'mv', nodeId: 'u', role: 'mv', delayMs: delay * 1000 }, { id: 'cv', nodeId: 'y', role: 'cv' }], beatMs: 1000 }
}

function dataset(delay: number, poorVal = false): DatasetView {
  const H = 24
  const P = 5
  const N = 6
  const x: number[] = []
  const u: number[] = []
  const y: number[] = []
  for (let n = 0; n < N; n++) {
    const inputs = Array.from({ length: H + P }, (_, t) => Math.sin(t * 1.17 + n) * 3 + Math.cos(t * 0.41 + n * 2))
    const outputs: number[] = []
    for (let t = 0; t < H + P; t++) outputs.push(0.5 * (outputs[t - 1] ?? 0) + (poorVal && n === 3 ? 5 : 2) * (inputs[t - delay] ?? 0))
    for (let t = 0; t < H; t++) x.push(outputs[t]!, inputs[t]!)
    u.push(...inputs.slice(H))
    y.push(...outputs.slice(H))
  }
  return {
    dir: '', manifest: {}, H, P, N, nAll: 2, nCtrl: 1, nTgt: 1,
    allNodes: ['y', 'u'], controlNodes: ['u'], targetNodes: ['y'],
    norm: { x: { mean: [0, 0], std: [1, 1] }, u: { mean: [0], std: [1] }, y: { mean: [0], std: [1] } },
    x: new Float32Array(x), u: new Float32Array(u), y: new Float32Array(y),
    split: { train: 3, val: 1, test: 2, trainRunIds: [], valRunIds: [], testRunIds: [] }, beatMs: 1000,
  }
}

for (const delay of [0, 1, 2]) {
  test(`ARX d=${delay}: trained state preserves feedback across multiple future moves`, () => {
    const artifact = trainLinearArx(dataset(delay), config, spec(delay))
    const predicted = simulateLinear({
      stateDim: artifact.stateDim, A: artifact.A.flat(), B: artifact.B.flat(),
      C: artifact.C.flat(), D: artifact.D.flat(), bias: artifact.bias,
      x0: new Array<number>(artifact.stateDim).fill(0),
    }, 1, 1, [0], [[1], [1], [1], [1]])
    const expected = delay === 0 ? [2, 3, 3.5, 3.75] : delay === 1 ? [0, 2, 3, 3.5] : [0, 0, 2, 3]
    for (let t = 0; t < expected.length; t++) assert.ok(Math.abs(predicted[t]![0]! - expected[t]!) < 1e-4)
    assert.deepEqual(artifact.D, [[0]])
    assert.ok(artifact.metrics.rolloutNrmse < 1e-4)
  })
}

test('ARX validation metrics use separate data and correct window counts', () => {
  const ds = dataset(0, true)
  const datasetDir = mkdtempSync(join(tmpdir(), 'aw-arx-val-'))
  mkdirSync(join(datasetDir, 'arrays'))
  for (const name of ['x', 'u', 'y'] as const) writeFileSync(join(datasetDir, 'arrays', `${name}.f32`), Buffer.from(ds[name].buffer))
  writeFileSync(join(datasetDir, 'manifest.json'), JSON.stringify({ ...ds, x: undefined, u: undefined, y: undefined, shapes: { x: [ds.N, ds.H, 2], u: [ds.N, ds.P, 1], y: [ds.N, ds.P, 1] } }))
  const result = runBuiltinTraining('linear_arx@1', {
    datasetDir, jobDir: join(datasetDir, 'job'),
    spec: { variables: spec(0).variables, timing: { beatMs: 1000 }, trainer: { config } } as unknown as ProcessModelSpec,
  })
  const platform = result.metrics.platform as { artifactKind?: string, oneStepVal: { windows: number, nrmse: number }, oneStepTest: { windows: number, nrmse: number } }
  assert.equal(platform.oneStepVal.windows, 1)
  assert.equal(platform.oneStepTest.windows, 2)
  assert.ok(platform.oneStepVal.nrmse > 1)
  assert.ok(platform.oneStepTest.nrmse < 1e-4)
  const gates = evaluateGates('mpc_surrogate', { rowCount: 10000, runIds: ['a', 'b', 'c'] }, { split: ds.split }, { ...platform, artifactKind: 'linear_state_space@1' }, join(datasetDir, 'job', 'artifacts'))
  assert.equal(gates.checks.find(c => c.id === 'G3')?.pass, false)
})

test('trainers reject missing independent holdouts rather than report perfect metrics', () => {
  const ds = dataset(0)
  ds.split.test = 0
  assert.throws(() => trainLinearArx(ds, config, spec(0)), /独立验证集和测试集/)
  assert.throws(() => trainStaticResponse(ds, { order: 1, ridgeLambda: 1e-9, standardize: true }, spec(0)), /独立测试集/)
  ds.split.test = 2
  ds.split.val = 0
  assert.throws(() => trainLinearArx(ds, config, spec(0)), /独立验证集和测试集/)
})

test('quality gates reject empty or nonfinite evaluation even with perfect claimed NRMSE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-gate-empty-'))
  writeFileSync(join(dir, 'model.json'), '{}')
  for (const artifactKind of ['static_response@1', 'linear_state_space@1']) {
    for (const [testCount, windows, nrmse] of [[0, 10, 0], [10, 0, 0], [10, 10, Number.NEGATIVE_INFINITY]]) {
      const split = { ...dataset(0).split, test: testCount! }
      const report = evaluateGates('mpc_surrogate', { rowCount: 10000, runIds: ['a', 'b', 'c'] }, { split }, {
        artifactKind, oneStepVal: { windows: 1, nrmse: 0.01 }, oneStepTest: { windows: windows!, nrmse: nrmse! },
        rolloutTest: { windows: windows!, nrmse: 0, horizon: 5 }, rolloutImprovement: 1,
      }, dir)
      assert.equal(report.passed, false)
      assert.equal(report.checks.find(c => c.id === 'G1')?.pass, false)
    }
  }
})

test('generalization gate accepts separately evaluated exact predictions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-gate-exact-'))
  writeFileSync(join(dir, 'model.json'), '{}')
  const report = evaluateGates('mpc_surrogate', { rowCount: 10000, runIds: ['a', 'b', 'c'] }, { split: dataset(0).split }, {
    artifactKind: 'linear_state_space@1', oneStepVal: { windows: 1, nrmse: 0 }, oneStepTest: { windows: 2, nrmse: 0 },
    rolloutTest: { windows: 2, nrmse: 0, horizon: 5 }, rolloutImprovement: 1,
  }, dir)
  assert.equal(report.checks.find(c => c.id === 'G3')?.pass, true)
})

test('static constraint report independently rejects moves exceeding maxStep', () => {
  const ir = { problem: { template: 'steady_response@1', mvOrder: ['mv'], cvOrder: [], mvBounds: [{ min: 0, max: 100, maxStep: 2 }], cvBounds: [], uPrev: [20] } } as unknown as ProblemIR
  const reports = constraintReport(ir, { seq: 0, controls: [[25]], predicted: [[]], cost: 0, constraints: [], feasible: true })
  assert.equal(reports.find(r => r.kind === 'bound')?.satisfied, true)
  assert.equal(reports.find(r => r.kind === 'rate')?.satisfied, false)
  assert.equal(reports.find(r => r.kind === 'rate')?.residual, 3)
})

test('failed file acquisition clears local exclusive state and preserves foreign lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-env-exclusive-'))
  const path = join(root, 'runtime', 'env.lock')
  mkdirSync(join(root, 'runtime'))
  const foreign = JSON.stringify({ owner: 'maintenance', pid: process.pid, heartbeatAt: Date.now(), token: 'foreign' })
  writeFileSync(path, foreign)
  await assert.rejects(() => withEnvExclusiveLock('maintenance', root, () => assert.fail('must not enter')), (err: { code?: string }) => err.code === 'ENV_BUSY')
  assert.equal(envLeaseStatus().exclusive, null)
  assert.equal(readFileSync(path, 'utf8'), foreign)
  const lease = acquireEnvReadLease('after-failed-maintenance')
  lease.release()
  rmSync(path)
  await withEnvExclusiveLock('maintenance', root, () => assert.equal(envLeaseStatus().exclusive, 'maintenance'))
  assert.equal(existsSync(path), false)
  await withEnvExclusiveLock('maintenance', root, () => writeFileSync(path, foreign))
  assert.equal(readFileSync(path, 'utf8'), foreign)
})

interface TestWorker {
  child: EventEmitter | null
  ready: boolean
  retiring: boolean
  inFlight: string | null
  onExit(code: number | null, signal: NodeJS.Signals | null): void
  send(frame: SolverRequestFrame, timeoutMs: number): Promise<unknown>
}

test('timed-out worker is sealed until process exit, then its slot can restart', async () => {
  const pool = new SolverWorkerPool({ poolSize: 2 })
  const internal = pool as unknown as { workers: TestWorker[], acquireSlot(): Promise<TestWorker>, retire(worker: TestWorker): Promise<void> }
  const slot = internal.workers[0]!
  const child = Object.assign(new EventEmitter(), { stdin: { write: () => true } })
  slot.child = child
  slot.ready = true
  child.once('exit', (code, signal) => slot.onExit(code, signal))
  const frame = { protocolVersion: 1, reqId: 'timed-out', op: 'solve', payload: {} } as SolverRequestFrame
  await assert.rejects(() => slot.send(frame, 5), (err: { code?: string }) => err.code === 'SOLVE_TIMEOUT')
  assert.equal(slot.retiring, true)
  assert.equal(pool.stats().ready, 0)
  const nextSlot = await internal.acquireSlot()
  assert.notEqual(nextSlot, slot)
  const retired = internal.retire(slot)
  assert.equal(slot.retiring, true)
  child.emit('exit', 0, null)
  await retired
  assert.equal(slot.child, null)
  assert.equal(slot.retiring, false)
  assert.equal(await internal.acquireSlot(), slot)
  assert.equal(pool.size, 2)
  await pool.shutdown()
})

test('crashed worker cannot be respawned before its failed request is retired', async () => {
  const pool = new SolverWorkerPool({ poolSize: 2 })
  const internal = pool as unknown as { workers: TestWorker[], acquireSlot(): Promise<TestWorker>, retire(worker: TestWorker): Promise<void> }
  const slot = internal.workers[0]!
  const child = Object.assign(new EventEmitter(), { stdin: { write: () => true } })
  slot.child = child
  slot.ready = true
  child.once('exit', (code, signal) => slot.onExit(code, signal))
  const pending = slot.send({ protocolVersion: 1, reqId: 'crash', op: 'solve', payload: {} } as SolverRequestFrame, 1000)
  const rejected = assert.rejects(pending, (err: { code?: string }) => err.code === 'WORKER_INTERRUPTED')
  child.emit('exit', 1, null)
  assert.equal(slot.retiring, true)
  assert.notEqual(await internal.acquireSlot(), slot)
  await rejected
  await internal.retire(slot)
  assert.equal(await internal.acquireSlot(), slot)
  await pool.shutdown()
})
