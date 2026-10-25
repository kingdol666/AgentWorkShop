/**
 * Worker 池真实进程集成:并发槽位 / 超时杀进程 / 崩溃后退避补位 / 连续失败降级。
 * 走 SolverWorkerPool 公共 API(生产同一条 spawn 路径),不直接 spawn。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProblemIR } from '../server/services/workshop/optimization/contracts'

const venvPython = process.platform === 'win32'
  ? join(homedir(), '.AgentWorkShop', 'aml', '.venv', 'Scripts', 'python.exe')
  : join(homedir(), '.AgentWorkShop', 'aml', '.venv', 'bin', 'python')
const skip = !existsSync(venvPython) && 'AML venv 不存在'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = process.env.AW_HOME ?? mkdtempSync(join(tmpdir(), 'aw-worker-pool-'))
process.env.AW_AML_DIR = process.env.AW_AML_DIR ?? join(homedir(), '.AgentWorkShop', 'aml')
process.env.NO_PROXY = '127.0.0.1,localhost'

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { SolverWorkerPool } = await import('../server/services/workshop/optimization/worker-client')

function initRuntime() {
  configureAmlRuntime(openWorkshopDb(join(process.env.AW_HOME!, `worker-pool-${process.pid}.sqlite`)))
}

function mpcIr(hash: string, horizon = 2, setpoint = 3): ProblemIR {
  return {
    irVersion: 1, hash, profileRef: 'p@1',
    modelRef: { modelId: 'm', artifactKind: 'linear_state_space@1', artifactHash: 'h', modelInterface: 'linear_state_space', stage: 'production' },
    solverRef: 'osqp_mpc@1',
    conditions: { conditionId: 'c', lineId: 'l', productId: 'p', recipeId: 'r', recipeVersion: 1 },
    horizon, beatMs: 1000,
    scaling: { mv: { mv1: { scale: 1, offset: 0 } }, cv: { cv1: { scale: 1, offset: 0 } } },
    weights: { cv: { cv1: 1 }, du: { mv1: 0.01 }, terminal: 0 },
    context: { capturedAt: '', eventAsOf: 0, availabilityWatermark: null, evidenceSource: 'simulation' },
    problem: {
      template: 'linear_mpc_quadratic@1',
      dynamics: { stateDim: 1, A: [1], B: [1], C: [1], D: [0], delays: { mv1: 0 }, x0: [0] },
      cvSetpoints: [setpoint], cvBounds: [{}], mvOrder: ['mv1'], cvOrder: ['cv1'],
      mvBounds: [{ min: -10, max: 10, maxStep: 10 }], uPrev: [0],
    },
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('池能力探针:osqp + scipy 在同一解释器可用', { skip }, async () => {
  initRuntime()
  const pool = new SolverWorkerPool({ poolSize: 1, requestTimeoutMs: 30_000, threads: 1 })
  try {
    const probe = await pool.probe()
    assert.equal(probe.ok, true, probe.pythonPath)
    assert.equal(probe.osqp, true)
    assert.equal(probe.scipy, true)
    assert.match(probe.pythonPath, /python(\.exe)?$/)
  }
  finally { await pool.shutdown() }
})

test('池并发:poolSize=2 两个 solve 真并行(不同 workerPid)', { skip }, async () => {
  initRuntime()
  const pool = new SolverWorkerPool({ poolSize: 2, requestTimeoutMs: 60_000, threads: 1 })
  try {
    const [a, b] = await Promise.all([
      pool.solve(mpcIr('pool-a', 3, 2), { timeoutMs: 60_000 }),
      pool.solve(mpcIr('pool-b', 3, 5), { timeoutMs: 60_000 }),
    ])
    const sa = a.result as { status: string, controls: number[][] }
    const sb = b.result as { status: string, controls: number[][] }
    assert.equal(sa.status, 'optimal')
    assert.equal(sb.status, 'optimal')
    assert.notEqual(a.workerPid, b.workerPid)
    assert.ok(a.workerPid > 0 && b.workerPid > 0)
    // 两个槽位各自解自己的问题(低位设定值先动、高位设定值后动),证明无串扰
    assert.ok(sa.controls[0]![0]! < sb.controls[0]![0]!, `${sa.controls[0]![0]} vs ${sb.controls[0]![0]}`)
    assert.ok(Number.isFinite(sa.controls[0]![0]) && Number.isFinite(sb.controls[0]![0]))
    assert.equal(pool.size, 2)
  }
  finally { await pool.shutdown() }
})

test('池超时:慢问题 SOLVE_TIMEOUT → 进程回收 → 新 pid 恢复服务', { skip }, async () => {
  initRuntime()
  const pool = new SolverWorkerPool({ poolSize: 1, requestTimeoutMs: 60_000, threads: 1 })
  try {
    const first = await pool.solve(mpcIr('pool-warm'), { timeoutMs: 30_000 })
    const oldPid = first.workerPid
    await assert.rejects(
      () => pool.solve(mpcIr('pool-slow', 1200), { timeoutMs: 1 }),
      (err: { code?: string }) => err.code === 'SOLVE_TIMEOUT',
    )
    assert.equal(pool.workerPids().includes(oldPid), false, `旧进程 ${oldPid} 仍存活`)
    await sleep(1200)
    const recovered = await pool.solve(mpcIr('pool-recover'), { timeoutMs: 30_000 })
    assert.equal((recovered.result as { status: string }).status, 'optimal')
    assert.notEqual(recovered.workerPid, oldPid)
    assert.equal(pool.stats().degraded, false)
  }
  finally { await pool.shutdown() }
})

test('池降级:连续 3 次超时 → degraded → SOLVER_UNAVAILABLE;shutdown 清空 pid', { skip }, async () => {
  initRuntime()
  const pool = new SolverWorkerPool({ poolSize: 1, requestTimeoutMs: 60_000, threads: 1 })
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(
        () => pool.solve(mpcIr(`pool-degrade-${attempt}`, 1200), { timeoutMs: 1 }),
        (err: { code?: string }) => err.code === 'SOLVE_TIMEOUT',
      )
      await sleep(attempt === 0 ? 1200 : 2200)
    }
    assert.equal(pool.stats().degraded, true)
    await assert.rejects(
      () => pool.solve(mpcIr('pool-after-degrade')),
      (err: { code?: string }) => err.code === 'SOLVER_UNAVAILABLE',
    )
  }
  finally {
    await pool.shutdown()
    assert.deepEqual(pool.workerPids(), [])
  }
})
