/**
 * SchedulerLoop 的依赖类型与对外 DTO(原 server/services/workshop/runtime/scheduler-loop.ts 顶部模块级类型声明)。纯类型。
 */
import type { ChannelMail } from '../../types/a2a'
import type { SupervisionDecision } from '../../agents/agent-interface'

export interface MemberView {
  agentId: string
  name: string
  role: 'lead' | 'worker'
  state: 'idle' | 'busy' | 'stopped'
  /** 待执行队列长度(SUBMITTED/ASSIGNED;FIFO) */
  queued: number
  /** 执行中任务 id(空闲为 null) */
  currentTaskId: string | null
  /** 执行中任务标题(lead 观察 worker 在干什么,不必翻任务表) */
  currentTaskTitle: string | null
  /** 执行中任务进度 0-100(空闲/未上报为 null;lead 据此判断是否在推进) */
  currentTaskProgress: number | null
  /** 已完成任务数 */
  completedCount: number
  /** 忙碌但进度长期停滞(超 stallMs 未变)→ lead 应介入(notify/reassign/cancel) */
  stalled: boolean
}

export interface SchedulerLoopOptions {
  tickMs?: number
  stallMs?: number
  /** 调度快照邮件提供者(manager 注入;返回最新在前);未注入则快照 mail 为空 */
  supervisionMail?: (limit: number) => ChannelMail[]
  /** agent 最近一次工具调用时刻(manager 注入;停滞看门狗的活性信号:
   *  真实 LLM 长工具链不更新 progress 数字,健康工作不能被两轮 stallMs 误回收) */
  toolActivityOf?: (agentId: string) => number | null
  /**
   * Lead 决策留痕回调(§7.1 lead.wait/guide/reassign/cancel)。
   * manager 注入后把决策写入 Channel shared memory;未注入 = 不留痕(测试脚手架)。
   */
  onLeadDecision?: (e: {
    channelId: string
    agentId: string
    decision: string
    taskId?: string
    toAgentId?: string
    reason?: string
    rootId?: string
  }) => void
}

/** 空闲退避上限(指纹不变时 tick 间隔指数退避至此;事件 wake 立即恢复) */
export type SchedulerDecision = SupervisionDecision | { kind: 'recovery_complete', taskId: string }
