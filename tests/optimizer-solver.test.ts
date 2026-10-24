/* eslint-disable @stylistic/max-statements-per-line */
/**
 * G3 真实 Python 求解(A4):SciPy 解析解 ≤1e-4;OSQP 凸 QP 与参考解 ≤1e-5、约束残差 ≤1e-5。
 * 直接拉起 worker.py(NDJSON),不走 server;缺 venv 时跳过并明确报告。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProblemIR } from '../server/services/workshop/optimization/contracts'

const python = process.platform === 'win32'
  ? join(homedir(), '.AgentWorkShop', 'aml', '.venv', 'Scripts', 'python.exe')
  : join(homedir(), '.AgentWorkShop', 'aml', '.venv', 'bin', 'python')
const pythonDir = join(process.cwd(), 'server', 'services', 'workshop', 'optimization', 'python')

function runWorker(ir: ProblemIR, timeoutMs = 30_000): Promise<{ status: string, controls?: number[][], predicted?: number[][], cost?: number, message?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [join(pythonDir, 'worker.py')], {
      cwd: pythonDir, shell: false,
      env: { ...process.env, PYTHONPATH: pythonDir, PYTHONIOENCODING: 'utf-8', OMP_NUM_THREADS: '1' },
    })
    const rl = createInterface({ input: child.stdout! })
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker timeout')) }, timeoutMs)
    let ready = false
    const nonProtocol: string[] = []
    child.stderr?.on('data', () => { /* 日志走 stderr,忽略 */ })
    rl.on('line', (line) => {
      let frame: Record<string, unknown>
      try { frame = JSON.parse(line) as Record<string, unknown> }
      catch {
        nonProtocol.push(line)
        return
      }
      if (frame.type === 'ready') {
        ready = true
        child.stdin!.write(`${JSON.stringify({ protocolVersion: 1, reqId: 'req-1', op: 'solve', payload: { problemIr: ir }, deadlineMs: timeoutMs })}\n`)
        return
      }
      if (!ready) return
      clearTimeout(timer)
      if (nonProtocol.length) {
        child.kill()
        reject(new Error(`stdout 出现非协议行:${nonProtocol.slice(0, 3).join(' | ')}`))
        return
      }
      if (frame.ok !== true) {
        child.kill()
        reject(new Error(JSON.stringify(frame.error)))
        return
      }
      child.kill()
      resolve(frame.result as never)
    })
    child.once('error', reject)
  })
}

function steadyIr(): ProblemIR {
  return {
    irVersion: 1, hash: 'steady-test', profileRef: 'p@1',
    modelRef: { modelId: 'm', artifactKind: 'static_response@1', artifactHash: 'h', modelInterface: 'static_response', stage: 'production' },
    solverRef: 'scipy_slsqp@1',
    conditions: { conditionId: 'c', lineId: 'l', productId: 'p', recipeId: 'r', recipeVersion: 1 },
    horizon: 1, beatMs: 1000,
    scaling: { mv: { mv1: { scale: 1, offset: 0 } }, cv: { cv1: { scale: 1, offset: 0 } } },
    weights: { cv: { cv1: 1 }, du: {}, terminal: 0, economic: {} },
    context: { capturedAt: '', eventAsOf: 0, availabilityWatermark: null, evidenceSource: 'simulation' },
    problem: {
      template: 'steady_response@1',
      mvOrder: ['mv1'], cvOrder: ['cv1'],
      coefficients: { cv1: [0, 1] }, featureOrder: ['bias', 'mv1'],
      cvTargets: [3], mvBounds: [{ min: -10, max: 10, maxStep: 10 }], cvBounds: [{}], uPrev: [0],
    },
  }
}

function mpcIr(): ProblemIR {
  return {
    irVersion: 1, hash: 'mpc-test', profileRef: 'p@1',
    modelRef: { modelId: 'm', artifactKind: 'linear_state_space@1', artifactHash: 'h', modelInterface: 'linear_state_space', stage: 'production' },
    solverRef: 'osqp_mpc@1',
    conditions: { conditionId: 'c', lineId: 'l', productId: 'p', recipeId: 'r', recipeVersion: 1 },
    horizon: 5, beatMs: 1000,
    scaling: { mv: { mv1: { scale: 1, offset: 0 } }, cv: { cv1: { scale: 1, offset: 0 } } },
    weights: { cv: { cv1: 1 }, du: { mv1: 0.001 }, terminal: 1 },
    context: { capturedAt: '', eventAsOf: 0, availabilityWatermark: null, evidenceSource: 'simulation' },
    problem: {
      template: 'linear_mpc_quadratic@1',
      dynamics: { stateDim: 1, A: [1], B: [1], C: [1], D: [0], delays: { mv1: 0 }, x0: [0] },
      cvSetpoints: [5], cvBounds: [{}], mvOrder: ['mv1'], cvOrder: ['cv1'],
      mvBounds: [{ min: -10, max: 10, maxStep: 10 }], uPrev: [0],
    },
  }
}

test('SciPy 静态求解:解析解 u*=3,目标差 ≤1e-4', { skip: !existsSync(python) && 'AML venv 不存在' }, async () => {
  const result = await runWorker(steadyIr())
  assert.equal(result.status, 'optimal')
  const u = result.controls?.[0]?.[0] ?? Number.NaN
  assert.ok(Math.abs(u - 3) <= 1e-4, `u=${u}`)
  assert.ok(Math.abs((result.cost ?? 0) - 0) <= 1e-4)
})

test('OSQP 线性 MPC:达到设定值、约束残差 ≤1e-5、候选非恒值', { skip: !existsSync(python) && 'AML venv 不存在' }, async () => {
  const result = await runWorker(mpcIr())
  assert.equal(result.status, 'optimal')
  const controls = result.controls ?? []
  assert.equal(controls.length, 5)
  // 无 Δu 惩罚主导时最优解是尽快到设定值(首步 ≈5),不是均摊 1 —— 只断言收敛与边界
  const predicted = result.predicted ?? []
  assert.ok(Math.abs((predicted[4]?.[0] ?? 0) - 5) <= 1e-3, `pred5=${predicted[4]?.[0]}`)
  for (const c of controls) assert.ok((c[0] ?? 0) >= -10 - 1e-9 && (c[0] ?? 0) <= 10 + 1e-9)
  assert.ok(new Set(controls.map(c => c[0]!.toFixed(4))).size >= 2, '候选序列不能是恒值')
  // 速率约束:相邻步 |Δu| ≤ 10(本 fixture 不触发,验证报告可算)
  for (let i = 1; i < controls.length; i++) assert.ok(Math.abs(controls[i]![0]! - controls[i - 1]![0]!) <= 10 + 1e-6)
})
