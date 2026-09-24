/**
 * AgentRuntimeLayer00 —— 运行时状态 / 队列视图 / 中断与 steer 注入
 * (分层 1/4,承 AgentRuntimeContracts;方法体与原文件逐行一致)
 */
import { AgentRuntimeContracts } from './contracts'
import type { A2AMessage } from '../../types/a2a'
import type { AgentEvent, AgentInfo, AgentInterface, AgentWorkspace } from '../../agents/agent-interface'
import type { AgentMemory } from '../memory'
import type { AgentStatusView, AgentTaskQueueView } from '../../types/task'
import type { ChannelBus, TaskEngine } from './types'
import type { Mailbox } from '../mailbox'
import { log } from './helpers'
import { randomUUID } from 'node:crypto'

export abstract class AgentRuntimeLayer00 extends AgentRuntimeContracts {
  readonly agentId: string
  readonly role: 'lead' | 'worker'
  readonly channelId: string
  readonly name: string
  protected state: 'idle' | 'busy' | 'stopped' = 'idle'
  /** 回合失败重投计数(每消息;进程内存,重启由 resetConsuming 重新给机会) */
  protected runErrorRetries = new Map<string, number>()
  /** 正在执行的任务 id(run 期间;空闲时 null) */
  protected currentTaskId: string | null = null
  /** poll_messages 阻塞等待数(waitPending 活动计数;>0 = 有轮询在等,实时消息留信箱由其取走) */
  protected pollWaiters = 0
  /** run 与 supervise 互斥锁(promise 链) */
  protected execLock: Promise<void> = Promise.resolve()
  protected abortController: AbortController | null = null
  protected loopPromise: Promise<void> | null = null
  protected started = false

  constructor(
    agent: AgentInfo,
    protected impl: AgentInterface,
    protected deps: {
      mailbox: Mailbox
      taskEngine: TaskEngine
      bus: ChannelBus
      workspace: AgentWorkspace
      memory?: AgentMemory
      /** 平台代投(落时间线+广播):人类 requireReply 的回执 —— 人类无信箱,emitExternal 只广播不落库。
       *  v17:额外携带全链路关联 ID(sourceChatMessageId/requesterUserId/replyToId/deliveryId),
       *  由 manager 的适配层写入群聊事实表(chat_messages)并自动 @提问者。 */
      platformReply?: (input: {
        text: string
        inReplyTo: string
        toLabel: string
        /** Agent 身份(群聊回复的 senderId/senderName) */
        agentId?: string
        agentName?: string
        channelId?: string
        /** 源群聊消息 id(Agent 回复关联的唯一锚点) */
        sourceChatMessageId?: string
        /** 提问者稳定用户 id(服务端从入站 metadata 读取,不是"最近发言者") */
        requesterUserId?: string
        /** 回复目标消息 id(= sourceChatMessageId;显式传递便于契约自描述) */
        replyToId?: string
        /** 投递台账 id(闭环留痕) */
        deliveryId?: string
      }) => void
    },
  ) {
    super()
    this.agentId = agent.id
    this.role = agent.role
    this.channelId = agent.channelId
    this.name = agent.name
    // 工作区即时可用:impl 的 workspace 原本在首个 run() 才注入,此前 REST 直调
    // host 工具(agent-tools/invoke)会拿到 null →「workspace 未就绪」。
    // 装配期即绑定(与 run() 注入的是同一对象,语义等价)。
    const attach = (this.impl as { attachWorkspace?: (ws: AgentWorkspace) => void }).attachWorkspace
    if (typeof attach === 'function') attach.call(this.impl, deps.workspace)
  }

  /** 投递消息;idle 时立即唤醒消费 */
  enqueue(message: A2AMessage): void {
    this.deps.mailbox.enqueue(message)
  }

  getState(): 'idle' | 'busy' | 'stopped' {
    return this.state
  }

  /** 实时状态视图:idle/busy/stopped + 当前任务 + 队列 + harness 上下文用量 */
  getStatus(): AgentStatusView {
    const queue = this.getQueueView()
    const current = queue.current ?? (this.currentTaskId ? this.deps.taskEngine.get(this.currentTaskId) : undefined)
    const context = this.impl.getContextStats?.() ?? undefined
    return {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      name: this.name,
      state: this.state,
      currentTaskId: current?.id ?? null,
      // 进度/标题透出:lead 观察 worker 是否在推进(progress 空闲/未上报时为 null)
      currentTaskTitle: current?.title ?? null,
      currentTaskProgress: current?.progress != null ? current.progress : null,
      queuedCount: queue.queued.length,
      completedCount: queue.completed.length,
      ...(context ? { context } : {}),
    }
  }

  /** 本 agent 的任务队列视图(自己的任务管理系统:待执行 FIFO / 执行中 / 已完成) */
  getQueueView(): AgentTaskQueueView {
    return this.deps.taskEngine.queueViewOf(this.channelId, this.agentId)
  }

  /** 中止当前 run(任务取消/Agent 移除时);空闲时无操作 */
  abortCurrent(): void {
    log.warn(`[AgentRuntime:${this.agentId}] abortCurrent 调用(state=${this.state})`)
    this.abortController?.abort()
    // supervise 回合同样可打断(调度器 cancel 路径 → LLM 回合真中止)
    this.superviseController?.abort()
  }

  /** 仅中止仍在执行指定任务的当前 run;不影响其它任务或 supervise 回合 */
  abortTask(taskId: string): boolean {
    if (this.currentTaskId !== taskId) return false
    log.warn(`[AgentRuntime:${this.agentId}] abortTask 调用(task=${taskId},state=${this.state})`)
    this.abortController?.abort()
    return true
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
   * 实时注入策略(信箱优先,与主动轮询完全兼容):
   *  - poll_messages 等待中:任何实时消息留在 pending —— 等待中的轮询经 Mailbox
   *    到信回调毫秒级取走(读即取=已读),零打断、不与轮询竞争唯一所有权
   *  - agent 间协作消息(from-agent):同样走信箱 —— turn 结束后消费循环按 peer
   *    回合处理(require_reply 触发语义/回执关联完整)。steer 注入 omp 会话会让
   *    其把排队消息后的工具调用标记 "Skipped due to queued user message",
   *    中断 poll_messages 长等待并污染执行流(实测故障源)
   *  - 仅人类紧急直发(immediate + from-label,无 from-agent)保留 steer 同轮注入:
   *    紧急人工打断是唯一值得中断会话的场景
   */
  injectSteer(message: A2AMessage): void {
    if (this.state !== 'busy' || !this.impl.steer) return
    // ① 轮询等待中:留 pending 给 poll_messages(毫秒级取走并标记已读)
    if (this.pollWaiters > 0) return
    // ② agent 间协作消息:信箱优先(turn 结束 peer 回合处理)
    const from = message.metadata?.['x-aw-from-agent']
    if (typeof from === 'string' && from.length > 0) return
    // ③ requireReply 不走 steer:同轮注入的回复文本归属当前回合,平台代投无法
    //    关联到本消息(in_reply_to 断链,回执丢失实测)。改走信箱 peer 回合 ——
    //    稍晚但归属正确、回执必有应答。
    if (message.metadata?.['x-aw-require-reply'] === 'true') return
    // ④ 其余(人类紧急直发):原有 steer 注入路径
    if (!this.deps.mailbox.claim(message.messageId)) return
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
    this.impl.steer(lines.join('\n'))
      .then((mode) => {
        if (mode === 'steer') {
          // 确认注入流式会话 → 消费落定(at-least-once:进程崩溃由 resetConsuming 兜底)
          this.deps.mailbox.markConsumed(message.messageId)
        }
        else {
          // deferred:释放认领回 pending,poll_messages(250ms 兜底重查)或
          // 本回合结束后的消费循环(FIFO)接管,消息必达不丢失
          this.releaseSteerClaim(message.messageId)
        }
      })
      .catch((err) => {
        log.error(`[AgentRuntime:${this.agentId}] steer 失败(释放认领回 pending 待循环处理):`, err)
        this.releaseSteerClaim(message.messageId)
      })
  }

  /** 释放 steer 认领:consuming → pending + 唤醒 dequeue 门闩与到信等待方 */
  protected releaseSteerClaim(messageId: string): void {
    if (this.deps.mailbox.requeue(messageId)) {
      this.deps.mailbox.wake()
    }
  }

  /**
   * 长轮询未消费消息(poll_messages host 工具用):
   * 250ms 兜底重查 + Mailbox 到信回调即时唤醒——消息到达后毫秒级返回,
   * 不再每秒盲查。不改消息状态(peek 只读);消费语义由调用方(poll 读即取)决定。
   * pollWaiters 计数暴露"轮询等待中"状态:injectSteer 据此把实时消息留在信箱
   * 由本方法取走(不打断会话、与主动轮询兼容)。
   */
  async waitPending(limit: number, waitMs: number): Promise<A2AMessage[]> {
    this.pollWaiters += 1
    try {
      const deadline = Date.now() + Math.max(0, waitMs)
      for (;;) {
        const msgs = await this.deps.mailbox.peek(limit)
        if (msgs.length > 0 || Date.now() >= deadline) return msgs
        const { promise, resolve } = Promise.withResolvers<unknown>()
        const off = this.deps.mailbox.onArrival(() => resolve(undefined))
        const timer = setTimeout(() => resolve(undefined), 250)
        await promise
        clearTimeout(timer)
        off()
      }
    }
    finally {
      this.pollWaiters -= 1
    }
  }
}
