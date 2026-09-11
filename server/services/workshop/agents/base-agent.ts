/**
 * BaseAgentImpl —— 全部 harness impl 的通用基类(可复用共性能力 + 接口设计)。
 *
 * 沉淀与具体引擎协议无关的平台语义,子类只实现「一次回合怎么跑」:
 *  - 身份与桥接上下文(selfAgentId/agentName/agentRole/channelId + toolState/bridgeCtx/roster)
 *  - 消息分流(run():assign → workerTurn / 人类·同事消息 → peerTurn;metadata['x-aw-task-kind'])
 *  - lead 调度回合(supervise():supervisePrompt 组装 → collectTurnEvents 收齐 → extractJsonArray)
 *  - host tools 直调面(dispatchHostTool → 共享 host-tool-bridge)
 *  - 上下文前缀(contextPrefix:场景 × 身份 × 工业简报 × 名册)
 *
 * 子类契约:
 *  - `harnessId`:日志/进程登记用的引擎标识
 *  - `configRecord()`:子类强类型配置的 Record 视图(基类只读公共键)
 *  - `workerTurn` / `peerTurn`:一次回合的事件流
 *  - `collectTurnEvents`:supervise 用的整回合收集(默认实现可选覆盖)
 *
 * 可选覆盖:dispose/steer/getContextStats/getProcessInfo/killProcess/reconcileProcess/
 * respondHitl/onTurnSettled —— 能力面如实声明(registry capabilities)。
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
import { createSessionState, dispatchHostTool, type HostToolBridgeContext, type HostToolSessionState } from './host-tool-bridge'
import {
  contextPrefix as buildContextPrefix,
  createRosterCache,
  extractJsonArray,
  supervisePrompt,
  systemManual,
} from './prompt-builder'

export interface BaseAgentIdentity {
  agentId?: string
  name?: string
  role?: 'lead' | 'worker'
  channelId?: string
}

export abstract class BaseAgentImpl implements AgentInterface {
  protected workspace: AgentRunContext['workspace'] | null = null
  protected readonly toolState: HostToolSessionState = createSessionState()
  protected readonly bridgeCtx: HostToolBridgeContext
  protected roster: ReturnType<typeof createRosterCache>

  protected selfAgentId = ''
  protected agentName = 'agent'
  protected agentRole: 'lead' | 'worker' = 'worker'
  protected channelId = ''

  protected constructor(identity: BaseAgentIdentity) {
    this.selfAgentId = identity.agentId ?? ''
    this.agentName = identity.name ?? 'agent'
    this.agentRole = identity.role ?? 'worker'
    this.channelId = identity.channelId ?? ''
    this.bridgeCtx = {
      identity: { agentId: this.selfAgentId, channelId: this.channelId, role: this.agentRole, name: this.agentName },
      state: this.toolState,
      getWorkspace: () => this.workspace,
    }
    this.refreshIdentity()
  }

  /** 引擎标识(日志/登记;如 'dsh'/'pi') */
  protected abstract get harnessId(): string

  /** 子类强类型配置的 Record 视图(基类只读公共键) */
  protected abstract configRecord(): Record<string, unknown>

  protected makeRoster(): ReturnType<typeof createRosterCache> {
    return createRosterCache({
      selfAgentId: this.selfAgentId,
      listAgents: async () => this.workspace?.listAgents() ?? [],
    })
  }

  protected refreshIdentity(): void {
    this.bridgeCtx.identity = { agentId: this.selfAgentId, channelId: this.channelId, role: this.agentRole, name: this.agentName }
    this.roster = this.makeRoster()
  }

  async init(input: { agent: AgentInfo, channelId: string }): Promise<void> {
    this.workspace = null
    this.channelId = input.channelId
    this.agentName = input.agent.name
    this.agentRole = input.agent.role
    this.selfAgentId = input.agent.id
    this.refreshIdentity()
  }

  dispatchHostTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string, isError?: boolean }> {
    return dispatchHostTool(this.bridgeCtx, { toolName, arguments: args })
  }

  /** HITL:默认无程序化审批面(有审批能力的引擎覆盖;能力面如实声明) */
  async respondHitl(kind: string, _id: string, _outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<void> {
    throw new Error(`${this.harnessId} 无 HITL 应答面(${kind})`)
  }

  // ===== run:消息分流(平台语义,全引擎一致) =====

  /**
   * 装配期注入工作区(AgentRuntime 构造时调用):使 host 工具在首个 run() 之前
   * 即可直调 —— 否则 REST agent-tools/invoke 在实例未处理过任何消息时会得到
   * 「workspace 未就绪」(实测生产闭环 Stage D 的 kb_store 偶发因此失败)。
   */
  attachWorkspace(ws: AgentRunContext['workspace']): void {
    if (ws && !this.workspace) this.workspace = ws
  }

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    if (!this.workspace) this.workspace = ctx.workspace
    const kind = request.message.metadata?.['x-aw-task-kind']
    if (kind === 'assign' && ctx.role === 'worker') {
      yield* this.workerTurn(request, ctx)
      return
    }
    if (!kind && (request.fromAgentId || request.message.metadata?.['x-aw-from-label'])) {
      yield* this.peerTurn(request, ctx)
      return
    }
  }

  /** 任务指派回合(assign) */
  protected abstract workerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown>

  /** 同事/人类消息回合(peer;含 x-aw-require-reply 回执上下文) */
  protected abstract peerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown>

  // ===== lead 调度回合(模板方法) =====

  private supervising = false

  async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext, opts?: { signal?: AbortSignal }): Promise<SupervisionDecision[]> {
    if (this.supervising) return []
    if (!this.workspace) this.workspace = ctx.workspace
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
      const events = await this.collectTurnEvents(prompt, this.superviseTimeoutMs(), opts?.signal)
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

  protected superviseTimeoutMs(): number {
    const v = Number(this.configRecord().superviseTimeoutMs)
    return Number.isFinite(v) && v > 0 ? v : 150_000
  }

  /** supervise 用:收齐整个回合的事件(回合实现方提供) */
  protected abstract collectTurnEvents(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]>

  // ===== prompt 组装(共享) =====

  protected async contextPrefix(): Promise<string> {
    const cfg = this.configRecord()
    return buildContextPrefix({
      scenarioPrompt: typeof cfg.scenarioPrompt === 'string' ? cfg.scenarioPrompt : undefined,
      systemPromptPrefix: typeof cfg.systemPromptPrefix === 'string' ? cfg.systemPromptPrefix : undefined,
      agentId: this.selfAgentId,
      roster: await this.roster.roster(),
    })
  }

  /** 消息/任务 parts 拼文本(worker/peer 共用) */
  protected partsText(message: AgentRunRequest['message']): string {
    return message.parts.map((p) => {
      if ('text' in p) return p.text
      if ('data' in p) return JSON.stringify(p.data)
      if ('url' in p) return p.url
      if ('raw' in p) return p.raw
      return ''
    }).join('\n')
  }

  /** 状态事件快捷构造(🔧 行等) */
  protected statusEvent(text: string): AgentEvent {
    return {
      kind: 'status',
      status: {
        state: 'WORKING',
        message: { messageId: randomUUID(), contextId: this.channelId, role: 'ROLE_AGENT', parts: [{ text }] },
        timestamp: new Date().toISOString(),
      },
    }
  }
}
