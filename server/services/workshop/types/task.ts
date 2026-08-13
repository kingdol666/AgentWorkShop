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
  createdAt: string
  updatedAt: string
}
