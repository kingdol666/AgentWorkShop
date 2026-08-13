/**
 * ChannelRuntime — Channel 隔离路由 + 订阅 + 广播。
 * route 仅在本 channel 内路由消息;订阅关系经 subscriptionRepo。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T3。
 */
import type { A2AMessage } from '../types/a2a'
import type { SubscriptionRepo } from '../db/subscription.repo'
import type { AgentRuntimeLike, TaskEngine } from './agent-runtime'

/** 调度循环结构契约(实现方 T5 SchedulerLoop) */
export interface SchedulerLoopLike {
  start(): void
  wake(): void
  stop(): void
}

export class ChannelRuntime {
  readonly channelId: string
  private agents = new Map<string, AgentRuntimeLike>()
  private schedulerLoop: SchedulerLoopLike | null = null

  constructor(
    channelId: string,
    private deps: { taskEngine: TaskEngine, subscriptionRepo: SubscriptionRepo },
  ) {
    this.channelId = channelId
  }

  /** 核心路由:解析收件人 → 逐人投递 mailbox */
  route(message: A2AMessage): void {
    for (const agentId of this.resolveRecipients(message)) {
      this.agents.get(agentId)?.enqueue(message)
    }
  }

  addAgent(runtime: AgentRuntimeLike): void {
    this.agents.set(runtime.agentId, runtime)
  }

  async removeAgent(agentId: string): Promise<void> {
    const runtime = this.agents.get(agentId)
    if (runtime) {
      await runtime.stop()
      this.agents.delete(agentId)
    }
  }

  /** 解析目标 agentId 列表(规则见 §5.3) */
  resolveRecipients(message: A2AMessage): string[] {
    const meta = message.metadata ?? {}
    // ① 点对点:x-aw-target-agent(同 channel 校验,目标不存在忽略)
    const target = meta['x-aw-target-agent']
    if (typeof target === 'string' && target.length > 0) {
      return this.agents.has(target) ? [target] : []
    }
    // ② 任务消息:x-aw-task-kind 存在 → 直投 assignee(任务不存在忽略)
    const taskKind = meta['x-aw-task-kind']
    if (taskKind !== undefined) {
      const taskId = meta['x-aw-task-id']
      if (typeof taskId === 'string') {
        const task = this.deps.taskEngine.get(taskId)
        if (task && this.agents.has(task.assigneeId)) {
          return [task.assigneeId]
        }
      }
      return []
    }
    // ③ 无 target 普通消息:广播给订阅了发送者的 Agent;发送者 null 广播全部
    const sender = meta['x-aw-from-agent']
    if (sender == null) {
      return [...this.agents.keys()]
    }
    return this.deps.subscriptionRepo
      .listByTarget(sender as string)
      .map(s => s.agentId)
      .filter(id => this.agents.has(id))
  }

  getAgents(): AgentRuntimeLike[] {
    return [...this.agents.values()]
  }

  get lead(): AgentRuntimeLike | null {
    return this.getAgents().find(a => a.role === 'lead') ?? null
  }

  set scheduler(loop: SchedulerLoopLike | null) {
    this.schedulerLoop = loop
  }

  get scheduler(): SchedulerLoopLike | null {
    return this.schedulerLoop
  }

  /** 唤醒调度循环(事件驱动) */
  wakeScheduler(): void {
    this.schedulerLoop?.wake()
  }
}
