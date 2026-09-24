/**
 * AgentRuntime 的依赖类型与对外 DTO(原 server/services/workshop/runtime/agent-runtime.ts 顶部模块级类型声明)。纯类型。
 */
import type { A2AArtifact, A2AMessage, Part } from '../../types/a2a'
import type { AgentContextStats, AgentStatusView, AgentTaskQueueView, TaskState, WorkspaceTask } from '../../types/task'
import type { AgentEvent, AgentWorkspace } from '../../agents/agent-interface'

export interface TaskEventTask {
  id: string
  title?: string
  parentId?: string
  assigneeId?: string
  progress?: number | null
  routeReason?: string
  closeReason?: string
  deadlineAt?: string
  retryCount?: number
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
  /**
   * v17 群聊事件通知(chat.message / chat.delivery.status / chat.member / chat.settings)。
   * 群聊事件**必须**走 channel 流(publish → seq/环形缓冲/落库/重放),
   * 因此这里只做"投递到频道总线",不涉及用户定向 —— 用户定向通知走 user-notification-hub。
   */
  notifyChat?(e: { type: string, payload: unknown }): void
  onChatEvent?(fn: (e: { type: string, payload: unknown }) => void): () => void
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
export interface TaskEngine {
  create(input: {
    channelId: string
    creatorId: string
    assigneeId: string
    title: string
    description?: string
    parentId?: string
    parts?: Part[]
    sourceChatMessageId?: string
    sourceChatDeliveryId?: string
    closeReason?: string
    deadlineAt?: string
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
  cancel(taskId: string, by: string, reason?: string): WorkspaceTask
  cancelTree(taskId: string, by: string, reason?: string): WorkspaceTask[]
  timeoutTree(taskId: string, by: string): WorkspaceTask[]
  onChildCompleted(child: WorkspaceTask): void
  /** 断线重连重投:非终态任务无 pending assign 时向 assignee 重发(restore 用) */
  redeliverAssign(taskId: string): WorkspaceTask
  /** 单 agent 任务队列视图(待执行 FIFO / 执行中 / 已完成) */
  queueViewOf(channelId: string, agentId: string): AgentTaskQueueView
  /** 批量队列视图(一次查询聚合全 channel;调度快照热路径) */
  queueViewsOf(channelId: string): Map<string, AgentTaskQueueView>
  /** 批量队列视图 lite 版(元数据投影,免 artifacts/history 大列解析;调度快照热路径) */
  queueViewsOfLite(channelId: string): Map<string, AgentTaskQueueView>
  /** 任务列表 lite 版(元数据投影;调度决策/规则引擎仅消费 id/state/parent/进度/标题) */
  listLite(channelId: string): WorkspaceTask[]
  /** 调度监督快照(轻量元数据 + 有界已完成 worker 交付物)。 */
  listForSupervision(channelId: string, leadAgentId: string): WorkspaceTask[]
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
  /** 仅中止仍在执行指定任务的当前 run;不影响其它任务或 supervise 回合 */
  abortTask?(taskId: string): boolean
  wakeMailbox(): void
  stop(): Promise<void>
  /** 平台侧合成事件出口(如 SchedulerLoop 汇总成果);转发 ChannelBus.emit 走统一事件流 */
  emitExternal(event: AgentEvent, fromAgentId?: string): void
  /** 实时消息注入:busy 时通过 impl.steer 注入 omp 会话;idle 时入 mailbox 队列 */
  injectSteer(message: A2AMessage): void
  /** Agent 能力面(调度器执行成员管理决策用;AgentRuntime 始终提供) */
  readonly workspace?: AgentWorkspace
}
