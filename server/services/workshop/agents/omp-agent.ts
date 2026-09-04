/**
 * OmpRpcAgentImpl — omp harness 的完整 AgentInterface 实现。
 *
 * 通过 OmpRpcClient 驱动真实 omp 子进程(--mode rpc),将 omp 的原生 agent 能力
 * (LLM 推理 + 内置工具 read/write/edit/bash/grep/glob 等)接入 Workshop 的
 * Channel 编排体系。
 *
 * 核心设计:
 *  - 每个 Agent 实例持有一个 omp 子进程(lazy spawn,跨消息复用)
 *  - AgentWorkspace 方法经 host-tool-bridge 注册为 omp host tools,agent 原生调用
 *    report_progress / complete_task / dispatch_task / send_message 等,无需文本解析
 *  - omp AgentSessionEvent → AgentEvent 五变体映射
 *  - worker run():接收 assign → prompt omp → agent 用原生工具作业 + host tools 管理任务生命周期
 *  - lead supervise():格式化快照 → prompt omp → agent 直接用 host tools 执行调度决策 → 返回 []
 *  - dispose():杀子进程
 *
 * prompt 组装与工具分发已抽至共享层(prompt-builder / host-tool-bridge),
 * 与 codex/dsh/opencode impl 全引擎一致。协议权威:omp://rpc.md。
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
import type { A2AMessage } from '../types/a2a'
import type { AgentContextStats } from '../types/task'
import {
  OmpRpcClient,
  type AgentSessionEvent,
  type CompactionResult,
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
  createSessionState,
  dispatchHostTool,
  hostToolsForRole,
} from './host-tool-bridge'
import {
  contextPrefix as buildContextPrefix,
  createRosterCache,
  extractJsonArray,
  parseSteerBanner,
  peerPrompt,
  supervisePrompt,
  systemManual,
  toolArgsPreview,
  workerPrompt,
} from './prompt-builder'
import { renderPrompt } from '../prompts/loader'
import { attachOmpPluginBridge, onPluginToolsChange } from './plugin-tools'
import { ompSettings } from '../settings'

const log = createLogger('workshop.omp')

// 兼容再导出(脚本/测试历史导入面;实现在 host-tool-bridge)
export { HOST_TOOLS, hostToolsForRole } from './host-tool-bridge'

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
  /** supervise 轮超时(ms,默认 150000) */
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

// 插件桥接管(host.mjs ctx.omp 排队注册的工具在此回放;幂等)
attachOmpPluginBridge()

/** 在跑 agent 实例表(工具注册表变更 → 热重发 set_host_tools,运行时注入无需重spawn) */
const gLive = globalThis as typeof globalThis & { __ompLiveAgents?: Set<OmpRpcAgentImpl> }
function liveAgents(): Set<OmpRpcAgentImpl> {
  return gLive.__ompLiveAgents ??= new Set()
}

// 工具注册表变更 → 全部在跑会话热更新工具面
onPluginToolsChange(() => {
  for (const impl of liveAgents()) {
    try {
      impl.refreshPluginTools()
    }
    catch { /* 单实例失败不影响其他 */ }
  }
})

// ===== OmpRpcAgentImpl =====

export class OmpRpcAgentImpl implements AgentInterface {
  private readonly config: OmpAgentConfig
  private client: OmpRpcClient | null = null
  private workspace: AgentRunContext['workspace'] | null = null
  private agentInfo: AgentInfo | null = null
  private hostToolsRegistered = false
  /** host tool 会话态(当前任务 + 待回执上下文;与共享桥共用) */
  private readonly toolState = createSessionState()
  /** 工具桥上下文(分发唯一入口) */
  private readonly bridgeCtx = {
    identity: { agentId: '', channelId: '', role: 'worker' as 'lead' | 'worker', name: 'agent' },
    state: this.toolState,
    getWorkspace: () => this.workspace,
  }

  /**
   * 会话回合状态(steer 可靠注入的依据):
   * omp 的 steer 仅在回合 streaming 中生效——prompt 已入列但尚未开始输出时,
   * steer 会"成功"返回但被静默丢弃。因此注入方轮询直到回合输出开始(streamingStarted)
   * 才发送;若回合在等待期间结束,消息保持 pending 由消费循环处理。
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
  /** 团队名册缓存(共享 prompt-builder) */
  private roster = createRosterCache({
    selfAgentId: '',
    listAgents: () => this.workspace!.listAgents(),
  })

  // ===== 上下文治理(70% 无中断压缩环)=====
  /** 压缩进行中(平台 gate 与 omp 原生压缩共用互斥位) */
  private compacting = false
  private lastCompactAt = 0
  /** omp 不支持 compact 命令(旧版)→ 永久停用平台压缩;原生 auto-compaction 兜底,harvest 照常 */
  private compactLegacy = false
  /** 模型上下文窗口(get_state/get_session_stats 探测;null = 未知,percent 不可算) */
  private contextWindow: number | null = null
  private sessionId: string | null = null
  /** harvest 双路去重(compact 响应与 compaction_end 事件可能双达) */
  private lastHarvestKey = ''
  private lastHarvestAt = 0

  /** 总开关(omp.compact_enabled;env AW_OMP_COMPACT_ENABLED=0 显式关闭兼容) */
  private compactEnabled(): boolean {
    return ompSettings().compact_enabled
  }

  private compactThreshold(): number {
    return ompSettings().compact_threshold
  }

  private compactMinIntervalMs(): number {
    return ompSettings().compact_min_interval_ms
  }

  private compactWaitMs(): number {
    return ompSettings().compact_wait_ms
  }

  /** 被动上下文用量快照(无探测 RPC;getStatus 透出用) */
  getContextStats(): AgentContextStats | null {
    const usage = this.client?.getContextUsage() ?? null
    const window = this.contextWindow ?? usage?.contextWindow ?? null
    if (!usage && window === null) return null
    const usedTokens = usage?.tokens ?? 0
    return {
      usedTokens,
      contextWindow: window,
      percent: window && window > 0 ? Math.min(1, usedTokens / window) : null,
      compacting: this.compacting,
    }
  }

  /**
   * 上下文用量探测:get_session_stats 权威值;不可用退化为被动 usage + 已探测窗口。
   * percent 归一化到 0-1(omp 可能返回 0-100)。
   */
  private async probeUsage(client: OmpRpcClient): Promise<{ tokens: number, contextWindow: number | null, percent: number | null } | null> {
    try {
      const resp = await client.send({ type: 'get_session_stats' })
      const cu = ((resp.data ?? {}) as Record<string, unknown>).contextUsage as
        | { tokens?: number, contextWindow?: number, percent?: number }
        | undefined
      if (cu && typeof cu.tokens === 'number' && cu.tokens > 0) {
        if (typeof cu.contextWindow === 'number' && cu.contextWindow > 0) {
          this.contextWindow = cu.contextWindow
          client.setContextWindow(cu.contextWindow)
        }
        const window = this.contextWindow ?? cu.contextWindow ?? null
        const rawPercent = typeof cu.percent === 'number' ? (cu.percent > 1 ? cu.percent / 100 : cu.percent) : null
        const percent = rawPercent ?? (window && window > 0 ? Math.min(1, cu.tokens / window) : null)
        return { tokens: cu.tokens, contextWindow: window, percent }
      }
    }
    catch { /* get_session_stats 不可用 → 被动跟踪 */ }
    return client.getContextUsage()
  }

  /**
   * 上下文治理门控:三条 prompt 路径(worker/peer/supervise)在回合间隙统一调用;
   * post-settle 经 onTurnSettled 复用同一守卫。任何失败路径都放行——压缩晚一轮
   * 永远好过中断作业。三重防线:仅回合间隙发起 → get_state 复查 isStreaming/
   * isCompacting → compacting 互斥位 + 最小间隔防振荡。
   */
  private async contextGate(reason: string): Promise<void> {
    if (!this.compactEnabled() || this.compactLegacy || this.compacting) return
    const client = this.client
    if (!client || !client.alive) return
    try {
      const usage = await this.probeUsage(client)
      if (!usage || usage.percent === null || usage.percent < this.compactThreshold()) return
      if (Date.now() - this.lastCompactAt < this.compactMinIntervalMs()) return
      // 回合间隙硬校验:流式中/压缩中绝不发起(不中断执行的硬约束)
      const st = await client.send({ type: 'get_state' })
      const s = (st.data ?? {}) as Record<string, unknown>
      if (s.isStreaming === true || s.isCompacting === true) return
      if (typeof s.sessionId === 'string' && s.sessionId) this.sessionId = s.sessionId
      this.compacting = true
      this.lastCompactAt = Date.now()
      try {
        const result = await this.runCompaction(client)
        if (result?.summary) {
          await this.harvestCompaction(
            result.summary,
            result.tokensBefore,
            result.tokensAfter ?? result.estimatedTokensAfter,
            reason,
          )
        }
      }
      finally {
        this.compacting = false
      }
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/compact/i.test(msg) && /unknown|unsupported|invalid|无效|未知|不支持/i.test(msg)) this.compactLegacy = true
      log.warn(`[OmpRpcAgent:${this.selfAgentId}] contextGate(${reason}) 失败,放行: ${msg}`)
    }
  }

  /**
   * 发起 compact 并等待 compaction_end(响应内含 result 则立即收口;
   * 超时放行——压缩在 harness 内后台继续,isCompacting 防后续双发)。
   */
  private runCompaction(client: OmpRpcClient): Promise<CompactionResult | null> {
    return new Promise<CompactionResult | null>((resolve) => {
      let settled = false
      const finish = (r: CompactionResult | null): void => {
        if (settled) return
        settled = true
        off()
        clearTimeout(timer)
        resolve(r)
      }
      const off = client.onEvent((event) => {
        if (event.type === 'compaction_end') {
          finish((event as { result?: CompactionResult }).result ?? null)
        }
        else if (event.type === '__process_exit__') {
          finish(null)
        }
      })
      const timer = setTimeout(() => {
        log.warn(`[OmpRpcAgent:${this.selfAgentId}] compact 等待超时(${this.compactWaitMs()}ms)→ 放行(压缩后台继续)`)
        finish(null)
      }, this.compactWaitMs())
      void client.send({ type: 'compact', customInstructions: this.compactionHints() })
        .then((resp) => {
          const result = (resp.data as { result?: CompactionResult } | undefined)?.result
          if (result?.summary) finish(result)
          // 响应无 result:等 compaction_end 事件(协议权威语义)
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (/compact/i.test(msg)) this.compactLegacy = true
          log.warn(`[OmpRpcAgent:${this.selfAgentId}] compact 发起失败: ${msg}`)
          finish(null)
        })
    })
  }

  /** 压缩摘要指令(外置 prompts;缺失时省略,omp 用默认策略) */
  private compactionHints(): string | undefined {
    try {
      return renderPrompt('compaction-hints')
    }
    catch {
      return undefined
    }
  }

  /**
   * 压缩摘要 harvest(三路统一:平台主动 compact / omp 阈值自动 / overflow):
   * 经 workspace.recordSessionMemory 落库为本人 episodic-session 记忆。
   * 双路去重:同摘要 60s 内只入库一次。
   */
  private async harvestCompaction(summary: string, tokensBefore?: number, tokensAfter?: number, reason?: string): Promise<void> {
    const key = summary.slice(0, 120)
    if (key === this.lastHarvestKey && Date.now() - this.lastHarvestAt < 60_000) return
    this.lastHarvestKey = key
    this.lastHarvestAt = Date.now()
    try {
      await this.workspace?.recordSessionMemory?.({ summary, tokensBefore, tokensAfter, reason })
      log.info(`[OmpRpcAgent:${this.selfAgentId}] 压缩摘要已入记忆(${summary.length} 字,reason=${reason ?? 'auto'})`)
    }
    catch (err) {
      log.warn(`[OmpRpcAgent:${this.selfAgentId}] 压缩摘要入库失败(不影响会话):`, err instanceof Error ? err.message : err)
    }
  }

  /** 回合落定钩子(AgentRuntime 在信箱空时调用):后台压缩检查,自守卫不抛错 */
  async onTurnSettled(): Promise<void> {
    await this.contextGate('post-settle')
  }

  constructor(config: Record<string, unknown> = {}) {
    this.config = config as OmpAgentConfig
    // factory 注入的 agent 身份(无需等待 init())
    this.selfAgentId = this.config.agentId ?? ''
    this.agentName = this.config.name ?? 'agent'
    this.agentRole = this.config.role ?? 'worker'
    this.channelId = this.config.channelId ?? ''
    this.bridgeCtx.identity = { agentId: this.selfAgentId, channelId: this.channelId, role: this.agentRole, name: this.agentName }
    this.roster = createRosterCache({
      selfAgentId: this.selfAgentId,
      listAgents: () => this.workspace!.listAgents(),
    })
    liveAgents().add(this) // 在跑实例表:插件工具热注入的目标集
  }

  // ===== 生命周期 =====

  async init(input: { agent: AgentInfo, channelId: string }): Promise<void> {
    this.agentInfo = input.agent
    this.channelId = input.channelId
    this.agentName = input.agent.name
    this.agentRole = input.agent.role
    this.selfAgentId = input.agent.id
    this.bridgeCtx.identity = { agentId: this.selfAgentId, channelId: this.channelId, role: this.agentRole, name: this.agentName }
    this.roster = createRosterCache({
      selfAgentId: this.selfAgentId,
      listAgents: () => this.workspace!.listAgents(),
    })
  }

  async dispose(): Promise<void> {
    liveAgents().delete(this)
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

  /** 工具注册表变更 → 热重发 set_host_tools(在跑会话立即获得插件新工具,无需重spawn) */
  refreshPluginTools(): void {
    const client = this.client
    if (!client || !client.alive) return
    void client.send({ type: 'set_host_tools', tools: hostToolsForRole(this.agentRole) }).catch(() => {})
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

  /**
   * harness 进程存活校准(manager sweeper 周期性调用;休眠/强杀后 exit 事件
   * 可能不达父进程):按 PID 探 OS 实际存在性,进程已死 → 客户端收敛为已退出,
   * 在途回合经 __process_exit__ 归位,下一回合 ensureClient 重生子进程。
   */
  reconcileProcess(): void {
    this.client?.reconcile()
  }

  /** omp 输出模式(rpc-ui = 默认,启用 HITL 对话框) */
  private get rpcMode(): 'rpc' | 'rpc-ui' {
    return this.config.rpcMode === 'rpc' ? 'rpc' : 'rpc-ui'
  }

  // ===== 工具桥(共享分发)=====

  /** 引擎无关工具面:REST/MCP 桥直调与 omp 内部 host_tool_call 共用同一实现 */
  dispatchHostTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string, isError?: boolean }> {
    return dispatchHostTool(this.bridgeCtx, { toolName, arguments: args })
  }

  private async handleHostTool(req: HostToolCallRequest): Promise<{ text: string, isError?: boolean }> {
    return this.dispatchHostTool(req.toolName, req.arguments ?? {})
  }

  // ===== prompt 组合 =====

  /** 前置上下文(场景 × 身份 × 工业简报 × 名册;共享 prompt-builder) */
  private async contextPrefix(): Promise<string> {
    return buildContextPrefix({
      scenarioPrompt: this.config.scenarioPrompt,
      systemPromptPrefix: this.config.systemPromptPrefix,
      agentId: this.selfAgentId,
      roster: await this.roster.roster(),
    })
  }

  private systemManual(): string {
    return systemManual()
  }

  /**
   * 实时消息注入(送达模式协议):
   *  - 回合 streaming 中 → 立即 steer,返回 'steer'(同轮可见,唯一可标记消费的路径)
   *  - 回合活跃但尚未 streaming(prompt 排队窗口,上限 20s)→ 等 streaming 开始后 steer
   *  - 回合被 host 工具阻塞(如 poll_messages 等待)/空闲/发送失败 → 返回 'deferred':
   *    消息保持 pending,poll_messages 的 Mailbox 到信回调即时取走(毫秒级),或本回合
   *    结束后由消费循环按 FIFO 起回合处理。
   */
  async steer(text: string): Promise<'steer' | 'deferred'> {
    // 从确定性触发横幅提取回执上下文(AgentRuntime.injectSteer 生成,格式固定):
    // "[实时消息 from <id>]: ..." + "[系统触发器] 本消息要求回复(reply_to=<messageId>)。"
    const banner = parseSteerBanner(text)
    if (banner) {
      this.toolState.replyContext = banner
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
      log.error(`[OmpRpcAgent:${this.selfAgentId}] steer 注入失败(消息保持 pending):`, err instanceof Error ? err.message : err)
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
    // 人类经 REST 注入的消息(from 空 + x-aw-from-label)同样进入应答流
    if (!kind && (request.fromAgentId || request.message.metadata?.['x-aw-from-label'])) {
      yield* this.peerMessageRun(request, ctx)
      return
    }

    // 其余消息(lead 的 assign/child-completed 等):no-op(调度由 supervise() 处理)
  }

  // ===== supervise() =====

  /** supervise 单飞守卫:同一 client 不并发 LLM 回合(残留回合与下一 prompt 混流的根因) */
  private supervising = false

  async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext, opts?: { signal?: AbortSignal }): Promise<SupervisionDecision[]> {
    await this.ensureClient(ctx)
    if (!this.client) return []
    if (this.supervising) return [] // 上一轮 supervise 未收口:跳过本拍(节流即正确)

    // 上下文门控(≥70% 先压缩再调度;回合间隙发起,失败放行)
    await this.contextGate('supervise')

    const prompt = supervisePrompt({
      snapshot,
      agentName: this.agentName,
      channelId: this.channelId,
      ctxPrefix: await this.contextPrefix(),
      manual: this.systemManual(),
      memory: ctx.memory,
    })
    // 150s 上界:supervise 持 lead.execLock 期间信箱消费停顿(更久会拖垮 worker 回执处理);
    // supervise 是一次真实 LLM 回合:omp 冷启动(插件/MCP 加载 30~90s)+ 慢 provider
    // 单步可能 >60s,过紧会把正常回合掐成 "Interrupted by user"。默认 150s,
    // 仅拦真僵死(更紧的预算由调用方 config.superviseTimeoutMs 显式传入);真 abort 已实现。
    const timeoutMs = this.config.superviseTimeoutMs ?? 150_000

    return new Promise<SupervisionDecision[]>((resolve) => {
      let assistantText = ''
      let resolved = false

      const finish = (decisions: SupervisionDecision[]) => {
        if (resolved) return
        resolved = true
        this.supervising = false
        unsub()
        clearTimeout(timer)
        signalUnsub?.()
        resolve(decisions)
      }

      const abortTurn = (): void => {
        // 超时/外部取消:真正中止 omp 当前回合 —— 只 resolve 不 abort 会让残留回合
        // 与下一个 prompt 在同一 client 混流(决策错位 + token 空烧)
        log.warn(`[OmpRpcAgent:${this.selfAgentId}] supervise 超时(${timeoutMs}ms)→ abort 当前调度回合`)
        void this.client?.send({ type: 'abort' }).catch(() => {})
        finish([])
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

      const timer = setTimeout(abortTurn, timeoutMs)

      // 外部取消(调度器 cancel 路径)传导:abort 当前 LLM 回合并立即收口
      let signalUnsub: (() => void) | undefined
      if (opts?.signal) {
        if (opts.signal.aborted) {
          unsub()
          resolve([])
          return
        }
        const onAbort = (): void => abortTurn()
        opts.signal.addEventListener('abort', onAbort, { once: true })
        signalUnsub = () => opts.signal?.removeEventListener('abort', onAbort)
      }

      this.supervising = true
      this.client!.send({ type: 'prompt', message: prompt }).catch(() => finish([]))
    })
  }

  // ===== 内部:worker 执行 =====

  private async* workerRun(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId
      ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return

    this.toolState.currentTaskId = taskId

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
      manual: this.systemManual(),
    })

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
    catch (err) {
      // spawn 失败必须显式报错:静默 return 会让 sawRunError=false → 消息被
      // 直接 markConsumed,实时消息一次性丢失且无任何重试;产出 error 事件
      // 走消息 requeue(≤2 次),与 workerRun 同口径
      yield {
        kind: 'error',
        error: {
          code: 'OMP_SPAWN_FAILED',
          message: `omp 子进程启动失败(peer 消息未消费,将重试): ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }
    if (!this.client) {
      yield { kind: 'error', error: { code: 'OMP_NOT_READY', message: 'omp 客户端未就绪(peer 消息未消费,将重试)' } }
      return
    }

    const msg = request.message
    // 显示名:agent 同事用 id(名册可解析);人类发送者用 fromLabel;兜底 unknown
    const fromId = request.fromAgentId
      ?? (typeof msg.metadata?.['x-aw-from-label'] === 'string' ? msg.metadata['x-aw-from-label'] : undefined)
      ?? 'unknown'
    const msgText = msg.parts.map((p) => {
      if ('text' in p) return p.text
      if ('data' in p) return JSON.stringify(p.data)
      if ('url' in p) return p.url
      if ('raw' in p) return p.raw
      return ''
    }).join('\n')
    const requireReply = msg.metadata?.['x-aw-require-reply'] === 'true'
    const isReply = typeof msg.metadata?.['x-aw-in-reply-to'] === 'string'
    // 跨 Channel 来信:发送方是其他 channel 的 lead,回执必须走 send_cross_channel_message
    const crossChannel = msg.metadata?.['x-aw-cross-channel'] === 'true'
    const fromChannel = typeof msg.metadata?.['x-aw-from-channel'] === 'string'
      ? String(msg.metadata['x-aw-from-channel'])
      : ''
    // 回执自动关联仅对真实 agent 发送者生效(人类无 agentId 可回投;
    // 对人类的回复经事件流/时间线可见)
    this.toolState.replyContext = requireReply && request.fromAgentId && !crossChannel
      ? { fromId: request.fromAgentId, messageId: msg.messageId }
      : null

    const prompt = peerPrompt({
      agentName: this.agentName,
      role: this.agentRole,
      channelId: this.channelId,
      ctxPrefix: await this.contextPrefix(),
      manual: this.systemManual(),
      memory: request.memory,
      fromId,
      messageId: msg.messageId,
      requireReply,
      isReply,
      crossChannel,
      fromChannel,
      msgText,
    })

    yield* this.promptAndStream(prompt, undefined, ctx.signal)
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
    // 上下文门控(≥70% 时在回合间隙先压缩再发 prompt;等待有界,失败放行)
    await this.contextGate('pre-prompt')
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
          // LLM 流式增量透出(AEP agent.delta 事件源):仅 worker/peer 转本走生成器
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
      log.warn(`[OmpRpcAgent:${this.selfAgentId}] run 被 abort(signal)→ 中止 omp 回合,taskId=${taskId ?? '-'}`)
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
      // 僵死进程回收:prompt send 失败 = stdio 断裂或 60s 命令确认超时 —— 进程
      // "活着但不干活"(alive-but-wedged)。若仅报错不清理,消息重试(≤2 次)会
      // 复用同一僵死 stdio 每次空转 60s;必须杀掉并置空,下回合 ensureClient
      // 全新重生(host tools/模型/终端 tap 随重建)。
      log.warn(`[OmpRpcAgent:${this.selfAgentId}] prompt 失败 → 回收可疑僵死进程 pid=${client.pid}`)
      this.killProcess()
      this.client = null
      this.hostToolsRegistered = false
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
      // 事件监听必须全部解除:本 client 跨回合长期复用,残留的 mapOmpEvent
      // 闭包会在后续每一帧继续执行并把事件 push 进孤儿队列(内存/CPU 随
      // 回合数线性劣化,直接违背进程常驻的稳定性目标)
      unsubState()
      unsub()
      signal.removeEventListener('abort', onAbort)
      this.turnActive = false
      this.streaming = false
      this.toolState.currentTaskId = null
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
          log.error(`[OmpRpcAgent:${this.selfAgentId}] harness 回合失败 ${code}: ${detail}`)
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

      // ===== 上下文治理事件(回合中到达的原生阈值/overflow 压缩;不污染事件流)=====
      case 'compaction_start':
        this.compacting = true
        return []

      case 'compaction_end': {
        this.compacting = false
        const result = (event as { result?: CompactionResult }).result
        if (result?.summary) {
          void this.harvestCompaction(
            result.summary,
            result.tokensBefore,
            result.tokensAfter ?? result.estimatedTokensAfter,
            (event as { reason?: string }).reason,
          )
        }
        return []
      }

      // 回合完全落定(无自动重试/压缩重试/排队续跑):后续压缩检查由 AgentRuntime 驱动
      case 'agent_settled':
        return []

      case '__error__':
        return [{
          kind: 'error',
          error: { code: 'OMP_ERROR', message: (event as { error?: string }).error ?? 'omp 未知错误' },
        }]

      default:
        return []
    }
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
      this.bridgeCtx.identity = { agentId: this.selfAgentId, channelId: this.channelId, role: this.agentRole, name: this.agentName }
    }

    if (!this.client || !this.client.alive) {
      // 旧客户端已退出(exit 事件/OS 存活校准 reconcile 触发)——必须丢弃并重生,
      // 否则后续回合会一直对着死 stdio 报 PROMPT_FAILED 烧重试配额
      this.client = null
      this.hostToolsRegistered = false
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

      // 设置模型(如果配置了 provider/model 任一;omp 以当前已设值为缺省补全,
      // 只配其一时也显式发送,避免 respawn 后静默回落默认模型)
      if (this.config.provider || this.config.model) {
        try {
          // 未配置一侧保持 undefined(JSON 序列化丢键)→ omp 以当前已设值补全
          await client.send({
            type: 'set_model',
            provider: this.config.provider as string,
            modelId: this.config.model as string,
          })
        }
        catch {
          // 模型设置失败不致命(用 omp 默认模型)
        }
      }

      // 注册 host tools(按角色差异化:lead 全量,worker 剔除调度/团队管理专属工具)
      client.onHostToolCall(req => this.handleHostTool(req))
      await client.send({ type: 'set_host_tools', tools: hostToolsForRole(this.agentRole) })

      // 上下文治理探测(feature-detect 一次;失败退化被动 usage 跟踪)+ 原生压缩兜底保持开启
      void this.probeContext(client).catch(() => {})
      void client.send({ type: 'set_auto_compaction', enabled: true }).catch(() => {})

      this.client = client
      this.hostToolsRegistered = true
    }
  }

  /** 上下文状态探测:get_state 取 contextWindow/sessionId(一次;失败仅损失 percent 精度) */
  private async probeContext(client: OmpRpcClient): Promise<void> {
    try {
      const resp = await client.send({ type: 'get_state' })
      const data = (resp.data ?? {}) as Record<string, unknown>
      const model = data.model as { contextWindow?: number } | undefined
      if (typeof model?.contextWindow === 'number' && model.contextWindow > 0) {
        this.contextWindow = model.contextWindow
        client.setContextWindow(model.contextWindow)
      }
      if (typeof data.sessionId === 'string' && data.sessionId) this.sessionId = data.sessionId
    }
    catch { /* get_state 不可用:仅被动 usage */ }
  }
}
