/**
 * ClaudeSdkAgentImpl — Anthropic Claude Agent SDK(@anthropic-ai/claude-agent-sdk)的
 * AgentInterface 实现(骨架升级为全量)。
 *
 * 进程模型:每 Agent 一个常驻 SDK 会话(lazy 启动;SDK 自管 claude 二进制),跨消息复用;
 * 输入为 AsyncGenerator(流式输入)→ steer 同轮注入可用;abort → AbortController + interrupt。
 *
 *  - 事件映射:system/init(session_id/model) → status;assistant(text/tool_use 块) →
 *    delta/🔧 status;result(subtype/usage/total_cost_usd) → artifact+done / error
 *  - HITL:canUseTool → hitl-registry(kind 'claude-permission') → respondHitl →
 *    PermissionResult(allow/deny;超时/取消 fail-closed);AW 桥工具经
 *    allowedTools ['mcp__aw'] 预授权,不走审批
 *  - 工具:mcpServers.aw = stdio 桥(与 codex/dsh/opencode 同构;工具清单动态经
 *    tools/list 拉取,适配插件热更);agent 身份经 env 继承到桥进程
 *  - 上下文:SDK 原生 auto-compact(compact_boundary 消息观测);usage 从 result 透出
 *  - 鉴权/网关:config.apiKey → ANTHROPIC_AUTH_TOKEN;config.providerBaseUrl →
 *    ANTHROPIC_BASE_URL(智谱 coding plan Anthropic 兼容端点实测可用);
 *    config.model → ANTHROPIC_MODEL
 *
 * SDK 经动态 import 装配:依赖缺失时回合产出 HARNESS_NOT_CONFIGURED(注册表仍可列出)。
 */
import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger'
import type {
  AgentEvent,
  AgentInterface,
  AgentRunContext,
  AgentRunRequest,
} from './agent-interface'
import type { AgentContextStats } from '../types/task'
import { workerPrompt, peerPrompt, systemManual } from './prompt-builder'
import { getHitlRegistry } from './hitl-registry'
import { harnessSettings } from '../settings'
import { generateMcpBridgeEnv } from './harness-env'
import { BaseAgentImpl } from './base-agent'

const log = createLogger('workshop.claude')

export interface ClaudeAgentConfig {
  model?: string
  /** Anthropic 兼容网关(缺省继承进程环境 ANTHROPIC_BASE_URL) */
  providerBaseUrl?: string
  /** ANTHROPIC_AUTH_TOKEN(缺省继承进程环境) */
  apiKey?: string
  permissionMode?: string
  maxTurns?: number
  cwd?: string
  contextWindow?: number
  promptTimeoutMs?: number
  superviseTimeoutMs?: number
  systemPromptPrefix?: string
  scenarioPrompt?: string
  agentId?: string
  name?: string
  role?: 'lead' | 'worker'
  channelId?: string
  token?: string
  baseUrl?: string
  mcpBridgePath?: string
  [key: string]: unknown
}

interface SdkUserMessage {
  type: 'user'
  message: { role: 'user', content: string }
  parent_tool_use_id: null
  session_id: string | null
}

/** canUseTool 的裁决结果(结构对齐 SDK PermissionResult) */
type PermissionVerdict
  = | { behavior: 'allow', updatedInput: Record<string, unknown> }
    | { behavior: 'deny', message: string }

export class ClaudeSdkAgentImpl extends BaseAgentImpl implements AgentInterface {
  private readonly config: ClaudeAgentConfig

  private agentRole: 'lead' | 'worker' = 'worker'
  /** SDK 会话句柄(动态类型:依赖包可能未安装) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null
  private abortCtrl: AbortController | null = null
  private pushMessage: ((m: SdkUserMessage) => void) | null = null
  private closeInput: (() => void) | null = null
  private sessionId: string | null = null
  private sessionStarting: Promise<void> | null = null
  private turnActive = false
  private lastUsage: { inputTokens: number, outputTokens: number, costUsd: number, at: number } | null = null
  private pendingPermissions = new Map<string, {
    resolve: (verdict: PermissionVerdict) => void
    input: Record<string, unknown>
    timer: ReturnType<typeof setTimeout> | null
  }>()

  constructor(config: Record<string, unknown> = {}) {
    super({
      agentId: typeof config.agentId === 'string' ? config.agentId : '',
      name: typeof config.name === 'string' ? config.name : undefined,
      role: config.role === 'lead' ? 'lead' : 'worker',
      channelId: typeof config.channelId === 'string' ? config.channelId : '',
    })
    this.config = config as ClaudeAgentConfig
  }

  protected get harnessId(): string {
    return 'claude'
  }

  protected configRecord(): Record<string, unknown> {
    return this.config
  }

  async dispose(): Promise<void> {
    for (const [, p] of this.pendingPermissions) {
      if (p.timer) clearTimeout(p.timer)
      p.resolve({ behavior: 'deny', message: '实例已释放' })
    }
    this.pendingPermissions.clear()
    this.closeInput?.()
    this.abortCtrl?.abort()
    try {
      await this.session?.interrupt?.()
    }
    catch { /* 会话可能已结束 */ }
    this.session = null
    this.pushMessage = null
    this.closeInput = null
  }

  getProcessInfo(): null {
    return null // SDK 自管二进制生命周期,无宿主侧进程句柄
  }

  killProcess(): void {
    this.abortCtrl?.abort()
    void this.session?.interrupt?.().catch(() => {})
  }

  getContextStats(): AgentContextStats | null {
    if (!this.lastUsage) return null
    const window = this.config.contextWindow ?? 200_000
    return {
      usedTokens: this.lastUsage.inputTokens,
      contextWindow: window,
      percent: window > 0 ? Math.min(1, this.lastUsage.inputTokens / window) : null,
      compacting: false,
    }
  }

  /** steer:流式输入会话活跃时同轮注入(七引擎中第二个原生 steer 面) */
  steer(text: string): Promise<'steer' | 'deferred'> {
    if (this.turnActive && this.pushMessage) {
      this.pushMessage({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      })
      return Promise.resolve('steer')
    }
    return Promise.resolve('deferred')
  }

  /** HITL 应答:canUseTool 挂起的权限请求 → allow/deny(fail-closed) */
  async respondHitl(kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    comment?: string
  }): Promise<void> {
    if (kind !== 'claude-permission') return
    const pending = this.pendingPermissions.get(id)
    if (!pending) throw new Error(`待办不存在或已处理: ${id}`)
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingPermissions.delete(id)
    if (outcome.confirmed === true) {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
    }
    else {
      const reason = outcome.cancelled === true
        ? '人类放弃本次请求'
        : (outcome.comment ?? '已拒绝')
      pending.resolve({ behavior: 'deny', message: reason })
    }
    getHitlRegistry().resolve('claude-permission', id, outcome.cancelled === true ? 'cancelled' : 'answered')
  }

  private denyPending(id: string, resolution: 'answered' | 'cancelled' | 'expired'): void {
    const p = this.pendingPermissions.get(id)
    if (!p) return
    if (p.timer) clearTimeout(p.timer)
    this.pendingPermissions.delete(id)
    p.resolve({ behavior: 'deny', message: resolution === 'expired' ? '审批超时,自动拒绝' : '已拒绝' })
    getHitlRegistry().resolve('claude-permission', id, resolution)
  }

  // ===== run / supervise =====

  protected async* workerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return
    this.workspace ??= ctx.workspace
    this.toolState.currentTaskId = taskId
    try {
      await this.ensureSession(ctx)
      const taskText = request.message.parts.map((p) => {
        if ('text' in p) return p.text
        if ('data' in p) return JSON.stringify(p.data)
        if ('url' in p) return p.url
        if ('raw' in p) return p.raw
        return ''
      }).join('\n')
      const prompt = workerPrompt({
        agentName: this.agentName,
        channelId: this.channelId,
        taskId,
        taskText,
        memory: request.memory,
        ctxPrefix: await this.contextPrefix(),
        manual: systemManual(),
      })
      yield* this.streamTurn(prompt, taskId, this.config.promptTimeoutMs ?? 600_000, ctx.signal)
    }
    finally {
      this.toolState.currentTaskId = null
    }
  }

  protected async* peerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    this.workspace ??= ctx.workspace
    await this.ensureSession(ctx)
    const msg = request.message
    const fromId = request.fromAgentId
      ?? (typeof msg.metadata?.['x-aw-from-label'] === 'string' ? msg.metadata['x-aw-from-label'] : undefined)
      ?? 'unknown'
    const requireReply = msg.metadata?.['x-aw-require-reply'] === 'true'
    const crossChannel = msg.metadata?.['x-aw-cross-channel'] === 'true'
    this.toolState.replyContext = requireReply && request.fromAgentId && !crossChannel
      ? { fromId: request.fromAgentId, messageId: msg.messageId }
      : null
    const msgText = msg.parts.map((p) => {
      if ('text' in p) return p.text
      if ('data' in p) return JSON.stringify(p.data)
      if ('url' in p) return p.url
      if ('raw' in p) return p.raw
      return ''
    }).join('\n')
    const prompt = peerPrompt({
      agentName: this.agentName,
      role: this.agentRole,
      channelId: this.channelId,
      ctxPrefix: await this.contextPrefix(),
      manual: systemManual(),
      memory: request.memory,
      fromId,
      messageId: msg.messageId,
      requireReply,
      isReply: typeof msg.metadata?.['x-aw-in-reply-to'] === 'string',
      crossChannel,
      fromChannel: typeof msg.metadata?.['x-aw-from-channel'] === 'string' ? String(msg.metadata['x-aw-from-channel']) : '',
      msgText,
    })
    yield* this.streamTurn(prompt, undefined, this.config.promptTimeoutMs ?? 600_000, ctx.signal)
  }

  // ===== 回合执行 =====

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onSdkMessage: ((msg: any) => void) | null = null

  private async* streamTurn(prompt: string, taskId: string | undefined, timeoutMs: number, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, unknown> {
    if (!this.session || !this.pushMessage) {
      yield { kind: 'error', error: { code: 'CLAUDE_NOT_READY', message: 'claude SDK 会话未就绪' } }
      return
    }
    if (this.turnActive) {
      yield { kind: 'error', error: { code: 'CLAUDE_TURN_BUSY', message: 'claude 上一回合尚未收口' } }
      return
    }
    this.turnActive = true
    const queue: AgentEvent[] = []
    let isDone = false
    let resolveWait: (() => void) | null = null
    let lastActivity = Date.now()
    let agentText = ''

    const enqueue = (e: AgentEvent): void => {
      if (e.kind === 'done' && !isDone && agentText.trim()) {
        queue.push({
          kind: 'artifact',
          artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text: agentText.trim() }] },
          lastChunk: true,
          totalChunks: 1,
        })
      }
      if (e.kind === 'done' || e.kind === 'error') {
        isDone = true
        this.turnActive = false
      }
      queue.push(e)
      lastActivity = Date.now()
      resolveWait?.()
      resolveWait = null
    }

    // SDK 消息 → 事件(读取循环后台消费,生成器边到边 yield)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.onSdkMessage = (msg: any) => {
      lastActivity = Date.now()
      const type = String(msg?.type ?? '')
      const now = new Date().toISOString()
      const statusEvent = (text: string): void => {
        enqueue({
          kind: 'status',
          status: { state: 'WORKING', message: { messageId: randomUUID(), contextId: this.channelId, role: 'ROLE_AGENT', parts: [{ text }] }, timestamp: now },
        })
      }
      if (type === 'system' && String(msg.subtype ?? '') === 'init') {
        if (typeof msg.session_id === 'string') this.sessionId = msg.session_id
        statusEvent(`▶ claude(${String(msg.model ?? 'default')})`)
        return
      }
      if (type === 'assistant') {
        const blocks = (msg.message?.content ?? []) as Array<Record<string, unknown>>
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            agentText += block.text
            enqueue({ kind: 'delta', delta: { text: block.text } })
          }
          else if (block.type === 'tool_use') {
            statusEvent(`🔧 ${String(block.name ?? 'tool')}`)
          }
        }
        return
      }
      if (type === 'user') return
      if (type === 'stream_event') return // v1 关闭 includePartialMessages,不达
      if (type === 'compact_boundary') {
        statusEvent('📦 上下文已压缩')
        return
      }
      if (type === 'result') {
        const usage = (msg.usage ?? {}) as Record<string, unknown>
        const input = Number(usage.input_tokens ?? 0)
        const output = Number(usage.output_tokens ?? 0)
        const cost = Number(msg.total_cost_usd ?? 0)
        if (input > 0 || output > 0) this.lastUsage = { inputTokens: input, outputTokens: output, costUsd: cost, at: Date.now() }
        const failureReasons = Array.isArray(msg.errors) ? msg.errors.map(String).filter(Boolean) : []
        if (msg.is_error === true || String(msg.subtype ?? '') !== 'success') {
          const reason = failureReasons.length > 0
            ? failureReasons.slice(0, 3).join(' | ')
            : String(msg.result ?? '').slice(0, 300)
          enqueue({
            kind: 'error',
            error: {
              code: 'CLAUDE_RESULT_ERROR',
              message: `claude 回合失败(subtype=${String(msg.subtype ?? 'unknown')}): ${reason}`,
            },
          })
          return
        }
        if (typeof msg.result === 'string' && msg.result && !agentText.trim()) {
          agentText = msg.result
        }
        enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
        return
      }
      // 其他系统消息:忽略
    }

    this.pushMessage({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })

    const onAbort = (): void => {
      log.warn(`[ClaudeSdk:${this.selfAgentId}] run 被 abort → interrupt,taskId=${taskId ?? '-'}`)
      void this.session?.interrupt?.().catch(() => {})
      setTimeout(() => {
        if (!isDone) enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      }, 5000)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = timeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            void this.session?.interrupt?.().catch(() => {})
            enqueue({
              kind: 'error',
              error: { code: 'CLAUDE_TURN_STALLED', message: `回合停滞 ${Math.round(timeoutMs / 1000)}s 无事件,已中断` },
            })
            continue
          }
          await new Promise<void>((r) => {
            resolveWait = r
            setTimeout(() => {
              resolveWait = null
              r()
            }, remaining + 100)
          })
        }
        while (queue.length > 0) {
          yield queue.shift()!
        }
      }
    }
    finally {
      signal?.removeEventListener('abort', onAbort)
      this.onSdkMessage = null
      this.turnActive = false
    }
  }

  protected async collectTurnEvents(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const e of this.streamTurn(prompt, undefined, timeoutMs, signal)) {
      events.push(e)
      if (e.kind === 'error') break
    }
    return events
  }

  // ===== 会话管理 =====

  private async ensureSession(ctx: AgentRunContext): Promise<void> {
    if (!this.workspace) this.workspace = ctx.workspace
    if (this.session) return
    this.sessionStarting ??= this.startSession().finally(() => {
      this.sessionStarting = null
    })
    await this.sessionStarting
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async startSession(): Promise<any> {
    let sdk: Record<string, unknown>
    try {
      sdk = await import('@anthropic-ai/claude-agent-sdk') as Record<string, unknown>
    }
    catch (err) {
      throw new Error(`@anthropic-ai/claude-agent-sdk 未安装: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
    const createSdkTurn = sdk.query as
      | ((input: { prompt: AsyncGenerator<SdkUserMessage>, options?: Record<string, unknown> }) => unknown)
    if (typeof createSdkTurn !== 'function') throw new Error('claude-agent-sdk 导出面异常(缺 query)')

    const bridge = generateMcpBridgeEnv({
      agentId: this.selfAgentId,
      token: this.config.token,
      baseUrl: this.config.baseUrl,
      bridgePath: this.config.mcpBridgePath,
    })
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    Object.assign(env, bridge.bridgeEnv)
    if (this.config.apiKey) env.ANTHROPIC_AUTH_TOKEN = this.config.apiKey
    if (this.config.providerBaseUrl) env.ANTHROPIC_BASE_URL = this.config.providerBaseUrl
    if (this.config.model) env.ANTHROPIC_MODEL = this.config.model

    // 流式输入通道:pushMessage 投递 user 消息,closeInput 终止生成器
    const pending: SdkUserMessage[] = []
    let notify: (() => void) | null = null
    let closed = false
    this.pushMessage = (m) => {
      pending.push(m)
      notify?.()
      notify = null
    }
    this.closeInput = () => {
      closed = true
      notify?.()
      notify = null
    }
    const waitFor = (): Promise<void> => new Promise((r) => {
      notify = r
    })
    async function* inputStream(): AsyncGenerator<SdkUserMessage> {
      while (true) {
        if (pending.length === 0) {
          if (closed) return
          await waitFor()
          if (closed && pending.length === 0) return
        }
        if (pending.length > 0) {
          yield pending.shift()!
        }
      }
    }

    this.abortCtrl = new AbortController()
    const options: Record<string, unknown> = {
      cwd: this.config.cwd ?? process.cwd(),
      env,
      permissionMode: this.config.permissionMode ?? 'default',
      allowedTools: ['mcp__aw'],
      maxTurns: this.config.maxTurns ?? 200,
      includePartialMessages: false, // v1 消息级事件,避免 stream_event/assistant 双计文本
      abortController: this.abortCtrl,
      mcpServers: {
        aw: {
          type: 'stdio',
          command: process.execPath,
          args: [bridge.bridgePath],
          env: bridge.bridgeEnv,
        },
      },
      canUseTool: async (toolName: string, input: Record<string, unknown>): Promise<PermissionVerdict> =>
        await this.requestPermission(toolName, input),
    }
    if (this.sessionId) options.resume = this.sessionId

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = createSdkTurn({ prompt: inputStream(), options }) as any
    this.session = session

    // 读取循环:SDK 消息 → onSdkMessage(回合挂接)/ 状态跟踪
    void (async () => {
      try {
        for await (const msg of session) {
          if (this.onSdkMessage) this.onSdkMessage(msg)
        }
      }
      catch (err) {
        log.warn(`[ClaudeSdk:${this.selfAgentId}] 消息流异常: ${err instanceof Error ? err.message : String(err)}`)
      }
      finally {
        this.pushMessage = null
      }
    })()

    return session
  }

  /** canUseTool → HITL 登记(超时 fail-closed deny) */
  private async requestPermission(toolName: string, input: Record<string, unknown>): Promise<PermissionVerdict> {
    const id = `claude-${randomUUID().slice(0, 8)}`
    getHitlRegistry().register({
      kind: 'claude-permission',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: null,
      method: 'confirm',
      title: `claude 权限请求:${toolName}`,
      detail: JSON.stringify(input).slice(0, 500),
      options: ['allow', 'reject'],
      createdAt: new Date().toISOString(),
      expiresAt: null,
    })
    const timeoutMs = harnessSettings().hitl_timeout_ms
    return await new Promise<PermissionVerdict>((resolve) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => this.denyPending(id, 'expired'), timeoutMs)
        : null
      this.pendingPermissions.set(id, { resolve, input, timer })
    })
  }
}
