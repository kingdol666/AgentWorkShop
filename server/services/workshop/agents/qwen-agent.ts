/**
 * QwenAgentImpl — Qwen Code(`qwen --experimental-acp`)的 AgentInterface 实现。
 *
 * qwen 0.0.x 内嵌的是最老版 Zed ACP(camelCase 方法,无 sessionId,单隐式会话):
 *   client→agent: initialize / sendUserMessage{content[]} / cancelSendMessage
 *   agent→client(请求): streamAssistantMessageChunk{chunk:{text|thought}} /
 *     requestToolCallConfirmation(→ HITL) / pushToolCall
 *   sendUserMessage 的 JSON-RPC 响应在回合终点返回(与 dsh ACP 单飞同型)。
 *
 *  - 鉴权:selectedAuthType=openai + env OPENAI_API_KEY/OPENAI_BASE_URL(自定义网关,
 *    智谱 coding plan OpenAI 兼容端点实测可用);model 经 -m 透传
 *  - 工具:~/.qwen/settings.json merge-only 写 mcpServers.aw(trust=true);agent 身份
 *    经进程 env 继承到 MCP 子进程
 *  - HITL:requestToolCallConfirmation → hitl-registry(kind 'qwen-permission') →
 *    respondHitl(outcome allow/reject/cancel;fail-closed)
 *  - steer:sendUserMessage 单飞无同轮注入 → 恒 'deferred'
 */
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger'
import type {
  AgentEvent,
  AgentRunContext,
  AgentRunRequest,
} from './agent-interface'
import type { AgentContextStats } from '../types/task'
import { markHarnessProcessExit, registerHarnessProcess, bindHarnessProcess, killHarnessProcess } from './harness-process'
import { peerPrompt, systemManual, toolArgsPreview, workerPrompt } from './prompt-builder'
import { getHitlRegistry } from './hitl-registry'
import { harnessSettings } from '../settings'
import { StdioJsonRpcClient, type JsonRpcRequestIncoming } from './adapters/stdio-jsonrpc'
import { generateMcpBridgeEnv } from './harness-env'
import { BaseAgentImpl } from './base-agent'

const log = createLogger('workshop.qwen')

/** qwen ACP(旧版 zed)方法名集中地 */
export const QWEN_ACP_METHODS = {
  initialize: 'initialize',
  sendUserMessage: 'sendUserMessage',
  cancelSendMessage: 'cancelSendMessage',
  streamChunk: 'streamAssistantMessageChunk',
  toolConfirmation: 'requestToolCallConfirmation',
  pushToolCall: 'pushToolCall',
} as const

/** 确保 ~/.qwen/settings.json 具备 openai 鉴权与 aw 桥(merge-only;保留用户既有键) */
export function ensureQwenSettings(bridgePath: string, qwenHome?: string): void {
  const base = qwenHome && qwenHome.trim() !== ''
    ? resolve(qwenHome.trim())
    : resolve(homedir(), '.qwen')
  if (!base.startsWith(resolve(homedir()) + '\\') && !base.startsWith(resolve(homedir()) + '/') && base !== resolve(homedir(), '.qwen')) {
    log.warn(`qwenHome 越出用户主目录,跳过配置写入: ${base}`)
    return
  }
  const file = join(base, 'settings.json')
  let doc: Record<string, unknown> = {}
  try {
    if (existsSync(file)) doc = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
  }
  catch (err) {
    log.warn(`~/.qwen/settings.json 解析失败,保留原文件: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  let dirty = false
  if (!doc.selectedAuthType) {
    doc.selectedAuthType = 'openai'
    dirty = true
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}) as Record<string, unknown>
  const existing = servers.aw as Record<string, unknown> | undefined
  if (!existing?.command || !existing?.args) {
    servers.aw = { command: process.execPath, args: [bridgePath], trust: true }
    doc.mcpServers = servers
    dirty = true
  }
  if (!dirty) return
  try {
    writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')
  }
  catch (err) {
    log.warn(`~/.qwen/settings.json 写入失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export interface QwenAgentConfig {
  command?: string
  args?: string[]
  cwd?: string
  model?: string
  /** OpenAI 兼容网关(如智谱 coding plan)的 base URL */
  providerBaseUrl?: string
  /** OpenAI 兼容 API key(缺省继承进程环境 OPENAI_API_KEY) */
  apiKey?: string
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

export class QwenAgentImpl extends BaseAgentImpl {
  private readonly config: QwenAgentConfig

  private agentRole: 'lead' | 'worker' = 'worker'
  private client: StdioJsonRpcClient | null = null
  private clientStarting: Promise<void> | null = null
  private turnActive = false
  private sessionStarted = false
  private pendingConfirmations = new Map<string, { rpcId: string | number, timer: ReturnType<typeof setTimeout> | null }>()
  private toolCallCounter = 0

  constructor(config: Record<string, unknown> = {}) {
    super({
      agentId: typeof config.agentId === 'string' ? config.agentId : '',
      name: typeof config.name === 'string' ? config.name : undefined,
      role: config.role === 'lead' ? 'lead' : 'worker',
      channelId: typeof config.channelId === 'string' ? config.channelId : '',
    })
    this.config = config as QwenAgentConfig
  }

  protected get harnessId(): string {
    return 'qwen'
  }

  protected configRecord(): Record<string, unknown> {
    return this.config
  }

  async dispose(): Promise<void> {
    const client = this.client
    this.client = null
    this.sessionStarted = false
    if (client) {
      const pid = client.pid
      await client.dispose().catch(() => {})
      if (pid) markHarnessProcessExit(pid, null)
    }
    for (const [id, p] of this.pendingConfirmations) {
      if (p.timer) clearTimeout(p.timer)
      this.pendingConfirmations.delete(id)
    }
  }

  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const pid = this.client?.pid
    if (!pid || !this.client) return null
    return { pid, alive: this.client.alive, command: 'qwen --experimental-acp' }
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
    return null // 旧版 ACP 不透出 usage(能力面如实声明 contextStats:false)
  }

  async steer(_text: string): Promise<'steer' | 'deferred'> {
    return 'deferred'
  }

  /** HITL 应答:requestToolCallConfirmation → outcome allow/reject/cancel(fail-closed) */
  async respondHitl(kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
  }): Promise<void> {
    if (kind !== 'qwen-permission') return
    const pending = this.pendingConfirmations.get(id)
    if (!pending) throw new Error(`待办不存在或已处理: ${id}`)
    const client = this.client
    if (!client) throw new Error('qwen 会话已关闭')
    const acpOutcome = outcome.cancelled === true ? 'cancel' : (outcome.confirmed === true ? 'allow' : 'reject')
    client.respond(pending.rpcId, { outcome: acpOutcome })
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingConfirmations.delete(id)
    getHitlRegistry().resolve('qwen-permission', id, outcome.cancelled === true ? 'cancelled' : 'answered')
  }

  private clearPending(id: string, resolution: 'answered' | 'cancelled' | 'expired'): void {
    const p = this.pendingConfirmations.get(id)
    if (p?.timer) clearTimeout(p.timer)
    this.pendingConfirmations.delete(id)
    getHitlRegistry().resolve('qwen-permission', id, resolution)
  }

  // ===== run / supervise =====

  async supervise(snapshot: import('./agent-interface').SupervisionSnapshot, ctx: AgentRunContext, opts?: { signal?: AbortSignal }): Promise<import('./agent-interface').SupervisionDecision[]> {
    await this.ensureClient(ctx)
    if (!this.client || !this.sessionStarted) return []
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
      return parsed && parsed.length > 0 ? parsed as import('./agent-interface').SupervisionDecision[] : []
    }
    catch {
      return []
    }
    finally {
      this.supervising = false
    }
  }

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
    if (!client || !this.sessionStarted) {
      yield { kind: 'error', error: { code: 'QWEN_NOT_READY', message: 'qwen 会话未就绪' } }
      return
    }
    if (this.turnActive) {
      yield { kind: 'error', error: { code: 'QWEN_TURN_BUSY', message: 'qwen 上一回合尚未收口' } }
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

    // agent→client 请求/通知(旧版 ACP:增量与工具调用都走请求面)
    const unsub = client.onRequest((req: JsonRpcRequestIncoming) => {
      if (req.method === QWEN_ACP_METHODS.streamChunk) {
        lastActivity = Date.now()
        const p = (req.params ?? {}) as Record<string, unknown>
        const chunk = (p.chunk ?? {}) as Record<string, unknown>
        const text = typeof chunk.text === 'string' ? chunk.text : ''
        if (text) {
          agentText += text
          enqueue({ kind: 'delta', delta: { text } })
        }
        client.respond(req.id, {})
        return
      }
      if (req.method === QWEN_ACP_METHODS.pushToolCall) {
        const p = (req.params ?? {}) as Record<string, unknown>
        enqueue({
          kind: 'status',
          status: {
            state: 'WORKING',
            message: { messageId: randomUUID(), contextId: this.channelId, role: 'ROLE_AGENT', parts: [{ text: `🔧 ${String(p.label ?? p.tool_name ?? p.name ?? 'tool')}${toolArgsPreview(p.arguments ?? p.input ?? p.args)}` }] },
            timestamp: new Date().toISOString(),
          },
        })
        client.respond(req.id, { id: `aw-${++this.toolCallCounter}` })
        return
      }
      if (req.method === QWEN_ACP_METHODS.toolConfirmation) {
        this.registerConfirmationHitl(req)
        return
      }
      // 未知 agent→client 请求:空应答避免卡死回合
      client.respond(req.id, {})
    })

    const onAbort = (): void => {
      log.warn(`[QwenAgent:${this.selfAgentId}] run 被 abort → cancelSendMessage,taskId=${taskId ?? '-'}`)
      client.notify(QWEN_ACP_METHODS.cancelSendMessage, {})
      setTimeout(() => {
        if (!isDone) enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      }, 5000)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    void client.request(QWEN_ACP_METHODS.sendUserMessage, {
      chunks: [{ text: prompt }],
    }, timeoutMs + 30_000)
      .then(() => {
        enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      })
      .catch((err: unknown) => {
        enqueue({
          kind: 'error',
          error: {
            code: 'QWEN_PROMPT_FAILED',
            message: `qwen sendUserMessage 失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      })

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = timeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            client.notify(QWEN_ACP_METHODS.cancelSendMessage, {})
            enqueue({
              kind: 'error',
              error: { code: 'QWEN_TURN_STALLED', message: `回合停滞 ${Math.round(timeoutMs / 1000)}s 无事件,已取消` },
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
    if (this.client?.alive && this.sessionStarted) return
    if (this.client && !this.client.alive) {
      this.client = null
      this.sessionStarted = false
    }
    this.clientStarting ??= this.startClient().finally(() => {
      this.clientStarting = null
    })
    await this.clientStarting
  }

  private async startClient(): Promise<void> {
    const command = this.config.command ?? harnessSettings().qwen_command
    const bridge = generateMcpBridgeEnv({
      agentId: this.selfAgentId,
      token: this.config.token,
      baseUrl: this.config.baseUrl,
      bridgePath: this.config.mcpBridgePath,
    })
    ensureQwenSettings(bridge.bridgePath, typeof this.config.qwenHome === 'string' ? this.config.qwenHome : undefined)
    const env = {
      ...bridge.bridgeEnv,
      ...(this.config.providerBaseUrl ? { OPENAI_BASE_URL: this.config.providerBaseUrl } : {}),
      ...(this.config.apiKey ? { OPENAI_API_KEY: this.config.apiKey } : {}),
      // openai provider 的请求模型走 OPENAI_MODEL(-m 在 acp 路径不生效,源码 contentGenerator.js:56)
      ...(this.config.model ? { OPENAI_MODEL: this.config.model } : {}),
    }
    const args = this.config.args ?? [
      ...(this.config.model ? ['-m', this.config.model] : []),
      '--experimental-acp',
      '--allowed-mcp-server-names', 'aw',
    ]
    const client = new StdioJsonRpcClient({
      name: 'qwen',
      command,
      args,
      cwd: this.config.cwd ?? process.cwd(),
      env,
      requestTimeoutMs: 60_000,
    })
    const pidRef = { pid: undefined as number | undefined }
    client.onExit((code) => {
      if (pidRef.pid) markHarnessProcessExit(pidRef.pid, code)
      this.sessionStarted = false
      log.warn(`[QwenAgent:${this.selfAgentId}] qwen acp 进程退出(code=${code});下回合自动重生`)
    })
    await client.start()
    pidRef.pid = client.pid
    if (client.pid) {
      registerHarnessProcess(client.pid, { harness: 'qwen', command, args })
      bindHarnessProcess(client.pid, { agentId: this.selfAgentId, channelId: this.channelId, name: this.agentName, role: this.agentRole })
    }

    const initResult = await client.request(QWEN_ACP_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    }, 30_000) as Record<string, unknown>
    if (initResult?.isAuthenticated !== true) {
      await client.dispose().catch(() => {})
      throw new Error('qwen 未完成鉴权(selectedAuthType=openai + OPENAI_API_KEY/OPENAI_BASE_URL)')
    }
    this.client = client
    this.sessionStarted = true
  }

  private registerConfirmationHitl(req: JsonRpcRequestIncoming): void {
    const client = this.client
    if (!client) return
    const p = (req.params ?? {}) as Record<string, unknown>
    const id = `qwen-${randomUUID().slice(0, 8)}`
    getHitlRegistry().register({
      kind: 'qwen-permission',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: client.pid,
      method: 'confirm',
      title: `qwen 工具确认:${String(p.label ?? '操作').slice(0, 200)}`,
      detail: String((p.confirmation as Record<string, unknown> | undefined)?.prompt ?? ''),
      options: ['allow', 'reject'],
      createdAt: new Date().toISOString(),
      expiresAt: null,
    })
    const timeoutMs = harnessSettings().hitl_timeout_ms
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          void this.respondHitl('qwen-permission', id, { confirmed: false }).catch(() => {})
        }, timeoutMs)
      : null
    this.pendingConfirmations.set(id, { rpcId: req.id, timer })
  }
}
