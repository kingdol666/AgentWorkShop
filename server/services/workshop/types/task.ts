/**
 * 任务对象模型 — L1 数据层。
 * 定义任务状态机与任务实体的统一类型(一等公民)。
 * 仅类型定义,无运行时逻辑;供 task engine、repo 与 impl 层共同消费。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块。
 */
import type { A2AArtifact, A2AMessage } from './a2a'

/** 任务状态机:终态为 COMPLETED / FAILED / CANCELED */
export type TaskState
  = | 'SUBMITTED'
    | 'ASSIGNED'
    | 'WORKING'
    | 'WAITING'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELED'

/** 工作区任务:主理人编排与下属执行的最小作业单元 */
export interface WorkspaceTask {
  id: string
  channelId: string
  /** 子任务挂主任务(主理人分解) */
  parentId?: string
  /** Channel root FIFO sequence; only root tasks carry it */
  rootQueueSeq?: number
  /** 当前负责 Agent */
  assigneeId: string
  /** 创建者(lead / 用户) */
  creatorId: string
  title: string
  description?: string
  state: TaskState
  /** 0-100,由 Agent 事件驱动 */
  progress: number
  retryCount: number
  /** 作业成果 */
  artifacts: A2AArtifact[]
  /** 执行过程(消息/上报) */
  history: A2AMessage[]
  /** 派发路由理由(koda RouteDecision 借鉴):lead 留痕"为什么派给他" */
  routeReason?: string
  /** 群聊来源身份(仅根任务使用,用于跨标题幂等) */
  sourceChatMessageId?: string
  sourceChatDeliveryId?: string
  /** 终态/关闭原因与持久化 deadline */
  closeReason?: string
  deadlineAt?: string
  /** 执行交接代次(§5.1;每次新分配/重分配 +1,用于拒绝旧 worker 迟到事件) */
  assignmentGeneration?: number
  /** 当前执行租约 id / 持有者 / 起止时间(§2.1) */
  executionLeaseId?: string
  executionLeaseAgentId?: string
  executionLeaseStartedAt?: string
  executionLeaseRevokedAt?: string
  createdAt: string
  updatedAt: string
}

/** 终态判定(COMPLETED / FAILED / CANCELED);membership:TERMINAL_TASK_STATES[state] */
export const TERMINAL_TASK_STATES: Partial<Record<TaskState, true>> = {
  COMPLETED: true,
  FAILED: true,
  CANCELED: true,
}

/**
 * 单 Agent 任务队列视图(每个 AgentRuntime 自己的任务管理系统)。
 * DB tasks 表是唯一事实源;本视图为派生只读投影,不持有第二份状态:
 *  - queued:待执行队列(FIFO,createdAt ASC;含 SUBMITTED/ASSIGNED)
 *  - current:执行中任务(WORKING;空闲时 undefined)
 *  - completed:已完成任务(COMPLETED)
 *  WAITING(已分解等待子任务)不计入 queued——它由子任务推进,不由本 agent 主动执行。
 */
export interface AgentTaskQueueView {
  agentId: string
  channelId: string
  queued: WorkspaceTask[]
  current?: WorkspaceTask
  completed: WorkspaceTask[]
}

/**
 * 根任务队列视图(§2.2)。后端统一派生 —— 前端不得自行推导 active root,
 * 否则前后端会对「谁在跑」给出相反结论。
 */
export interface RootQueueView {
  activeRootId: string | null
  activeRoot: WorkspaceTask | null
  /** 排队中的 roots(不含 active);`position` 从 2 起,1 恒为 active */
  queuedRoots: Array<{ task: WorkspaceTask, position: number }>
  /** 已终态 root 计数 */
  completedRoots: number
  activeRootCount: number
  queuedRootCount: number
}

/** harness 上下文用量快照(omp harness 有;进程内 harness 无 → 字段缺省) */
export interface AgentContextStats {
  /** 最近已知上下文 tokens(≈ prompt 规模) */
  usedTokens: number
  /** 模型上下文窗口(未知为 null,percent 同为 null) */
  contextWindow: number | null
  /** 占窗口比例 0-1(窗口未知为 null) */
  percent: number | null
  /** harness 正在压缩会话 */
  compacting: boolean
}

export interface SupervisionAttemptView {
  attemptId: string | null
  /** 归属(§2.3 channel_id / lead_agent_id;前端展示与审计) */
  channelId?: string
  leadAgentId?: string
  state: 'IDLE' | 'RUNNING' | 'WATCHDOG_SIGNALED' | 'WAITING_FOR_RESULT' | 'DECISION_APPLIED' | 'ABORT_REQUESTED' | 'ABORTED'
  startedAt: string | null
  watchdogAt: string | null
  /** 监督回合落定时刻(§2.3 completed_at) */
  completedAt?: string | null
  /** 本轮决策依据的快照修订号(= 调度 tick;§2.3 snapshot_revision) */
  snapshotRevision?: number | null
  activeRootId: string | null
  watchdogCount: number
  /** 最近一次 watchdog/监督信号时刻(§2.3 last_signal_at) */
  lastSignalAt?: string | null
  /** 最近一次 Lead 决策类型 wait|guide|reassign|cancel|complete|…(§2.3/§8「Lead 最后决策」) */
  lastDecisionKind?: string | null
}

/**
 * Harness 连续性租约只读 DTO(§2.4)。
 * 只暴露观测字段 —— 不含凭据、不含内部 prompt;`continuityMode` 来自 registry,
 * 一次性 CLI 如实标 `per_turn`,平台不虚假承诺同进程复用。
 */
export interface HarnessContinuityView {
  leaseId: string
  agentId: string
  channelId: string
  harness: string
  continuityMode: 'persistent' | 'per_turn'
  /** harness 子进程 pid(进程内引擎为 null) */
  pid: number | null
  /** harness 会话/线程身份(§2.4 session_id / thread_id;未探测到为 null) */
  sessionId: string | null
  /** 本租约内进程/会话被复用的回合数(§11 harness_reuse_count) */
  reuseCount: number
  /** 当前仍持有的非终态任务(§6.1 卸载闸门依据) */
  activeTaskIds: string[]
  startedAt: string
  lastUsedAt: string
  /** 空闲宽限到期时刻(此刻之前即便 idle 也不卸载) */
  idleGraceUntil: string | null
  /** 最近一次 Harness 重建原因(§6.2 last_restart_reason) */
  lastRestartReason: string | null
  lastRestartAt: string | null
  /** 本租约生命周期内重建次数 */
  restartCount: number
  /** 按原因聚合的重启计数(§11 harness_restart_count_by_reason) */
  harnessRestartCounts: Record<string, number>
}

/** Agent 实时状态视图(状态管理机制:idle/busy/stopped + 队列上下文) */
export interface AgentStatusView {
  agentId: string
  channelId: string
  role: 'lead' | 'worker'
  name: string
  state: 'idle' | 'busy' | 'stopped'
  /** 执行中的任务 id(空闲时 null) */
  currentTaskId: string | null
  /** 执行中任务的标题(空闲时 null;lead 观察 worker 在干什么,不必去翻任务表) */
  currentTaskTitle: string | null
  /** 执行中任务的进度 0-100(空闲/未上报进度时 null;lead 据此判断 worker 是否在推进) */
  currentTaskProgress: number | null
  /** 待执行队列长度(实时) */
  queuedCount: number
  /** 已完成任务数 */
  completedCount: number
  /** harness 上下文用量(omp 有;进程内 harness/未知时缺省) */
  context?: AgentContextStats
  supervision?: SupervisionAttemptView
  /** Harness 连续性租约(§2.4/§8;只读观测面) */
  continuity?: HarnessContinuityView
}
