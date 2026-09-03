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
}
