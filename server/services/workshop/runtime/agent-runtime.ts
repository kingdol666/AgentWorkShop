/**
 * AgentRuntime — Agent 独立运行时对象。
 * 状态机 idle/busy/stopped + 消费循环(自动接取/自动作业)+ run/supervise 互斥 + abort。
 * 任务管理系统:每个运行时对自己的任务队列(待执行 FIFO / 执行中 / 已完成)有完整视图;
 * 队列是 tasks 表的派生投影(DB 唯一事实源),状态迁移实时广播(idle/busy + 队列上下文)。
 */
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
import type { AgentStatusView, AgentTaskQueueView, TaskState, WorkspaceTask } from '../types/task'
import { TERMINAL_TASK_STATES } from '../types/task'
import type { AgentMemory } from './memory'
import type { Mailbox } from './mailbox'

/** ChannelBus:运行时事件总线(逐事件广播 + 任务/成员事件通知 + 调度唤醒) */
export interface ChannelBus {
  /** AgentEvent 流式广播:所有 harness 的统一事件出口(自定义协议流) */
  emit(event: AgentEvent, source: A2AMessage): void
  /** 订阅 AgentEvent 流(monitor/WS 消费);返回退订函数 */
  onEvent(fn: (event: AgentEvent, source: A2AMessage) => void): () => void
  /** 任务事件通知(状态迁移/进度变化;由 TaskEngine hooks 统一触发) */
  notifyTask(e: { taskId: string, state?: TaskState, progress?: number, agentId?: string }): void
  onTaskEvent(fn: (e: { taskId: string, state?: TaskState, progress?: number }) => void): () => void
  /**
   * 成员状态通知(idle/busy/stopped + 队列上下文;AgentRuntime 转换处触发,事件驱动无轮询)。
   * currentTaskId/queuedCount/completedCount 为增量字段:实时状态追踪的完整视图。
   */
  notifyAgent(e: {
    agentId: string
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId?: string | null
    queuedCount?: number
    completedCount?: number
  }): void
  onAgentStatus(fn: (e: {
    agentId: string
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId?: string | null
    queuedCount?: number
    completedCount?: number
  }) => void): () => void
  wakeScheduler(): void
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
    input: { assigneeId: string, title: string, description?: string, parts?: Part[] },
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
}

export class AgentRuntime {
  readonly agentId: string
  readonly role: 'lead' | 'worker'
  readonly channelId: string
  readonly name: string
  private state: 'idle' | 'busy' | 'stopped' = 'idle'
  /** 正在执行的任务 id(run 期间;空闲时 null) */
  private currentTaskId: string | null = null
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

  /** 实时状态视图:idle/busy/stopped + 当前任务 + 队列上下文(实时追踪的单一入口) */
  getStatus(): AgentStatusView {
    const queue = this.getQueueView()
    return {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      name: this.name,
      state: this.state,
      currentTaskId: queue.current?.id ?? this.currentTaskId,
      queuedCount: queue.queued.length,
      completedCount: queue.completed.length,
    }
  }

  /** 本 agent 的任务队列视图(自己的任务管理系统:待执行 FIFO / 执行中 / 已完成) */
  getQueueView(): AgentTaskQueueView {
    return this.deps.taskEngine.queueViewOf(this.channelId, this.agentId)
  }

  /** 中止当前 run(任务取消/Agent 移除时);空闲时无操作 */
  abortCurrent(): void {
    this.abortController?.abort()
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
   * 实时消息注入:busy 时通过 impl.steer 注入 omp 会话;idle 时入 mailbox 队列。
   * 触发器语义:metadata['x-aw-require-reply']='true' 时,注入文本携带回执指令——
   * 接收方须把执行结果与对方所需内容经 send_message_to_agent 回给发送者,
   * 并以 x-aw-in-reply-to 关联原消息、自带 x-aw-require-reply 声明是否需再响应。
   */
  injectSteer(message: A2AMessage): void {
    if (this.state === 'busy' && this.impl.steer) {
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
      this.impl.steer(lines.join('\n')).catch((err) => {
        console.error(`[AgentRuntime:${this.agentId}] steer 失败:`, err)
      })
    }
    else {
      // idle/stopped 或 impl 不支持 steer → 落入 mailbox 作为消息(FIFO 消费)
      this.enqueue(message)
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
    this.state = 'stopped'
    this.abortController?.abort()
    this.deps.mailbox.close()
    await this.loopPromise
    // 清理 impl 持有的资源(omp 子进程等);容错:impl.dispose 可能不存在
    try {
      await this.impl.dispose?.()
    }
    catch (err) {
      console.error(`[AgentRuntime:${this.agentId}] dispose 失败:`, err)
    }
  }

  /** 唤醒 mailbox(供 manager 在 taskEngine 直接落库投递后唤醒消费) */
  wakeMailbox(): void {
    this.deps.mailbox.wake()
  }

  /** 暴露 TaskEngine(供 SchedulerLoop 收集快照与执行调度决策) */
  get taskEngine(): TaskEngine {
    return this.deps.taskEngine
  }

  /**
   * lead 调度决策(供 SchedulerLoop 调用):转发 impl.supervise。
   * 未实现 supervise 时返回 null(调用方回退内置规则引擎);
   * 与 run 的互斥由调用方通过 withExecLock 保证。
   */
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
      console.error(`[AgentRuntime:${this.agentId}] supervise 记忆召回失败:`, err)
    }
    const ctx: AgentRunContext = {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      workspace: this.deps.workspace,
      signal: new AbortController().signal,
      memory: memoryBlock,
    }
    return this.impl.supervise(snapshot, ctx)
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
        console.error(`[AgentRuntime:${this.agentId}] run 失败:`, err)
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
      // 记忆召回(异常不阻塞)
      let memoryBlock: string | undefined
      try {
        memoryBlock = (await this.deps.memory?.recall(partsToText(msg.parts))) ?? undefined
      }
      catch (err) {
        console.error(`[AgentRuntime:${this.agentId}] 记忆召回失败:`, err)
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
      for await (const event of this.impl.run(request, ctx)) {
        this.deps.bus.emit(event, enrichedSource)
        if (taskId) await this.deps.taskEngine.applyEvent(taskId, event)
        if (event.kind === 'message') cap(partsToText(event.message.parts))
        else if (event.kind === 'status' && event.status.message) cap(partsToText(event.status.message.parts))
        else if (event.kind === 'artifact' && event.artifact.name === 'output') cap(partsToText(event.artifact.parts))
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
            await this.deps.taskEngine.complete(taskId)
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
          console.error(`[AgentRuntime:${this.agentId}] 记忆写入失败:`, err)
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
      this.deps.mailbox.markConsumed(msg.messageId)
    }
  }

  /** 状态通知的队列上下文(实时:当前任务/待执行数/已完成数) */
  private queueContext(): Pick<AgentStatusView, 'currentTaskId' | 'queuedCount' | 'completedCount'> {
    const status = this.getStatus()
    return {
      currentTaskId: status.currentTaskId,
      queuedCount: status.queuedCount,
      completedCount: status.completedCount,
    }
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
