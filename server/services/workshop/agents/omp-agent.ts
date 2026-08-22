/**
 * OmpRpcAgentImpl — omp harness 的完整 AgentInterface 实现。
 *
 * 通过 OmpRpcClient 驱动真实 omp 子进程(--mode rpc),将 omp 的原生 agent 能力
 * (LLM 推理 + 内置工具 read/write/edit/bash/grep/glob 等)接入 Workshop 的
 * Channel 编排体系。
 *
 * 核心设计:
 *  - 每个 Agent 实例持有一个 omp 子进程(lazy spawn,跨消息复用)
 *  - AgentWorkspace 方法注册为 omp host tools,agent 原生调用 report_progress /
 *    complete_task / dispatch_task / send_message 等,无需文本解析
 *  - omp AgentSessionEvent → AgentEvent 五变体映射
 *  - worker run():接收 assign → prompt omp → agent 用原生工具作业 + host tools 管理任务生命周期
 *  - lead supervise():格式化快照 → prompt omp → agent 直接用 host tools 执行调度决策 → 返回 []
 *  - dispose():杀子进程
 *
 * 协议权威:omp://rpc.md;AgentInterface 契约见 agent-interface.ts。
 */
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
import type { A2AArtifact, A2AMessage, Part } from '../types/a2a'
import type { WorkspaceTask } from '../types/task'
import {
  OmpRpcClient,
  type AgentSessionEvent,
  type RpcHostToolDefinition,
  type HostToolCallRequest,
} from './adapters/omp-rpc-client'
import {
  registerHarnessProcess,
  bindHarnessProcess,
  markHarnessProcessExit,
  killHarnessProcess,
} from './harness-process'
import {
  attachTerminalTap,
  markTerminalSessionExit,
} from './harness-terminal'
import {
  loadHostToolDefs,
  renderPrompt,
} from '../prompts/loader'
import { extractTaskMode } from '../runtime/execution-mode'

// ===== 配置 =====

export interface OmpAgentConfig {
  /** omp 可执行文件路径(默认 'omp',从 PATH 查找) */
  command?: string
  /** 额外 CLI 参数 */
  args?: string[]
  /** omp 工作目录(默认 process.cwd()) */
  cwd?: string
  /** 模型 provider(如 'anthropic'/'openai'/'zhipu');省略则用 omp 默认 */
  provider?: string
  /** 模型 ID;省略则用 omp 默认 */
  model?: string
  /** thinking level: off/minimal/low/medium/high/xhigh/max */
  thinkingLevel?: string
  /** 自定义系统 prompt 前缀(拼接到 agent 系统指令之前) */
  systemPromptPrefix?: string
  /** 限制 omp 仅使用指定内置工具(null = 全部) */
  toolNames?: string[]
  /** 每轮停滞超时(ms,默认 300000):整轮无任何 omp 事件才中止;工具内阻塞(poll_messages ≤180s)有 tool 事件刷新计时 */
  promptTimeoutMs?: number
  /** supervise 轮超时(ms,默认 60000) */
  superviseTimeoutMs?: number
  /**
   * omp 输出模式:'rpc-ui'(默认)= RPC 协议 + UI 上下文 —— ask 工具与
   * extension_ui_request 对话框可用(监控终端 HITL 通道,强制 noPty);
   * 'rpc' = 纯协议(无 UI,ask 不可用)。
   */
  rpcMode?: 'rpc' | 'rpc-ui'
  /** channel 级作业场景 prompt(manager 装配时注入;用户场景规范,全员共享) */
  scenarioPrompt?: string
  /** agent 身份(由 factory 从 AgentInfo 注入) */
  agentId?: string
  name?: string
  role?: 'lead' | 'worker'
  channelId?: string
}

// ===== host tool 定义(注册到 omp,agent 原生调用) =====

// ===== host tool 定义(外置 .AgentWorkShop/prompts/host-tools.json;加载器缓存)=====

export const HOST_TOOLS: RpcHostToolDefinition[] = loadHostToolDefs()

/** 仅 lead 可见的工具名(dispatch/调度/团队管理面;worker 注册时剔除,压缩工具上下文) */
const LEAD_ONLY_TOOL_NAMES = new Set([
  'dispatch_task',
  'get_queue_overview',
  'read_channel_mail',
  'reassign_task',
  'update_task',
  'create_team_agent',
  'update_team_agent',
  'remove_team_agent',
])

/** 按角色装配 host tools:lead = 全量;worker = 剔除 lead 专属(执行面 + 通信面 + 记忆面) */
export function hostToolsForRole(role: 'lead' | 'worker'): RpcHostToolDefinition[] {
  if (role === 'lead') return HOST_TOOLS
  return HOST_TOOLS.filter(t => !LEAD_ONLY_TOOL_NAMES.has(t.name))
}

// ===== 辅助函数 =====

/** 从消息 parts 提取纯文本 */
function partsToText(parts: Part[]): string {
  return parts
    .map((p) => {
      if ('text' in p) return p.text
      if ('data' in p) return JSON.stringify(p.data)
      if ('url' in p) return p.url
      if ('raw' in p) return p.raw
      return ''
    })
    .join('\n')
}

/**
 * 工具参数预览(Codex 式紧凑工具行):`name(path)` / `name(a=1, b=2)`。
 * 首选 path/file/command/cmd 等单值字段,否则取前两个标量字段;截断 64 字符。
 */
function toolArgsPreview(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const a = args as Record<string, unknown>
  const single = ['path', 'file', 'filename', 'command', 'cmd', 'query', 'pattern', 'url', 'taskId', 'task_id', 'id', 'name', 'toolName']
  const pick = single.find(k => typeof a[k] === 'string' && (a[k] as string).length > 0)
  let preview: string
  if (pick) {
    preview = (a[pick] as string)
  }
  else {
    const scalars = Object.entries(a)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .slice(0, 2)
      .map(([k, v]) => `${k}=${String(v)}`)
    if (scalars.length === 0) return ''
    preview = scalars.join(', ')
  }
  const flat = preview.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return `(${flat.length > 64 ? `${flat.slice(0, 64)}…` : flat})`
}

/** 安全 JSON 解析(容错:提取第一个 JSON 数组/对象) */
function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim()
  // 直接尝试
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    return null
  }
  catch {
    // 继续
  }
  // 提取第一个 [ ... ] 块
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    }
    catch {
      // 继续
    }
  }
  return null
}

// ===== OmpRpcAgentImpl =====

export class OmpRpcAgentImpl implements AgentInterface {
  private readonly config: OmpAgentConfig
  private client: OmpRpcClient | null = null
  private workspace: AgentRunContext['workspace'] | null = null
  private agentInfo: AgentInfo | null = null
  private hostToolsRegistered = false
  /** 当前 run() 的 taskId(worker 完成任务时用) */
  private currentTaskId: string | null = null
  /**
   * 会话回合状态(steer 可靠注入的依据):
   * omp 的 steer 仅在回合 streaming 中生效——prompt 已入列但尚未开始输出时,
   * steer 会"成功"返回但被静默丢弃。因此注入方轮询直到回合输出开始(streamingStarted)
   * 才发送;若回合在等待期间结束,改走 follow_up(prompt 通道)兜底投递。
   */
  private streaming = false
  private turnActive = false
  /** 当前回合产生的 assistant 文本(供诊断) */
  private turnText = ''
  /** agent 身份信息(factory 注入;无需等待 init()) */
  private selfAgentId = ''
  private agentName = 'agent'
  private agentRole: 'lead' | 'worker' = 'worker'
  private channelId = ''
  /**
   * 当前待回执的触发上下文(自动关联兜底):
   * LLM 偶发省略 in_reply_to 参数 → 平台在 send_message_to_agent 时按上下文自动盖章,
   * 保证触发器回执关联契约不依赖模型传参纪律。
   */
  private replyContext: { fromId: string, messageId: string } | null = null

  constructor(config: Record<string, unknown> = {}) {
    this.config = config as OmpAgentConfig
    // factory 注入的 agent 身份(无需等待 init())
    this.selfAgentId = this.config.agentId ?? ''
    this.agentName = this.config.name ?? 'agent'
    this.agentRole = this.config.role ?? 'worker'
    this.channelId = this.config.channelId ?? ''
  }

  // ===== 生命周期 =====

  async init(input: { agent: AgentInfo, channelId: string }): Promise<void> {
    this.agentInfo = input.agent
    this.channelId = input.channelId
    this.agentName = input.agent.name
    this.agentRole = input.agent.role
    this.selfAgentId = input.agent.id
  }

  async dispose(): Promise<void> {
    if (this.client) {
      const pid = this.client.pid
      await this.client.dispose()
      this.client = null
      if (pid) {
        markHarnessProcessExit(pid, null)
        markTerminalSessionExit(pid, null)
      }
    }
    this.hostToolsRegistered = false
  }

  /** harness 进程资源信息(运行时资源监控;进程未 spawn/已回收 → null) */
  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const client = this.client
    const pid = client?.pid
    if (!pid || !client) return null
    return { pid, alive: client.alive, command: `omp --mode ${this.rpcMode}` }
  }

  /** 强制终止 harness 进程(进程树;终止后由调用方停止对应 AgentRuntime) */
  killProcess(): void {
    const pid = this.client?.pid
    if (pid) {
      markTerminalSessionExit(pid, null)
      killHarnessProcess(pid)
    }
    else {
      this.client?.kill()
    }
  }

  /** omp 输出模式(rpc-ui = 默认,启用 HITL 对话框) */
  private get rpcMode(): 'rpc' | 'rpc-ui' {
    return this.config.rpcMode === 'rpc' ? 'rpc' : 'rpc-ui'
  }

  // ===== prompt 组合:场景 × 身份 × 记忆 × 系统设计 =====

  /**
   * 前置上下文段(channel 场景 + 实例身份):场景优先级最高——用户对整个作业
   * 场景的规范要求,全体成员共享;未设定时注入通用默认场景(prompts/scenario-default.md)。
   * 实例 systemPromptPrefix 定义成员专长(可选,无默认)。
   */
  private contextPrefix(roster?: string): string {
    const scenario = typeof this.config.scenarioPrompt === 'string' ? this.config.scenarioPrompt.trim() : ''
    const identity = this.config.systemPromptPrefix ?? ''
    const parts: string[] = []
    parts.push(
      scenario
        ? `## Scenario Brief (channel-wide, highest priority — user-defined operating rules)\n${scenario}`
        : renderPrompt('scenario-default'),
      ``,
    )
    if (identity) {
      parts.push(
        `## Your Profile (agent-specific)\n${identity}`,
        ``,
      )
    }
    if (roster) {
      parts.push(roster, ``)
    }
    return parts.join('\n')
  }

  /**
   * 系统设计手册(prompts/system-manual.md):让 agent 真正理解其运行环境。
   */
  private systemManual(): string {
    return renderPrompt('system-manual')
  }

  // ===== 团队名册(roster):全成员名单 + 专长,注入每个回合 =====

  /** 名册缓存(null = 待刷新);30s TTL——任何成员的增删改都会及时反映到名单 */
  private rosterCache: string | null = null
  private rosterAt = 0

  /**
   * 构建团队名册(prompts/team-roster.md):
   * 每位成员一行 — id(寻址键)/名字/角色/harness/专长(systemPromptPrefix 压缩);
   * 自己的条目带 ← 你 标记。所有回合(worker/supervise/peer)统一注入,
   * 保证任何 Agent 都知道找谁、怎么发信、怎么等回执。
   */
  private async teamRoster(): Promise<string> {
    if (this.rosterCache !== null && Date.now() - this.rosterAt < 30_000) return this.rosterCache
    if (!this.workspace) return ''
    try {
      const agents = await this.workspace.listAgents()
      const condense = (s: unknown): string =>
        String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 110)
      const lines = agents
        .filter(a => a.enabled !== 0)
        .map((a) => {
          const specialty = condense(a.config?.systemPromptPrefix)
          const self = a.id === this.selfAgentId ? ' ← 你' : ''
          return `- id: ${a.id} | ${a.name}${self} | role=${a.role} | harness=${a.harness}${specialty ? ` | 擅长: ${specialty}` : ''}`
        })
        .join('\n')
      this.rosterCache = renderPrompt('team-roster', { rosterLines: lines })
      this.rosterAt = Date.now()
    }
    catch {
      // 拉取失败不再沿用旧名册(频道重建/运行时漂移会把陈旧 id 冻结进每个回合,
      // 直接导致 A2A 寻址未命中);置空下次重试,寻址层另有名字容错兜底
      this.rosterCache = null
      this.rosterAt = 0
    }
    return this.rosterCache ?? ''
  }

  /**
   * 实时消息注入(送达模式协议):
   *  - 回合 streaming 中 → 立即 steer,返回 'steer'(同轮可见,唯一可标记消费的路径)
   *  - 回合活跃但尚未 streaming(prompt 排队窗口,上限 20s)→ 等 streaming 开始后 steer
   *  - 回合被 host 工具阻塞(如 poll_messages 等待)/空闲/发送失败 → 返回 'deferred':
   *    不再走 follow_up 兜底 —— 目标处理中时 omp 会拒绝该请求,而旧实现拒绝后仍被
   *    上层标记消费,消息从信箱消失(轮询查空丢失 bug 根因)。deferred 下消息保持
   *    pending:poll_messages 的 Mailbox 到信回调即时取走(毫秒级),或本回合结束后
   *    由消费循环按 FIFO 起回合处理。
   */
  async steer(text: string): Promise<'steer' | 'deferred'> {
    // 从确定性触发横幅提取回执上下文(AgentRuntime.injectSteer 生成,格式固定):
    // "[实时消息 from <id>]: ..." + "[系统触发器] 本消息要求回复(reply_to=<messageId>)。"
    const banner = text.match(/\[实时消息 from ([^\]]+)]:[\s\S]*?要求回复\(reply_to=([0-9a-f-]{36})\)/)
    if (banner) {
      this.replyContext = { fromId: banner[1]!, messageId: banner[2]! }
    }
    const client = this.client
    if (!client) return 'deferred'
    try {
      if (this.streaming) {
        await client.send({ type: 'steer', message: text })
        return 'steer'
      }
      if (this.turnActive) {
        // prompt 排队窗口:等 streaming 开始(上限 20s);工具阻塞的回合等不到 → deferred
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline && this.turnActive && !this.streaming) {
          const { promise, resolve } = Promise.withResolvers()
          setTimeout(resolve, 150)
          await promise
        }
        if (this.streaming && this.turnActive) {
          await client.send({ type: 'steer', message: text })
          return 'steer'
        }
        return 'deferred'
      }
      // 空闲/回合已结束:deferred(消息 pending,消费循环 dequeue 即起回合)
      return 'deferred'
    }
    catch (err) {
      console.error(`[OmpRpcAgent:${this.selfAgentId}] steer 注入失败(消息保持 pending):`, err instanceof Error ? err.message : err)
      return 'deferred'
    }
  }

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    const kind = request.message.metadata?.['x-aw-task-kind']

    // worker: assign 消息 → 执行任务
    if (kind === 'assign' && ctx.role === 'worker') {
      yield* this.workerRun(request, ctx)
      return
    }

    // worker/lead: 同事点对点消息(含实时通信触发器)→ 按触发器语义处理并回复;
    // 人类经 REST 注入的消息(from 空 + x-aw-from-label)同样进入应答流 ——
    // 旧判定把 from 为空的人类消息落到 no-op 分支静默吞掉(消息秒标 consumed,
    // Agent 从未读到内容),这是"给 Agent 发消息没有回复"的根因
    if (!kind && (request.fromAgentId || request.message.metadata?.['x-aw-from-label'])) {
      yield* this.peerMessageRun(request, ctx)
      return
    }

    // 其余消息(lead 的 assign/child-completed 等):no-op(调度由 supervise() 处理)
  }

  // ===== supervise() =====

  async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext): Promise<SupervisionDecision[]> {
    await this.ensureClient(ctx)
    if (!this.client) return []

    const prompt = await this.buildSupervisePrompt(snapshot, ctx.memory)
    const timeoutMs = this.config.superviseTimeoutMs ?? 60_000

    return new Promise<SupervisionDecision[]>((resolve) => {
      let assistantText = ''
      let resolved = false

      const finish = (decisions: SupervisionDecision[]) => {
        if (resolved) return
        resolved = true
        unsub()
        clearTimeout(timer)
        resolve(decisions)
      }

      const unsub = this.client!.onEvent((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          assistantText += event.assistantMessageEvent.delta ?? ''
        }
        if (event.type === 'agent_end' && event.isTerminal !== false) {
          // 尝试从文本解析 JSON 决策(备用:如果 agent 没用 host tools 而是输出 JSON)
          const parsed = extractJsonArray(assistantText)
          if (parsed && parsed.length > 0) {
            finish(parsed as SupervisionDecision[])
          }
          else {
            // agent 可能已通过 host tools 直接执行了调度,返回空(已执行)
            finish([])
          }
        }
        if (event.type === '__process_exit__' || event.type === '__error__') {
          finish([])
        }
      })

      const timer = setTimeout(() => finish([]), timeoutMs)

      this.client!.send({ type: 'prompt', message: prompt }).catch(() => finish([]))
    })
  }

  // ===== 内部:worker 执行 =====

  private async* workerRun(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId
      ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return

    this.currentTaskId = taskId

    try {
      await this.ensureClient(ctx)
    }
    catch (err) {
      yield {
        kind: 'error',
        error: {
          code: 'OMP_SPAWN_FAILED',
          message: `omp 子进程启动失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    if (!this.client) {
      yield { kind: 'error', error: { code: 'OMP_NOT_READY', message: 'omp 客户端未就绪' } }
      return
    }

    // 构建 prompt
    const taskText = partsToText(request.message.parts)
    const prompt = await this.buildWorkerPrompt(taskId, taskText, request.memory)

    // 流式执行 + 事件映射
    yield* this.promptAndStream(prompt, taskId, ctx.signal)
  }

  /**
   * 点对点消息处理(实时通信驱动;lead 与 worker 通用)。
   * 触发器语义:metadata['x-aw-require-reply']='true' → 必须经 send_message_to_agent
   * 回给发送者:执行结果 + 对方所需内容,in_reply_to 关联原消息,并声明是否需再响应。
   */
  private async* peerMessageRun(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    try {
      await this.ensureClient(ctx)
    }
    catch {
      return
    }
    if (!this.client) return

    const msg = request.message
    // 显示名:agent 同事用 id(名册可解析);人类发送者用 fromLabel;兜底 unknown
    const fromId = request.fromAgentId
      ?? (typeof msg.metadata?.['x-aw-from-label'] === 'string' ? msg.metadata['x-aw-from-label'] : undefined)
      ?? 'unknown'
    const msgText = partsToText(msg.parts)
    const requireReply = msg.metadata?.['x-aw-require-reply'] === 'true'
    const isReply = typeof msg.metadata?.['x-aw-in-reply-to'] === 'string'
    // 回执自动关联仅对真实 agent 发送者生效(人类无 agentId 可回投;
    // 对人类的回复经事件流/时间线可见)
    this.replyContext = requireReply && request.fromAgentId
      ? { fromId: request.fromAgentId, messageId: msg.messageId }
      : null

    const roleLine = this.agentRole === 'lead'
      ? `You are "${this.agentName}", the LEAD coordinator of a multi-agent team (Channel: ${this.channelId}). A team member sent you a direct message.`
      : `You are "${this.agentName}", a worker agent in a multi-agent team (Channel: ${this.channelId}).`

    // 消息应答指令:必复/可选两态 + lead 名册提示(全部外置 prompts/)
    const respondBlock = renderPrompt(requireReply ? 'peer-reply-required' : 'peer-reply-optional', {
      fromId,
      messageId: msg.messageId,
    })
    const peerBody = renderPrompt('peer-message', {
      fromId,
      messageId: msg.messageId,
      requireReply,
      isReplyTo: isReply ? `in_reply_to: ${String(msg.metadata?.['x-aw-in-reply-to'])}` : '',
      msgText,
      respondBlock,
    })
    const lines: string[] = [
      roleLine,
      ``, this.contextPrefix(await this.teamRoster()),
      ``, this.systemManual(),
      ``,
      ...(request.memory ? [``, request.memory] : []),
      ``,
      peerBody,
    ]

    if (this.agentRole === 'lead') {
      lines.push(``, renderPrompt('peer-lead-roster'))
    }

    yield* this.promptAndStream(lines.join('\n'), undefined, ctx.signal)
  }

  /** 消费待回执上下文(自动关联兜底):取走即清,避免跨消息污染 */
  private takeReplyContext(): { fromId: string, messageId: string } | null {
    const ctx = this.replyContext
    this.replyContext = null
    return ctx
  }

  // ===== 内部:prompt 发送 + 事件流桥接 =====

  private async* promptAndStream(
    prompt: string,
    taskId: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const client = this.client
    if (!client) {
      throw new Error('omp 客户端未就绪')
    }
    const queue: AgentEvent[] = []
    let resolveWait: (() => void) | null = null
    let isDone = false
    // 回合生命周期:prompt 已发出 → turnActive;首条 message_update → streaming;message_end/turn_end → 结束
    this.turnActive = true
    this.streaming = false
    this.turnText = ''
    // 正文流式差额账本:contentIndex → 已流出长度。部分 provider(reasoning 模型/
    // openai-completions)的 text 块不走 text_delta(只有换行),全文在 text_end.content
    // 落定 —— 差额兜底把未流出部分补发为 delta,保证前端流式不缺正文。
    const textSent = new Map<number, number>()
    const unsubState = client.onEvent((event) => {
      if (event.type === 'message_update') {
        const ev = event.assistantMessageEvent as
          | { type?: string, delta?: string, content?: string, contentIndex?: number }
          | undefined
        if (ev?.type === 'text_delta') {
          this.streaming = true
          const text = ev.delta ?? ''
          const ci = typeof ev.contentIndex === 'number' ? ev.contentIndex : 0
          textSent.set(ci, (textSent.get(ci) ?? 0) + text.length)
          this.turnText += text
          // LLM 流式增量透出(AEP agent.delta 事件源;P2):仅 worker/peer 转本走生成器
          if (text) enqueueDelta(text)
        }
        else if (ev?.type === 'text_end' && typeof ev.content === 'string') {
          const ci = typeof ev.contentIndex === 'number' ? ev.contentIndex : 0
          const sent = textSent.get(ci) ?? 0
          if (ev.content.length > sent) {
            const chunk = ev.content.slice(sent)
            textSent.set(ci, ev.content.length)
            this.streaming = true
            this.turnText += chunk
            enqueueDelta(chunk)
          }
        }
      }
      if (event.type === 'message_end' || event.type === 'turn_end') {
        this.streaming = false
        flushDelta()
      }
      if (event.type === 'agent_end' && event.isTerminal !== false) {
        this.turnActive = false
        this.streaming = false
        flushDelta()
      }
      if (event.type === '__process_exit__' || event.type === '__error__') {
        this.turnActive = false
        this.streaming = false
      }
    })

    const enqueue = (event: AgentEvent): void => {
      queue.push(event)
      if (event.kind === 'done' || event.kind === 'error') isDone = true
      lastActivity = Date.now()
      resolveWait?.()
      resolveWait = null
    }

    // 停滞看门狗:整轮无任何 omp 事件(挂死的 LLM 调用/子进程僵死)时中止回合,
    // 否则消息永久卡 consuming、队友消息无限堆积。host 工具内阻塞
    // (poll_messages 最长 180s)与慢 provider(实测单步可 >5min)都有
    // tool/状态事件刷新计时;默认 600s 覆盖慢回合,只拦真僵死。
    const idleTimeoutMs = this.config.promptTimeoutMs ?? 600_000
    let lastActivity = Date.now()
    let stallTimer: ReturnType<typeof setTimeout> | null = null

    // LLM 流式增量缓冲:50ms 批量合并为一帧 delta(防高频 text_delta 洪泛 WS)
    let deltaBuf = ''
    let deltaTimer: ReturnType<typeof setTimeout> | null = null
    const flushDelta = (): void => {
      if (deltaTimer) {
        clearTimeout(deltaTimer)
        deltaTimer = null
      }
      if (!deltaBuf) return
      const text = deltaBuf
      deltaBuf = ''
      enqueue({ kind: 'delta', delta: { text } })
    }
    const enqueueDelta = (text: string): void => {
      deltaBuf += text
      deltaTimer ??= setTimeout(() => {
        deltaTimer = null
        flushDelta()
      }, 50)
    }

    // 订阅 omp 事件流
    const unsub = client.onEvent((event) => {
      for (const mapped of this.mapOmpEvent(event, taskId)) {
        enqueue(mapped)
      }
    })

    // abort 传导
    const onAbort = (): void => {
      client.send({ type: 'abort' }).catch(() => {})
      if (!isDone) {
        enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      }
    }
    if (signal.aborted) {
      onAbort()
    }
    else {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // 发送 prompt
    try {
      await client.send({ type: 'prompt', message: prompt })
    }
    catch (err) {
      unsub()
      signal.removeEventListener('abort', onAbort)
      yield {
        kind: 'error',
        error: {
          code: 'PROMPT_FAILED',
          message: `omp prompt 失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    // 产出事件直到 done/error
    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = idleTimeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            client.send({ type: 'abort' }).catch(() => {})
            // 子进程大概率已僵死:击杀并清引用,下回合 ensureClient 全新重生
            this.killProcess()
            this.client = null
            this.hostToolsRegistered = false
            enqueue({
              kind: 'error',
              error: {
                code: 'TURN_STALLED',
                message: `回合停滞 ${Math.round(idleTimeoutMs / 1000)}s 无 omp 事件,已中止重置(消息按已处理落账,后续消息继续)`,
              },
            })
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
      unsubState()
      this.turnActive = false
      this.streaming = false
      this.currentTaskId = null
    }
  }

  // ===== 内部:omp 事件 → AgentEvent 映射 =====

  private mapOmpEvent(event: AgentSessionEvent, taskId: string | undefined): AgentEvent[] {
    switch (event.type) {
      case 'agent_start':
        return [{
          kind: 'status',
          status: { state: 'WORKING', timestamp: new Date().toISOString() },
        }]
      case 'message_end': {
        // 消息完成:如果有 message 内容,产出为 status 事件(任务历史追踪)
        const msg = event.message
        if (msg && Array.isArray(msg.content)) {
          const text = (msg.content as Array<{ type?: string, text?: string }>)
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .join('')
          if (text) {
            const a2aMsg: A2AMessage = {
              messageId: randomUUID(),
              contextId: this.channelId,
              role: 'ROLE_AGENT',
              parts: [{ text }],
            }
            return [{
              kind: 'status',
              status: { state: 'WORKING', message: a2aMsg, timestamp: new Date().toISOString() },
            }]
          }
        }
        return []
      }

      case 'tool_execution_start': {
        const toolName = event.toolName ?? 'tool'
        return [{
          kind: 'status',
          status: {
            state: 'WORKING',
            message: {
              messageId: randomUUID(),
              contextId: this.channelId,
              role: 'ROLE_AGENT',
              parts: [{ text: `🔧 ${toolName}${toolArgsPreview(event.args)}` }],
            },
            timestamp: new Date().toISOString(),
          },
        }]
      }

      case 'agent_end': {
        if (event.isTerminal === false) return []
        const events: AgentEvent[] = []
        // 提取最终 assistant 文本作为 artifact
        const messages = event.messages ?? []
        const assistantText = messages
          .filter(m => m.role === 'assistant')
          .flatMap(m => m.content.filter(c => c.type === 'text').map(c => c.text ?? ''))
          .join('')
        // 回合内的 provider/API 失败(限额 429、鉴权、上游 5xx 等):omp 把错误挂在最后一条
        // assistant 消息上(stopReason='error' + errorStatus/errorMessage)而非 __error__ 帧。
        // 不映射出来,上层只能看到「回合结束无产出」,真实原因彻底丢失(且照常重试到耗尽)。
        const failure = [...messages].reverse().find((m) => {
          const mm = m as { role?: string, stopReason?: string, errorMessage?: string }
          return mm.role === 'assistant' && (mm.stopReason === 'error' || typeof mm.errorMessage === 'string')
        }) as { errorStatus?: number, errorMessage?: string } | undefined
        if (failure) {
          const code = failure.errorStatus != null ? `OMP_LLM_${failure.errorStatus}` : 'OMP_LLM_ERROR'
          const detail = failure.errorMessage ?? 'harness 回合以错误结束(无错误详情)'
          console.error(`[OmpRpcAgent:${this.selfAgentId}] harness 回合失败 ${code}: ${detail}`)
          // error 事件即回合终点(队列侧据此收口),不再追加 done
          return [{ kind: 'error', error: { code, message: detail } }]
        }
        if (assistantText) {
          events.push({
            kind: 'artifact',
            artifact: {
              artifactId: randomUUID(),
              name: 'output',
              parts: [{ text: assistantText }],
            },
            lastChunk: true,
            totalChunks: 1,
          })
        }
        events.push({ kind: 'done', final: taskId ? { taskId } : undefined })
        return events
      }

      case '__process_exit__':
        return [{
          kind: 'error',
          error: { code: 'OMP_PROCESS_EXIT', message: 'omp 子进程意外退出' },
        }]

      case '__error__':
        return [{
          kind: 'error',
          error: { code: 'OMP_ERROR', message: (event as { error?: string }).error ?? 'omp 未知错误' },
        }]

      default:
        return []
    }
  }

  // ===== 内部:prompt 构建 =====

  private async buildWorkerPrompt(taskId: string, taskText: string, memory?: string): Promise<string> {
    const parts: string[] = []

    const ctx = this.contextPrefix(await this.teamRoster())
    if (ctx) parts.push(ctx)
    if (memory) parts.push(memory)
    parts.push(this.systemManual())
    parts.push(renderPrompt('worker-workflow', {
      agentName: this.agentName,
      channelId: this.channelId,
      taskId,
      taskText,
    }))

    return parts.join('\n')
  }

  /**
   * 成员能力画像(koda 运营信号借鉴):按任务历史计算
   * total/completed/failed/successRate/avgDurationMs(仅统计已终态任务)。
   * 数据源即 supervise 快照内的任务列表——零额外查询,证据随历史自然累积。
   */
  private capabilityProfiles(snapshot: SupervisionSnapshot): Map<string, { total: number, completed: number, failed: number, successRate: number, avgDurationMs: number }> {
    const byAgent = new Map<string, { total: number, completed: number, failed: number, durationSum: number }>()
    for (const t of snapshot.tasks) {
      if (!['COMPLETED', 'FAILED'].includes(t.state)) continue
      const agg = byAgent.get(t.assigneeId) ?? { total: 0, completed: 0, failed: 0, durationSum: 0 }
      agg.total += 1
      if (t.state === 'COMPLETED') {
        agg.completed += 1
        agg.durationSum += Math.max(0, new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime())
      }
      else {
        agg.failed += 1
      }
      byAgent.set(t.assigneeId, agg)
    }
    const out = new Map<string, { total: number, completed: number, failed: number, successRate: number, avgDurationMs: number }>()
    for (const [agentId, agg] of byAgent) {
      out.set(agentId, {
        total: agg.total,
        completed: agg.completed,
        failed: agg.failed,
        successRate: agg.total > 0 ? agg.completed / agg.total : 0,
        avgDurationMs: agg.completed > 0 ? agg.durationSum / agg.completed : 0,
      })
    }
    return out
  }

  private async buildSupervisePrompt(snapshot: SupervisionSnapshot, memory?: string): Promise<string> {
    const parts: string[] = []

    const ctx = this.contextPrefix(await this.teamRoster())
    if (ctx) parts.push(ctx)
    if (memory) parts.push(memory)
    parts.push(this.systemManual())
    // 格式化成员(含队列上下文 + 能力画像:koda 运营信号借鉴——按任务历史算
    // 成功率/平均耗时/失败数,lead 按证据而非直觉选人)
    const capability = this.capabilityProfiles(snapshot)
    const members = snapshot.members.map((m) => {
      const cap = capability.get(m.agentId)
      const capLine = cap && cap.total > 0
        ? `, 成功率=${Math.round(cap.successRate * 100)}%, 均耗时=${Math.round(cap.avgDurationMs / 1000)}s, 失败=${cap.failed}`
        : ', 暂无历史'
      return `  - ${m.agentId} (${m.name}, role=${m.role}, state=${m.state}, executing=${m.currentTaskId ?? '-'}, queued=${m.queued ?? 0}, completed=${m.completedCount ?? 0}${capLine})`
    }).join('\n')

    // 格式化任务(createdAt ASC = FIFO 顺序);COMPLETED 附交付预览(lead 直接看到 worker 成果)
    const tasks = snapshot.tasks.map((t) => {
      const deliverable = t.state === 'COMPLETED' && t.artifacts.length > 0
        ? ` — 交付:${t.artifacts.map(a => a.parts.map(p => 'text' in p ? p.text : '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).join(' / ').slice(0, 400) || '(空)'}`
        : ''
      const artifacts = t.artifacts.length > 0 ? `, artifacts=${t.artifacts.length}` : ''
      return `  - ${t.id} [${t.state}] "${t.title}" (assignee=${t.assigneeId}, progress=${t.progress}%${artifacts})${deliverable}`
    }).join('\n')

    // 未完成子任务数
    const pending = Object.entries(snapshot.pendingChildren)
      .map(([parentId, count]) => `  ${parentId}: ${count} pending`)
      .join('\n')

    // 最近邮件(最新在前):worker 间点对点通信/回执 —— 判断"结果是否已被产出"的依据
    const mail = (snapshot.mail ?? []).map((m) => {
      const from = m.fromAgentId ?? '(system)'
      const to = m.toAgentId ?? '(broadcast)'
      const body = m.parts.map(p => 'text' in p ? p.text : JSON.stringify('data' in p ? p.data : p)).join(' ').trim().slice(0, 140)
      const label = m.metadata?.['x-aw-task-kind'] === 'assign'
        ? 'task-assign'
        : m.metadata?.['x-aw-msg-priority'] === 'immediate' ? 'immediate' : 'peer'
      return `  - [${m.createdAt.slice(11, 19)}] ${from} → ${to} (${label}): ${body || '(empty)'}`
    }).join('\n')

    // 检测执行模式(从 lead 自己的任务 description 前缀)
    const leadTask = snapshot.tasks.find(t =>
      t.assigneeId === snapshot.members.find(m => m.role === 'lead')?.agentId
      && (t.state === 'SUBMITTED' || t.state === 'WORKING' || t.state === 'WAITING'),
    )
    const modeInfo = leadTask ? this.detectMode(leadTask.description ?? '') : null

    parts.push(
      `You are "${this.agentName}", the lead coordinator of a multi-agent team (Channel: ${this.channelId}).`,
      `Tick #${snapshot.tick}`,
      ``,
      `## Team Members (state + task queues)`,
      members || '  (none)',
      ``,
      `## All Tasks (FIFO order)`,
      tasks || '  (none)',
      ``,
      `## Pending Children Count`,
      pending || '  (none)',
      ``,
      `## Recent Team Mail (newest first)`,
      mail || '  (none)',
    )

    // 模式特定指令(外置 mode-*.md)/ 默认协调指令(外置 lead-supervise.md)
    if (modeInfo) {
      parts.push('', ...this.buildModeInstructions(modeInfo))
    }
    else {
      parts.push('', renderPrompt('lead-supervise'))
    }

    return parts.join('\n')
  }

  /** 从 description 前缀检测执行模式 */
  private detectMode(desc: string): { mode: string, criteria?: string, stages?: string[], interval?: number } | null {
    const match = desc.match(/^\[mode:(goal|loop|pipeline)\]/)
    if (!match) return null
    const mode = match[1]!
    const result: { mode: string, criteria?: string, stages?: string[], interval?: number } = { mode }
    if (mode === 'goal') {
      const crit = desc.match(/\[criteria:([^\]]+)\]/)
      if (crit) result.criteria = crit[1]
    }
    if (mode === 'loop') {
      const intv = desc.match(/\[interval:(\d+)\]/)
      if (intv) result.interval = parseInt(intv[1]!, 10)
    }
    if (mode === 'pipeline') {
      const stg = desc.match(/\[stages:([^\]]+)\]/)
      if (stg) result.stages = stg[1]!.split('->')
    }
    return result
  }

  /** 构建模式特定指令(外置 mode-goal/loop/pipeline.md) */
  private buildModeInstructions(modeInfo: { mode: string, criteria?: string, stages?: string[], interval?: number }): string[] {
    if (modeInfo.mode === 'goal') {
      return [renderPrompt('mode-goal', { criteria: modeInfo.criteria ?? '任务描述中的需求已全部完成' })]
    }
    if (modeInfo.mode === 'loop') {
      return [renderPrompt('mode-loop', { interval: (modeInfo.interval ?? 60000) / 1000 })]
    }
    if (modeInfo.mode === 'pipeline') {
      const stageList = modeInfo.stages?.length
        ? modeInfo.stages.map((s, i) => `  Stage ${i + 1}: ${s}`).join('\n')
        : '  Decompose the task into sequential stages yourself.'
      return [renderPrompt('mode-pipeline', { stageList })]
    }
    return []
  }

  // ===== 内部:omp 客户端管理 =====

  private async ensureClient(ctx: AgentRunContext): Promise<void> {
    if (!this.workspace) {
      this.workspace = ctx.workspace
    }
    if (!this.agentInfo) {
      // init() 可能未调用;从 ctx 推断
      this.channelId = ctx.channelId
      this.agentRole = ctx.role
    }

    if (!this.client) {
      const command = this.config.command ?? 'omp'
      const client = new OmpRpcClient({
        command,
        mode: this.rpcMode,
        args: this.config.args,
        cwd: this.config.cwd ?? process.cwd(),
        // 进程退出 → 注册表标记(供运行时资源监控);pid=-1 表示无法取得,忽略
        onExit: (pid, code) => {
          if (pid > 0) {
            markHarnessProcessExit(pid, code)
            markTerminalSessionExit(pid, code)
          }
        },
      })
      await client.start()

      // 登记 + 绑定 agent 身份(harness 进程监控的事实源)
      const pid = client.pid
      if (pid) {
        registerHarnessProcess(pid, {
          harness: 'omp',
          command,
          args: ['--mode', this.rpcMode, ...(this.config.args ?? [])],
        })
        bindHarnessProcess(pid, {
          agentId: this.selfAgentId,
          channelId: this.channelId,
          name: this.agentName,
          role: this.agentRole,
        })
        // 终端镜像 tap:全部 RPC 帧 → /monitor 终端(实时 TUI 渲染 + HITL)
        attachTerminalTap(client, {
          pid,
          harness: 'omp',
          agentId: this.selfAgentId,
          channelId: this.channelId,
          name: this.agentName,
          role: this.agentRole,
        })
      }

      // 设置模型(如果配置了)
      if (this.config.provider && this.config.model) {
        try {
          await client.send({ type: 'set_model', provider: this.config.provider, modelId: this.config.model })
        }
        catch {
          // 模型设置失败不致命(用 omp 默认模型)
        }
      }

      // 注册 host tools(按角色差异化:lead 全量,worker 剔除调度/团队管理专属工具)
      client.onHostToolCall(req => this.handleHostTool(req))
      await client.send({ type: 'set_host_tools', tools: hostToolsForRole(this.agentRole) })

      this.client = client
      this.hostToolsRegistered = true
    }
  }

  // ===== 内部:host tool handler(workspace 桥接) =====

  private async handleHostTool(req: HostToolCallRequest): Promise<{ text: string, isError?: boolean }> {
    const ws = this.workspace
    if (!ws) {
      return { text: 'workspace 未就绪', isError: true }
    }

    try {
      switch (req.toolName) {
        case 'report_progress': {
          const progress = req.arguments.progress as number
          const message = req.arguments.message as string | undefined
          const taskId = this.currentTaskId
          if (!taskId) return { text: '无当前任务上下文', isError: true }
          await ws.reportTask({ taskId, progress, message })
          return { text: `进度已上报: ${progress}%${message ? ` (${message})` : ''}` }
        }

        case 'complete_task': {
          const summary = req.arguments.summary as string
          const deliverable = req.arguments.deliverable as string | undefined
          const taskId = (req.arguments.task_id as string | undefined) ?? this.currentTaskId
          if (!taskId) return { text: '无任务 ID', isError: true }
          // 父任务保护:有未完成子任务时拒绝完成(lead 须等 worker 交付)
          const allTasks = await ws.listTasks()
          const incompleteChildren = allTasks.filter(t => t.parentId === taskId && t.state !== 'COMPLETED' && t.state !== 'CANCELED')
          if (incompleteChildren.length > 0) {
            return {
              text: `任务 ${taskId} 有 ${incompleteChildren.length} 个未完成子任务,不能完成父任务。请等待子任务完成。`,
              isError: true,
            }
          }
          // 终态幂等:任务已被平台收口(看门狗取消/调度器完成)时不撞状态机 ——
          // 给 Agent 明确的"无需再完成,继续下一项"信号,杜绝重复重试烧 token
          const current = await ws.getTask(taskId)
          if (current && current.state !== 'SUBMITTED' && current.state !== 'ASSIGNED' && current.state !== 'WORKING' && current.state !== 'WAITING') {
            if (current.state === 'COMPLETED') {
              return { text: `任务 ${taskId} 已是完成状态(可能已被平台收口),无需重复完成。` }
            }
            try {
              const q = await ws.myQueue()
              const next = q.queued[0]
              return {
                text: `任务 ${taskId} 已被平台${current.state === 'CANCELED' ? '取消(如停滞回收/上级作废)' : '判定失败'},不能再标记完成 —— 这不是你的错误,也无需重试。${next ? `队列还有 ${q.queued.length} 项,下一项「${next.title}」即将开始,请继续处理。` : '队列为空,保持待命。'}`,
                isError: false,
              }
            }
            catch {
              return { text: `任务 ${taskId} 已被平台${current.state === 'CANCELED' ? '取消' : '判定失败'},无需再完成,请继续处理队列下一项。` }
            }
          }
          const artifacts: A2AArtifact[] = []
          if (deliverable || summary) {
            artifacts.push({
              artifactId: randomUUID(),
              name: 'deliverable',
              parts: [{ text: deliverable ?? summary }],
            })
          }
          await ws.completeTask(taskId, artifacts)
          this.currentTaskId = null
          // 完成即衔接:报告队列余量与下一项(状态同步 + 驱动继续处理;
          // 消费循环随后会以新消息自动起回合,这里给 LLM 明确的继续信号)
          try {
            const q = await ws.myQueue()
            const next = q.queued[0]
            if (next) {
              return {
                text: `任务 ${taskId} 已完成(状态已同步为 COMPLETED)。你的队列还有 ${q.queued.length} 项待处理,下一项:「${next.title}」(即将自动开始;收到任务指派消息后按工作流执行,完成后同样调用 complete_task)。`,
              }
            }
            return { text: `任务 ${taskId} 已完成(状态已同步为 COMPLETED),队列为空。保持待命:新任务/实时消息会自动到达你的信箱。` }
          }
          catch {
            return { text: `任务 ${taskId} 已完成(状态已同步为 COMPLETED)。` }
          }
        }

        case 'dispatch_task': {
          const assigneeId = req.arguments.assignee_id as string
          const title = req.arguments.title as string
          const description = req.arguments.description as string | undefined
          const parentTaskId = req.arguments.parent_task_id as string | undefined
          const routeReason = req.arguments.route_reason as string | undefined
          const task = await ws.dispatchTask({ assigneeId, title, description, parentTaskId, routeReason })
          return { text: `子任务 ${task.id} 已创建并指派 → ${assigneeId}(父任务 ${parentTaskId ?? '无'},标题: ${title}${routeReason ? `,路由理由: ${routeReason}` : ''})` }
        }

        case 'send_message_to_agent': {
          const toAgentId = req.arguments.to_agent_id as string
          const message = req.arguments.message as string
          // 回执自动实时:回复(in_reply_to)默认提升为 immediate——
          // 接收方正等待该结果,realtime 路由会把回复直接注入其运行中的会话
          let priority = (req.arguments.priority as string | undefined) ?? 'task'
          const metadata: Record<string, unknown> = {}
          // 触发器:要求对方回复 / 标记本消息是对某消息的回复(回执关联)
          if (req.arguments.require_reply === true) metadata['x-aw-require-reply'] = 'true'
          let inReplyTo = req.arguments.in_reply_to as string | undefined
          // 自动关联兜底:LLM 省略 in_reply_to 时,按待回执上下文盖章
          // (触发消息要求回复 → 本次发送即回执;发给原发送者且无显式 in_reply_to)
          const replyCtx = this.takeReplyContext()
          if (!inReplyTo && replyCtx && replyCtx.fromId === toAgentId) {
            inReplyTo = replyCtx.messageId
          }
          if (inReplyTo) {
            metadata['x-aw-in-reply-to'] = inReplyTo
            if (priority === 'task') priority = 'immediate'
          }
          metadata['x-aw-msg-priority'] = priority
          const sent = await ws.sendMessage({ toAgentId, parts: [{ text: message }], metadata })
          const triggerNote = inReplyTo
            ? `(回复 ${inReplyTo.slice(0, 8)}…,已实时推送给对方)`
            : metadata['x-aw-require-reply'] === 'true' ? '(已要求对方回复)' : ''
          return { text: `消息 ${sent.messageId.slice(0, 8)}… 已发送给 ${toAgentId}(priority=${priority})${triggerNote}` }
        }

        case 'refuse_task': {
          const taskId = req.arguments.task_id as string
          const reason = req.arguments.reason as string
          if (!taskId || !reason) return { text: '缺少 task_id 或 reason', isError: true }
          const r = await ws.refuseTask(taskId, reason)
          const notified = r.notifiedTo ? `拒绝回执已送达 ${r.notifiedTo.slice(0, 8)}` : '无回执对象(创建者已不在 channel)'
          return {
            text: `任务 ${taskId.slice(0, 8)}("${r.task.title}") 已拒绝(state=${r.task.state});${notified}。调度器将改派他人,请勿再处理该任务。`,
          }
        }

        case 'poll_messages': {
          const limit = (req.arguments.limit as number | undefined) ?? 10
          // 阻塞等待(真即时):Mailbox 到信回调毫秒级唤醒 + 250ms 兜底重查;
          // 对方消息一到立即返回 —— 取代旧每秒盲查(阻塞窗口内到信可能被
          // 实时注入层抢先标记消费,盲查扑空即"轮询查空"丢失)
          const waitSec = Math.min(180, Math.max(0, Number(req.arguments.wait_seconds ?? 0) || 0))
          const msgs = await ws.waitMailbox(limit, waitSec * 1000)
          if (msgs.length === 0) {
            return {
              text: waitSec > 0
                ? `等待 ${waitSec}s 后收件箱仍为空。若此前已有"[实时消息 from X]"注入你的会话,那就是回复本身(无需再轮询);否则可继续处理其他工作,对方回复会以新回合送达。`
                : '收件箱为空(无未消费消息)。等待回复请用 wait_seconds 参数阻塞等待,不要反复空轮询。',
            }
          }
          // 读即取:协作消息(非任务投递)取出即确认——防止消费循环稍后把同一消息再跑一遍回合;
          // 任务指派(assign)不确认,仍由执行循环处理
          const ackIds = msgs
            .filter(m => !m.metadata?.['x-aw-task-kind'])
            .map(m => m.messageId)
          if (ackIds.length > 0) await ws.ackMailbox(ackIds)
          const text = msgs.map((m, i) => {
            const from = m.metadata?.['x-aw-from-agent'] ?? '?'
            const reply = m.metadata?.['x-aw-in-reply-to']
              ? ` (回复 ${String(m.metadata['x-aw-in-reply-to']).slice(0, 8)}…)`
              : ''
            const needReply = m.metadata?.['x-aw-require-reply'] === 'true' ? ' [需回复]' : ''
            const body = m.parts.map(p => 'text' in p ? p.text : '').join(' ')
            // 不截到 100 字符:谜面/任务书等长消息截半句会让收件人误判内容不完整
            return `  [${i + 1}/${msgs.length}] [from ${from}]${needReply}${reply} ${body.slice(0, 2000)}`
          }).join('\n')
          return {
            text:
              `未消费消息(${msgs.length},已读即取):\n${text}`
              + (msgs.length > 1
                ? '\n(收到多条:请按编号逐条处理并逐条回复,不要只回应最后一条或合并敷衍)'
                : ''),
          }
        }

        case 'read_channel_mail': {
          const limit = (req.arguments.limit as number | undefined) ?? 50
          const agentId = req.arguments.agent_id as string | undefined
          const mails = await ws.listMail({ limit, agentId })
          if (mails.length === 0) return { text: 'Channel 无邮件记录(或该成员无往来)' }
          const text = mails.map((m) => {
            const from = m.fromAgentId ?? '(系统)'
            const to = m.toAgentId ?? '(广播)'
            const body = partsToText(m.parts).trim().slice(0, 2000)
            const reply = m.metadata?.['x-aw-in-reply-to']
              ? ` [回复 ${String(m.metadata['x-aw-in-reply-to']).slice(0, 8)}…]`
              : ''
            const label = m.metadata?.['x-aw-task-kind'] === 'assign'
              ? '[任务指派]'
              : m.metadata?.['x-aw-msg-priority'] === 'immediate' ? '[实时]' : '[协作]'
            const state = m.state === 'pending' ? '未读' : m.state === 'consuming' ? '处理中' : '已读'
            return `  ${m.createdAt.slice(11, 19)} ${label} ${from} → ${to} (${state})${reply}: ${body || '(空)'}`
          }).join('\n')
          return { text: `Channel 邮件(${mails.length},倒序;可传 agent_id 查看指定成员信箱):\n${text}` }
        }

        case 'broadcast_message': {
          const message = req.arguments.message as string
          const priority = (req.arguments.priority as string | undefined) ?? 'task'
          const agents = await ws.listAgents()
          const others = agents.filter(a => a.id !== this.selfAgentId)
          for (const agent of others) {
            await ws.sendMessage({
              toAgentId: agent.id,
              parts: [{ text: message }],
              metadata: { 'x-aw-msg-priority': priority },
            })
          }
          return { text: `已广播给 ${others.length} 个 agent(priority=${priority})` }
        }

        case 'list_channel_tasks': {
          const tasks = await ws.listTasks()
          const text = tasks.map(t =>
            `  ${t.id} [${t.state}] "${t.title}" assignee=${t.assigneeId} progress=${t.progress}%`,
          ).join('\n')
          return { text: `Channel 任务(${tasks.length}):\n${text || '(空)'}` }
        }

        case 'get_my_task_queue': {
          const queue = await ws.myQueue()
          const fmt = (t: WorkspaceTask): string =>
            `  ${t.id} [${t.state}] "${t.title}" progress=${t.progress}%`
          return {
            text: [
              `我的任务队列(${this.agentRole}):`,
              `执行中: ${queue.current ? `${queue.current.id} "${queue.current.title}" (${queue.current.progress}%)` : '(无)'}`,
              `待执行(${queue.queued.length},FIFO):`,
              ...queue.queued.map(fmt),
              `已完成(${queue.completed.length}):`,
              ...queue.completed.map(fmt),
            ].join('\n'),
          }
        }

        case 'get_queue_overview': {
          const overview = await ws.queueOverview()
          const lines = overview.map(s =>
            `  ${s.agentId} (${s.name}, role=${s.role}, state=${s.state}, current=${s.currentTaskId ?? '-'}, queued=${s.queuedCount}, completed=${s.completedCount})`,
          )
          return { text: `团队队列总览(${overview.length}):\n${lines.join('\n') || '(空)'}` }
        }

        case 'reassign_task': {
          const taskId = req.arguments.task_id as string
          const toAgentId = req.arguments.to_agent_id as string
          const task = await ws.reassignTask(taskId, toAgentId)
          return { text: `任务 ${taskId}("${task.title}")已调配 → ${toAgentId}(state=${task.state})` }
        }

        case 'update_task': {
          const taskId = req.arguments.task_id as string
          const title = req.arguments.title as string | undefined
          const description = req.arguments.description as string | undefined
          const task = await ws.updateTask(taskId, { title, description })
          return { text: `任务 ${taskId} 已更新: "${task.title}"` }
        }

        case 'cancel_task': {
          const taskId = req.arguments.task_id as string
          // 守卫:goal/loop/pipeline 的 mode 父任务是用户的作业主任务,Agent 不得经工具取消
          // (模型偶发误判会毁掉整个目标;终止主任务只能由用户在界面/REST 操作)。
          // 目标未达成时的正确动作:dispatch_task 补派子任务;确认无法达成:complete_task 附结论说明。
          const target = await ws.getTask(taskId).catch(() => null)
          if (target && extractTaskMode(target)) {
            return {
              text: `拒绝:任务 ${taskId} 是 mode 父任务(${target.title}),不能用 cancel_task 取消。若目标未达成 → dispatch_task 派发子任务补齐差距;若确认无法达成 → complete_task 并在交付中说明未达成原因。终止整个作业请由用户操作。`,
            }
          }
          await ws.cancelTask(taskId)
          return { text: `任务 ${taskId} 已取消并移出 assignee 队列` }
        }

        case 'list_team_agents': {
          const agents = await ws.listAgents()
          const text = agents.map(a =>
            `  ${a.id} (${a.name}, role=${a.role}, harness=${a.harness})`,
          ).join('\n')
          return { text: `团队成员(${agents.length}):\n${text || '(空)'}` }
        }

        case 'get_task_details': {
          const taskId = req.arguments.task_id as string
          const task: WorkspaceTask = await ws.getTask(taskId)
          const artifactText = task.artifacts.map(a =>
            `  artifact ${a.artifactId}: ${a.parts.map(p => 'text' in p ? p.text.slice(0, 100) : '').join('; ')}`,
          ).join('\n')
          return {
            text: `任务 ${task.id}\n  状态: ${task.state}\n  标题: ${task.title}\n  描述: ${task.description ?? '-'}\n  指派: ${task.assigneeId}\n  进度: ${task.progress}%\n  成果:\n${artifactText || '  (无)'}`,
          }
        }

        case 'search_memory': {
          const query = req.arguments.query as string
          const scope = (req.arguments.scope as 'auto' | 'private' | 'shared' | undefined) ?? 'auto'
          const snippets = await ws.recallMemory({ query, scope, limit: req.arguments.limit as number | undefined })
          if (snippets.length === 0) {
            return { text: `记忆检索无命中(query="${query}", scope=${scope})。可尝试更换关键词或放宽 scope。` }
          }
          const lines = snippets.map(s =>
            `  [${s.source}·${s.kind}·score=${s.score}] ${s.title}\n    ${s.content}`,
          )
          return { text: `记忆检索结果(${snippets.length} 条, scope=${scope}):\n${lines.join('\n')}` }
        }

        case 'save_memory': {
          const title = req.arguments.title as string
          const content = req.arguments.content as string
          const scope = req.arguments.scope as 'private' | 'shared'
          const saved = await ws.saveMemory({
            title,
            content,
            importance: req.arguments.importance as number | undefined,
            scope,
            dedupKey: req.arguments.dedup_key as string | undefined,
          })
          const where = scope === 'shared' ? 'Channel 公共记忆(全员可检索)' : '本人私有记忆'
          return { text: `已沉淀到${where}: "${title}"(dedupKey=${saved.dedupKey})` }
        }

        case 'create_team_agent': {
          const name = req.arguments.name as string
          const harness = req.arguments.harness as string | undefined
          const systemPrompt = req.arguments.system_prompt as string | undefined
          const reason = req.arguments.reason as string | undefined
          const agent = await ws.createTeamMember({
            name,
            harness,
            config: systemPrompt ? { systemPromptPrefix: systemPrompt } : undefined,
            reason,
          })
          return {
            text: [
              `团队成员已创建并加入 channel:`,
              `  id: ${agent.id}`,
              `  name: ${agent.name}(role=worker, harness=${agent.harness})`,
              `新成员当前空闲,可立即 dispatch_task 指派任务;list_team_agents 可随时查看团队名册。`,
            ].join('\n'),
          }
        }

        case 'update_team_agent': {
          const agentId = req.arguments.agent_id as string
          const name = req.arguments.name as string | undefined
          const systemPrompt = req.arguments.system_prompt as string | undefined
          const enabled = req.arguments.enabled as boolean | undefined
          const reason = req.arguments.reason as string | undefined
          const agent = await ws.updateTeamMember(agentId, {
            name,
            config: systemPrompt !== undefined ? { systemPromptPrefix: systemPrompt } : undefined,
            enabled: enabled === undefined ? undefined : (enabled ? 1 : 0),
            reason,
          })
          return {
            text: `团队成员 ${agentId} 已更新:name="${agent.name}"${enabled !== undefined ? `, enabled=${enabled ? 1 : 0}` : ''};运行时将按新配置重载(下次任务生效)。`,
          }
        }

        case 'remove_team_agent': {
          const agentId = req.arguments.agent_id as string
          const reason = req.arguments.reason as string | undefined
          const result = await ws.removeTeamMember(agentId, reason)
          const recycleNote = result.recycledTasks.length > 0
            ? `其 ${result.recycledTasks.length} 个在途任务已回收(排队任务重派给剩余最短队列成员;执行中任务转 FAILED 待调度重试)。`
            : `该成员无在途任务。`
          return { text: `团队成员 ${agentId} 已移除。${recycleNote}` }
        }

        default:
          return { text: `未知工具: ${req.toolName}`, isError: true }
      }
    }
    catch (err) {
      return {
        text: `工具执行异常(${req.toolName}): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
}
