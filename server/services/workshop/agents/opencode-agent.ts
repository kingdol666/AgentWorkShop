/**
 * OpenCodeAgentImpl — opencode harness 的 AgentInterface 实现。
 *
 * 进程模型:每 Agent 一个 `opencode serve --port <free>` 子进程(lazy spawn,跨消息复用),
 * 经 HTTP API(prompt_async / abort / permissions / summarize)与全局 SSE 事件流(/event)
 * 交互 —— 官方机器面,协议参考 opencode OpenAPI(1.18.x)。
 *
 *  - prompt 组装与工具面与 omp 全引擎同源(prompt-builder / host-tool-bridge);
 *    工具经 stdio MCP 桥(server/harness/aw-mcp-bridge.mjs)以 POST /mcp 运行时注册注入
 *  - opencode 事件 → AgentEvent 五变体映射(适配器职责,本文件统一收口)
 *  - 权限/提问(permission.asked / question.asked)→ hitl-registry(程序化应答)
 *  - steer:回合运行中再投 prompt(引擎 steer/queue admission),内容不丢 → 'steer'
 *  - 上下文治理:message.tokens 被动跟踪;越阈值 → POST /session/{id}/summarize
 *
 * 协议权威:https://opencode.ai/docs/server(v1.18.28 实测)。
 */
import { createLogger } from '../logger'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
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
import { registerHarnessProcess, bindHarnessProcess, markHarnessProcessExit, killHarnessProcess, isProcessAlive } from './harness-process'
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
import { spawnLineProcess } from './adapters/line-spawn'
import { resolveBridgePath, resolvePlatformBaseUrl } from './harness-env'

const log = createLogger('workshop.opencode')

export interface OpenCodeAgentConfig {
  /** opencode 可执行文件(默认取 harness.opencode_command 设置) */
  command?: string
  cwd?: string
  /** 模型(provider/model,如 anthropic/claude-sonnet-4-5) */
  model?: string
  /** opencode agent 名(默认 build) */
  agent?: string
  /** provider 推理档位(variant) */
  variant?: string
  /** 权限策略(session 级;缺省 edit/bash/webfetch 全 ask → HITL) */
  permission?: unknown
  /** 数据目录覆盖(XDG_DATA_HOME;实例隔离/绕开损坏的全局库) */
  dataDir?: string
  /** 配置目录覆盖(XDG_CONFIG_HOME;空目录 = 不加载用户全局 opencode 插件/配置) */
  configDir?: string
  /** 上下文窗口(usage 百分比计算;未知则 percent=null) */
  contextWindow?: number
  /** 压缩阈值(0-1,默认 0.7) */
  compactThreshold?: number
  /** 回合停滞超时(ms,默认 600000) */
  promptTimeoutMs?: number
  /** supervise 超时(ms,默认 150000) */
  superviseTimeoutMs?: number
  systemPromptPrefix?: string
  scenarioPrompt?: string
  agentId?: string
  name?: string
  role?: 'lead' | 'worker'
  channelId?: string
  /** 平台自证 token(MCP 桥回程鉴权;factory 注入) */
  token?: string
  /** 平台 HTTP 基址(桥回程;默认 AW_BASE_URL 或 127.0.0.1:PORT) */
  baseUrl?: string
  /** MCP 桥脚本路径(默认 <packageRoot>/server/harness/aw-mcp-bridge.mjs) */
  mcpBridgePath?: string
}

const DEFAULT_PERMISSION = [
  { permission: 'edit', pattern: '*', action: 'ask' },
  { permission: 'bash', pattern: '*', action: 'ask' },
  { permission: 'webfetch', pattern: '*', action: 'ask' },
]

/** 取一个空闲 TCP 端口(绑定即弃,竞态窗口小;opencode serve 自身再绑定) */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('无可用端口'))))
    })
  })
}

interface PendingHitl {
  kind: 'opencode-permission'
  id: string
  type: 'permission' | 'question'
  sessionId: string
  timer: ReturnType<typeof setTimeout> | null
}

export class OpenCodeAgentImpl implements AgentInterface {
  private readonly config: OpenCodeAgentConfig
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

  // 服务进程与 API 面
  private child: ReturnType<typeof spawnLineProcess> | null = null
  private baseUrl = ''
  private basicAuth = ''
  private sessionId: string | null = null
  private serverStarting: Promise<void> | null = null
  private exited = false
  private stderrTail = ''
  private sseAbort: AbortController | null = null

  // 回合状态
  private turnActive = false
  private aborted = false
  /** 助手正文(partId → 全文;message.part.updated 携带全量文本) */
  private partTexts = new Map<string, string>()
  private partOrder: string[] = []
  private lastUsage: { input: number, at: number } | null = null
  private compacting = false
  private lastCompactAt = 0
  /** 待应答 HITL(id → 定位信息) */
  private pendingHitl = new Map<string, PendingHitl>()

  constructor(config: Record<string, unknown> = {}) {
    this.config = config as OpenCodeAgentConfig
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

  // ===== 生命周期 / 进程面 =====

  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const pid = this.child?.pid
    if (!pid || !this.child) return null
    return { pid, alive: !this.exited, command: 'opencode serve' }
  }

  killProcess(): void {
    const pid = this.child?.pid
    if (pid) killHarnessProcess(pid)
    this.child = null
  }

  reconcileProcess(): void {
    const pid = this.child?.pid
    if (!pid || this.exited) return
    if (!isProcessAlive(pid)) this.handleServerExit(null)
  }

  async dispose(): Promise<void> {
    this.sseAbort?.abort()
    const pid = this.child?.pid
    if (pid) {
      killHarnessProcess(pid)
      markHarnessProcessExit(pid, null)
    }
    this.child = null
    this.exited = true
    this.serverStarting = null
    for (const [id, p] of this.pendingHitl) {
      if (p.timer) clearTimeout(p.timer)
      this.pendingHitl.delete(id)
    }
  }

  // ===== 引擎无关面 =====

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

  /**
   * 实时注入:回合运行中再投一条 prompt(opencode 引擎 admit 为 steer/queue,
   * 内容必然到达模型)→ 'steer';空闲 → 'deferred'(消费循环起回合处理)。
   */
  async steer(text: string): Promise<'steer' | 'deferred'> {
    if (!this.sessionId || !this.turnActive) return 'deferred'
    try {
      await this.promptAsync(text)
      return 'steer'
    }
    catch (err) {
      log.warn(`[OpenCodeAgent:${this.selfAgentId}] steer 投递失败(消息保持 pending):`, err instanceof Error ? err.message : err)
      return 'deferred'
    }
  }

  /** HITL 应答(codex/opencode/dsh 统一入口;本 impl 处理 opencode-permission) */
  async respondHitl(kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<void> {
    if (kind !== 'opencode-permission') return
    const pending = this.pendingHitl.get(id)
    if (!pending) throw new Error(`待办不存在或已处理: ${id}`)
    // 应答映射:显式 response > confirmed/cancelled 布尔(缺省拒绝,fail-closed)
    const cancelled = outcome.cancelled === true || (outcome.confirmed !== true && !outcome.response)
    if (pending.type === 'permission') {
      const response = cancelled ? 'reject' : (outcome.response === 'always' || outcome.response === 'once' ? outcome.response : 'once')
      await this.api('POST', `/session/${pending.sessionId}/permissions/${encodeURIComponent(id)}`, { response })
    }
    else {
      // question:取消走 reject 端点;回答携带 value
      if (cancelled) {
        await this.api('POST', `/question/${encodeURIComponent(id)}/reject`, {})
      }
      else {
        await this.api('POST', `/question/${encodeURIComponent(id)}/reply`, { answer: outcome.value ?? outcome.comment ?? '' })
      }
    }
    if (pending.timer) clearTimeout(p.timer)
    this.pendingHitl.delete(id)
    getHitlRegistry().resolve(kind, id, cancelled ? 'cancelled' : 'answered')
  }

  /** 上下文治理(post-settle 钩子):越阈值 → summarize;异常不抛出 */
  async onTurnSettled(): Promise<void> {
    if (this.compacting || !this.sessionId) return
    const stats = this.getContextStats()
    const threshold = this.config.compactThreshold ?? 0.7
    if (!stats?.percent || stats.percent < threshold) return
    if (Date.now() - this.lastCompactAt < 5 * 60_000) return
    this.compacting = true
    this.lastCompactAt = Date.now()
    try {
      await this.api('POST', `/session/${this.sessionId}/summarize`, {})
      log.info(`[OpenCodeAgent:${this.selfAgentId}] 上下文压缩已触发(percent=${(stats.percent * 100).toFixed(0)}%)`)
    }
    catch (err) {
      log.warn(`[OpenCodeAgent:${this.selfAgentId}] summarize 失败(放行):`, err instanceof Error ? err.message : err)
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
    await this.ensureServer(ctx)
    if (!this.sessionId) return []
    if (this.supervising) return []
    const prompt = supervisePrompt({
      snapshot,
      agentName: this.agentName,
      channelId: this.channelId,
      ctxPrefix: await this.contextPrefix(),
      manual: systemManual(),
      memory: ctx.memory,
    })
    const timeoutMs = this.config.superviseTimeoutMs ?? 150_000
    return await this.runTurn(prompt, undefined, {
      timeoutMs,
      signal: opts?.signal,
      onDone: async () => {
        this.supervising = false
      },
      beforeStart: () => {
        this.supervising = true
      },
    }).then((events) => {
      // 从事件流提取最终文本 → JSON 决策兜底(工具直执行路径返回空)
      let text = ''
      for (const e of events) {
        if (e.kind === 'artifact') {
          text += e.artifact.parts.map(p => 'text' in p ? p.text : '').join('')
        }
      }
      const parsed = extractJsonArray(text)
      return parsed && parsed.length > 0 ? parsed as SupervisionDecision[] : []
    }).catch(() => {
      this.supervising = false
      return []
    })
  }

  private async* workerRun(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return
    this.toolState.currentTaskId = taskId
    try {
      await this.ensureServer(ctx)
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
      yield* this.runTurn(prompt, taskId, {
        timeoutMs: this.config.promptTimeoutMs ?? 600_000,
        signal: ctx.signal,
      })
    }
    finally {
      this.toolState.currentTaskId = null
    }
  }

  private async* peerMessageRun(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    await this.ensureServer(ctx)
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
    yield* this.runTurn(prompt, undefined, { timeoutMs: this.config.promptTimeoutMs ?? 600_000, signal: ctx.signal })
  }

  private async contextPrefix(): Promise<string> {
    return buildContextPrefix({
      scenarioPrompt: this.config.scenarioPrompt,
      systemPromptPrefix: this.config.systemPromptPrefix,
      agentId: this.selfAgentId,
      roster: await this.roster.roster(),
    })
  }

  // ===== 回合执行(prompt → SSE 事件 → AgentEvent)=====

  private runTurn(
    prompt: string,
    taskId: string | undefined,
    opts: { timeoutMs: number, signal?: AbortSignal, beforeStart?: () => void, onDone?: () => void },
  ): AsyncGenerator<AgentEvent, void, unknown> {
    return this._runTurn(prompt, taskId, opts)
  }

  private async* _runTurn(
    prompt: string,
    taskId: string | undefined,
    opts: { timeoutMs: number, signal?: AbortSignal, beforeStart?: () => void, onDone?: () => void },
  ): AsyncGenerator<AgentEvent, void, unknown> {
    if (!this.sessionId) {
      yield { kind: 'error', error: { code: 'OPENCODE_NOT_READY', message: 'opencode 会话未就绪' } }
      return
    }
    opts.beforeStart?.()
    const queue: AgentEvent[] = []
    let isDone = false
    let resolveWait: (() => void) | null = null
    let lastActivity = Date.now()
    this.turnActive = true
    this.aborted = false
    this.partTexts = new Map()
    this.partOrder = []

    const enqueue = (e: AgentEvent): void => {
      // done 事件前先收口 artifact(助手正文聚合),保证事件序 artifact → done
      if (e.kind === 'done' && !isDone) {
        const text = this.partOrder.map(id => this.partTexts.get(id) ?? '').join('').trim()
        if (text) {
          queue.push({
            kind: 'artifact',
            artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text }] },
            lastChunk: true,
            totalChunks: 1,
          })
        }
        this.turnActive = false
        opts.onDone?.()
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

    // 事件订阅(SSE → 队列)
    const unsub = this.onEngineEvent((ev) => {
      for (const mapped of this.mapEngineEvent(ev, taskId)) enqueue(mapped)
    })

    // 停滞看门狗
    let stallTimer: ReturnType<typeof setTimeout> | null = null

    const finishTurn = (): void => {
      if (isDone) return
      const text = this.partOrder.map(id => this.partTexts.get(id) ?? '').join('').trim()
      if (text) {
        enqueue({
          kind: 'artifact',
          artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text }] },
          lastChunk: true,
          totalChunks: 1,
        })
      }
      enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      this.turnActive = false
      opts.onDone?.()
    }

    const onAbort = (): void => {
      log.warn(`[OpenCodeAgent:${this.selfAgentId}] run 被 abort → POST abort,taskId=${taskId ?? '-'}`)
      this.aborted = true
      void this.api('POST', `/session/${this.sessionId}/abort`, {}).catch(() => {})
      // 引擎将回 session.idle → finishTurn;兜底 5s 后强制收口
      setTimeout(() => finishTurn(), 5000)
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    // 投递 prompt
    try {
      await this.promptAsync(prompt)
      enqueue({ kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } })
    }
    catch (err) {
      unsub()
      opts.signal?.removeEventListener('abort', onAbort)
      this.turnActive = false
      yield {
        kind: 'error',
        error: {
          code: 'OPENCODE_PROMPT_FAILED',
          message: `opencode prompt 失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = opts.timeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            this.aborted = true
            void this.api('POST', `/session/${this.sessionId}/abort`, {}).catch(() => {})
            enqueue({
              kind: 'error',
              error: {
                code: 'OPENCODE_TURN_STALLED',
                message: `回合停滞 ${Math.round(opts.timeoutMs / 1000)}s 无事件,已中止(消息按已处理落账)`,
              },
            })
            this.turnActive = false
            continue
          }
          await new Promise<void>((r) => {
            resolveWait = r
            stallTimer = setTimeout(() => {
              resolveWait = null
              r()
            }, remaining + 100)
          })
          if (stallTimer) {
            clearTimeout(stallTimer)
            stallTimer = null
          }
        }
        while (queue.length > 0) {
          yield queue.shift()!
        }
      }
    }
    finally {
      if (stallTimer) clearTimeout(stallTimer)
      unsub()
      opts.signal?.removeEventListener('abort', onAbort)
      this.turnActive = false
    }
  }

  /** 引擎事件 → AgentEvent(适配器核心) */
  private mapEngineEvent(ev: Record<string, unknown>, taskId: string | undefined): AgentEvent[] {
    const type = String(ev.type ?? '')
    const props = (ev.properties ?? {}) as Record<string, unknown>
    const sid = props.sessionID ?? props.sessionId
    if (sid && sid !== this.sessionId) return [] // 多会话实例隔离(本 impl 一会话,防御)

    const now = new Date().toISOString()
    const statusEvent = (text: string): AgentEvent => ({
      kind: 'status',
      status: {
        state: 'WORKING',
        message: { messageId: randomUUID(), contextId: this.channelId, role: 'ROLE_AGENT', parts: [{ text }] },
        timestamp: now,
      },
    })

    switch (type) {
      case 'message.part.delta': {
        if (props.field === 'text' && typeof props.delta === 'string' && props.delta) {
          return [{ kind: 'delta', delta: { text: props.delta } }]
        }
        return []
      }
      case 'message.part.updated': {
        const part = props.part as Record<string, unknown> | undefined
        if (!part) return []
        const partId = String(part.id ?? '')
        const partType = String(part.type ?? '')
        if (partType === 'text' && typeof part.text === 'string' && partId) {
          if (!this.partOrder.includes(partId)) this.partOrder.push(partId)
          this.partTexts.set(partId, part.text)
        }
        else if (partType === 'tool') {
          const state = (part.state ?? {}) as Record<string, unknown>
          const tool = String(part.tool ?? 'tool')
          const statusStr = String(state.status ?? '')
          if (statusStr === 'pending' || statusStr === 'running') {
            const input = state.input ?? part.input
            return [statusEvent(`🔧 ${tool}${toolArgsPreview(input)}`)]
          }
          if (statusStr === 'error') {
            return [statusEvent(`🔧 ${tool} 失败: ${String(state.error ?? '未知错误').slice(0, 200)}`)]
          }
        }
        else if (partType === 'compaction') {
          this.lastCompactAt = Date.now()
        }
        return []
      }
      case 'message.updated': {
        const info = props.info as Record<string, unknown> | undefined
        if (info?.role === 'assistant') {
          const tokens = info.tokens as Record<string, unknown> | undefined
          const input = Number(tokens?.input)
          if (Number.isFinite(input) && input > 0) this.lastUsage = { input, at: Date.now() }
          const err = info.error as Record<string, unknown> | undefined
          if (err && this.turnActive) {
            const code = String(err.name ?? 'UnknownError')
            return [{
              kind: 'error',
              error: { code: `OPENCODE_LLM_${code}`, message: String(err.message ?? 'opencode 回合错误') },
            }]
          }
        }
        return []
      }
      case 'session.error': {
        const err = props.error as Record<string, unknown> | undefined
        if (!this.turnActive) return []
        const data = (err?.data ?? {}) as Record<string, unknown>
        const detail = String(data.message ?? err?.message ?? 'opencode 会话错误')
        return [{
          kind: 'error',
          error: {
            code: `OPENCODE_ERROR_${String(err?.name ?? 'UNKNOWN')}`,
            message: `${detail}${data.statusCode != null ? ` (HTTP ${data.statusCode})` : ''}`,
          },
        }]
      }
      case 'session.status': {
        const status = props.status as Record<string, unknown> | undefined
        if (String(status?.type ?? '') === 'idle' && this.turnActive) {
          return [{ kind: 'done', final: taskId ? { taskId } : undefined }]
        }
        return []
      }
      case 'session.idle': {
        if (this.turnActive) {
          return [{ kind: 'done', final: taskId ? { taskId } : undefined }]
        }
        return []
      }
      // ===== HITL =====
      case 'permission.asked':
      case 'permission.v2.asked': {
        this.registerPermissionHitl(type === 'permission.v2.asked', props)
        return []
      }
      case 'question.asked': {
        this.registerQuestionHitl(props)
        return []
      }
      case 'permission.replied':
      case 'permission.v2.replied':
      case 'question.replied':
      case 'question.rejected': {
        const id = String(props.id ?? '')
        if (id && this.pendingHitl.has(id)) {
          const p = this.pendingHitl.get(id)!
          if (p.timer) clearTimeout(p.timer)
          this.pendingHitl.delete(id)
        }
        return []
      }
      default:
        return []
    }
  }

  private registerPermissionHitl(v2: boolean, props: Record<string, unknown>): void {
    const id = String(props.id ?? '')
    if (!id) return
    if (this.pendingHitl.has(id)) return
    const sessionId = String(props.sessionID ?? this.sessionId ?? '')
    const permission = String(props.permission ?? props.action ?? 'action')
    const patterns = Array.isArray(props.patterns) ? props.patterns.map(String).join(', ') : ''
    const v2res = Array.isArray(props.resources) ? props.resources.map(String).join(', ') : ''
    const detail = patterns || v2res
    const title = `opencode 权限请求:${permission}${detail ? `(${detail})` : ''}`
    this.registerHitl(id, 'permission', sessionId, title, `引擎将执行 ${permission}${detail ? ` → ${detail}` : ''};批准放行一次,拒绝则引擎收到 reject。`)
  }

  private registerQuestionHitl(props: Record<string, unknown>): void {
    const id = String(props.id ?? '')
    if (!id || this.pendingHitl.has(id)) return
    const sessionId = String(props.sessionID ?? this.sessionId ?? '')
    const questions = Array.isArray(props.questions) ? props.questions : []
    const first = (questions[0] ?? {}) as Record<string, unknown>
    const title = String(first.question ?? first.header ?? 'opencode 提问')
    this.registerHitl(id, 'question', sessionId, title, String(first.question ?? ''), 'input')
  }

  private registerHitl(id: string, type: 'permission' | 'question', sessionId: string, title: string, detail: string, method: 'confirm' | 'input' = 'confirm'): void {
    const registry = getHitlRegistry()
    registry.register({
      kind: 'opencode-permission',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: this.child?.pid,
      method,
      title,
      detail,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    })
    // 无人应答超时(fail-closed:到时自动拒绝),0 = 无限等待
    const timeoutMs = harnessSettings().hitl_timeout_ms
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          void this.respondHitl('opencode-permission', id, { cancelled: true }).catch(() => {})
          registry.resolve('opencode-permission', id, 'expired')
        }, timeoutMs)
      : null
    this.pendingHitl.set(id, { kind: 'opencode-permission', id, type, sessionId, timer })
  }

  // ===== opencode 服务进程与 HTTP 客户端 =====

  private async ensureServer(ctx: AgentRunContext): Promise<void> {
    if (!this.workspace) this.workspace = ctx.workspace
    if (!this.agentInfo) {
      this.channelId = ctx.channelId
      this.agentRole = ctx.role
      this.refreshIdentity()
    }
    if (this.sessionId && this.child && !this.exited) return
    this.serverStarting ??= this.startServer().finally(() => {
      this.serverStarting = null
    })
    await this.serverStarting
  }

  private async startServer(): Promise<void> {
    const command = this.config.command ?? harnessSettings().opencode_command
    const port = await freePort()
    const password = randomUUID()
    const cwd = this.config.cwd ?? process.cwd()
    this.exited = false
    const child = spawnLineProcess(command, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd,
      env: {
        OPENCODE_SERVER_PASSWORD: password,
        ...(this.config.dataDir ? { XDG_DATA_HOME: this.config.dataDir } : {}),
        ...(this.config.configDir ? { XDG_CONFIG_HOME: this.config.configDir } : {}),
      },
    })
    this.child = child
    this.baseUrl = `http://127.0.0.1:${port}`
    this.basicAuth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-8000)
    })
    const pid = child.pid
    if (pid) {
      registerHarnessProcess(pid, { harness: 'opencode', command, args: ['serve', '--port', String(port)] })
      bindHarnessProcess(pid, { agentId: this.selfAgentId, channelId: this.channelId, name: this.agentName, role: this.agentRole })
    }
    child.on('exit', code => this.handleServerExit(code))

    // 健康探测(serve 冷启动含 provider registry,预算 60s;/global/health 需 Basic 认证)
    const deadline = Date.now() + 60_000
    let healthy = false
    while (Date.now() < deadline) {
      if (this.exited) {
        throw new Error(`opencode serve 启动失败(进程退出)${this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-400)}` : ''}`)
      }
      try {
        const res = await fetch(`${this.baseUrl}/global/health`, {
          headers: { authorization: this.basicAuth },
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          healthy = true
          break
        }
      }
      catch { /* 未就绪,重试 */ }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!healthy) throw new Error(`opencode serve 健康探测超时(60s)${this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-400)}` : ''}`)

    // 注册 MCP 桥(全量 host tools 注入;幂等;command 为 [可执行, 参数...] 数组形态)
    try {
      await this.api('POST', '/mcp', {
        name: 'aw-host-tools',
        config: {
          type: 'local',
          command: [process.execPath, resolveBridgePath(this.config.mcpBridgePath)],
          environment: {
            AW_BASE_URL: resolvePlatformBaseUrl(this.config.baseUrl),
            AW_AGENT_ID: this.selfAgentId,
            AW_AGENT_TOKEN: this.config.token ?? '',
            AW_MCP_TOOL_TIMEOUT_MS: String(200_000),
          },
        },
      })
    }
    catch (err) {
      log.warn(`[OpenCodeAgent:${this.selfAgentId}] MCP 桥注册失败(host tools 不可用):`, err instanceof Error ? err.message : err)
    }

    // 建会话(权限策略缺省全 ask;引擎版本不认 permission 字段时降级重试)
    const body: Record<string, unknown> = {
      title: `${this.agentName}@${this.channelId || 'channel'}`,
      ...(this.config.model ? { model: this.modelRef() } : {}),
    }
    const createWith = async (permission: unknown): Promise<Record<string, unknown>> =>
      this.api('POST', '/session', { ...body, ...(permission !== undefined ? { permission } : {}) })
    const created = await (this.config.permission ?? DEFAULT_PERMISSION)
      ? createWith(this.config.permission ?? DEFAULT_PERMISSION).catch(() => createWith(undefined))
      : createWith(undefined)
    this.sessionId = String(created?.id ?? '')
    if (!this.sessionId) throw new Error('opencode 会话创建失败(无 session id)')

    // 订阅全局事件流
    this.openEventStream()
  }

  private modelRef(): Record<string, string> | undefined {
    const model = this.config.model
    if (!model) return undefined
    if (model.includes('/')) {
      const [providerID, modelID] = model.split('/', 2)
      return { providerID: providerID ?? '', modelID: modelID ?? '' }
    }
    return { providerID: 'opencode', modelID: model }
  }

  private handleServerExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.sseAbort?.abort()
    const pid = this.child?.pid
    if (pid) markHarnessProcessExit(pid, code)
    // 在途回合经引擎错误归位:下一回合 ensureServer 重生
    log.warn(`[OpenCodeAgent:${this.selfAgentId}] opencode serve 退出(code=${code});下回合自动重生`)
  }

  /** 全局 SSE 订阅(断线重连;帧解析 data: 行) */
  private openEventStream(): void {
    this.sseAbort?.abort()
    const ctrl = new AbortController()
    this.sseAbort = ctrl
    const connect = async (): Promise<void> => {
      while (!ctrl.signal.aborted && !this.exited) {
        try {
          const res = await fetch(`${this.baseUrl}/event`, {
            headers: { authorization: this.basicAuth, accept: 'text/event-stream' },
            signal: ctrl.signal,
          })
          if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const chunks = buf.split('\n\n')
            buf = chunks.pop() ?? ''
            for (const chunk of chunks) {
              for (const line of chunk.split('\n')) {
                if (!line.startsWith('data:')) continue
                const payload = line.slice(5).trim()
                if (!payload) continue
                try {
                  this.dispatchEngineEvent(JSON.parse(payload))
                }
                catch { /* 非 JSON data 行忽略 */ }
              }
            }
          }
        }
        catch (err) {
          if (ctrl.signal.aborted || this.exited) return
          log.warn(`[OpenCodeAgent:${this.selfAgentId}] SSE 断开(1s 后重连):`, err instanceof Error ? err.message : err)
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
    void connect()
  }

  /** SSE 事件缓冲(回合未激活时事件即到即弃,激活后由 mapEngineEvent 消费) */
  private engineListeners = new Set<(ev: Record<string, unknown>) => void>()

  private dispatchEngineEvent(ev: Record<string, unknown>): void {
    for (const fn of this.engineListeners) fn(ev)
  }

  private onEngineEvent(fn: (ev: Record<string, unknown>) => void): () => void {
    this.engineListeners.add(fn)
    return () => this.engineListeners.delete(fn)
  }

  private async api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: this.basicAuth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    })
    if (res.status === 204) return {}
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = text ? JSON.parse(text) as Record<string, unknown> : {}
    }
    catch { /* 非 JSON 响应体 */ }
    if (!res.ok) {
      throw new Error(`opencode API ${method} ${path} → HTTP ${res.status}: ${String((json as { message?: string }).message ?? text.slice(0, 200))}`)
    }
    return json
  }

  private async promptAsync(text: string): Promise<void> {
    if (!this.sessionId) throw new Error('会话未就绪')
    await this.api('POST', `/session/${this.sessionId}/prompt_async`, {
      parts: [{ type: 'text', text }],
      ...(this.config.agent ? { agent: this.config.agent } : {}),
      ...(this.config.model ? { model: this.modelRef() } : {}),
      ...(this.config.variant ? { variant: this.config.variant } : {}),
    })
  }
}
