/**
 * OmpRpcAgentImplLayer00 —— 字段与基础配置面(harnessId/configRecord/collectTurnEvents)
 * (分层 1/6,承 BaseAgentImpl;方法体与原文件逐行一致)
 *
 * 本层还声明了 2 个跨层契约抽象方法(原类已有基类,无法再挂 contracts.ts)。
 */
import { BaseAgentImpl } from '../base-agent'
import type { AgentEvent, AgentInfo, AgentRunContext } from '../agent-interface'
import type { AgentSessionEvent, OmpRpcClient } from '../adapters/omp-rpc-client'
import type { BaseAgentConfigView } from '../base-agent'
import type { OmpAgentConfig } from './types'
import { createRosterCache } from '../prompt-builder'
import { liveAgents } from './helpers'
import { randomUUID } from 'node:crypto'

export abstract class OmpRpcAgentImplLayer00 extends BaseAgentImpl {
  // ── 跨层能力契约(由后面的层实现;见本文件头部说明)──
  protected abstract ensureClient(ctx: AgentRunContext): Promise<void>
  protected abstract mapOmpEvent(event: AgentSessionEvent, taskId: string | undefined): AgentEvent[]
  /** 构造器里 `liveAgents().add(this)` 需要本能力在**本层**可见(实现在 02-lifecycle)。
   *  必须是 public:结构化类型 `LiveOmpAgent` 只认公开成员,protected 不参与可赋值性判断。 */
  abstract refreshPluginTools(): void

  protected readonly config: OmpAgentConfig

  protected get harnessId(): string {
    return 'omp'
  }

  protected configRecord(): BaseAgentConfigView {
    return this.config
  }

  /**
   * supervise 用:收齐整个回合的事件。omp 的 supervise() 已整体覆盖(直接解析
   * 决策/执行语义),本实现作为抽象成员的兜底:prompt → text deltas → agent_end,
   * 文本装进单个 artifact 事件(与基类 extractJsonArray 消费形状一致)。
   */
  protected collectTurnEvents(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
    return new Promise((resolve) => {
      if (!this.client) {
        resolve([])
        return
      }
      let text = ''
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        unsub()
        clearTimeout(timer)
        signalUnsub?.()
        resolve(text.trim()
          ? [{
              kind: 'artifact',
              artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text }] },
              lastChunk: true,
              totalChunks: 1,
            } as AgentEvent]
          : [])
      }
      const abortTurn = (): void => {
        void this.client?.send({ type: 'abort' }).catch(() => {})
        finish()
      }
      const unsub = this.client.onEvent((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          text += event.assistantMessageEvent.delta ?? ''
        }
        if (event.type === 'agent_end' && event.isTerminal !== false) finish()
        if (event.type === '__process_exit__' || event.type === '__error__') finish()
      })
      const timer = setTimeout(abortTurn, Math.max(timeoutMs, 1_000))
      let signalUnsub: (() => void) | undefined
      if (signal) {
        if (signal.aborted) {
          finish()
          return
        }
        const onAbort = (): void => abortTurn()
        signal.addEventListener('abort', onAbort, { once: true })
        signalUnsub = () => signal.removeEventListener('abort', onAbort)
      }
      this.client.send({ type: 'prompt', message: prompt }).catch(() => finish())
    })
  }

  protected client: OmpRpcClient | null = null
  protected agentInfo: AgentInfo | null = null
  protected hostToolsRegistered = false
  /**
   * 会话回合状态(steer 可靠注入的依据):
   * omp 的 steer 仅在回合 streaming 中生效——prompt 已入列但尚未开始输出时,
   * steer 会"成功"返回但被静默丢弃。因此注入方轮询直到回合输出开始(streamingStarted)
   * 才发送;若回合在等待期间结束,消息保持 pending 由消费循环处理。
   */
  protected streaming = false
  protected turnActive = false
  /** 当前回合产生的 assistant 文本(供诊断) */
  protected turnText = ''
  /** agent 身份信息(factory 注入;无需等待 init()) */
  // agentRole 由 BaseAgentImpl 持有(protected);同名私有声明会遮蔽基类 identity 角色。
  // 仅收窄可见性声明,运行时代码不变(构造函数与 ensureClient 仍显式同步)。
  protected override agentRole: 'lead' | 'worker' = 'worker'

  // ===== 上下文治理(70% 无中断压缩环)=====
  constructor(config: Record<string, unknown> = {}) {
    super({
      agentId: typeof config.agentId === 'string' ? config.agentId : '',
      name: typeof config.name === 'string' ? config.name : undefined,
      role: config.role === 'lead' ? 'lead' : 'worker',
      channelId: typeof config.channelId === 'string' ? config.channelId : '',
    })
    this.config = config as OmpAgentConfig
    // effort 统一入口(channel 默认 LLM 注入 config.effort)→ omp thinking 级别
    if (!this.config.thinkingLevel && typeof config.effort === 'string' && config.effort) {
      this.config.thinkingLevel = config.effort
    }
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

  override async init(input: { agent: AgentInfo, channelId: string }): Promise<void> {
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
}
