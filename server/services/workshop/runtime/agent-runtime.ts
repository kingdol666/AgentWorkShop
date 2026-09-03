/**
 * AgentRuntime — Agent 独立运行时对象。
 * 状态机 idle/busy/stopped + 消费循环(自动接取/自动作业)+ run/supervise 互斥 + abort。
 * 任务管理系统:每个运行时对自己的任务队列(待执行 FIFO / 执行中 / 已完成)有完整视图;
 * 队列是 tasks 表的派生投影(DB 唯一事实源),状态迁移实时广播(idle/busy + 队列上下文)。
 */
import { createLogger } from '../logger'
import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentInfo,
  AgentInterface,
  AgentRunContext,
  AgentRunRequest,
  AgentWorkspace,
  SupervisionDecision,
  SupervisionSnapshot,
} from '../agents/agent-interface'
import type { A2AMessage, A2AArtifact, Part } from '../types/a2a'
import type { AgentContextStats, AgentStatusView, AgentTaskQueueView, TaskState, WorkspaceTask } from '../types/task'
import { TERMINAL_TASK_STATES } from '../types/task'
import type { AgentMemory } from './memory'
import type { Mailbox } from './mailbox'

const log = createLogger('workshop.agent-runtime')

/** ChannelBus:运行时事件总线(逐事件广播 + 任务/成员事件通知 + 调度唤醒) */
/** 任务变更事件携带的源头任务视图(WS 推送免 per-event 回查;WorkspaceTask 结构兼容) */
export interface TaskEventTask {
  id: string
  title?: string
  parentId?: string
  assigneeId?: string
  progress?: number | null
  routeReason?: string
  createdAt: string
  artifacts?: unknown[]
}

export interface ChannelBus {
  /** AgentEvent 流式广播:所有 harness 的统一事件出口(自定义协议流) */
  emit(event: AgentEvent, source: A2AMessage): void
  /** 订阅 AgentEvent 流(monitor/WS 消费);返回退订函数 */
  onEvent(fn: (event: AgentEvent, source: A2AMessage) => void): () => void
  /** 任务事件通知(状态迁移/进度变化;由 TaskEngine hooks 统一触发;task = 源头视图) */
  notifyTask(e: { taskId: string, state?: TaskState, progress?: number, agentId?: string, task?: TaskEventTask }): void
  onTaskEvent(fn: (e: { taskId: string, state?: TaskState, progress?: number, agentId?: string, task?: TaskEventTask }) => void): () => void
  /**
   * 成员状态通知(idle/busy/stopped + 队列上下文;AgentRuntime 转换处触发,事件驱动无轮询)。
   * currentTaskId/currentTaskTitle/currentTaskProgress/queuedCount/completedCount
   * 为增量字段:实时状态追踪的完整视图(lead 观察 worker 进度,防"在跑但无信号")。
   */
  notifyAgent(e: {
    agentId: string
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId?: string | null
    currentTaskTitle?: string | null
    currentTaskProgress?: number | null
    queuedCount?: number
    completedCount?: number
    /** harness 上下文用量(omp 有;进程内 harness 缺省) */
    context?: AgentContextStats | null
  }): void
  onAgentStatus(fn: (e: {
    agentId: string
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId?: string | null
    currentTaskTitle?: string | null
    currentTaskProgress?: number | null
    queuedCount?: number
    completedCount?: number
    context?: AgentContextStats | null
  }) => void): () => void
  /** channel 内消息投递通知(route 汇流点触发;AEP a2a.message 事件源) */
  notifyMessage(message: A2AMessage): void
  onMessage(fn: (message: A2AMessage) => void): () => void
  /** 团队成员增/改/删通知(lead 自主管理或用户 REST;AEP agent.member 事件源) */
  notifyMember(e: MemberChangeEvent): void
  onMemberEvent(fn: (e: MemberChangeEvent) => void): () => void
  /** 记忆写入通知(策展/主动沉淀;AEP memory.saved 事件源) */
  notifyMemory(e: { agentId: string, scope: 'private' | 'shared', title: string, dedupKey: string }): void
  onMemoryEvent(fn: (e: { agentId: string, scope: 'private' | 'shared', title: string, dedupKey: string }) => void): () => void
  wakeScheduler(): void
}

/** 团队成员变更事件(lead 执行中自主管理成员或用户 REST 操作;AEP agent.member 载荷) */
export interface MemberChangeEvent {
  op: 'added' | 'updated' | 'removed'
  agentId: string
  name: string
  role: 'lead' | 'worker'
  harness: string
  enabled?: number
  /** 实例 config(含 systemPromptPrefix 场景提示词;added/updated 时携带,removed 可空) */
  config?: Record<string, unknown>
  /** 操作发起方:'lead:<agentId>' 或 'user' */
  by: string
  reason?: string
}

/** Parts → 纯文本(text 片段拼接;记忆召回查询与回复收集共用) */
function partsToText(parts: Part[]): string {
  return parts.map(p => ('text' in p ? p.text : '')).filter(Boolean).join('\n')
}

/**
 * TaskEngine 结构契约(实现方 T4 task-engine.ts,同步签名)。
 * 以接口而非具体类声明依赖,便于测试注入 fake 与集成装配真实引擎。
 */
export interface TaskEngine {
  create(input: {
    channelId: string
    creatorId: string
    assigneeId: string
    title: string
    description?: string
    parentId?: string
    parts?: Part[]
  }): WorkspaceTask
  dispatch(
    parent: WorkspaceTask,
    input: { assigneeId: string, title: string, description?: string, parts?: Part[], routeReason?: string },
  ): WorkspaceTask
  transition(taskId: string, state: TaskState, by: string): WorkspaceTask
  applyEvent(taskId: string, event: AgentEvent): void
  list(channelId: string): WorkspaceTask[]
  get(taskId: string): WorkspaceTask | undefined
  complete(taskId: string, artifacts?: A2AArtifact[]): WorkspaceTask
  reassign(taskId: string, toAgentId: string): WorkspaceTask
  /** 修改待执行任务(title/description)+ 刷新 assignee 队列投递 */
  updateTask(taskId: string, patch: { title?: string, description?: string }, by: string): WorkspaceTask
  cancel(taskId: string, by: string): WorkspaceTask
  onChildCompleted(child: WorkspaceTask): void
  /** 断线重连重投:非终态任务无 pending assign 时向 assignee 重发(restore 用) */
  redeliverAssign(taskId: string): WorkspaceTask
  /** 单 agent 任务队列视图(待执行 FIFO / 执行中 / 已完成) */
  queueViewOf(channelId: string, agentId: string): AgentTaskQueueView
  /** 批量队列视图(一次查询聚合全 channel;调度快照热路径) */
  queueViewsOf(channelId: string): Map<string, AgentTaskQueueView>
}

/**
 * AgentRuntime 的结构契约(ChannelRuntime/SchedulerLoop 消费的最小接口)。
 */
export interface AgentRuntimeLike {
  readonly agentId: string
  readonly role: 'lead' | 'worker'
  readonly channelId: string
  readonly name: string
  enqueue(message: A2AMessage): void
  getState(): 'idle' | 'busy' | 'stopped'
  /** 实时状态视图(idle/busy/stopped + 当前任务 + 队列长度) */
  getStatus(): AgentStatusView
  /** 本 agent 的任务队列视图(待执行 FIFO / 执行中 / 已完成) */
  getQueueView(): AgentTaskQueueView
  abortCurrent(): void
  wakeMailbox(): void
  stop(): Promise<void>
  /** 平台侧合成事件出口(如 SchedulerLoop 汇总成果);转发 ChannelBus.emit 走统一事件流 */
  emitExternal(event: AgentEvent, fromAgentId?: string): void
  /** 实时消息注入:busy 时通过 impl.steer 注入 omp 会话;idle 时入 mailbox 队列 */
  injectSteer(message: A2AMessage): void
  /** Agent 能力面(调度器执行成员管理决策用;AgentRuntime 始终提供) */
  readonly workspace?: AgentWorkspace
}

export class AgentRuntime {
  readonly agentId: string
  readonly role: 'lead' | 'worker'
  readonly channelId: string
  readonly name: string
  private state: 'idle' | 'busy' | 'stopped' = 'idle'
  /** 回合失败重投计数(每消息;进程内存,重启由 resetConsuming 重新给机会) */
  private runErrorRetries = new Map<string, number>()
  /** 正在执行的任务 id(run 期间;空闲时 null) */
  private currentTaskId: string | null = null
  /** poll_messages 阻塞等待数(waitPending 活动计数;>0 = 有轮询在等,实时消息留信箱由其取走) */
  private pollWaiters = 0
  /** run 与 supervise 互斥锁(promise 链) */
  private execLock: Promise<void> = Promise.resolve()
  private abortController: AbortController | null = null
  private loopPromise: Promise<void> | null = null
  private started = false

  constructor(
    agent: AgentInfo,
    private impl: AgentInterface,
    private deps: {
      mailbox: Mailbox
      taskEngine: TaskEngine
      bus: ChannelBus
      workspace: AgentWorkspace
      memory?: AgentMemory
    },
  ) {
    this.agentId = agent.id
    this.role = agent.role
    this.channelId = agent.channelId
    this.name = agent.name
  }

  /** 投递消息;idle 时立即唤醒消费 */
  enqueue(message: A2AMessage): void {
    this.deps.mailbox.enqueue(message)
  }

  getState(): 'idle' | 'busy' | 'stopped' {
    return this.state
  }

  /** 实时状态视图:idle/busy/stopped + 当前任务 + 队列 + harness 上下文用量 */
  getStatus(): AgentStatusView {
    const queue = this.getQueueView()
    const current = queue.current ?? (this.currentTaskId ? this.deps.taskEngine.get(this.currentTaskId) : undefined)
    const context = this.impl.getContextStats?.() ?? undefined
    return {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      name: this.name,
      state: this.state,
      currentTaskId: current?.id ?? null,
      // 进度/标题透出:lead 观察 worker 是否在推进(progress 空闲/未上报时为 null)
      currentTaskTitle: current?.title ?? null,
      currentTaskProgress: current?.progress != null ? current.progress : null,
      queuedCount: queue.queued.length,
      completedCount: queue.completed.length,
      ...(context ? { context } : {}),
    }
  }

  /** 本 agent 的任务队列视图(自己的任务管理系统:待执行 FIFO / 执行中 / 已完成) */
  getQueueView(): AgentTaskQueueView {
    return this.deps.taskEngine.queueViewOf(this.channelId, this.agentId)
  }

  /** 中止当前 run(任务取消/Agent 移除时);空闲时无操作 */
  abortCurrent(): void {
    log.warn(`[AgentRuntime:${this.agentId}] abortCurrent 调用(state=${this.state})`)
    this.abortController?.abort()
    // supervise 回合同样可打断(调度器 cancel 路径 → LLM 回合真中止)
    this.superviseController?.abort()
  }

  emitExternal(event: AgentEvent, fromAgentId?: string): void {
    // 合成 source(monitor 依 metadata 归属 agent);平台侧产出与 harness 事件同流
    const source: A2AMessage = {
      messageId: randomUUID(),
      contextId: this.channelId,
      role: 'ROLE_AGENT',
      parts: [],
      metadata: { 'x-aw-from-agent': fromAgentId ?? this.agentId },
    }
    this.deps.bus.emit(event, source)
  }

  /**
   * 实时注入策略(信箱优先,与主动轮询完全兼容):
   *  - poll_messages 等待中:任何实时消息留在 pending —— 等待中的轮询经 Mailbox
   *    到信回调毫秒级取走(读即取=已读),零打断、不与轮询竞争唯一所有权
   *  - agent 间协作消息(from-agent):同样走信箱 —— turn 结束后消费循环按 peer
   *    回合处理(require_reply 触发语义/回执关联完整)。steer 注入 omp 会话会让
   *    其把排队消息后的工具调用标记 "Skipped due to queued user message",
   *    中断 poll_messages 长等待并污染执行流(实测故障源)
   *  - 仅人类紧急直发(immediate + from-label,无 from-agent)保留 steer 同轮注入:
   *    紧急人工打断是唯一值得中断会话的场景
   */
  injectSteer(message: A2AMessage): void {
    if (this.state !== 'busy' || !this.impl.steer) return
    // ① 轮询等待中:留 pending 给 poll_messages(毫秒级取走并标记已读)
    if (this.pollWaiters > 0) return
    // ② agent 间协作消息:信箱优先(turn 结束 peer 回合处理)
    const from = message.metadata?.['x-aw-from-agent']
    if (typeof from === 'string' && from.length > 0) return
    // ③ 其余(人类紧急直发):原有 steer 注入路径
    if (!this.deps.mailbox.claim(message.messageId)) return
    const text = message.parts
      .map((p) => {
        if ('text' in p) return p.text
        if ('data' in p) return JSON.stringify(p.data)
        return ''
      })
      .join('\n')
    const fromId = (message.metadata?.['x-aw-from-agent'] as string | undefined) ?? 'system'
    const lines = [`[实时消息 from ${fromId}]: ${text}`]
    if (message.metadata?.['x-aw-require-reply'] === 'true') {
      lines.push(
        `[系统触发器] 本消息要求回复(reply_to=${message.messageId})。`,
        `请处理消息中的需求,随后用 send_message_to_agent 回复发送者 ${fromId}:`,
        `参数 message=执行结果+对方所需内容, in_reply_to=${message.messageId},`,
        `require_reply=仅当你还需要对方进一步响应时才设 true。`,
      )
    }
    this.impl.steer(lines.join('\n'))
      .then((mode) => {
        if (mode === 'steer') {
          // 确认注入流式会话 → 消费落定(at-least-once:进程崩溃由 resetConsuming 兜底)
          this.deps.mailbox.markConsumed(message.messageId)
        }
        else {
          // deferred:释放认领回 pending,poll_messages(250ms 兜底重查)或
          // 本回合结束后的消费循环(FIFO)接管,消息必达不丢失
          this.releaseSteerClaim(message.messageId)
        }
      })
      .catch((err) => {
        log.error(`[AgentRuntime:${this.agentId}] steer 失败(释放认领回 pending 待循环处理):`, err)
        this.releaseSteerClaim(message.messageId)
      })
  }

  /** 释放 steer 认领:consuming → pending + 唤醒 dequeue 门闩与到信等待方 */
  private releaseSteerClaim(messageId: string): void {
    if (this.deps.mailbox.requeue(messageId)) {
      this.deps.mailbox.wake()
    }
  }

  /**
   * 长轮询未消费消息(poll_messages host 工具用):
   * 250ms 兜底重查 + Mailbox 到信回调即时唤醒——消息到达后毫秒级返回,
   * 不再每秒盲查。不改消息状态(peek 只读);消费语义由调用方(poll 读即取)决定。
   * pollWaiters 计数暴露"轮询等待中"状态:injectSteer 据此把实时消息留在信箱
   * 由本方法取走(不打断会话、与主动轮询兼容)。
   */
  async waitPending(limit: number, waitMs: number): Promise<A2AMessage[]> {
    this.pollWaiters += 1
    try {
      const deadline = Date.now() + Math.max(0, waitMs)
      for (;;) {
        const msgs = await this.deps.mailbox.peek(limit)
        if (msgs.length > 0 || Date.now() >= deadline) return msgs
        const { promise, resolve } = Promise.withResolvers<unknown>()
        const off = this.deps.mailbox.onArrival(() => resolve(undefined))
        const timer = setTimeout(() => resolve(undefined), 250)
        await promise
        clearTimeout(timer)
        off()
      }
    }
    finally {
      this.pollWaiters -= 1
    }
  }

  /** 启动消费循环 */
  start(): void {
    if (this.started) return
    this.started = true
    this.state = 'idle'
    this.loopPromise = this.consumeLoop()
  }

  /** 停止:中断当前 run + 等当前事件流结束 + dispose impl(杀子进程等) */
  async stop(): Promise<void> {
    log.warn(`[AgentRuntime:${this.agentId}] runtime.stop() 调用(卸载/停用)`)
    this.state = 'stopped'
    this.abortController?.abort()
    this.deps.mailbox.close()
    // 状态广播:前端经 WS agent.status 实时反映 stopped
    this.deps.bus.notifyAgent({ agentId: this.agentId, state: 'stopped', ...this.queueContext() })
    await this.loopPromise
    // 清理 impl 持有的资源(omp 子进程等);容错:impl.dispose 可能不存在
    try {
      await this.impl.dispose?.()
    }
    catch (err) {
      log.error(`[AgentRuntime:${this.agentId}] dispose 失败:`, err)
    }
  }

  /** 唤醒 mailbox(供 manager 在 taskEngine 直接落库投递后唤醒消费) */
  wakeMailbox(): void {
    this.deps.mailbox.wake()
  }

  /**
   * 状态重广播:调度器收口(complete/cancel 等不经 processMessage 的终态迁移)
   * 直接改动了本 agent 的队列上下文(current/completed),重新广播 agent.status,
   * 前端实时反映 lead 判定完成后的最新状态(不刷新即可见)。
   */
  refreshStatus(): void {
    this.deps.bus.notifyAgent({ agentId: this.agentId, state: this.state, ...this.queueContext() })
  }

  /** harness 进程资源信息(运行时资源监控;进程内 harness 无外部进程 → null) */
  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    return this.impl.getProcessInfo?.() ?? null
  }

  /**
   * 强制终止 harness 进程(不等优雅退出)。
   * 调用方(manager terminateRuntimeProcess)终止后随即 stop 本运行时。
   */
  killProcess(): void {
    this.impl.killProcess?.()
  }

  /** harness 进程存活校准(manager sweeper 周期性调用;休眠/强杀后校准 alive 失真;异常不抛出) */
  reconcileProcess(): void {
    try {
      this.impl.reconcileProcess?.()
    }
    catch (err) {
      log.error(`[AgentRuntime:${this.agentId}] 进程存活校准失败:`, err)
    }
  }

  /** 暴露 TaskEngine(供 SchedulerLoop 收集快照与执行调度决策) */
  get taskEngine(): TaskEngine {
    return this.deps.taskEngine
  }

  /** 暴露 AgentWorkspace(供 SchedulerLoop 执行 lead 成员管理决策) */
  get workspace(): AgentWorkspace {
    return this.deps.workspace
  }

  /**
   * lead 调度决策(供 SchedulerLoop 调用):转发 impl.supervise。
   * 未实现 supervise 时返回 null(调用方回退内置规则引擎);
   * 与 run 的互斥由调用方通过 withExecLock 保证。
   */
  /** 当前 supervise 回合的控制器(abortCurrent 经此打断 LLM 调度回合) */
  private superviseController: AbortController | null = null

  async supervise(snapshot: SupervisionSnapshot): Promise<SupervisionDecision[] | null> {
    if (!this.impl.supervise) return null
    // lead 调度记忆:非终态/失败任务标题 + 成员名构造查询;touch:false 防 tick 通胀
    let memoryBlock: string | undefined
    try {
      const query = [
        ...snapshot.tasks.filter(t => t.state === 'SUBMITTED' || t.state === 'FAILED' || t.state === 'WAITING').map(t => t.title),
        ...snapshot.members.map(m => m.name),
      ].join(' ')
      memoryBlock = (await this.deps.memory?.recall(query, { touch: false })) ?? undefined
    }
    catch (err) {
      log.error(`[AgentRuntime:${this.agentId}] supervise 记忆召回失败:`, err)
    }
    const controller = new AbortController()
    this.superviseController = controller
    const ctx: AgentRunContext = {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      workspace: this.deps.workspace,
      signal: controller.signal,
      memory: memoryBlock,
    }
    try {
      return await this.impl.supervise(snapshot, ctx, { signal: controller.signal })
    }
    finally {
      if (this.superviseController === controller) this.superviseController = null
      // 调度回合落定:lead 的 supervise 是上下文膨胀大户,同样走 post-settle 压缩检查
      this.maybePostSettle()
    }
  }

  /**
   * 平台侧任务记忆沉淀(调度器直接执行决策的收口路径):
   * lead 经 supervise 决策 complete/cancel 任务时不经过 processMessage,
   * 由 SchedulerLoop 调用此方法补齐终态 harvest(与 worker 路径同源)。
   */
  async recordTaskMemory(task: WorkspaceTask): Promise<void> {
    await this.deps.memory?.recordTaskOutcome(task)
  }

  /** run/supervise 互斥执行(promise 链;供消费循环与 SchedulerLoop 串行化) */
  withExecLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.execLock
    let release!: () => void
    this.execLock = new Promise<void>((r) => {
      release = r
    })
    return (async () => {
      await prev
      try {
        return await fn()
      }
      finally {
        release()
      }
    })()
  }

  /** 消费循环:空闲自动接取,执行中不打断 */
  private async consumeLoop(): Promise<void> {
    while (this.state !== 'stopped') {
      const msg = await this.deps.mailbox.dequeue()
      if (this.getState() === 'stopped' || msg === null) break
      // 单条 run 抛错不阻塞下一条
      try {
        await this.withExecLock(() => this.processMessage(msg))
      }
      catch (err) {
        log.error(`[AgentRuntime:${this.agentId}] run 失败:`, err)
      }
    }
  }

  private async processMessage(msg: A2AMessage): Promise<void> {
    const taskId = this.taskIdOf(msg)
    // 过期任务投递检查:任务已终态(cancel/reassign 后残留的旧 assign)→ 跳过执行,
    // 否则 worker 会对着已取消任务的旧投递真的跑一轮 harness。
    if (msg.metadata?.['x-aw-task-kind'] === 'assign' && taskId) {
      const task = this.deps.taskEngine.get(taskId)
      if (!task || TERMINAL_TASK_STATES[task.state]) {
        this.deps.mailbox.markConsumed(msg.messageId)
        return
      }
    }
    this.state = 'busy'
    this.currentTaskId = taskId ?? null
    this.deps.bus.notifyAgent({ agentId: this.agentId, state: 'busy', ...this.queueContext() })
    // 回合失败标记(须在 try 外声明,finally 依据它决定重投还是消费)
    let sawRunError = false
    try {
      // 任务消息联动:assign → WORKING(自动接取;状态事件由 TaskEngine transition hooks 广播)
      // 仅 SUBMITTED/ASSIGNED 自动接取:WAITING(已有子任务)的任务由 SchedulerLoop/子任务汇总推进,
      // 此处不得把父任务从 WAITING 翻回 WORKING(否则父任务在子任务执行期间虚挂 WORKING,
      // 会被 stall 检测误判为停滞而 cancel)。
      if (msg.metadata?.['x-aw-task-kind'] === 'assign' && taskId) {
        const task = this.deps.taskEngine.get(taskId)
        if (task && (task.state === 'SUBMITTED' || task.state === 'ASSIGNED')) {
          await this.deps.taskEngine.transition(taskId, 'WORKING', this.agentId)
        }
      }
      // 每次 run 新建 AbortController;abort 后事件流终止
      this.abortController = new AbortController()
      // 记忆召回(异常不阻塞):查询=消息原文(title 首词天然显著)+ 任务关联加权
      let memoryBlock: string | undefined
      try {
        memoryBlock = (await this.deps.memory?.recall(partsToText(msg.parts), {
          relatedTaskIds: this.relatedTaskIdsOf(taskId),
        })) ?? undefined
      }
      catch (err) {
        log.error(`[AgentRuntime:${this.agentId}] 记忆召回失败:`, err)
      }
      const request: AgentRunRequest = this.toRequest(msg, memoryBlock)
      const ctx: AgentRunContext = {
        agentId: this.agentId,
        channelId: msg.contextId,
        role: this.role,
        workspace: this.deps.workspace,
        signal: this.abortController.signal,
      }
      // 补入产出者 agentId(monitor 据此归属事件;不改原 msg,用浅拷贝)
      const enrichedSource = { ...msg, metadata: { ...msg.metadata, 'x-aw-producing-agent': this.agentId } }
      // 回复文本收集(V9:omp 不产 message 事件,聚合三类源——message 事件 / status.message / 终态 artifact 'output')
      let replyText = ''
      const cap = (text: string): void => {
        if (replyText.length < 400) replyText += text.slice(0, 400 - replyText.length)
      }
      try {
        for await (const event of this.impl.run(request, ctx)) {
          this.deps.bus.emit(event, enrichedSource)
          // LLM 流式增量:只走事件流(AEP agent.delta),不进任务引擎/交付兜底管道
          if (event.kind === 'delta') continue
          if (event.kind === 'error') sawRunError = true
          if (taskId) await this.deps.taskEngine.applyEvent(taskId, event)
          if (event.kind === 'message') cap(partsToText(event.message.parts))
          else if (event.kind === 'status' && event.status.message) cap(partsToText(event.status.message.parts))
          else if (event.kind === 'artifact' && event.artifact.name === 'output') cap(partsToText(event.artifact.parts))
        }
      }
      catch (err) {
        // run 生成器抛错(如 omp 子进程 spawn 失败):按回合失败走重投,不外抛断循环
        sawRunError = true
        log.error(`[AgentRuntime:${this.agentId}] 回合异常:`, err)
      }
      // 交付兜底(harness 回合结束 ≠ 任务完成):
      //  - 回合产出过实质 artifact(LLM 完成了工作但跳过 complete_task 工具)→ 隐式完成,
      //    交付物即回合规避的输出,平台代为收口(进度 100)。
      //  - 无任何产出(LLM 空转)→ FAILED 交给调度器 retry/reassign。
      // 仅 worker 的 assign 执行消息生效:lead 由 supervise 协调;WAITING 父任务不属此列。
      if (taskId && this.role === 'worker' && msg.metadata?.['x-aw-task-kind'] === 'assign') {
        const after = this.deps.taskEngine.get(taskId)
        if (after && after.assigneeId === this.agentId && after.state === 'WORKING') {
          const deliverable = after.artifacts.find(a => a.name !== 'input' && a.parts.some(p => ('text' in p ? p.text.trim().length : 1) > 0))
          if (deliverable) {
            const completed = await this.deps.taskEngine.complete(taskId)
            this.emitExternal({
              kind: 'status',
              status: {
                state: 'COMPLETED',
                message: {
                  messageId: randomUUID(),
                  contextId: this.channelId,
                  role: 'ROLE_AGENT',
                  parts: [{ text: `任务 ${taskId} 回合已产出交付物但未调用完成工具,平台隐式收口为 COMPLETED` }],
                },
                timestamp: new Date().toISOString(),
              },
            })
            // 子任务隐式完成 → 通知父任务(lead 汇总/WAITING→WORKING 接续):
            // 与 manager.completeTask 的显式收口同构,否则父任务 WAITING 永挂
            // (无 child-completed 事件、父任务不翻转,lead 无感知)。
            if (completed.parentId) {
              this.deps.taskEngine.onChildCompleted(completed)
              const parent = this.deps.taskEngine.get(completed.parentId)
              if (parent) this.deps.bus.wakeScheduler()
            }
          }
          else {
            await this.deps.taskEngine.transition(taskId, 'FAILED', this.agentId)
            this.emitExternal({
              kind: 'status',
              status: {
                state: 'FAILED',
                message: {
                  messageId: randomUUID(),
                  contextId: this.channelId,
                  role: 'ROLE_AGENT',
                  parts: [{ text: `任务 ${taskId} 执行结束但无交付(harness 回合结束未产出),标记 FAILED 待重试` }],
                },
                timestamp: new Date().toISOString(),
              },
            })
          }
        }
      }

      // 记忆沉淀:终态任务 harvest;无 taskId 的点对点消息记协作(异常不阻塞)
      if (this.deps.memory) {
        try {
          const task = taskId ? this.deps.taskEngine.get(taskId) : undefined
          if (task && TERMINAL_TASK_STATES[task.state]) {
            await this.deps.memory.recordTaskOutcome(task)
          }
          else if (!taskId) {
            const fromAgentId = (msg.metadata?.['x-aw-from-agent'] as string | undefined) ?? null
            if (fromAgentId) await this.deps.memory.recordPeerExchange(msg, replyText)
          }
        }
        catch (err) {
          log.error(`[AgentRuntime:${this.agentId}] 记忆写入失败:`, err)
        }
      }
    }
    finally {
      this.abortController = null
      this.currentTaskId = null
      if (this.state === 'busy') {
        this.state = 'idle'
        this.deps.bus.notifyAgent({ agentId: this.agentId, state: 'idle', ...this.queueContext() })
      }
      // 回合失败(harness 错误/停滞看门狗中止/子进程异常):重投消息而非静默消费,
      // 内容不丢,重试回合(通常已是全新子进程)再处理;每消息最多重投 2 次防毒消息死循环。
      // 任务已终态(取消/收口后 abort 让回合报错)则不再重投 —— 消息依任务终态
      // 由调度器 reassign/新 assign 驱动,重投只会空转(启动即被终态检查消费)。
      const taskNow = taskId ? this.deps.taskEngine.get(taskId) : undefined
      const taskDone = !!taskNow && TERMINAL_TASK_STATES[taskNow.state]
      if (sawRunError && !taskDone && (this.runErrorRetries.get(msg.messageId) ?? 0) < 2
        && this.deps.mailbox.requeue(msg.messageId)) {
        const attempt = (this.runErrorRetries.get(msg.messageId) ?? 0) + 1
        this.runErrorRetries.set(msg.messageId, attempt)
        this.emitExternal({
          kind: 'status',
          status: {
            state: 'WORKING',
            message: {
              messageId: randomUUID(),
              contextId: this.channelId,
              role: 'ROLE_AGENT',
              parts: [{ text: `消息 ${msg.messageId.slice(0, 8)} 回合失败,已重投信箱待重试(第 ${attempt} 次)` }],
            },
            timestamp: new Date().toISOString(),
          },
        })
      }
      else {
        this.runErrorRetries.delete(msg.messageId)
        this.deps.mailbox.markConsumed(msg.messageId)
      }
      // 回合落定:信箱空 → 后台压缩检查(post-settle 路径;impl 自守卫不阻塞)
      this.maybePostSettle()
    }
  }

  /** 状态通知的队列上下文(实时:当前任务/待执行数/已完成数/harness 上下文用量) */
  private queueContext(): Pick<AgentStatusView, 'currentTaskId' | 'currentTaskTitle' | 'currentTaskProgress' | 'queuedCount' | 'completedCount'> & { context?: AgentContextStats | null } {
    const status = this.getStatus()
    return {
      currentTaskId: status.currentTaskId,
      currentTaskTitle: status.currentTaskTitle,
      currentTaskProgress: status.currentTaskProgress,
      queuedCount: status.queuedCount,
      completedCount: status.completedCount,
      context: status.context ?? null,
    }
  }

  /**
   * 任务关联集(自身+父+兄弟,≤20):related-task boost 数据源。
   * 同父兄弟任务的记忆(前几个子任务做了什么)在引子中必然置顶——
   * 纯内存 id 判断,零检索开销。
   */
  private relatedTaskIdsOf(taskId: string | undefined): string[] | undefined {
    if (!taskId) return undefined
    const task = this.deps.taskEngine.get(taskId)
    if (!task) return undefined
    const ids = new Set<string>([taskId])
    if (task.parentId) {
      ids.add(task.parentId)
      for (const t of this.deps.taskEngine.list(this.channelId)) {
        if (t.parentId === task.parentId) ids.add(t.id)
        if (ids.size >= 20) break
      }
    }
    return [...ids]
  }

  /**
   * post-settle 压缩检查:仅信箱无排队消息时触发(排队消息的 pre-prompt gate 兜底)。
   * impl 自守卫(回合间隙才压缩、异常不抛出);本方法自身也不阻塞消费循环。
   */
  private maybePostSettle(): void {
    if (!this.impl.onTurnSettled) return
    void this.deps.mailbox.peek(1)
      .then((pending) => {
        if (pending.length > 0) return undefined
        return this.impl.onTurnSettled?.()
      })
      .catch(() => {})
  }

  private toRequest(msg: A2AMessage, memory?: string): AgentRunRequest {
    return {
      message: msg,
      taskId: msg.taskId,
      contextId: msg.contextId,
      fromAgentId: (msg.metadata?.['x-aw-from-agent'] as string | undefined) ?? null,
      toAgentId: this.agentId,
      memory,
    }
  }

  private taskIdOf(msg: A2AMessage): string | undefined {
    return msg.taskId ?? (msg.metadata?.['x-aw-task-id'] as string | undefined)
  }
}
