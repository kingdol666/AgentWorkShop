/**
 * DshAgentImpl — DeepSeek Harness(`dsh --profile acp`)的 AgentInterface 实现。
 *
 * 进程模型:每 Agent 一个 `dsh --profile acp` 子进程(ACP v1:JSON-RPC over stdio,
 * lazy spawn 跨消息复用);session/new 建会话(挂 stdio MCP 桥),session/prompt
 * 驱动回合(单飞,响应在回合终点返回 stopReason)。
 *
 *  - prompt/工具面与 omp 全引擎同源(prompt-builder / host-tool-bridge);
 *    工具经 stdio MCP 桥以 session/new mcpServers 挂载(工具名 mcp__aw__* 由引擎加前缀)
 *  - 事件映射:session/update(agent_message_chunk/tool_call/tool_call_update/contextUsage)
 *    → AgentEvent;session/prompt 响应(stopReason)→ done/error
 *  - HITL:session/request_permission(server→client 请求)→ hitl-registry 登记 →
 *    respondHitl 应答(allow 选项 / reject 选项 / cancelled;fail-closed)
 *  - steer:ACP 无同轮注入 → 恒 'deferred'(能力面如实声明 steer:false)
 *  - 上下文:引擎原生 auto-compaction;usage 随事件被动跟踪(平台不主动压缩)
 *
 * 风险:pre-1.0(developer preview),协议方法名集中本文件;版本 pin + 契约测试兜底。
 * 协议权威:github.com/deepseek-ai/deepseek-harness packages/acp/acp/README.md。
 */
import { createLogger } from '../logger'
import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentInterface,
  AgentInfo,
  AgentRunContext,
  AgentRunRequest,
  SupervisionDecision,
  SupervisionSnapshot,
} from './agent-interface'
import type { AgentContextStats } from '../types/task'
import { registerHarnessProcess, bindHarnessProcess, markHarnessProcessExit, killHarnessProcess } from './harness-process'
import { createSessionState, dispatchHostTool } from './host-tool-bridge'
import {
  contextPrefix as buildContextPrefix,
  createRosterCache,
  extractJsonArray,
  peerPrompt,
  supervisePrompt,
  systemManual,
  toolArgsPreview,
  workerPrompt,
} from './prompt-builder'
import { getHitlRegistry } from './hitl-registry'
import { harnessSettings } from '../settings'
import { StdioJsonRpcClient, type JsonRpcRequestIncoming } from './adapters/stdio-jsonrpc'
import { generateMcpBridgeEnv } from './harness-env'

const log = createLogger('workshop.dsh')

/** ACP 协议方法名集中地(pre-1.0 变更时改这一处) */
export const DSH_ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
} as const

export interface DshAgentConfig {
  /** dsh 可执行文件(默认取 harness.dsh_command 设置) */
  command?: string
  /** 额外 CLI 参数(默认 ['--profile','acp']) */
  args?: string[]
  cwd?: string
  /** 模型(如 deepseek-v4-flash;经进程环境传给 profile patch 的 acp provider/model) */
  model?: string
  /** provider(如 deepseek-official;经进程环境传给 profile patch) */
  provider?: string
  /** 推理档位(off|low|high|max) */
  reasoningEffort?: string
  /** 审批策略(ask=默认,触发 HITL;never=引擎侧全拒) */
  approvalPolicy?: 'ask' | 'never'
  /** 沙箱预设(read-only|workspace-write|danger-full-access) */
  sandboxPreset?: string
  /** DSH_HOME(缺省继承用户环境,保留其凭据) */
  dshHome?: string
  /** DEEPSEEK_API_KEY(缺省继承进程环境) */
  apiKey?: string
  /** 上下文窗口(usage 百分比;默认 1_000_000,deepseek v4 系) */
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
}

export class DshAgentImpl implements AgentInterface {
  private readonly config: DshAgentConfig
  private workspace: AgentRunContext['workspace'] | null = null
  private agentInfo: AgentInfo | null = null
  private readonly toolState = createSessionState()
  private readonly bridgeCtx = {
    identity: { agentId: '', channelId: '', role: 'worker' as 'lead' | 'worker', name: 'agent' },
    state: this.toolState,
    getWorkspace: () => this.workspace,
  }

  private roster = createRosterCache({ selfAgentId: '', listAgents: async () => [] })

  private selfAgentId = ''
  private agentName = 'agent'
  private agentRole: 'lead' | 'worker' = 'worker'
  private channelId = ''

  private client: StdioJsonRpcClient | null = null
  private clientStarting: Promise<void> | null = null
  private sessionId: string | null = null
  /** ACP 会话回合锁(一 session 一 in-flight prompt) */
  private turnActive = false
  private lastUsage: { input: number, at: number } | null = null
  /** 待应答权限(permission request id → rpc id) */
  private pendingPermissions = new Map<string, { rpcId: string | number, options: Array<Record<string, unknown>>, timer: ReturnType<typeof setTimeout> | null }>()

  constructor(config: Record<string, unknown> = {}) {
    this.config = config as DshAgentConfig
    this.selfAgentId = this.config.agentId ?? ''
    this.agentName = this.config.name ?? 'agent'
    this.agentRole = this.config.role ?? 'worker'
    this.channelId = this.config.channelId ?? ''
    this.refreshIdentity()
  }

  private refreshIdentity(): void {
    this.bridgeCtx.identity = { agentId: this.selfAgentId, channelId: this.channelId, role: this.agentRole, name: this.agentName }
    this.roster = createRosterCache({
      selfAgentId: this.selfAgentId,
      listAgents: async () => this.workspace?.listAgents() ?? [],
    })
  }

  async init(input: { agent: AgentInfo, channelId: string }): Promise<void> {
    this.agentInfo = input.agent
    this.channelId = input.channelId
    this.agentName = input.agent.name
    this.agentRole = input.agent.role
    this.selfAgentId = input.agent.id
    this.refreshIdentity()
  }

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
    const client = this.client
    const pid = client?.pid
    if (!pid || !client) return null
    return { pid, alive: client.alive, command: 'dsh --profile acp' }
  }

  killProcess(): void {
    const pid = this.client?.pid
    if (pid) killHarnessProcess(pid)
    else this.client?.kill()
  }

  reconcileProcess(): void {
    this.client?.reconcile()
  }

  dispatchHostTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string, isError?: boolean }> {
    return dispatchHostTool(this.bridgeCtx, { toolName, arguments: args })
  }

  getContextStats(): AgentContextStats | null {
    if (!this.lastUsage) return null
    const window = this.config.contextWindow ?? 1_000_000
    return {
      usedTokens: this.lastUsage.input,
      contextWindow: window,
      percent: window > 0 ? Math.min(1, this.lastUsage.input / window) : null,
      compacting: false, // 压缩由引擎原生驱动,平台无主动 compact 面
    }
  }

  /** ACP 无同轮注入:恒 'deferred'(消息保持 pending,消费循环处理;能力面如实声明) */
  async steer(_text: string): Promise<'steer' | 'deferred'> {
    return 'deferred'
  }

  /** HITL 应答:session/request_permission → allow/reject/cancelled(fail-closed) */
  async respondHitl(kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<void> {
    if (kind !== 'dsh-permission') return
    const pending = this.pendingPermissions.get(id)
    if (!pending) throw new Error(`待办不存在或已处理: ${id}`)
    const client = this.client
    if (!client) throw new Error('dsh 会话已关闭')
    let result: Record<string, unknown>
    if (outcome.cancelled === true) {
      result = { outcome: { outcome: 'cancelled' } }
    }
    else if (outcome.confirmed === true) {
      // 选第一个 allow 语义选项(kind: allow_once/allow_always 或 name 含 allow)
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
    getHitlRegistry().resolve('dsh-permission', id, resolution)
  }

  // ===== run / supervise =====

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    const kind = request.message.metadata?.['x-aw-task-kind']
    if (kind === 'assign' && ctx.role === 'worker') {
      yield* this.workerRun(request, ctx)
      return
    }
    if (!kind && (request.fromAgentId || request.message.metadata?.['x-aw-from-label'])) {
      yield* this.peerMessageRun(request, ctx)
      return
    }
  }

  private supervising = false

  async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext, opts?: { signal?: AbortSignal }): Promise<SupervisionDecision[]> {
    await this.ensureClient(ctx)
    if (!this.client || !this.sessionId) return []
    if (this.supervising) return []
    const prompt = supervisePrompt({
      snapshot,
      agentName: this.agentName,
      channelId: this.channelId,
      ctxPrefix: await this.contextPrefix(),
      manual: systemManual(),
      memory: ctx.memory,
    })
    this.supervising = true
    try {
      const events = await this.collectTurn(prompt, this.config.superviseTimeoutMs ?? 150_000, opts?.signal)
      let text = ''
      for (const e of events) {
        if (e.kind === 'artifact') {
          text += e.artifact.parts.map(p => 'text' in p ? p.text : '').join('')
        }
      }
      const parsed = extractJsonArray(text)
      return parsed && parsed.length > 0 ? parsed as SupervisionDecision[] : []
    }
    catch {
      return []
    }
    finally {
      this.supervising = false
    }
  }

  private async* workerRun(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
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

  private async* peerMessageRun(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
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

  private async contextPrefix(): Promise<string> {
    return buildContextPrefix({
      scenarioPrompt: this.config.scenarioPrompt,
      systemPromptPrefix: this.config.systemPromptPrefix,
      agentId: this.selfAgentId,
      roster: await this.roster.roster(),
    })
  }

  // ===== 回合执行 =====

  /**
   * ACP 回合:session/prompt(响应在回合终点返回)+ session/update 通知流。
   * 通知由 client 级 handler 转 turnSettlers;abort → session/cancel 通知。
   */
  private async* streamTurn(prompt: string, taskId: string | undefined, timeoutMs: number, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, unknown> {
    const client = this.client
    if (!client || !this.sessionId) {
      yield { kind: 'error', error: { code: 'DSH_NOT_READY', message: 'dsh 会话未就绪' } }
      return
    }
    if (this.turnActive) {
      // 单飞约束:上一回合未收口(理论不可达,run/supervise 互斥在上层保证)
      yield { kind: 'error', error: { code: 'DSH_TURN_BUSY', message: 'dsh 上一回合尚未收口' } }
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

    // 引擎事件 → 队列(session/update 映射)
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
      // contextUsage / config / 其他通知:仅刷新活动时间
      const usage = (p.contextUsage ?? update.contextUsage ?? update.usage) as Record<string, unknown> | undefined
      if (usage) {
        const input = Number(usage.usedTokens ?? usage.inputTokens ?? usage.input ?? usage.totalTokens)
        if (Number.isFinite(input) && input > 0) this.lastUsage = { input, at: Date.now() }
      }
    }

    const unsub = client.onNotification((method, params) => {
      if (method === DSH_ACP_METHODS.sessionUpdate) pushUpdate(params)
    })

    // abort:session/cancel 通知 → 引擎终结 prompt(响应 stopReason=cancelled)
    const onAbort = (): void => {
      log.warn(`[DshAgent:${this.selfAgentId}] run 被 abort → session/cancel,taskId=${taskId ?? '-'}`)
      client.notify(DSH_ACP_METHODS.sessionCancel, { sessionId: this.sessionId })
      setTimeout(() => {
        if (!isDone) enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      }, 5000)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    // 投递 prompt(响应在回合终点返回 → 异步挂接,回合内事件由生成器边到边 yield)
    void client.request(DSH_ACP_METHODS.sessionPrompt, {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: prompt }],
    }, timeoutMs + 30_000)
      .then((result) => {
        const stopReason = String((result as Record<string, unknown>)?.stopReason ?? 'end_turn')
        if (stopReason === 'refusal') {
          enqueue({ kind: 'error', error: { code: 'DSH_REFUSAL', message: 'dsh 回合被引擎拒绝(refusal)' } })
        }
        else {
          // end_turn / cancelled / 其他:中断按 done 收口(消息按已处理落账)
          enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
        }
      })
      .catch((err: unknown) => {
        enqueue({
          kind: 'error',
          error: {
            code: 'DSH_PROMPT_FAILED',
            message: `dsh session/prompt 失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      })

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = timeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            client.notify(DSH_ACP_METHODS.sessionCancel, { sessionId: this.sessionId })
            enqueue({
              kind: 'error',
              error: { code: 'DSH_TURN_STALLED', message: `回合停滞 ${Math.round(timeoutMs / 1000)}s 无事件,已取消` },
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

  /** supervise 用:收齐整个回合 */
  private async collectTurn(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
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
    const command = this.config.command ?? harnessSettings().dsh_command
    const env = generateMcpBridgeEnv({
      agentId: this.selfAgentId,
      token: this.config.token,
      baseUrl: this.config.baseUrl,
      bridgePath: this.config.mcpBridgePath,
      extra: {
        // 桥身份随进程环境注入:profile 级 mcp-client(patch 层)经 !!js 读取;
        // 此 dsh 版本 session/new 不支持 mcpServers 参数,挂载走 profile 配置。
        ...generateMcpBridgeEnv({ agentId: this.selfAgentId, token: this.config.token, baseUrl: this.config.baseUrl, bridgePath: this.config.mcpBridgePath }).bridgeEnv,
        AW_BRIDGE_PATH: generateMcpBridgeEnv({ agentId: this.selfAgentId, token: this.config.token, baseUrl: this.config.baseUrl, bridgePath: this.config.mcpBridgePath }).bridgePath,
        // provider/model 经环境传给 profile patch(!!js 读取):channel/agent config 驱动
        ...(this.config.provider ? { AW_ACP_PROVIDER: this.config.provider } : {}),
        ...(this.config.model ? { AW_ACP_MODEL: this.config.model } : {}),
        ...(this.config.dshHome ? { DSH_HOME: this.config.dshHome } : {}),
        ...(this.config.apiKey ? { DEEPSEEK_API_KEY: this.config.apiKey } : {}),
      },
    })
    const client = new StdioJsonRpcClient({
      name: 'dsh',
      command,
      args: this.config.args ?? ['--profile', 'acp'],
      cwd: this.config.cwd ?? process.cwd(),
      env: env.engineEnv,
      requestTimeoutMs: 60_000,
    })
    const pidRef = { pid: undefined as number | undefined }
    client.onExit((code) => {
      if (pidRef.pid) markHarnessProcessExit(pidRef.pid, code)
      this.sessionId = null
      log.warn(`[DshAgent:${this.selfAgentId}] dsh acp 进程退出(code=${code});下回合自动重生`)
    })
    await client.start()
    pidRef.pid = client.pid
    if (client.pid) {
      registerHarnessProcess(client.pid, { harness: 'dsh', command, args: ['--profile', 'acp'] })
      bindHarnessProcess(client.pid, { agentId: this.selfAgentId, channelId: this.channelId, name: this.agentName, role: this.agentRole })
    }

    // 服务端→客户端请求(权限)→ HITL
    client.onRequest((req: JsonRpcRequestIncoming) => {
      if (req.method === DSH_ACP_METHODS.requestPermission) {
        this.registerPermissionHitl(req)
        return
      }
      client.respondError(req.id, -32601, `方法不存在: ${req.method}`)
    })

    // ACP 握手
    await client.request(DSH_ACP_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    }, 30_000).catch(async (err: Error) => {
      // 协议版本协商失败 → 显式版本重试一次
      await client.request(DSH_ACP_METHODS.initialize, { protocolVersion: '2025-06-01', clientCapabilities: {} }, 30_000)
        .catch(() => { throw err })
    })

    // 建会话(此版本不接受自定义 mcpServers;工具经 profile 级 mcp-client 挂载;
    // ACP schema 要求 mcpServers 字段存在,传空数组)
    const created = await client.request(DSH_ACP_METHODS.sessionNew, {
      cwd: this.config.cwd ?? process.cwd(),
      mcpServers: [],
    }, 60_000) as Record<string, unknown>
    const sid = created?.sessionId ?? created?.id
    this.sessionId = typeof sid === 'string' ? sid : null
    if (!this.sessionId) throw new Error('dsh session/new 未返回 sessionId')

    this.client = client
  }

  private registerPermissionHitl(req: JsonRpcRequestIncoming): void {
    const client = this.client
    if (!client) return
    const p = (req.params ?? {}) as Record<string, unknown>
    const options = Array.isArray(p.options) ? p.options as Array<Record<string, unknown>> : []
    const toolCall = (p.toolCall ?? {}) as Record<string, unknown>
    const id = `dsh-${randomUUID().slice(0, 8)}`
    const registry = getHitlRegistry()
    registry.register({
      kind: 'dsh-permission',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: client.pid,
      method: 'confirm',
      title: `dsh 权限请求:${String(toolCall.title ?? toolCall.toolName ?? p.toolName ?? '操作').slice(0, 200)}`,
      detail: String(toolCall.kind ?? p.kind ?? ''),
      options: options.map(o => String(o.name ?? o.optionId ?? '')),
      createdAt: new Date().toISOString(),
      expiresAt: null,
    })
    const timeoutMs = harnessSettings().hitl_timeout_ms
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          // fail-closed:超时按拒绝应答(引擎默认语义)
          void this.respondHitl('dsh-permission', id, { confirmed: false }).catch(() => {})
        }, timeoutMs)
      : null
    this.pendingPermissions.set(id, { rpcId: req.id, options, timer })
  }
}
