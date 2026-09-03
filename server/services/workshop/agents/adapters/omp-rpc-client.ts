/**
 * OmpRpcClient — omp `--mode rpc` stdio JSONL 传输客户端。
 *
 * 职责:
 *  - spawn omp 子进程(ready frame 握手 + v2 chunk 重组)
 *  - 命令/响应关联(按 id 匹配,RpcCommand → RpcResponse)
 *  - AgentSessionEvent 事件流转发(message_update / tool_execution_* / agent_end 等)
 *  - host_tool_call 请求转发到宿主 handler → host_tool_result 回传
 *  - AbortSignal 取消传导(中断当前 prompt)
 *
 * 协议权威见 omp://rpc.md。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { isProcessAlive } from '../harness-process'

// ===== 协议帧类型(仅本项目消费的子集) =====

/** 入站命令:本客户端发送给 omp 的请求 */
export type RpcCommand
  = | { id?: string, type: 'prompt', message: string, streamingBehavior?: 'steer' | 'followUp' }
    | { id?: string, type: 'steer', message: string }
    | { id?: string, type: 'follow_up', message: string }
    | { id?: string, type: 'abort' }
    | { id?: string, type: 'set_host_tools', tools: RpcHostToolDefinition[] }
    | { id?: string, type: 'set_todos', phases: unknown[] }
    | { id?: string, type: 'negotiate_protocol', protocolVersion: number }
    | { id?: string, type: 'set_model', provider: string, modelId: string }
    | { id?: string, type: 'get_state' }
    | { id?: string, type: 'new_session' }
    // ===== 上下文治理(70% 压缩环;协议权威 omp://rpc.md)=====
    | { id?: string, type: 'get_session_stats' }
    | { id?: string, type: 'compact', customInstructions?: string }
    | { id?: string, type: 'set_auto_compaction', enabled: boolean }

/** compaction 结果(compaction_end 事件 / compact 响应 data.result 共用形状) */
export interface CompactionResult {
  summary?: string
  tokensBefore?: number
  tokensAfter?: number
  estimatedTokensAfter?: number
}

/** provider 用量(被动上下文跟踪源;message_update 等帧携带的累计值) */
export interface RpcUsage {
  /** input tokens ≈ 当前上下文长度(本回合 LLM 调用的 prompt 规模) */
  input: number
  output?: number
  cacheRead?: number
  at: number
}
/** host 工具定义(omp 端可见的工具 schema) */
export interface RpcHostToolDefinition {
  name: string
  label?: string
  description: string
  parameters: Record<string, unknown>
  hidden?: boolean
}

/** RPC 响应(命令执行结果) */
export interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
  code?: string
}

/** omp AgentSession 事件(本项目消费的子集) */
export interface AgentSessionEvent {
  type: string
  // message_update
  assistantMessageEvent?: {
    type: 'text_delta' | 'text_start' | 'text_end' | 'thinking_delta' | 'tool_call' | 'tool_result' | string
    delta?: string
    text?: string
    toolName?: string
    toolCallId?: string
    [k: string]: unknown
  }
  message?: { role: string, content: unknown[] }
  // agent_end
  messages?: Array<{ role: string, content: Array<{ type: string, text?: string }> }>
  isTerminal?: boolean
  // tool_execution
  toolName?: string
  toolCallId?: string
  [k: string]: unknown
}

/** omp 向宿主发起的 host_tool_call 请求 */
export interface HostToolCallRequest {
  id: string
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
}

/** 宿主工具 handler:接收 omp 的工具调用,返回结果 */
export type HostToolHandler = (req: HostToolCallRequest) => Promise<{ text: string, isError?: boolean }>

/** RPC 客户端配置 */
export interface OmpRpcClientOptions {
  /** omp 可执行文件路径(默认 'omp') */
  command?: string
  /**
   * 输出模式:'rpc' = 纯协议(无 UI);'rpc-ui' = 协议 + UI 上下文
   * (ask 工具 / extension_ui_request 对话框可用 —— HITL 通道;强制 noPty)。默认 'rpc'。
   */
  mode?: 'rpc' | 'rpc-ui'
  /** 额外 CLI 参数 */
  args?: string[]
  /** 工作目录 */
  cwd?: string
  /** 环境变量 */
  env?: Record<string, string>
  /** 进程退出回调(运行时资源监控登记/标记用;pid 为 -1 表示无法取得) */
  onExit?: (pid: number, code: number | null) => void
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** 流式缓冲上限(超限截断并计数,防大输出/异常流拖爆内存) */
const STDERR_CAP = 1024 * 1024
const STDOUT_LINE_CAP = 8 * 1024 * 1024
/** chunk 重组缓冲 TTL(残缺分片 30s 后清理,base64 大 payload 不永久驻留) */
const CHUNK_TTL_MS = 30_000

/**
 * OmpRpcClient — omp RPC 子进程的完整客户端。
 *
 * 用法:
 *   const client = new OmpRpcClient({ command: 'omp' })
 *   await client.start()
 *   client.onEvent(event => ...)
 *   client.onHostToolCall(async req => { ... return { text } })
 *   await client.send({ type: 'set_host_tools', tools: [...] })
 *   const resp = await client.send({ type: 'prompt', message: '...' })
 *   await client.dispose()
 */
export class OmpRpcClient {
  private child: ChildProcess | null = null
  private stdoutBuf = ''
  private stderrBuf = ''
  private stderrTruncated = 0
  private ready = false
  private disposed = false
  /** 子进程是否已退出(资源监控/优雅 dispose 用) */
  private exited = false
  private exitCode: number | null = null

  private readonly pending = new Map<string, PendingRequest>()
  private seq = 0

  /** 被动上下文跟踪:最近一次帧携带的累计 provider usage(get_session_stats 不可用时的兜底源) */
  private lastUsage: RpcUsage | null = null
  /** 上下文窗口大小(外部经 get_state 探测后注入;null = 未知,percent 不可算) */
  private contextWindow: number | null = null

  private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>()
  /** 原始帧 tap(chunk 重组后的每一帧,含 response/host_tool_call/extension_ui_request) */
  private readonly rawFrameListeners = new Set<(frame: Record<string, unknown>) => void>()
  private hostToolHandler: HostToolHandler | null = null

  /** v2 chunk 重组缓冲(带最近活跃时间;TTL 清理残缺分片) */
  private readonly chunkBuffers = new Map<string, { count: number, parts: Map<number, string>, at: number }>()

  constructor(private readonly options: OmpRpcClientOptions = {}) {}

  /** 子进程 pid(spawn 前/失败为 undefined;已退出仍保留) */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** 子进程是否存活(spawn 前或已退出 → false) */
  get alive(): boolean {
    return !!this.child && !this.exited
  }

  /** 注入上下文窗口大小(get_state 探测 model.contextWindow 后调用;幂等) */
  setContextWindow(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.contextWindow = tokens
  }

  /** 被动上下文用量快照(无探测 RPC;数据来自最近一次携带 usage 的帧) */
  getContextUsage(): { tokens: number, contextWindow: number | null, percent: number | null } | null {
    if (!this.lastUsage) return null
    const window = this.contextWindow
    return {
      tokens: this.lastUsage.input,
      contextWindow: window,
      percent: window && window > 0 ? Math.min(1, this.lastUsage.input / window) : null,
    }
  }

  /**
   * 从帧中防御性提取累计 usage(顶层 frame.usage 或 frame.message.usage;
   * input 兼容 input/inputTokens/promptTokens 命名;无有效 input 返回 null)。
   */
  private extractUsage(frame: Record<string, unknown>): RpcUsage | null {
    const raw = (frame.usage ?? (frame.message as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined
    if (!raw || typeof raw !== 'object') return null
    const input = Number(raw.input ?? raw.inputTokens ?? raw.promptTokens)
    if (!Number.isFinite(input) || input <= 0) return null
    const output = Number(raw.output ?? raw.outputTokens)
    const cacheRead = Number(raw.cacheRead)
    return {
      input,
      output: Number.isFinite(output) ? output : undefined,
      cacheRead: Number.isFinite(cacheRead) ? cacheRead : undefined,
      at: Date.now(),
    }
  }

  /**
   * OS 级存活校准(系统休眠/强杀后 exit 事件可能不达,alive 会失真):
   * 按 PID 探 OS 实际存在性,进程已死则收敛为已退出(与 exit 事件同路径:
   * onExit 登记、拒绝 pending、广播 __process_exit__),在途回合据此归位,
   * 后续 ensureClient 得以重生子进程。幂等;进程健在/未 spawn 时无操作。
   */
  reconcile(): boolean {
    const pid = this.child?.pid
    if (!pid || this.exited || this.disposed) return true
    if (isProcessAlive(pid)) return true
    this.handleExit(null)
    return false
  }

  /** 强制终止子进程(不等优雅退出;进程树终止由监控层 killHarnessProcess 负责) */
  kill(): void {
    this.child?.kill('SIGKILL')
  }

  /** spawn omp 子进程,等待 ready frame */
  async start(): Promise<void> {
    const command = this.options.command ?? 'omp'
    const mode = this.options.mode ?? 'rpc'
    const args = ['--mode', mode, ...(this.options.args ?? [])]

    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd ?? process.cwd(),
      env: { ...process.env, ...this.options.env },
      windowsHide: true,
    })

    this.child.stdout?.setEncoding('utf-8')
    this.child.stderr?.setEncoding('utf-8')
    // stdio 流级 error 兜底监听:进程被强杀(terminate/进程树 kill)后写 stdin 会
    // 触发流 'error'(EPIPE);无监听者会升级为 uncaughtException。真实失败语义
    // 由 send 回调 / exit 事件传导,这里仅吞流级噪声。
    this.child.stdin?.on('error', () => {})
    this.child.stdout?.on('error', () => {})
    this.child.stderr?.on('error', () => {})

    return new Promise<void>((resolve, reject) => {
      const onReady = (frame: AgentSessionEvent): void => {
        if (frame.type === 'ready' && !this.ready) {
          this.ready = true
          resolve()
        }
      }
      this.eventListeners.add(onReady as (event: AgentSessionEvent) => void)

      this.child!.stdout!.on('data', (data: string) => this.onStdout(data))
      this.child!.stderr!.on('data', (data: string) => {
        this.stderrBuf += data
        if (this.stderrBuf.length > STDERR_CAP) {
          // 保留尾部(诊断价值最高),截断部分计数可见
          this.stderrTruncated += this.stderrBuf.length - STDERR_CAP
          this.stderrBuf = this.stderrBuf.slice(-STDERR_CAP)
        }
      })
      this.child!.on('error', (err: Error) => {
        if (!this.ready) reject(err)
        else this.notifyError(err)
      })
      this.child!.on('exit', (code: number | null) => {
        if (!this.ready) {
          reject(new Error(`omp 子进程在 ready 前退出(code=${code})${this.stderrBuf ? `\nstderr: ${this.stderrBuf.slice(-500)}` : ''}`))
        }
        else {
          this.handleExit(code)
        }
      })

      // 超时保护
      setTimeout(() => {
        if (!this.ready) reject(new Error('omp RPC ready 超时(10s)'))
      }, 10_000)
    })
  }

  /** 发送命令,等待关联响应 */
  async send<T = RpcResponse>(command: RpcCommand): Promise<T & RpcResponse> {
    if (!this.child?.stdin?.writable) throw new Error('omp 子进程未就绪或已关闭')
    if (this.disposed) throw new Error('omp RPC 客户端已 dispose')

    const id = command.id ?? `req_${++this.seq}`
    const frame = JSON.stringify({ ...command, id }) + '\n'

    return new Promise<T & RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`omp RPC 命令超时: ${command.type} (id=${id})`))
      }, 60_000)

      this.pending.set(id, {
        resolve: resolve as (r: RpcResponse) => void,
        reject,
        timer,
      })

      this.child!.stdin!.write(frame, (err) => {
        if (err) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(new Error(`omp RPC 写入失败: ${err.message}`))
        }
      })
    })
  }

  /** 订阅 AgentSessionEvent 流 */
  onEvent(fn: (event: AgentSessionEvent) => void): () => void {
    this.eventListeners.add(fn)
    return () => {
      this.eventListeners.delete(fn)
    }
  }

  /**
   * 订阅原始帧流(chunk 重组后的每一帧,含 response / host_tool_call /
   * extension_ui_request / 全部会话事件)。终端镜像(harness-terminal)的事实源。
   */
  onRawFrame(fn: (frame: Record<string, unknown>) => void): () => void {
    this.rawFrameListeners.add(fn)
    return () => {
      this.rawFrameListeners.delete(fn)
    }
  }

  /**
   * 写入原始 stdin 帧(不走命令/响应关联)——用于 side-channel 帧
   * (extension_ui_response 等)。
   */
  writeRaw(frame: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) throw new Error('omp 子进程未就绪或已关闭')
    this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  /** 注册 host 工具 handler(omp 调用宿主工具时回调) */
  onHostToolCall(handler: HostToolHandler): void {
    this.hostToolHandler = handler
  }

  /** 优雅关闭:中止当前 prompt → 等待退出 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // 尝试优雅关闭(stdin close → omp 排空后 exit 0)
    try {
      if (this.child?.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.end()
      }
    }
    catch {
      // ignore
    }

    // 等待退出,最多 3s
    await new Promise<void>((resolve) => {
      if (!this.child || this.child.killed || this.exited) return resolve()
      const timer = setTimeout(() => {
        this.child?.kill('SIGKILL')
        resolve()
      }, 3_000)
      this.child!.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    // 清理 pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('omp RPC 客户端已 dispose'))
    }
    this.pending.clear()
    this.eventListeners.clear()
    this.rawFrameListeners.clear()
  }

  // ===== 内部 =====

  /** stdout 数据处理:逐行 JSON 解析 → 分发 */
  private onStdout(data: string): void {
    this.stdoutBuf += data
    if (this.stdoutBuf.length > STDOUT_LINE_CAP) {
      // 半行缓冲异常膨胀(对端异常流):丢弃已积累部分,防内存无界增长
      this.stdoutBuf = ''
    }
    const lines = this.stdoutBuf.split('\n')
    this.stdoutBuf = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const frame = JSON.parse(trimmed)
        this.dispatchFrame(frame)
      }
      catch {
        // 非 JSON 行(理论上不应出现):忽略
      }
    }
  }

  /** 分发单个 JSON 帧 */
  private dispatchFrame(frame: Record<string, unknown>): void {
    const type = frame.type as string

    // 被动上下文跟踪:任何帧携带累计 usage 都刷新最近值(零额外请求)
    const usage = this.extractUsage(frame)
    if (usage) this.lastUsage = usage

    // 原始帧镜像(终端 hub;listener 异常不影响协议处理)
    for (const fn of this.rawFrameListeners) {
      try {
        fn(frame)
      }
      catch {
        /* ignore */
      }
    }

    // v2 chunk 重组
    if (type === 'rpc_chunk') {
      this.handleChunk(frame as unknown as RpcChunkFrame)
      return
    }

    // 命令响应
    if (type === 'response') {
      const resp = frame as unknown as RpcResponse
      const id = resp.id
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!
        clearTimeout(p.timer)
        this.pending.delete(id)
        if (resp.success) p.resolve(resp)
        else p.reject(new Error(resp.error ?? `omp RPC 命令失败: ${resp.command}`))
      }
      return
    }

    // host_tool_call:转发到宿主 handler
    if (type === 'host_tool_call') {
      void this.handleHostToolCall(frame as unknown as HostToolCallFrame)
      return
    }

    // host_tool_cancel:忽略(当前实现不支持中途取消 host tool)
    if (type === 'host_tool_cancel') return

    // extension_ui_request / available_commands_update / 其他事件:作为 session event 转发
    for (const fn of this.eventListeners) {
      try {
        fn(frame as unknown as AgentSessionEvent)
      }
      catch (err) {
        // listener 异常不影响协议处理
        void err
      }
    }
  }

  /** 处理 host_tool_call:调 handler → 发 host_tool_result */
  private async handleHostToolCall(req: HostToolCallFrame): Promise<void> {
    const { id, toolCallId, toolName, arguments: args } = req
    let result: { text: string, isError?: boolean }

    if (this.hostToolHandler) {
      try {
        result = await this.hostToolHandler({ id, toolCallId, toolName, arguments: args ?? {} })
      }
      catch (err) {
        result = { text: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }
    else {
      result = { text: `无 host tool handler 注册(toolName=${toolName})`, isError: true }
    }

    // 发送 host_tool_result
    const resultFrame = {
      type: 'host_tool_result' as const,
      id,
      result: {
        content: [{ type: 'text' as const, text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      },
    }
    try {
      this.child?.stdin?.write(JSON.stringify(resultFrame) + '\n')
    }
    catch {
      // 进程可能已关闭
    }
  }

  /** v2 chunk 重组 */
  private handleChunk(frame: RpcChunkFrame): void {
    const { chunkId, index, count, byteLength, data } = frame
    if (!chunkId || typeof index !== 'number' || typeof count !== 'number') return

    // TTL 清扫:残缺分片(丢失/乱序未收齐)30s 后释放
    const now = Date.now()
    for (const [cid, b] of this.chunkBuffers) {
      if (now - b.at > CHUNK_TTL_MS) this.chunkBuffers.delete(cid)
    }

    let buf = this.chunkBuffers.get(chunkId)
    if (!buf) {
      buf = { count, parts: new Map(), at: now }
      this.chunkBuffers.set(chunkId, buf)
    }
    buf.at = now
    buf.parts.set(index, data ?? '')

    // 全部分片到齐 → 重组
    if (buf.parts.size === buf.count) {
      const sorted = [...buf.parts.entries()].sort((a, b) => a[0] - b[0])
      const b64 = sorted.map(([, d]) => d).join('')
      this.chunkBuffers.delete(chunkId)
      try {
        const json = Buffer.from(b64, 'base64').toString('utf-8')
        const frame = JSON.parse(json)
        void byteLength
        this.dispatchFrame(frame)
      }
      catch {
        // chunk 重组失败:忽略
      }
    }
  }

  /** 子进程退出处理(exit 事件 / OS 存活校准 reconcile 共用;幂等) */
  private handleExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    this.options.onExit?.(this.child?.pid ?? -1, code)
    // 拒绝所有 pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`omp 子进程退出(code=${code})`))
    }
    this.pending.clear()

    // 通知事件监听器
    for (const fn of this.eventListeners) {
      try {
        fn({ type: '__process_exit__', isTerminal: true } as unknown as AgentSessionEvent)
      }
      catch { /* ignore */ }
    }
  }

  private notifyError(err: Error): void {
    for (const fn of this.eventListeners) {
      try {
        fn({ type: '__error__', isTerminal: true, messages: [], ...(err.message ? { error: err.message } : {}) } as unknown as AgentSessionEvent)
      }
      catch { /* ignore */ }
    }
  }
}

// ===== 内部帧类型 =====

interface RpcChunkFrame {
  type: 'rpc_chunk'
  chunkId: string
  index: number
  count: number
  byteLength: number
  data: string
}

interface HostToolCallFrame {
  type: 'host_tool_call'
  id: string
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
}
