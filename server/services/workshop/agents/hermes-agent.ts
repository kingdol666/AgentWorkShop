/**
 * HermesAgentImpl — Hermes Agent(NousResearch,`hermes acp`)的 AgentInterface 实现。
 *
 * 进程模型:每 Agent 一个 `hermes acp` 子进程(标准 ACP:JSON-RPC over stdio,lazy spawn
 * 跨消息复用),与 dsh 同型:session/new 建会话,session/prompt 驱动回合(单飞,响应在
 * 回合终点返回 stopReason)。
 *
 *  - 鉴权/provider:模型面来自 hermes 自身配置(config.yaml 的 model.provider/model.default
 *    /model.base_url,`hermes model` 交互配置);config.apiKey → GLM_API_KEY env(zai provider);
 *    config.provider/config.model → HERMES_PROVIDER/HERMES_MODEL env(若版本支持)
 *  - 事件映射:session/update(agent_message_chunk/tool_call/tool_call_update/contextUsage)
 *    → AgentEvent;session/prompt 响应(stopReason)→ done/error
 *  - HITL:session/request_permission → hitl-registry(kind 'hermes-permission') →
 *    respondHitl(allow/reject 选项,fail-closed)
 *  - steer:ACP 单飞无同轮注入 → 恒 'deferred'
 *  - 工具:hermes 自身 MCP 体系(`hermes mcp add aw ...` 用户级配置一次;aw 桥身份经
 *    hermes 进程 env 继承到桥子进程)
 */
import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger'
import type { AgentEvent, AgentInterface, AgentInfo, AgentRunContext, AgentRunRequest } from './agent-interface'
import type { AgentContextStats } from '../types/task'
import { registerHarnessProcess, bindHarnessProcess, markHarnessProcessExit, killHarnessProcess } from './harness-process'
import { peerPrompt, systemManual, toolArgsPreview, workerPrompt } from './prompt-builder'
import { getHitlRegistry } from './hitl-registry'
import { harnessSettings } from '../settings'
import { StdioJsonRpcClient, type JsonRpcRequestIncoming } from './adapters/stdio-jsonrpc'
import { BaseAgentImpl } from './base-agent'
import { generateMcpBridgeEnv } from './harness-env'

const log = createLogger('workshop.hermes')

export const HERMES_ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
} as const

export interface HermesAgentConfig {
  command?: string
  args?: string[]
  cwd?: string
  model?: string
  provider?: string
  apiKey?: string
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

export class HermesAgentImpl extends BaseAgentImpl implements AgentInterface {
  private readonly config: HermesAgentConfig

  private agentRole: 'lead' | 'worker' = 'worker'
  private client: StdioJsonRpcClient | null = null
  private clientStarting: Promise<void> | null = null
  private sessionId: string | null = null
  private turnActive = false
  private lastUsage: { input: number, at: number } | null = null
  private pendingPermissions = new Map<string, { rpcId: string | number, options: Array<Record<string, unknown>>, timer: ReturnType<typeof setTimeout> | null }>()

  constructor(config: Record<string, unknown> = {}) {
    super({
      agentId: typeof config.agentId === 'string' ? config.agentId : '',
      name: typeof config.name === 'string' ? config.name : undefined,
      role: config.role === 'lead' ? 'lead' : 'worker',
      channelId: typeof config.channelId === 'string' ? config.channelId : '',
    })
    this.config = config as HermesAgentConfig
  }

  protected get harnessId(): string {
    return 'hermes'
  }

  protected configRecord(): Record<string, unknown> {
    return this.config
  }

  private agentInfo: AgentInfo | null = null

  async dispose(): Promise<void> {
    const client = this.client
    this.client = null
    this.sessionId = null
    if (client) {
      const pid = client.pid
      await client.dispose().catch(() => {})
      if (pid) markHarnessProcessExit(pid, null)
    }
    for (const [id, p] of this.pendingPermissions) {
      if (p.timer) clearTimeout(p.timer)
      this.pendingPermissions.delete(id)
    }
  }

  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const pid = this.client?.pid
    if (!pid || !this.client) return null
    return { pid, alive: this.client.alive, command: 'hermes acp' }
  }

  killProcess(): void {
    const pid = this.client?.pid
    if (pid) killHarnessProcess(pid)
    else this.client?.kill()
  }

  reconcileProcess(): void {
    this.client?.reconcile()
  }

  getContextStats(): AgentContextStats | null {
    if (!this.lastUsage) return null
    const window = this.config.contextWindow ?? 200_000
    return {
      usedTokens: this.lastUsage.input,
      contextWindow: window,
      percent: window > 0 ? Math.min(1, this.lastUsage.input / window) : null,
      compacting: false,
    }
  }

  async steer(_text: string): Promise<'steer' | 'deferred'> {
    return 'deferred'
  }

  async respondHitl(kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
  }): Promise<void> {
    if (kind !== 'hermes-permission') return
    const pending = this.pendingPermissions.get(id)
    if (!pending) throw new Error(`待办不存在或已处理: ${id}`)
    const client = this.client
    if (!client) throw new Error('hermes 会话已关闭')
    let result: Record<string, unknown>
    if (outcome.cancelled === true) {
      result = { outcome: { outcome: 'cancelled' } }
    }
    else if (outcome.confirmed === true) {
      const allow = pending.options.find(o => String(o.kind ?? '').startsWith('allow') || /allow/i.test(String(o.name ?? '')))
      if (!allow) {
        client.respondError(pending.rpcId, -32602, '无可用 allow 选项')
        this.clearPending(id, 'cancelled')
        return
      }
      result = { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }
    else {
      const reject = pending.options.find(o => String(o.kind ?? '').startsWith('reject') || /reject|deny/i.test(String(o.name ?? '')))
      if (reject) {
        result = { outcome: { outcome: 'selected', optionId: reject.optionId } }
      }
      else {
        client.respondError(pending.rpcId, -32602, '已拒绝')
        this.clearPending(id, 'cancelled')
        return
      }
    }
    client.respond(pending.rpcId, result)
    this.clearPending(id, outcome.cancelled === true ? 'cancelled' : 'answered')
  }

  private clearPending(id: string, resolution: 'answered' | 'cancelled' | 'expired'): void {
    const p = this.pendingPermissions.get(id)
    if (p?.timer) clearTimeout(p.timer)
    this.pendingPermissions.delete(id)
    getHitlRegistry().resolve('hermes-permission', id, resolution)
  }

  // ===== run / supervise =====

  protected async* workerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return
    this.toolState.currentTaskId = taskId
    try {
      await this.ensureClient(ctx)
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
    await this.ensureClient(ctx)
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

  private async* streamTurn(prompt: string, taskId: string | undefined, timeoutMs: number, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, unknown> {
    const client = this.client
    if (!client || !this.sessionId) {
      yield { kind: 'error', error: { code: 'HERMES_NOT_READY', message: 'hermes 会话未就绪' } }
      return
    }
    if (this.turnActive) {
      yield { kind: 'error', error: { code: 'HERMES_TURN_BUSY', message: 'hermes 上一回合尚未收口' } }
      return
    }
    this.turnActive = true
    const queue: AgentEvent[] = []
    let isDone = false
    let resolveWait: (() => void) | null = null
    let lastActivity = Date.now()
    let agentText = ''

    const enqueue = (e: AgentEvent): void => {
      if (e.kind === 'done' && !isDone) {
        if (agentText.trim()) {
          queue.push({
            kind: 'artifact',
            artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text: agentText.trim() }] },
            lastChunk: true,
            totalChunks: 1,
          })
        }
        this.turnActive = false
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

    const pushUpdate = (params: unknown): void => {
      lastActivity = Date.now()
      const p = (params ?? {}) as Record<string, unknown>
      const sid = p.sessionId ?? p.sessionID
      if (sid && sid !== this.sessionId) return
      const update = (p.update ?? p) as Record<string, unknown>
      const kind = String(update.sessionUpdate ?? update.kind ?? update.type ?? '')
      const now = new Date().toISOString()
      const statusEvent = (text: string): void => {
        enqueue({
          kind: 'status',
          status: {
            state: 'WORKING',
            message: { messageId: randomUUID(), contextId: this.channelId, role: 'ROLE_AGENT', parts: [{ text }] },
            timestamp: now,
          },
        })
      }
      if (kind === 'agent_message_chunk' || kind === 'agentMessageChunk') {
        const content = (update.content ?? {}) as Record<string, unknown>
        const text = typeof content.text === 'string' ? content.text : ''
        if (text) {
          agentText += text
          enqueue({ kind: 'delta', delta: { text } })
        }
        return
      }
      if (kind === 'tool_call' || kind === 'toolCall') {
        statusEvent(`🔧 ${String(update.title ?? update.toolName ?? 'tool')}${toolArgsPreview(update.rawInput ?? update.arguments)}`)
        return
      }
      if (kind === 'tool_call_update' || kind === 'toolCallUpdate') {
        const status = String(update.status ?? '')
        if (status === 'failed' || status === 'error') {
          statusEvent(`🔧 ${String(update.title ?? 'tool')} 失败`)
        }
        return
      }
      const usage = (p.contextUsage ?? update.contextUsage ?? update.usage) as Record<string, unknown> | undefined
      if (usage) {
        const input = Number(usage.usedTokens ?? usage.inputTokens ?? usage.input ?? usage.totalTokens)
        if (Number.isFinite(input) && input > 0) this.lastUsage = { input, at: Date.now() }
      }
    }

    const unsub = client.onNotification((method, params) => {
      if (method === HERMES_ACP_METHODS.sessionUpdate) pushUpdate(params)
    })

    const onAbort = (): void => {
      log.warn(`[HermesAgent:${this.selfAgentId}] run 被 abort → session/cancel,taskId=${taskId ?? '-'}`)
      client.notify(HERMES_ACP_METHODS.sessionCancel, { sessionId: this.sessionId })
      setTimeout(() => {
        if (!isDone) enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      }, 5000)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    void client.request(HERMES_ACP_METHODS.sessionPrompt, {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: prompt }],
    }, timeoutMs + 30_000)
      .then((result) => {
        const stopReason = String((result as Record<string, unknown>)?.stopReason ?? 'end_turn')
        if (stopReason === 'refusal') {
          enqueue({ kind: 'error', error: { code: 'HERMES_REFUSAL', message: 'hermes 回合被引擎拒绝(refusal)' } })
        }
        else {
          enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
        }
      })
      .catch((err: unknown) => {
        enqueue({
          kind: 'error',
          error: {
            code: 'HERMES_PROMPT_FAILED',
            message: `hermes session/prompt 失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      })

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = timeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            client.notify(HERMES_ACP_METHODS.sessionCancel, { sessionId: this.sessionId })
            enqueue({
              kind: 'error',
              error: { code: 'HERMES_TURN_STALLED', message: `回合停滞 ${Math.round(timeoutMs / 1000)}s 无事件,已取消` },
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
      unsub()
      signal?.removeEventListener('abort', onAbort)
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

  // ===== 客户端管理 =====

  private async ensureClient(ctx: AgentRunContext): Promise<void> {
    if (!this.workspace) this.workspace = ctx.workspace
    if (!this.agentInfo) {
      this.channelId = ctx.channelId
      this.agentRole = ctx.role
      this.refreshIdentity()
    }
    if (this.client?.alive && this.sessionId) return
    if (this.client && !this.client.alive) {
      this.client = null
      this.sessionId = null
    }
    this.clientStarting ??= this.startClient().finally(() => {
      this.clientStarting = null
    })
    await this.clientStarting
  }

  private async startClient(): Promise<void> {
    const command = this.config.command ?? harnessSettings().hermes_command
    const bridge = generateMcpBridgeEnv({
      agentId: this.selfAgentId,
      token: this.config.token,
      baseUrl: this.config.baseUrl,
      bridgePath: this.config.mcpBridgePath,
    })
    const env = {
      ...bridge.bridgeEnv,
      ...(this.config.apiKey ? { GLM_API_KEY: this.config.apiKey } : {}),
      ...(this.config.provider ? { HERMES_PROVIDER: this.config.provider } : {}),
      ...(this.config.model ? { HERMES_MODEL: this.config.model } : {}),
    }
    const args = this.config.args ?? ['acp']
    const client = new StdioJsonRpcClient({
      name: 'hermes',
      command,
      args,
      cwd: this.config.cwd ?? process.cwd(),
      env,
      requestTimeoutMs: 60_000,
    })
    const pidRef = { pid: undefined as number | undefined }
    client.onExit((code) => {
      if (pidRef.pid) markHarnessProcessExit(pidRef.pid, code)
      this.sessionId = null
      log.warn(`[HermesAgent:${this.selfAgentId}] hermes acp 进程退出(code=${code});下回合自动重生`)
    })
    await client.start()
    pidRef.pid = client.pid
    if (client.pid) {
      registerHarnessProcess(client.pid, { harness: 'hermes', command, args })
      bindHarnessProcess(client.pid, { agentId: this.selfAgentId, channelId: this.channelId, name: this.agentName, role: this.agentRole })
    }

    client.onRequest((req: JsonRpcRequestIncoming) => {
      if (req.method === HERMES_ACP_METHODS.requestPermission) {
        this.registerPermissionHitl(req)
        return
      }
      client.respondError(req.id, -32601, `方法不存在: ${req.method}`)
    })

    await client.request(HERMES_ACP_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    }, 30_000).catch(async (err: Error) => {
      await client.request(HERMES_ACP_METHODS.initialize, { protocolVersion: '2025-06-01', clientCapabilities: {} }, 30_000)
        .catch(() => { throw err })
    })

    const created = await client.request(HERMES_ACP_METHODS.sessionNew, {
      cwd: this.config.cwd ?? process.cwd(),
      mcpServers: [],
    }, 60_000) as Record<string, unknown>
    const sid = created?.sessionId ?? created?.id
    this.sessionId = typeof sid === 'string' ? sid : null
    if (!this.sessionId) throw new Error('hermes session/new 未返回 sessionId')

    this.client = client
  }

  private registerPermissionHitl(req: JsonRpcRequestIncoming): void {
    const client = this.client
    if (!client) return
    const p = (req.params ?? {}) as Record<string, unknown>
    const options = Array.isArray(p.options) ? p.options as Array<Record<string, unknown>> : []
    const toolCall = (p.toolCall ?? {}) as Record<string, unknown>
    const id = `hermes-${randomUUID().slice(0, 8)}`
    getHitlRegistry().register({
      kind: 'hermes-permission',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: client.pid,
      method: 'confirm',
      title: `hermes 权限请求:${String(toolCall.title ?? toolCall.toolName ?? p.toolName ?? '操作').slice(0, 200)}`,
      detail: String(toolCall.kind ?? p.kind ?? ''),
      options: options.map(o => String(o.name ?? o.optionId ?? '')),
      createdAt: new Date().toISOString(),
      expiresAt: null,
    })
    const timeoutMs = harnessSettings().hitl_timeout_ms
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          void this.respondHitl('hermes-permission', id, { confirmed: false }).catch(() => {})
        }, timeoutMs)
      : null
    this.pendingPermissions.set(id, { rpcId: req.id, options, timer })
  }
}
