/**
 * Solver Worker 协议与故障面契约(真实 Python 进程)。
 *
 * 不直接 spawn:走 SolverWorkerPool 的槽位,复用生产同一条 spawnLineProcess 路径。
 * 断言 NDJSON 帧语义:ready/ping/协议版本/未知 op/坏 JSON/缺载荷/未知模板/单任务互斥,
 * 以及 stdout 全程无协议外污染(OSQP C 库横幅必须被静默)。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProblemIR, SolverRequestFrame, SolverResponseFrame } from '../server/services/workshop/optimization/contracts'

const venvPython = process.platform === 'win32'
  ? join(homedir(), '.AgentWorkShop', 'aml', '.venv', 'Scripts', 'python.exe')
  : join(homedir(), '.AgentWorkShop', 'aml', '.venv', 'bin', 'python')
const skip = !existsSync(venvPython) && 'AML venv 不存在'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = process.env.AW_HOME ?? mkdtempSync(join(tmpdir(), 'aw-solver-proto-'))
process.env.AW_AML_DIR = process.env.AW_AML_DIR ?? join(homedir(), '.AgentWorkShop', 'aml')
process.env.NO_PROXY = '127.0.0.1,localhost'

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { SolverWorkerPool, optimizerPythonDir } = await import('../server/services/workshop/optimization/worker-client')

interface RawWorker {
  child: unknown
  ready: boolean
  pid: number
  inFlight: string | null
  readyFrame: { protocolVersion: number, diag?: { pid?: number } } | null
  ensureSpawned(pythonPath: string, pythonDir: string, threads: number): Promise<void>
  send(frame: SolverRequestFrame, timeoutMs: number): Promise<SolverResponseFrame>
}

interface PoolInternals {
  workers: RawWorker[]
  acquireSlot(): Promise<RawWorker>
}

function initRuntime() {
  const db = openWorkshopDb(join(process.env.AW_HOME!, `solver-protocol-${process.pid}.sqlite`))
  configureAmlRuntime(db)
}

function mpcIr(hash: string, horizon = 2): ProblemIR {
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
      cvSetpoints: [3], cvBounds: [{}], mvOrder: ['mv1'], cvOrder: ['cv1'],
      mvBounds: [{ min: -10, max: 10, maxStep: 10 }], uPrev: [0],
    },
  }
}

async function withWorker(fn: (slot: RawWorker, lines: string[]) => Promise<void>) {
  initRuntime()
  const pool = new SolverWorkerPool({ poolSize: 1, requestTimeoutMs: 60_000, threads: 1 })
  const internal = pool as unknown as PoolInternals
  try {
    const probe = await pool.probe()
    assert.equal(probe.ok, true, `probe 失败:${probe.pythonPath}`)
    assert.equal(probe.osqp, true)
    assert.equal(probe.scipy, true)
    const slot = await internal.acquireSlot()
    await slot.ensureSpawned(probe.pythonPath, optimizerPythonDir(), 1)
    const lines: string[] = []
    let buffer = ''
    const stdout = (slot.child as { stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } }).stdout
    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) lines.push(line.trim())
    })
    await fn(slot, lines)
    // stdout 全程必须是 NDJSON:任何 OSQP 横幅/调试输出都会在这里暴露
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line) as unknown, `stdout 非协议行:${line.slice(0, 200)}`)
    }
  }
  finally {
    await pool.shutdown()
  }
}

test('协议:ready + ping + stdout 纯 NDJSON', { skip }, async () => {
  await withWorker(async (slot, lines) => {
    assert.equal(slot.ready, true)
    assert.equal(slot.readyFrame?.protocolVersion, 1, JSON.stringify(slot.readyFrame))
    assert.ok(Number(slot.readyFrame?.diag?.pid ?? 0) > 0, JSON.stringify(slot.readyFrame))
    assert.ok(slot.pid > 0)
    const pong = await slot.send({ protocolVersion: 1, reqId: 'ping-1', op: 'ping' }, 5000)
    assert.equal(pong.ok, true)
    assert.equal((pong.result as { pong: boolean }).pong, true)
    assert.equal((pong.result as { busy: boolean }).busy, false)
    const solved = await slot.send({ protocolVersion: 1, reqId: 'solve-1', op: 'solve', payload: { problemIr: mpcIr('proto-1') } }, 30_000)
    assert.equal(solved.ok, true)
    assert.equal((solved.result as { status: string }).status, 'optimal')
    // ready 帧在 attach 监听器前已消费;此后 ping/solve 两帧必须被捕获并全部可解析
    assert.ok(lines.length >= 2, `捕获帧数 ${lines.length}`)
  })
})

test('协议:protocolVersion 不匹配 → PROTOCOL_MISMATCH 且进程存活', { skip }, async () => {
  await withWorker(async (slot) => {
    const bad = await slot.send({ protocolVersion: 2, reqId: 'v2', op: 'ping' } as SolverRequestFrame, 5000)
    assert.equal(bad.ok, false)
    assert.equal(bad.error?.code, 'PROTOCOL_MISMATCH')
    const pong = await slot.send({ protocolVersion: 1, reqId: 'v1', op: 'ping' }, 5000)
    assert.equal((pong.result as { pong: boolean }).pong, true)
  })
})

test('协议:未知 op → UNKNOWN_OP;缺 problemIr → SOLVER_ERROR;两者后进程仍可用', { skip }, async () => {
  await withWorker(async (slot) => {
    const unknown = await slot.send({ protocolVersion: 1, reqId: 'u1', op: 'nope' } as unknown as SolverRequestFrame, 5000)
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error?.code, 'UNKNOWN_OP')
    const missing = await slot.send({ protocolVersion: 1, reqId: 's0', op: 'solve', payload: {} }, 5000)
    assert.equal(missing.ok, false)
    assert.equal(missing.error?.code, 'SOLVER_ERROR')
    assert.match(String(missing.error?.message), /problemIr/)
    const pong = await slot.send({ protocolVersion: 1, reqId: 'p2', op: 'ping' }, 5000)
    assert.equal((pong.result as { pong: boolean }).pong, true)
  })
})

test('协议:坏 JSON → BAD_JSON 帧且不中断主循环', { skip }, async () => {
  await withWorker(async (slot, lines) => {
    const stdin = (slot.child as { stdin: { write(chunk: string): boolean } }).stdin
    stdin.write('{not-json\n')
    const pong = await slot.send({ protocolVersion: 1, reqId: 'after-bad', op: 'ping' }, 5000)
    assert.equal((pong.result as { pong: boolean }).pong, true)
    const frames = lines.map(line => JSON.parse(line) as { error?: { code?: string } })
    assert.ok(frames.some(frame => frame.error?.code === 'BAD_JSON'), `未见 BAD_JSON:${lines.join(' | ').slice(0, 500)}`)
  })
})

test('协议:未知问题模板 → ok:true + result.status=unsupported(不伪造最优解)', { skip }, async () => {
  await withWorker(async (slot) => {
    const ir = mpcIr('proto-unsupported')
    ;(ir.problem as { template: string }).template = 'does_not_exist@1'
    const result = await slot.send({ protocolVersion: 1, reqId: 'unsup', op: 'solve', payload: { problemIr: ir } }, 10_000)
    assert.equal(result.ok, true)
    assert.equal((result.result as { status: string }).status, 'unsupported')
    assert.match(String((result.result as { message: string }).message), /unsupported template/)
  })
})

test('协议:同一 worker 并发的第二个 solve → SOLVER_BUSY(单任务互斥)', { skip }, async () => {
  await withWorker(async (slot) => {
    const slow = slot.send({ protocolVersion: 1, reqId: 'slow', op: 'solve', payload: { problemIr: mpcIr('proto-slow', 1200) } }, 60_000)
    const busy = await slot.send({ protocolVersion: 1, reqId: 'second', op: 'solve', payload: { problemIr: mpcIr('proto-second') } }, 10_000)
    assert.equal(busy.ok, false)
    assert.equal(busy.error?.code, 'SOLVER_BUSY')
    const first = await slow
    assert.equal(first.ok, true)
    assert.equal((first.result as { status: string }).status, 'optimal')
    // 互斥解除后同一进程可继续服务
    const after = await slot.send({ protocolVersion: 1, reqId: 'after', op: 'solve', payload: { problemIr: mpcIr('proto-after') } }, 10_000)
    assert.equal((after.result as { status: string }).status, 'optimal')
  })
})
