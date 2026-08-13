/**
 * AgentRuntime — Agent 独立运行时对象。
 * 状态机 idle/busy/stopped + 消费循环(自动接取/自动作业)+ run/supervise 互斥 + abort。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T3。
 */
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
import type { TaskState, WorkspaceTask } from '../types/task'
import type { Mailbox } from './mailbox'

/** ChannelBus:运行时事件总线(逐事件广播 + 任务事件通知 + 调度唤醒) */
export interface ChannelBus {
  emit(event: AgentEvent, source: A2AMessage): void
  onTaskEvent(fn: (e: { taskId: string, state?: TaskState, progress?: number }) => void): void
  wakeScheduler(): void
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
  cancel(taskId: string, by: string): WorkspaceTask
  onChildCompleted(child: WorkspaceTask): void
}

/**
 * AgentRuntime 结构契约(ChannelRuntime 视角)。
 * 以接口声明依赖,便于路由测试注入 fake 与集成装配真实 AgentRuntime。
 */
export interface AgentRuntimeLike {
  readonly agentId: string
  readonly role: 'lead' | 'worker'
  readonly channelId: string
  readonly name: string
  enqueue(message: A2AMessage): void
  getState(): 'idle' | 'busy' | 'stopped'
  abortCurrent(): void
  wakeMailbox(): void
  stop(): Promise<void>
}

export class AgentRuntime {
  readonly agentId: string
  readonly role: 'lead' | 'worker'
  readonly channelId: string
  readonly name: string
  private state: 'idle' | 'busy' | 'stopped' = 'idle'
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

  /** 中止当前 run(任务取消/Agent 移除时);空闲时无操作 */
  abortCurrent(): void {
    this.abortController?.abort()
  }

  /** 启动消费循环 */
  start(): void {
    if (this.started) return
    this.started = true
    this.state = 'idle'
    this.loopPromise = this.consumeLoop()
  }

  /** 停止:中断当前 run + 等当前事件流结束 */
  async stop(): Promise<void> {
    this.state = 'stopped'
    this.abortController?.abort()
    this.deps.mailbox.close()
    await this.loopPromise
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
    const ctx: AgentRunContext = {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      workspace: this.deps.workspace,
      signal: new AbortController().signal,
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
    this.state = 'busy'
    try {
      // 任务消息联动:assign → WORKING(自动接取)
      if (msg.metadata?.['x-aw-task-kind'] === 'assign') {
        const taskId = msg.metadata?.['x-aw-task-id'] as string | undefined
        if (taskId) await this.deps.taskEngine.transition(taskId, 'WORKING', this.agentId)
      }
      // 每次 run 新建 AbortController;abort 后事件流终止
      this.abortController = new AbortController()
      const request: AgentRunRequest = this.toRequest(msg)
      const ctx: AgentRunContext = {
        agentId: this.agentId,
        channelId: msg.contextId,
        role: this.role,
        workspace: this.deps.workspace,
        signal: this.abortController.signal,
      }
      const taskId = this.taskIdOf(msg)
      for await (const event of this.impl.run(request, ctx)) {
        this.deps.bus.emit(event, msg)
        if (taskId) await this.deps.taskEngine.applyEvent(taskId, event)
      }
    }
    finally {
      this.abortController = null
      if (this.state === 'busy') this.state = 'idle'
      this.deps.mailbox.markConsumed(msg.messageId)
    }
  }

  private toRequest(msg: A2AMessage): AgentRunRequest {
    return {
      message: msg,
      taskId: msg.taskId,
      contextId: msg.contextId,
      fromAgentId: (msg.metadata?.['x-aw-from-agent'] as string | undefined) ?? null,
      toAgentId: this.agentId,
    }
  }

  private taskIdOf(msg: A2AMessage): string | undefined {
    return msg.taskId ?? (msg.metadata?.['x-aw-task-id'] as string | undefined)
  }
}
