/**
 * Optimizer Python Worker 客户端(G3.1 / B.9.3)。
 *
 *  - 有界进程池(默认 1,范围 1–4),每进程同时 1 个 solve;
 *  - NDJSON(stdin/stdout),请求 ID、硬超时、协作取消 + 必要时杀独占进程;
 *  - Worker 崩溃:在途请求标 interrupted(不自动重放),指数退避补位;
 *  - 复用 AML 共享 .venv(不建第二套环境),线程预算显式注入,不继承 secrets。
 */
/* eslint-disable @stylistic/max-statements-per-line */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { AppError } from '../../../utils/errors'
import { getAmlRuntime } from '../aml/runtime'
import { ensureVenv, jobEnv, platformPythonDir } from '../aml/python-runtime'
import { acquireEnvReadLease } from '../aml/env-lease'
import { killHarnessProcess } from '../agents/harness-process'
import { spawnLineProcess } from '../agents/adapters/line-spawn'
import { optimizerSolverSettings } from '../settings'
import { createLogger } from '../logger'
import type { ProblemIR, SolverEventFrame, SolverRequestFrame, SolverResponseFrame } from './contracts'

const log = createLogger('optimizer.worker')
const PROTOCOL_VERSION = 1
const KILL_CONFIRM_MS = 5000

export function optimizerPythonDir(): string {
  const candidates = [
    process.env.AW_OPTIMIZER_PYHOME,
    join(process.cwd(), 'server/services/workshop/optimization/python'),
    join(process.cwd(), '.output/.AgentWorkShop/optimizer-python'),
  ].filter((p): p is string => Boolean(p))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'worker.py'))) return candidate
  }
  return join(process.cwd(), 'server/services/workshop/optimization/python')
}

/** 求解进程环境:jobEnv 白名单 + 线程预算;不继承 process.env。 */
export function solverEnv(amlRoot: string, pythonDir: string, threads: number): Record<string, string> {
  const rt = getAmlRuntime()
  const solverDir = join(amlRoot, 'runtime', 'solver')
  mkdirSync(solverDir, { recursive: true })
  const env = jobEnv(rt, solverDir)
  env.PYTHONPATH = [pythonDir, platformPythonDir()].join(process.platform === 'win32' ? ';' : ':')
  const n = String(Math.max(1, Math.min(threads, 16)))
  env.OMP_NUM_THREADS = n
  env.OPENBLAS_NUM_THREADS = n
  env.MKL_NUM_THREADS = n
  env.NUMEXPR_NUM_THREADS = n
  env.PYTHONHASHSEED = '0'
  return env
}

export interface WorkerClientOptions {
  poolSize: number
  requestTimeoutMs: number
  threads: number
}

interface Pending {
  reqId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class WorkerProc {
  child: ChildProcess | null = null
  ready = false
  retiring = false
  inFlight: string | null = null
  pending = new Map<string, Pending>()
  pid = 0
  /** ready 帧原样保留(协议版本/pid 可核验;测试与排障共用) */
  readyFrame: SolverEventFrame | null = null

  constructor(readonly index: number) {}

  async ensureSpawned(pythonPath: string, pythonDir: string, threads: number): Promise<void> {
    if (this.retiring) throw new AppError(503, 'WORKER_RETIRING', 'Solver Worker 正在退出')
    if (this.child && this.ready) return
    if (this.child) return
    const rt = getAmlRuntime()
    const env = solverEnv(rt.root, pythonDir, threads)
    const child = spawnLineProcess(pythonPath, [join(pythonDir, 'worker.py')], { cwd: pythonDir, env, cleanEnv: true })
    this.child = child
    this.pid = child.pid ?? 0
    const rl = createInterface({ input: child.stdout! })
    rl.on('line', line => this.onLine(line))
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd()
      if (text) log.info(`[worker ${this.index}] ${text.slice(-400)}`)
    })
    child.once('exit', (code, signal) => this.onExit(code, signal))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError(503, 'WORKER_START_TIMEOUT', 'Solver Worker 启动超时(未收到 ready 帧)')), 20_000)
      const check = setInterval(() => {
        if (this.ready) { clearInterval(check); clearTimeout(timer); resolve() }
      }, 25)
      child.once('exit', () => { clearInterval(check); clearTimeout(timer); reject(new AppError(503, 'WORKER_EXITED', `Solver Worker 启动即退出(pid=${this.pid})`)) })
    })
  }

  private onLine(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    }
    catch {
      log.warn(`[worker ${this.index}] 非协议 stdout 行被忽略:${line.slice(0, 200)}`)
      return
    }
    if (frame.type === 'ready') {
      const readyFrame = frame as unknown as SolverEventFrame
      const diagPid = Number((readyFrame.diag as { pid?: number } | undefined)?.pid ?? 0)
      if (readyFrame.protocolVersion !== PROTOCOL_VERSION || !Number.isInteger(diagPid) || diagPid <= 0) {
        log.error(`[worker ${this.index}] ready 帧非法(protocolVersion=${String(readyFrame.protocolVersion)} pid=${String(diagPid)});终止该进程`)
        this.retiring = true
        if (this.pid) killHarnessProcess(this.pid)
        return
      }
      this.readyFrame = readyFrame
      this.ready = true
      return
    }
    if (frame.type === 'heartbeat' || frame.type === 'log') {
      if (frame.type === 'log') log.info(`[worker ${this.index}] ${String(frame.message ?? '')}`)
      return
    }
    const reqId = String(frame.reqId ?? '')
    const pending = this.pending.get(reqId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(reqId)
    this.inFlight = null
    pending.resolve(frame)
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.inFlight != null) this.retiring = true
    this.ready = false
    this.child = null
    this.pid = 0
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new AppError(503, 'WORKER_INTERRUPTED', `Solver Worker 退出(code=${code} signal=${signal});在途请求标 interrupted`))
    }
    this.pending.clear()
    this.inFlight = null
  }

  async send(frame: SolverRequestFrame, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.retiring) throw new AppError(503, 'WORKER_NOT_READY', 'Solver Worker 未启动或正在退出')
    const reqId = frame.reqId
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 必须在清空请求前封存,否则并发排队请求会复用即将被终止的旧进程。
        this.retiring = true
        this.pending.delete(reqId)
        this.inFlight = null
        void this.cancel(reqId)
        reject(new AppError(504, 'SOLVE_TIMEOUT', `求解超时(${timeoutMs}ms);已请求取消`))
      }, timeoutMs)
      this.pending.set(reqId, { reqId, resolve, reject, timer })
      this.inFlight = reqId
      this.child!.stdin!.write(`${JSON.stringify(frame)}\n`)
    })
  }

  async cancel(reqId: string): Promise<void> {
    if (!this.child) return
    this.child.stdin?.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, reqId: `cancel-${reqId}`, op: 'cancel', payload: { reqId } })}\n`)
  }
}

export class SolverWorkerPool {
  private readonly workers: WorkerProc[]
  private pythonPath: string | null = null
  private readonly pythonDir = optimizerPythonDir()
  private consecutiveFailures = 0
  private degraded = false
  private nextAttemptAt = 0
  private readonly options: WorkerClientOptions

  constructor(options?: Partial<WorkerClientOptions>) {
    const defaults = workerOptionsFromSettings()
    this.options = { ...defaults, ...options }
    this.workers = Array.from({ length: Math.max(1, Math.min(this.options.poolSize, 4)) }, (_, index) => new WorkerProc(index))
  }

  get size(): number { return this.workers.length }

  /** 在跑 Worker 的 pid(排障/验收:崩溃恢复与进程退出确认) */
  workerPids(): number[] {
    return this.workers.map(w => w.pid).filter(pid => pid > 0)
  }

  stats(): { size: number, ready: number, busy: number, degraded: boolean, pythonPath: string | null } {
    return {
      size: this.workers.length,
      ready: this.workers.filter(w => w.ready && !w.retiring).length,
      busy: this.workers.filter(w => w.inFlight != null || w.retiring).length,
      degraded: this.degraded,
      pythonPath: this.pythonPath,
    }
  }

  async ensureReady(): Promise<string> {
    if (this.pythonPath) return this.pythonPath
    const rt = getAmlRuntime()
    this.pythonPath = await ensureVenv(rt)
    return this.pythonPath
  }

  /** 能力探针:缺依赖返回 ENV_MISSING_DEP(不要等请求崩)。 */
  async probe(): Promise<{ ok: boolean, osqp: boolean, scipy: boolean, pythonPath: string }> {
    const pythonPath = await this.ensureReady()
    // 固定脚本文件(不使用 -c 内联代码,零拼接);子进程统一走 line-spawn 包装
    const child = spawnLineProcess(pythonPath, [join(this.pythonDir, 'probe.py')], {
      cwd: this.pythonDir, env: solverEnv(getAmlRuntime().root, this.pythonDir, this.options.threads), cleanEnv: true,
    })
    const chunks: string[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    const code = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        if (child.pid) killHarnessProcess(child.pid)
        resolve(-1)
      }, 30_000)
      child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode ?? -1) })
    })
    let parsed: { osqp?: string | null, scipy?: string | null } = {}
    try { parsed = JSON.parse(chunks.join('').trim() || '{}') as typeof parsed }
    catch { /* 保持空 */ }
    return { ok: code === 0, osqp: Boolean(parsed.osqp), scipy: Boolean(parsed.scipy), pythonPath }
  }

  async solve(ir: ProblemIR, opts: { timeoutMs?: number, requestId?: string } = {}): Promise<{ result: unknown, workerPid: number, elapsedMs: number }> {
    if (this.degraded) throw new AppError(503, 'SOLVER_UNAVAILABLE', 'Solver Worker 池已降级(连续崩溃);检查 optimizer_capabilities 并重启实例')
    if (Date.now() < this.nextAttemptAt) throw new AppError(503, 'SOLVER_RESTARTING', 'Solver Worker 正在退避重启,请稍后重试')
    const probe = await this.probe()
    if (!probe.ok) throw new AppError(503, 'ENV_MISSING_DEP', '求解环境缺少 osqp/scipy;请重建 AML 环境(requirements 已锁定 osqp)')
    const lease = acquireEnvReadLease('optimizer-solver')
    const started = Date.now()
    try {
      const slot = await this.acquireSlot()
      const reqId = opts.requestId ?? `solve-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs
      try {
        await slot.ensureSpawned(probe.pythonPath, this.pythonDir, this.options.threads)
      }
      catch (err) {
        // 预占失败必须释放,否则该槽位永久 busy
        slot.inFlight = null
        await this.retire(slot)
        throw err
      }
      const frame: SolverRequestFrame = {
        protocolVersion: PROTOCOL_VERSION, reqId, op: 'solve',
        payload: { problemIr: ir }, deadlineMs: timeoutMs,
      }
      try {
        const response = await slot.send(frame, timeoutMs) as SolverResponseFrame
        this.consecutiveFailures = 0
        if (!response.ok) {
          const error = response.error ?? { code: 'SOLVER_ERROR', message: 'unknown' }
          throw new AppError(422, error.code, error.message)
        }
        return { result: response.result, workerPid: slot.pid, elapsedMs: Date.now() - started }
      }
      catch (err) {
        const code = err instanceof AppError ? err.code : ''
        if (code === 'SOLVE_TIMEOUT' || code === 'WORKER_INTERRUPTED') {
          // 超时/崩溃:独占进程直接终止(单任务进程,安全兜底),确认退出后从池移除
          await this.retire(slot)
          this.consecutiveFailures++
          if (this.consecutiveFailures >= 3) {
            this.degraded = true
            log.error('[optimizer-worker] 连续 3 次失败,池降级为不可用')
          }
          else {
            this.nextAttemptAt = Date.now() + Math.min(4000, 1000 * 2 ** (this.consecutiveFailures - 1))
          }
        }
        throw err
      }
    }
    finally {
      lease.release()
    }
  }

  async cancel(reqId: string): Promise<void> {
    for (const worker of this.workers) {
      if (worker.inFlight === reqId) await worker.cancel(reqId)
    }
  }

  /** 确认旧进程已退出才回收;超时则强杀进程树(Windows /T /F)。 */
  private async retire(worker: WorkerProc): Promise<void> {
    worker.retiring = true
    const child = worker.child
    if (!child) { worker.retiring = false; return }
    const exited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), KILL_CONFIRM_MS)
      child.once('exit', () => { clearTimeout(timer); worker.retiring = false; resolve(true) })
    })
    if (worker.pid) killHarnessProcess(worker.pid)
    const confirmed = await exited
    if (!confirmed) {
      log.error(`[optimizer-worker] pid=${worker.pid} 5s 内未确认退出(KILL_CONFIRM=WORKER_KILL_FAILED),隔离该进程`)
      // 保留封存槽位;仅当该进程真正退出后允许补位,不能静默缩小池容量。
    }
  }

  private async acquireSlot(): Promise<WorkerProc> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const free = this.workers.find(w => w.inFlight == null && !w.retiring)
      if (free) {
        // 预占:从 acquire 到 send 之间有 await(ensureSpawned),不预占会被并发请求
        // 拿到同一进程并触发 SOLVER_BUSY。
        free.inFlight = `reserved-${Date.now().toString(36)}-${attempt}`
        return free
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new AppError(429, 'SOLVER_QUEUE_FULL', 'Solver 进程池持续繁忙;请降低并发或扩大池上限')
  }

  async shutdown(): Promise<void> {
    for (const worker of this.workers) {
      if (worker.pid) killHarnessProcess(worker.pid)
      worker.child = null
    }
    this.workers.length = 0
  }
}

function workerOptionsFromSettings(): WorkerClientOptions {
  const s = optimizerSolverSettings()
  return { poolSize: s.poolSize, requestTimeoutMs: s.requestTimeoutMs, threads: s.threads }
}

const g = globalThis as typeof globalThis & { __optimizerWorkerPool?: SolverWorkerPool }

export function getSolverWorkerPool(): SolverWorkerPool {
  g.__optimizerWorkerPool ??= new SolverWorkerPool()
  return g.__optimizerWorkerPool
}

/** 环境重建前由 env-manager 调用:先停 Worker(Windows rmSync 才能成功)。 */
export function shutdownSolverWorkers(): void {
  const pool = g.__optimizerWorkerPool
  if (!pool) return
  void pool.shutdown()
  g.__optimizerWorkerPool = undefined
}
