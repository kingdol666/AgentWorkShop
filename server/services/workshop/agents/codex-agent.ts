/**
 * CodexAgentImpl — OpenAI Codex CLI(app-server)harness 的 AgentInterface 实现。
 *
 * 进程模型:每 Agent 一个 `codex app-server` 子进程(stdio NDJSON JSON-RPC v2,
 * lazy spawn 跨消息复用);thread/start 建会话,turn/start 驱动回合。
 *
 *  - prompt/工具面与 omp 全引擎同源(prompt-builder / host-tool-bridge);
 *    工具经 stdio MCP 桥注入(config.toml 由 impl 装配 [mcp_servers.aw])
 *  - 事件映射:item/agentMessage/delta → delta;item/started → 🔧 status;
 *    turn/completed → artifact + done / error(codexErrorInfo 结构化)
 *  - HITL:item/commandExecution|fileChange/requestApproval(server→client 请求)
 *    → hitl-registry 登记 → respondHitl 应答(decision: accept/decline/cancel)
 *  - steer:turn 运行中 → turn/steer;无 active turn → 'deferred'
 *  - 上下文治理:thread/tokenUsage/updated 被动跟踪;越阈值 → thread/compact/start
 *
 * 协议权威:github.com/openai/codex codex-rs/app-server/README.md(v0.149 实测)。
 */
import { createLogger } from '../logger'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
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
import { StdioJsonRpcClient } from './adapters/stdio-jsonrpc'
import { generateMcpBridgeEnv } from './harness-env'

const log = createLogger('workshop.codex')

export interface CodexAgentConfig {
  /** codex 可执行文件(默认取 harness.codex_command 设置) */
  command?: string
  /** 额外 CLI 参数(app-server 之前) */
  args?: string[]
  cwd?: string
  /** 模型(如 gpt-5.2) */
  model?: string
  /** 审批策略(默认 on-request:沙箱内自由,越界请求审批 → HITL) */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  /** 沙箱(默认 workspace-write) */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** CODEX_HOME(缺省进程环境;配置隔离/多账户时按 agent 指定) */
  codexHome?: string
  /** 上下文窗口(usage 百分比计算) */
  contextWindow?: number
  /** 压缩阈值(0-1,默认 0.7) */
  compactThreshold?: number
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

export class CodexAgentImpl implements AgentInterface {
  private readonly config: CodexAgentConfig
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
  private threadId: string | null = null
  private turnId: string | null = null

  // 回合状态
  private turnActive = false
  private deltaBuf = ''
  private deltaTimer: ReturnType<typeof setTimeout> | null = null
  private lastUsage: { input: number, at: number } | null = null
  private compacting = false
  private lastCompactAt = 0
  /** 待应答审批(approval request id → JSON-RPC id) */
  private pendingApprovals = new Map<string, { rpcId: string | number, timer: ReturnType<typeof setTimeout> | null }>()

  constructor(config: Record<string, unknown> = {}) {
    this.config = config as CodexAgentConfig
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
    this.threadId = null
    if (client) {
      const pid = client.pid
      await client.dispose().catch(() => {})
      if (pid) markHarnessProcessExit(pid, null)
    }
    for (const [id, p] of this.pendingApprovals) {
      if (p.timer) clearTimeout(p.timer)
      this.pendingApprovals.delete(id)
    }
  }

  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const client = this.client
    const pid = client?.pid
    if (!pid || !client) return null
    return { pid, alive: client.alive, command: 'codex app-server' }
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
    const window = this.config.contextWindow ?? null
    return {
      usedTokens: this.lastUsage.input,
      contextWindow: window,
      percent: window && window > 0 ? Math.min(1, this.lastUsage.input / window) : null,
      compacting: this.compacting,
    }
  }

  /** 实时注入:turn 运行中 → turn/steer;否则 'deferred'(消息保持 pending) */
  async steer(text: string): Promise<'steer' | 'deferred'> {
    const client = this.client
    if (!client?.alive || !this.threadId || !this.turnActive) return 'deferred'
    try {
      await client.request('turn/steer', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
      }, 15_000)
      return 'steer'
    }
    catch {
      // 无 active turn / 引擎拒绝 → 消息保持 pending 由消费循环处理
      return 'deferred'
    }
  }

  /** HITL 应答:审批请求 → JSON-RPC 应答(decision) */
  async respondHitl(kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<void> {
    if (kind !== 'codex-approval') return
    const pending = this.pendingApprovals.get(id)
    if (!pending) throw new Error(`待办不存在或已处理: ${id}`)
    const client = this.client
    if (!client) throw new Error('codex 会话已关闭')
    const decision = outcome.cancelled === true
      ? 'cancel'
      : outcome.confirmed === true ? 'accept' : 'decline'
    client.respond(pending.rpcId, { decision })
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingApprovals.delete(id)
    getHitlRegistry().resolve(kind, id, decision === 'cancel' ? 'cancelled' : 'answered')
  }

  /** 上下文治理(post-settle):越阈值 → thread/compact/start */
  async onTurnSettled(): Promise<void> {
    const client = this.client
    if (!client?.alive || !this.threadId || this.compacting) return
    const stats = this.getContextStats()
    const threshold = this.config.compactThreshold ?? 0.7
    if (!stats?.percent || stats.percent < threshold) return
    if (Date.now() - this.lastCompactAt < 5 * 60_000) return
    this.compacting = true
    this.lastCompactAt = Date.now()
    try {
      await client.request('thread/compact/start', { threadId: this.threadId }, 30_000)
      log.info(`[CodexAgent:${this.selfAgentId}] 上下文压缩已触发(percent=${(stats.percent * 100).toFixed(0)}%)`)
    }
    catch (err) {
      log.warn(`[CodexAgent:${this.selfAgentId}] compact 发起失败(放行):`, err instanceof Error ? err.message : err)
    }
    finally {
      this.compacting = false
    }
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
    if (!this.client || !this.threadId) return []
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
   * 流式回合:turn/start → 逐事件产出(delta/status)→ turn/completed 收口。
   * artifact 在 done 前注入(item/completed agentMessage 聚合文本)。
   */
  private async* streamTurn(prompt: string, taskId: string | undefined, timeoutMs: number, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, unknown> {
    const client = this.client
    if (!client || !this.threadId) {
      yield { kind: 'error', error: { code: 'CODEX_NOT_READY', message: 'codex 会话未就绪' } }
      return
    }
    const queue: AgentEvent[] = []
    let isDone = false
    let resolveWait: (() => void) | null = null
    let lastActivity = Date.now()
    let agentText = ''
    this.turnActive = true
    this.turnId = null

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
        flushDelta()
      }
      queue.push(e)
      lastActivity = Date.now()
      resolveWait?.()
      resolveWait = null
    }

    const flushDelta = (): void => {
      if (this.deltaTimer) {
        clearTimeout(this.deltaTimer)
        this.deltaTimer = null
      }
      if (!this.deltaBuf) return
      const text = this.deltaBuf
      this.deltaBuf = ''
      queue.push({ kind: 'delta', delta: { text } })
    }
    const pushDelta = (text: string): void => {
      this.deltaBuf += text
      this.deltaTimer ??= setTimeout(() => {
        this.deltaTimer = null
        flushDelta()
      }, 50)
    }

    // 通知订阅(审批请求处理器已在 startClient 挂接,此处只处理回合通知)
    const unsub = client.onNotification((method, params) => {
      const p = (params ?? {}) as Record<string, unknown>
      lastActivity = Date.now()
      if (method === 'item/agentMessage/delta') {
        const delta = typeof p.delta === 'string' ? p.delta : ''
        if (delta) {
          this.turnActive = true
          pushDelta(delta)
        }
        return
      }
      if (method === 'turn/started') {
        const turn = p.turn as Record<string, unknown> | undefined
        this.turnId = typeof turn?.id === 'string' ? turn.id : this.turnId
        this.turnActive = true
        enqueue({ kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } })
        return
      }
      if (method === 'item/started') {
        const item = p.item as Record<string, unknown> | undefined
        const t = String(item?.type ?? '')
        if (['commandExecution', 'mcpToolCall', 'fileChange', 'dynamicToolCall', 'webSearch', 'collabToolCall'].includes(t)) {
          const label = t === 'commandExecution'
            ? String(item?.command ?? 'command')
            : String(item?.tool ?? item?.title ?? t)
          enqueue({
            kind: 'status',
            status: {
              state: 'WORKING',
              message: {
                messageId: randomUUID(),
                contextId: this.channelId,
                role: 'ROLE_AGENT',
                parts: [{ text: `🔧 ${label}${toolArgsPreview(item?.input ?? item?.arguments ?? item?.command)}` }],
              },
              timestamp: new Date().toISOString(),
            },
          })
        }
        if (t === 'contextCompaction') this.compacting = true
        return
      }
      if (method === 'item/completed') {
        const item = p.item as Record<string, unknown> | undefined
        if (String(item?.type ?? '') === 'agentMessage' && typeof item?.text === 'string') {
          agentText += item.text
        }
        if (String(item?.type ?? '') === 'contextCompaction') this.compacting = false
        return
      }
      if (method === 'thread/tokenUsage/updated') {
        const usage = (p.usage ?? p.tokenUsage ?? p) as Record<string, unknown>
        const input = Number(usage.input_tokens ?? usage.inputTokens ?? usage.total_tokens ?? usage.totalTokens)
        if (Number.isFinite(input) && input > 0) this.lastUsage = { input, at: Date.now() }
        return
      }
      if (method === 'turn/completed') {
        const turn = (p.turn ?? {}) as Record<string, unknown>
        const status = String(turn.status ?? 'completed')
        if (status === 'failed') {
          const err = (turn.error ?? {}) as Record<string, unknown>
          const info = String(err.codexErrorInfo ?? '')
          enqueue({
            kind: 'error',
            error: {
              code: info ? `CODEX_${info}` : 'CODEX_LLM_ERROR',
              message: String(err.message ?? 'codex 回合失败'),
            },
          })
        }
        else {
          // completed / interrupted:中断按 done 收口(消息按已处理落账)
          enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
        }
        return
      }
      if (method === 'error') {
        enqueue({
          kind: 'error',
          error: { code: 'CODEX_ERROR', message: String(p.message ?? p.error ?? JSON.stringify(params).slice(0, 300)) },
        })
      }
    })

    // abort 传导
    const onAbort = (): void => {
      log.warn(`[CodexAgent:${this.selfAgentId}] run 被 abort → turn/interrupt,taskId=${taskId ?? '-'}`)
      void client.request('turn/interrupt', { threadId: this.threadId, ...(this.turnId ? { turnId: this.turnId } : {}) }, 15_000).catch(() => {})
      setTimeout(() => {
        if (!isDone) enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      }, 5000)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    // 投递 turn
    try {
      await client.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: prompt }],
      }, 60_000)
    }
    catch (err) {
      unsub()
      signal?.removeEventListener('abort', onAbort)
      this.turnActive = false
      yield {
        kind: 'error',
        error: {
          code: 'CODEX_PROMPT_FAILED',
          message: `codex turn/start 失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = timeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            void client.request('turn/interrupt', { threadId: this.threadId }, 15_000).catch(() => {})
            enqueue({
              kind: 'error',
              error: { code: 'CODEX_TURN_STALLED', message: `回合停滞 ${Math.round(timeoutMs / 1000)}s 无事件,已中止` },
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
      flushDelta()
      unsub()
      signal?.removeEventListener('abort', onAbort)
      this.turnActive = false
      this.turnId = null
    }
  }

  /** supervise 用:收齐整个回合的事件流(supervise 决策解析在调用方) */
  private async collectTurn(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const e of this.streamTurn(prompt, undefined, timeoutMs, signal)) {
      events.push(e)
      if (e.kind === 'error') break
    }
    return events
  }

  // ===== HITL 登记 =====

  private registerApprovalHitl(rpcId: string | number, itemId: string, kindLabel: 'command' | 'file', p: Record<string, unknown>): void {
    const id = `codex-${itemId}`
    if (this.pendingApprovals.has(id)) return
    const title = kindLabel === 'command'
      ? `codex 命令审批:${String(p.command ?? '(未知命令)').slice(0, 200)}`
      : `codex 文件变更审批:${String(p.cwd ?? p.grantRoot ?? '')}`
    const registry = getHitlRegistry()
    registry.register({
      kind: 'codex-approval',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: this.client?.pid,
      method: 'confirm',
      title,
      detail: typeof p.reason === 'string' ? p.reason : undefined,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    })
    const timeoutMs = harnessSettings().hitl_timeout_ms
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          void this.respondHitl('codex-approval', id, { cancelled: true }).catch(() => {})
          registry.resolve('codex-approval', id, 'expired')
        }, timeoutMs)
      : null
    this.pendingApprovals.set(id, { rpcId, timer })
  }

  private registerUserInputHitl(rpcId: string | number, p: Record<string, unknown>): void {
    const id = `codex-input-${randomUUID().slice(0, 8)}`
    const questions = Array.isArray(p.questions) ? p.questions : []
    const first = (questions[0] ?? {}) as Record<string, unknown>
    const registry = getHitlRegistry()
    registry.register({
      kind: 'codex-approval',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: this.client?.pid,
      method: 'input',
      title: String(first.question ?? first.header ?? 'codex 提问'),
      detail: typeof p.reason === 'string' ? p.reason : undefined,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    })
    const timeoutMs = harnessSettings().hitl_timeout_ms
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          void this.respondUserInput(rpcId, id, { cancelled: true }).catch(() => {})
        }, timeoutMs)
      : null
    this.pendingApprovals.set(id, { rpcId, timer })
  }

  private async respondUserInput(rpcId: string | number, id: string, outcome: { cancelled?: boolean, value?: string }): Promise<void> {
    const pending = this.pendingApprovals.get(id)
    if (!pending) return
    const client = this.client
    if (!client) return
    if (outcome.cancelled) {
      client.respondError(rpcId, -32800, '人工取消')
      getHitlRegistry().resolve('codex-approval', id, 'cancelled')
    }
    else {
      client.respond(rpcId, { answers: [{ answer: outcome.value ?? '' }] })
      getHitlRegistry().resolve('codex-approval', id, 'answered')
    }
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingApprovals.delete(id)
  }

  // ===== 客户端管理 =====

  private async ensureClient(ctx: AgentRunContext): Promise<void> {
    if (!this.workspace) this.workspace = ctx.workspace
    if (!this.agentInfo) {
      this.channelId = ctx.channelId
      this.agentRole = ctx.role
      this.refreshIdentity()
    }
    if (this.client?.alive && this.threadId) return
    if (this.client && !this.client.alive) {
      this.client = null
      this.threadId = null
    }
    this.clientStarting ??= this.startClient().finally(() => {
      this.clientStarting = null
    })
    await this.clientStarting
  }

  private async startClient(): Promise<void> {
    const command = this.config.command ?? harnessSettings().codex_command
    const client = new StdioJsonRpcClient({
      name: 'codex',
      command,
      args: [...(this.config.args ?? []), 'app-server'],
      cwd: this.config.cwd ?? process.cwd(),
      env: generateMcpBridgeEnv({
        agentId: this.selfAgentId,
        token: this.config.token,
        baseUrl: this.config.baseUrl,
        bridgePath: this.config.mcpBridgePath,
        extra: this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {},
      }).engineEnv,
      requestTimeoutMs: 60_000,
    })
    const pidRef = { pid: undefined as number | undefined }
    client.onExit((code) => {
      if (pidRef.pid) markHarnessProcessExit(pidRef.pid, code)
      this.threadId = null
      log.warn(`[CodexAgent:${this.selfAgentId}] codex app-server 退出(code=${code});下回合自动重生`)
    })
    await client.start()
    pidRef.pid = client.pid
    if (client.pid) {
      registerHarnessProcess(client.pid, { harness: 'codex', command, args: ['app-server'] })
      bindHarnessProcess(client.pid, { agentId: this.selfAgentId, channelId: this.channelId, name: this.agentName, role: this.agentRole })
    }

    // 握手
    await client.request('initialize', {
      clientInfo: { name: 'agentworkshop', title: 'AgentWorkShop', version: '0.8.0' },
    }, 30_000)
    client.notify('initialized', {})

    // MCP 桥装配(per-agent CODEX_HOME 的 config.toml [mcp_servers.aw])
    this.writeCodexHomeConfig()

    // 建会话
    const result = await client.request('thread/start', {
      ...(this.config.model ? { model: this.config.model } : {}),
      cwd: this.config.cwd ?? process.cwd(),
      approvalPolicy: this.config.approvalPolicy ?? 'on-request',
      sandbox: this.config.sandbox ?? 'workspace-write',
    }, 60_000) as Record<string, unknown>
    const thread = (result?.thread ?? result) as Record<string, unknown>
    this.threadId = typeof thread?.id === 'string' ? thread.id : null
    if (!this.threadId) throw new Error('codex thread/start 未返回 thread id')

    // 事件监听挂接(通知在 streamTurn 内按回合订阅;此处仅挂请求处理器)
    client.onRequest((req) => {
      if (req.method === 'item/commandExecution/requestApproval' || req.method === 'item/fileChange/requestApproval') {
        const p = (req.params ?? {}) as Record<string, unknown>
        this.registerApprovalHitl(req.id, String(p.itemId ?? randomUUID()), req.method === 'item/fileChange/requestApproval' ? 'file' : 'command', p)
      }
      else if (req.method === 'tool/requestUserInput') {
        const p = (req.params ?? {}) as Record<string, unknown>
        this.registerUserInputHitl(req.id, p)
      }
      else {
        client.respondError(req.id, -32601, `方法不存在: ${req.method}`)
      }
    })

    this.client = client
  }

  /**
   * per-agent CODEX_HOME config.toml:注册 MCP 桥(required=true,桥挂了宁可失败)。
   * 已有 config.toml(从全局目录种子化复制)→ 追加本段(保留用户的 provider/model
   * 配置,自定义网关/密钥不丢失);全新目录 → 独立写入。
   */
  private writeCodexHomeConfig(): void {
    const home = this.config.codexHome
    if (!home) return
    try {
      mkdirSync(home, { recursive: true })
      const configFile = join(home, 'config.toml')
      const env = generateMcpBridgeEnv({ agentId: this.selfAgentId, token: this.config.token, baseUrl: this.config.baseUrl, bridgePath: this.config.mcpBridgePath })
      const envLines = Object.entries(env.bridgeEnv).map(([k, v]) => `      ${k} = "${v}"`).join('\n')
      const section = [
        ``,
        `[mcp_servers.aw]`,
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(join(process.env.AW_PACKAGE_ROOT ?? process.cwd(), 'server', 'harness', 'aw-mcp-bridge.mjs'))}]`,
        `required = true`,
        ``,
        `[mcp_servers.aw.env]`,
        envLines,
        ``,
      ].join('\n')
      if (existsSync(configFile)) {
        const existing = readFileSync(configFile, 'utf-8')
        if (existing.includes('[mcp_servers.aw]')) return
        appendFileSync(configFile, section, 'utf-8')
      }
      else {
        writeFileSync(configFile, section, 'utf-8')
      }
    }
    catch (err) {
      log.warn(`[CodexAgent:${this.selfAgentId}] CODEX_HOME config 写入失败(信任全局配置):`, err instanceof Error ? err.message : err)
    }
  }
}
