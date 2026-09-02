/**
 * Agent 接口层 — harness 无关统一契约。
 * 定义 Agent 元信息、运行请求/上下文、事件流、调度快照与决策、以及所有 harness impl 必须实现的 AgentInterface。
 * 仅类型定义,无运行时逻辑;供运行时层(runtime)、调度层(scheduler)与 impl 层共同消费。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块。
 */
import type { A2AMessage, A2AArtifact, A2AError, ChannelMail, Part } from '../types/a2a'
import type { WorkspaceTask, AgentTaskQueueView, AgentStatusView, AgentContextStats } from '../types/task'

/** Agent 元信息:Channel 内成员声明(hook harness 类型与配置) */
export interface AgentInfo {
  id: string
  channelId: string
  name: string
  harness: string
  role: 'lead' | 'worker'
  config: Record<string, unknown>
  token?: string
  /** 实例启停(1 启用 / 0 禁用;模板视图无此字段) */
  enabled?: number
}

/** 运行请求:平台向 Agent 投递的一次消息输入 */
export interface AgentRunRequest {
  /** A2A 消息;任务类消息携带 taskId + metadata['x-aw-task-kind'] */
  message: A2AMessage
  taskId?: string
  /** = channelId */
  contextId: string
  fromAgentId: string | null
  toAgentId: string | null
  /** 平台记忆系统装配的历史上下文块(可选;harness 自主决定是否注入 prompt) */
  memory?: string
}

/** Agent 自主作业能力面(MCP 工具子集,进程内直调) */
export interface AgentWorkspace {
  /** 列出本 Channel 同事 */
  listAgents(): Promise<AgentInfo[]>
  /** 任务分发(仅 lead;创建子任务并指派) */
  dispatchTask(input: { parentTaskId?: string, assigneeId: string, title: string, description?: string, parts?: Part[], routeReason?: string }): Promise<WorkspaceTask>
  /** 查看同 Channel 任务列表(含同事) */
  listTasks(): Promise<WorkspaceTask[]>
  /** 查看指定任务详情 */
  getTask(taskId: string): Promise<WorkspaceTask>
  /** 上报进度/成果 */
  reportTask(input: { taskId: string, progress?: number, artifact?: A2AArtifact, message?: string }): Promise<WorkspaceTask>
  /** 完成任务 */
  completeTask(taskId: string, artifacts?: A2AArtifact[]): Promise<WorkspaceTask>
  /** 查看自己的任务队列(待执行 FIFO / 执行中 / 已完成)——每个 agent 自己的任务管理系统 */
  myQueue(): Promise<AgentTaskQueueView>
  /** (lead)全员状态 + 队列总览:统一调度与最优调配的观察面 */
  queueOverview(): Promise<AgentStatusView[]>
  /** (lead/creator)修改待执行任务(title/description;执行中/终态拒绝) */
  updateTask(taskId: string, patch: { title?: string, description?: string }): Promise<WorkspaceTask>
  /** (lead)重新指派任务:待执行(SUBMITTED/ASSIGNED)或 FAILED 可调配到其他 worker */
  reassignTask(taskId: string, toAgentId: string): Promise<WorkspaceTask>
  /** 取消任务 */
  cancelTask(taskId: string): Promise<WorkspaceTask>
  /** 点对点发消息给同事 */
  sendMessage(input: { toAgentId: string, parts: Part[], metadata?: Record<string, unknown> }): Promise<A2AMessage>
  /**
   * (仅 lead)跨 Channel 点对点:直投目标 channel 的 lead mailbox(沿用 mailbox/route 机制)。
   * 权限:发送方必须是本 channel 的 lead;目标 channel 与本 channel 须同主且启用、有 lead。
   */
  sendCrossChannelMessage(input: { toChannelId: string, parts: Part[], requireReply?: boolean, inReplyTo?: string }): Promise<{
    messageId: string
    toChannelId: string
    toChannelName: string
    toLeadAgentId: string
  }>
  /**
   * 拒绝指派给自己的任务(能力/范畴不匹配):任务置 FAILED(调度器改派他人),
   * 并向派发方(任务创建者,缺省 channel lead)回执拒绝原因。
   */
  refuseTask(taskId: string, reason: string): Promise<{ task: WorkspaceTask, notifiedTo: string | null }>
  /** 拉取自己 mailbox 未消费消息 */
  pollMailbox(limit?: number): Promise<A2AMessage[]>
  /** 阻塞长轮询未消费消息(到信即时唤醒 + 250ms 兜底;poll_messages 用) */
  waitMailbox(limit?: number, waitMs?: number): Promise<A2AMessage[]>
  /** 确认消费自己 mailbox 的协作消息(读即取;任务指派不经此确认,由执行循环处理) */
  ackMailbox(messageIds: string[]): Promise<void>
  /** (lead)Channel 邮件全览:全部 agent 间消息(含已消费),按时间倒序;可选按参与方过滤 */
  listMail(opts?: { limit?: number, agentId?: string }): Promise<ChannelMail[]>
  /**
   * 记忆按需抓取(search_memory 工具桥):混合检索(FTS+向量)本人私有域 + Channel 公共域。
   * scope: auto=私有+公共(默认) / private / shared;返回结构化片段(综合分排序)。
   */
  recallMemory(input: { query: string, scope?: 'auto' | 'private' | 'shared', limit?: number }): Promise<Array<{
    id: string
    kind: string
    title: string
    content: string
    importance: number
    createdAt: string
    score: number
    source: 'private' | 'shared'
  }>>
  /**
   * 记忆主动沉淀(save_memory 工具桥):Agent 作业中总结的可复用经验/结论。
   * scope='private' → 本人记忆库;scope='shared' → Channel 公共记忆域(全员可检索)。
   */
  saveMemory(input: { title: string, content: string, importance?: number, scope: 'private' | 'shared', dedupKey?: string }): Promise<{ scope: 'private' | 'shared', dedupKey: string }>
  /**
   * 会话压缩摘要入库(harvest 桥;omp compaction 产出的会话摘要 → 本成员持久记忆)。
   * 平台 70% 主动压缩与 omp 原生 auto-compaction 双路统一经此落库(episodic-session)。
   */
  recordSessionMemory?(input: { summary: string, tokensBefore?: number, tokensAfter?: number, reason?: string }): Promise<void>
  /** 订阅同事产出 */
  subscribe(input: { agentIds?: string[] }): Promise<void>
  /** (lead)在本 channel 内新建团队成员(worker):按需建模板并克隆为独立实例 */
  createTeamMember(input: {
    name: string
    harness?: string
    config?: Record<string, unknown>
    templateId?: string
    reason?: string
  }): Promise<AgentInfo>
  /** (lead)更新团队成员(改名/改配置/启停;不能改 lead 自己);变更后运行时重载 */
  updateTeamMember(agentId: string, patch: {
    name?: string
    config?: Record<string, unknown>
    enabled?: number
    reason?: string
  }): Promise<AgentInfo>
  /** (lead)移除团队成员(worker;不能移除自己);其未终态任务回收集成为 FAILED 待重派 */
  removeTeamMember(agentId: string, reason?: string): Promise<{ recycledTasks: string[] }>
}

/** 执行上下文:平台注入的只读能力(Agent 的"手脚") */
export interface AgentRunContext {
  agentId: string
  channelId: string
  /** Agent 在 Channel 内的角色(lead 可 dispatch) */
  role: 'lead' | 'worker'
  workspace: AgentWorkspace
  signal: AbortSignal
  /** 平台记忆块(supervise 路径注入;run 路径用 AgentRunRequest.memory) */
  memory?: string
}

/** 统一事件流(对齐 A2A StreamResponse):run() 逐条产出的五变体 */
export type AgentEvent
  = | { kind: 'status', status: { state: string, message?: A2AMessage, timestamp: string } }
    | { kind: 'message', message: A2AMessage }
    | { kind: 'artifact', artifact: A2AArtifact, append?: boolean, lastChunk?: boolean, totalChunks?: number }
    | { kind: 'error', error: A2AError }
    | { kind: 'done', final?: { taskId?: string } }
    /** LLM 流式增量(P2:omp text_delta 透出;AEP agent.delta 事件源;不进 taskEngine) */
    | { kind: 'delta', delta: { text: string } }

/** 调度快照:SchedulerLoop 每次 tick 喂给 lead 的团队观察 */
export interface SupervisionSnapshot {
  tick: number
  now: number
  /** 全 channel 任务摘要 */
  tasks: WorkspaceTask[]
  /** 成员状态(含队列上下文与实时进度,供 lead 做最优调配与停滞识别) */
  members: {
    agentId: string
    name: string
    role: 'lead' | 'worker'
    state: 'idle' | 'busy' | 'stopped'
    /** 待执行队列长度(快照时刻) */
    queued?: number
    /** 执行中任务 id(空闲时 null) */
    currentTaskId?: string | null
    /** 执行中任务标题(lead 观察 worker 在干什么,不必翻任务表) */
    currentTaskTitle?: string | null
    /** 执行中任务进度 0-100(空闲/未上报为 null;lead 据此判断是否在推进) */
    currentTaskProgress?: number | null
    /** 已完成任务数 */
    completedCount?: number
    /** 忙碌但进度长期停滞(超 stallMs 未变)→ lead 应介入(notify/reassign/cancel) */
    stalled?: boolean
  }[]
  /** 每个父任务未完成的子任务数 */
  pendingChildren: Record<string, number>
  /**
   * 最近 Channel 邮件(倒序,最新在前;调度循环注入,默认截取最近 20 条)。
   * 含 worker 间点对点通信/回执——lead 据此判断"结果是否已被某 worker 产出",
   * 避免把已完成工作重新派发造成浪费。
   */
  mail?: ChannelMail[]
}

/** 调度决策:lead 对快照的回应(空数组 = 本轮无动作) */
export type SupervisionDecision
  = | { kind: 'dispatch', parentTaskId?: string, assigneeId: string, title: string, description?: string, parts?: Part[] }
    | { kind: 'reassign', taskId: string, toAgentId: string }
    | { kind: 'cancel', taskId: string }
    | { kind: 'complete', taskId: string, artifacts?: A2AArtifact[] }
    | { kind: 'notify', toAgentId: string, parts: Part[] }
    | { kind: 'spawn_agent', name: string, harness?: string, config?: Record<string, unknown>, templateId?: string, reason?: string }
    | { kind: 'update_agent', agentId: string, name?: string, config?: Record<string, unknown>, enabled?: boolean, reason?: string }
    | { kind: 'remove_agent', agentId: string, reason?: string }
/** 执行模式:channel 任务提交时选择 */
export type ExecutionMode = 'goal' | 'loop' | 'pipeline'

/** 消息优先级:immediate 实时注入(steer);task 任务队列(等当前任务结束消费) */
export type MessagePriority = 'immediate' | 'task'

/** AgentInterface:所有 harness impl 的唯一契约 */
export interface AgentInterface {
  /** 标准流式返回:输入一次,产出统一事件流 */
  run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent>
  /** lead 调度决策(可选,仅 role='lead' 时被 SchedulerLoop 调用) */
  supervise?(snapshot: SupervisionSnapshot, ctx: AgentRunContext, opts?: { signal?: AbortSignal }): Promise<SupervisionDecision[]>
  /**
   * 实时消息注入:将文本注入正在运行的 omp 会话。
   * 返回送达模式:'steer' = 已注入流式会话(同轮可见,可安全标记消费);
   * 'deferred' = 未能注入(回合被工具阻塞/空闲/发送失败)——消息保持 pending,
   * 由 poll_messages 即时取走或消费循环起回合处理。
   */
  steer?(text: string): Promise<'steer' | 'deferred'>
  init?(config: { agent: AgentInfo, channelId: string }): Promise<void>
  dispose?(): Promise<void>
  /**
   * 可选:harness 进程资源信息(运行时资源监控用)。
   * 进程内 harness(mock/claude)无外部进程 → 不实现返回 null。
   */
  getProcessInfo?(): { pid: number, alive: boolean, command: string } | null
  /**
   * 可选:强制终止 harness 进程(不等优雅退出)。
   * 终止后调用方(manager)应随之 stop 对应的 AgentRuntime。
   */
  killProcess?(): void
  /**
   * 可选:harness 进程存活校准(manager sweeper 周期性调用)。
   * OS 级存活探针:系统休眠/强杀后子进程 exit 事件可能不达父进程,alive 标记失真;
   * 探到进程已死时收敛为已退出,让在途回合归位、下一回合自动重生子进程。
   */
  reconcileProcess?(): void
  /**
   * 可选:harness 上下文用量快照(omp;被动缓存值,无探测 RPC)。
   * 进程内 harness(mock/claude)不实现 → getStatus 不透出 context 字段。
   */
  getContextStats?(): AgentContextStats | null
  /**
   * 可选:回合落定后的后台钩子(post-settle 上下文压缩检查)。
   * 实现方自守卫(仅回合间隙发起、异常不抛出);调用方 AgentRuntime 在信箱无排队消息时调用。
   */
  onTurnSettled?(): Promise<void>
}
