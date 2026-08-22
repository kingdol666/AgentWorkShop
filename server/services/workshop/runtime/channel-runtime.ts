/**
 * ChannelRuntime — Channel 隔离路由 + 订阅 + 广播 + 懒加载。
 *
 * route 仅在本 channel 内路由消息;订阅关系经 subscriptionRepo。
 * 懒加载:agents map 不含目标时经 loader 回调按需装配(DB 行 → AgentRuntime);
 */
import type { A2AMessage } from '../types/a2a'
import type { SubscriptionRepo } from '../db/subscription.repo'
import type { ChannelAgentRepo } from '../db/channel-agent.repo'
import type { AgentRuntimeLike, TaskEngine } from './agent-runtime'

/** 调度循环结构契约(实现方 T5 SchedulerLoop) */
export interface SchedulerLoopLike {
  start(): void
  wake(): void
  stop(): void
  setLoopResubmitCallback(fn: (title: string, description: string) => void): void
}

/** 懒加载器:按 agentId 装配 AgentRuntime(未找到/禁用返回 undefined);幂等 */
export type AgentLoader = (agentId: string) => AgentRuntimeLike | undefined

export class ChannelRuntime {
  readonly channelId: string
  private agents = new Map<string, AgentRuntimeLike>()
  private schedulerLoop: SchedulerLoopLike | null = null
  /** 懒加载回调(manager 注入);未装配的收件人经此按需 wire */
  private loader: AgentLoader | null = null

  constructor(
    channelId: string,
    private deps: { taskEngine: TaskEngine, subscriptionRepo: SubscriptionRepo, channelAgents: ChannelAgentRepo },
    /** 路由成功回调(manager 注入:总线通知 → AEP a2a.message 帧 + 落库)。
     *  经由本回调而非 manager.route 显式通知,是为了让调度器等直呼
     *  channelRuntime.route 的调用方同样产生可见事件(催办消息不再对前端隐身)。 */
    private onRouted: (message: A2AMessage) => void = () => {},
  ) {
    this.channelId = channelId
  }

  /** channel 全部 enabled 实例元信息(含未装配;供快照/调度看到完整团队) */
  listChannelAgents(): Array<{ agentId: string, name: string, role: 'lead' | 'worker' }> {
    return this.deps.channelAgents
      .listByChannel(this.channelId)
      .filter(m => m.enabled === 1)
      .map(m => ({ agentId: m.id, name: m.name, role: m.role as 'lead' | 'worker' }))
  }

  setLoader(loader: AgentLoader): void {
    this.loader = loader
  }

  /** 核心路由:解析收件人 → 按需装配 → 按优先级投递(immediate → injectSteer;task → mailbox) */
  /**
   * Channel 信箱路由(本 channel 内):垃圾守卫通过的消息统一落库到收件人
   * mailbox(pending;lead 全览/断线重投/空闲回合作业都以此为准),
   * 实时类消息(immediate 优先级,或带 in_reply_to 的回执)额外注入收件人
   * 运行中的会话(steer 推送,送达即消费)——收件人忙则同轮可见,空闲则由
   * 消费循环按 FIFO 起回合处理。
   * 返回实际投递成功的收件人列表(发送方据此确认"真送达",不再静默丢失)。
   */
  route(message: A2AMessage): string[] {
    if (!this.acceptByGuard(message)) return []
    const meta = message.metadata ?? {}
    const realtime
      = meta['x-aw-msg-priority'] === 'immediate'
        || typeof meta['x-aw-in-reply-to'] === 'string'
    const delivered: string[] = []
    for (const agentId of this.resolveRecipients(message)) {
      const agent = this.ensureAgent(agentId)
      if (!agent) continue
      agent.enqueue(message)
      delivered.push(agentId)
      // 空闲收件人即时唤醒消费循环
      if (agent.getState() === 'idle') agent.wakeMailbox()
      if (realtime) agent.injectSteer(message)
    }
    // 实际投递成功的消息才通知总线(a2a.message 可见 + 落库);
    // 守卫拦截/无收件人的消息不产生事件帧(时间线不出现幽灵消息)
    if (delivered.length > 0) this.onRouted(message)
    return delivered
  }

  /**
   * 信箱守卫(垃圾信息拦截):三类消息放行,其余直接丢弃(不落库、不投递)——
   *  ① 平台任务消息(task-kind + 真实存在的任务);
   *  ② 声明发送人为本 channel 成员的消息(伪造/已移除成员 → 拒);
   *  ③ 人类经 REST 注入的消息(x-aw-from-label 必须非空)。
   * 防脏信息注入:无主消息与未知发送人的消息没有回执对象,处理它们只会
   * 污染 Agent 上下文,因此拦截并删除。
   */
  private acceptByGuard(message: A2AMessage): boolean {
    const meta = message.metadata ?? {}
    const taskKind = meta['x-aw-task-kind']
    if (taskKind !== undefined) {
      const taskId = meta['x-aw-task-id']
      if (typeof taskId === 'string' && this.deps.taskEngine.get(taskId)) return true
      console.warn(`[ChannelRuntime:${this.channelId.slice(0, 8)}] 拦截无效任务消息(kind=${String(taskKind)} task=${String(taskId)}),已丢弃`)
      return false
    }
    const from = meta['x-aw-from-agent']
    if (typeof from === 'string' && from.length > 0) {
      const member = this.deps.channelAgents.findByChannelAgent(this.channelId, from)
      if (member && member.enabled === 1) return true
      console.warn(`[ChannelRuntime:${this.channelId.slice(0, 8)}] 拦截非成员/已禁用成员消息(from=${from}),已丢弃`)
      return false
    }
    const label = meta['x-aw-from-label']
    if (typeof label === 'string' && label.length > 0) return true
    console.warn(`[ChannelRuntime:${this.channelId.slice(0, 8)}] 拦截无发送人消息(target=${String(meta['x-aw-target-agent'] ?? '广播')}),已丢弃`)
    return false
  }

  /** 按需装配 agent(loader 幂等);未装配成功返回 undefined */
  private ensureAgent(agentId: string): AgentRuntimeLike | undefined {
    let agent = this.agents.get(agentId)
    if (!agent && this.loader) {
      agent = this.loader(agentId)
      if (agent) this.agents.set(agentId, agent)
    }
    return agent
  }

  /** 唤醒 agent(懒加载感知):未装配则先经 loader 装配再唤醒 */
  wakeAgent(agentId: string): void {
    this.ensureAgent(agentId)?.wakeMailbox()
  }

  addAgent(runtime: AgentRuntimeLike): void {
    this.agents.set(runtime.agentId, runtime)
  }

  /** 永久移除(stop 运行时 + 移出 map;manager.removeAgent 用) */
  async removeAgent(agentId: string): Promise<void> {
    const runtime = this.agents.get(agentId)
    if (runtime) {
      await runtime.stop()
      this.agents.delete(agentId)
    }
  }

  /** 卸载移出(不停 stop;manager.unloadAgent 已 stop;仅删 map 引用) */
  detachAgent(agentId: string): void {
    this.agents.delete(agentId)
  }

  /** 解析目标 agentId 列表(规则见 §5.3;未装配收件人经 loader 按需装配) */
  resolveRecipients(message: A2AMessage): string[] {
    const meta = message.metadata ?? {}
    // ① 点对点:x-aw-target-agent(同 channel 校验,目标不存在忽略)
    const target = meta['x-aw-target-agent']
    if (typeof target === 'string' && target.length > 0) {
      return this.ensureAgent(target) ? [target] : []
    }
    // ② 任务消息:x-aw-task-kind 存在 → 直投 assignee(任务不存在忽略)
    const taskKind = meta['x-aw-task-kind']
    if (taskKind !== undefined) {
      const taskId = meta['x-aw-task-id']
      if (typeof taskId === 'string') {
        const task = this.deps.taskEngine.get(taskId)
        if (task && this.ensureAgent(task.assigneeId)) {
          return [task.assigneeId]
        }
      }
      return []
    }
    // ③ 无 target 普通消息:广播给订阅了发送者的 Agent;发送者 null 广播全部
    const sender = meta['x-aw-from-agent']
    if (sender == null) {
      // 广播仅覆盖已装配的成员(不触发全量懒加载,避免广播唤醒整个 channel)
      return [...this.agents.keys()]
    }
    return this.deps.subscriptionRepo
      .listByTarget(this.channelId, sender as string)
      .map(s => s.agentId)
      .filter(id => this.ensureAgent(id) !== undefined)
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
