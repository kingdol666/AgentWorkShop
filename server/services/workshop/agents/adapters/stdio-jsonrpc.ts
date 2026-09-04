/**
 * StdioJsonRpcClient —— NDJSON JSON-RPC 2.0 子进程客户端(codex app-server / dsh ACP 共用基座)。
 *
 * 职责:
 *  - 拉起子进程(line-spawn 受控面:拒绝 shell 元字符/路径校验/shell:false),
 *    逐行解析 stdout JSON-RPC 帧(响应/通知/服务端请求三分)
 *  - request():id 关联 + 超时;notify();onNotification/onRequest 订阅
 *  - 服务端→客户端请求(handler 异步产出 result 或 error 回传)
 *  - 进程退出广播 / OS 存活校准(reconcile)/ 强杀
 *
 * 帧约定:stdio 逐行;"jsonrpc" 头可省略(codex app-server 线上格式)。
 */
import { isProcessAlive } from '../harness-process'
import { spawnLineProcess } from './line-spawn'
import type { ChildProcess } from 'node:child_process'

export interface JsonRpcRequestIncoming {
  kind: 'request'
  id: string | number
  method: string
  params: unknown
}
export interface JsonRpcNotification {
  kind: 'notification'
  method: string
  params: unknown
}
export type JsonRpcIncoming = JsonRpcRequestIncoming | JsonRpcNotification

export interface StdioJsonRpcOptions {
  /** 展示名(日志/错误前缀) */
  name: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /** 请求默认超时(ms) */
  requestTimeoutMs?: number
  /** spawn → 可发首请求的就绪超时(ms;仅防 spawn 失败,不等协议握手) */
  startTimeoutMs?: number
  onExit?: (code: number | null) => void
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class StdioJsonRpcClient {
  private child: ChildProcess | null = null
  private readonly pending = new Map<string, Pending>()
  private seq = 0
  private exited = false
  private disposed = false
  private exitCode: number | null = null
  private stdoutBuf = ''
  private stderrTail = ''
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>()
  private readonly requestListeners = new Set<(req: JsonRpcRequestIncoming) => void>()
  private readonly exitListeners = new Set<(code: number | null) => void>()
  /** 退出广播已发(幂等) */
  private exitNotified = false
  /** 是否收到过任意合法帧(就绪前退出判定的辅助位) */
  private readySeen = false

  constructor(private readonly options: StdioJsonRpcOptions) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  get alive(): boolean {
    return !!this.child && !this.exited
  }

  /** stderr 尾部(诊断) */
  get stderr(): string {
    return this.stderrTail
  }

  /** 拉起子进程(spawn 错误/提前退出 → reject;不等待协议握手) */
  async start(): Promise<void> {
    const o = this.options
    try {
      this.child = spawnLineProcess(o.command, o.args ?? [], {
        cwd: o.cwd,
        env: o.env,
      })
    }
    catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }
    const startedAt = Date.now()
    const startTimeoutMs = o.startTimeoutMs ?? 15_000
    return new Promise<void>((resolve, reject) => {
      this.child!.stdout?.setEncoding('utf-8')
      this.child!.stderr?.setEncoding('utf-8')
      this.child!.stdin?.on('error', () => {})
      this.child!.stdout?.on('error', () => {})
      this.child!.stderr?.on('error', () => {})
      this.child!.stdout?.on('data', (d: string) => this.onStdout(d))
      this.child!.stderr?.on('data', (d: string) => {
        this.stderrTail = (this.stderrTail + d).slice(-8000)
      })
      this.child!.on('error', (err: Error) => {
        if (Date.now() - startedAt < startTimeoutMs && !this.exited) reject(err)
        else this.handleExit(null, err)
      })
      this.child!.on('exit', (code: number | null) => {
        if (Date.now() - startedAt < startTimeoutMs && !this.exited && !this.readySeen) {
          reject(new Error(`${o.name} 子进程在就绪前退出(code=${code})${this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-500)}` : ''}`))
        }
        else {
          this.handleExit(code)
        }
      })
      // 拉起成功即视为已启动(协议握手由上层 request 驱动;失败经 request 超时/exit 显性化)
      if (this.child!.pid) resolve()
      else reject(new Error(`${o.name} 拉起失败(无 pid)`))
    })
  }

  /** JSON-RPC 请求(等待响应;超时 reject) */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.child?.stdin?.writable) throw new Error(`${this.options.name} 子进程未就绪或已关闭`)
    if (this.disposed) throw new Error(`${this.options.name} 客户端已 dispose`)
    const id = ++this.seq
    const frame = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new Error(`${this.options.name} 请求超时: ${method} (id=${id},${timeoutMs ?? this.options.requestTimeoutMs ?? 60_000}ms)`))
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 60_000)
      this.pending.set(String(id), {
        resolve: resolve as (r: unknown) => void,
        reject,
        timer,
      })
      this.writeFrame(frame, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(String(id))
          reject(new Error(`${this.options.name} 写入失败: ${err.message}`))
        }
      })
    })
  }

  /** 通知(无响应) */
  notify(method: string, params?: unknown): void {
    const frame = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }
    this.writeFrame(frame, () => {})
  }

  /** 应答服务端请求 */
  respond(id: string | number, result: unknown): void {
    this.writeFrame({ jsonrpc: '2.0', id, result }, () => {})
  }

  respondError(id: string | number, code: number, message: string): void {
    this.writeFrame({ jsonrpc: '2.0', id, error: { code, message } }, () => {})
  }

  onNotification(fn: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(fn)
    return () => this.notificationListeners.delete(fn)
  }

  /** 服务端→客户端请求订阅(handler 内自行调用 respond/respondError) */
  onRequest(fn: (req: JsonRpcRequestIncoming) => void): () => void {
    this.requestListeners.add(fn)
    return () => this.requestListeners.delete(fn)
  }

  /** 进程退出订阅(含 OS 校准收敛;幂等触发) */
  onExit(fn: (code: number | null) => void): () => void {
    this.exitListeners.add(fn)
    return () => this.exitListeners.delete(fn)
  }

  /** OS 级存活校准(进程已死 → 收敛为退出;幂等) */
  reconcile(): boolean {
    const pid = this.child?.pid
    if (!pid || this.exited || this.disposed) return true
    if (isProcessAlive(pid)) return true
    this.handleExit(null)
    return false
  }

  kill(): void {
    this.child?.kill('SIGKILL')
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      this.child?.stdin?.end()
    }
    catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      if (!this.child || this.exited) return resolve()
      const timer = setTimeout(() => {
        this.child?.kill('SIGKILL')
        resolve()
      }, 3000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`${this.options.name} 客户端已 dispose`))
    }
    this.pending.clear()
  }

  get lastExitCode(): number | null {
    return this.exitCode
  }

  // ===== 内部 =====

  private writeFrame(frame: Record<string, unknown>, cb: (err: Error | null) => void): void {
    if (!this.child?.stdin?.writable) {
      cb(new Error('stdio 已关闭'))
      return
    }
    this.child.stdin.write(JSON.stringify(frame) + '\n', err => cb(err ?? null))
  }

  private onStdout(data: string): void {
    this.stdoutBuf += data
    if (this.stdoutBuf.length > 8 * 1024 * 1024) this.stdoutBuf = ''
    const lines = this.stdoutBuf.split('\n')
    this.stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(trimmed)
      }
      catch {
        continue // 非 JSON 行(横幅/日志混流)忽略
      }
      this.readySeen = true
      this.dispatch(frame)
    }
  }

  private dispatch(frame: Record<string, unknown>): void {
    const hasId = frame.id !== undefined && frame.id !== null
    const method = typeof frame.method === 'string' ? frame.method : undefined

    if (method === undefined && hasId) {
      // 响应帧
      const p = this.pending.get(String(frame.id))
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(String(frame.id))
      if (frame.error && typeof frame.error === 'object') {
        const e = frame.error as { code?: number, message?: string }
        p.reject(new Error(`${this.options.name} RPC 错误${e.code != null ? `(${e.code})` : ''}: ${e.message ?? '未知错误'}`))
      }
      else {
        p.resolve(frame.result)
      }
      return
    }

    if (method && hasId) {
      // 服务端请求
      const req: JsonRpcRequestIncoming = { kind: 'request', id: frame.id as string | number, method, params: frame.params }
      for (const fn of this.requestListeners) {
        try {
          fn(req)
        }
        catch { /* handler 异常不影响分发 */ }
      }
      return
    }

    if (method) {
      // 通知
      for (const fn of this.notificationListeners) {
        try {
          fn(method, frame.params)
        }
        catch { /* ignore */ }
      }
    }
  }

  private handleExit(code: number | null, spawnErr?: Error): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`${this.options.name} 子进程退出(code=${code})${spawnErr ? `:${spawnErr.message}` : ''}${this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-400)}` : ''}`))
    }
    this.pending.clear()
    if (!this.exitNotified) {
      this.exitNotified = true
      for (const fn of this.exitListeners) {
        try {
          fn(code)
        }
        catch { /* ignore */ }
      }
    }
  }
}
