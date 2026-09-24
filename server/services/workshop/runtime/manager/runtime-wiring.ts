/**
 * ManagerRuntimeWiring —— 实例装配、调度器挂载、卸载与空闲清扫
 * (拆分层,承 ManagerBus)
 */
import { ManagerBus } from './bus'
import type { AgentInfo } from '../../agents/agent-interface'
import type { ChannelAgentRow } from '../../db/database'
import type { SchedulerLoopOptions } from '../scheduler-loop'
import { AgentMemory } from '../memory'
import { AgentRuntime } from '../agent-runtime'
import type { ChannelRuntime } from '../channel-runtime'
import { Mailbox } from '../mailbox'
import { SchedulerLoop } from '../scheduler-loop'
import { buildMessage, instanceToAgentInfo, log, parseChannelLlm, rowToChannelMail, runtimeKey } from './helpers'
import { harnessContinuityEnabled, workshopSettings } from '../../settings'

export abstract class ManagerRuntimeWiring extends ManagerBus {
  /** 按实例装配 AgentRuntime(每个实例一个独立运行时) */
  protected wireMember(m: ChannelAgentRow): AgentRuntime {
    const agent = instanceToAgentInfo(m)
    const cr = this.ensureChannelRuntime(m.channelId)
    const bus = this.buses.get(m.channelId)!
    const mailbox = new Mailbox(this.deps.repos.messages, m.channelId, agent.id, () => cr.wakeScheduler())
    const memory = new AgentMemory(this.deps.repos.memories, { channelId: m.channelId, agentId: agent.id, embedder: this.memoryEmbedder ?? undefined })
    const workspace = this.buildWorkspace(agent, memory)
    const chWorkspace = this.channelWorkspace(m.channelId)
    // channel 级作业场景 prompt 注入 harness config(用户场景 × 系统设计组合的入口;
    // 变更经 updateChannel 回收成员运行时,下次装配拿到新场景)
    const scenarioPrompt = this.deps.repos.channels.findById(m.channelId)?.scenarioPrompt ?? ''
    const configWithCtx: Record<string, unknown> = { ...agent.config }
    if (scenarioPrompt) configWithCtx.scenarioPrompt = scenarioPrompt
    if (chWorkspace.length > 0) configWithCtx.cwd = chWorkspace
    // channel 级默认 LLM(v11):成员 config 未显式指定 model/provider 时按引擎注入;
    // effort 语义按引擎映射(omp thinkingLevel / opencode variant / codex effort / dsh 暂不支持)
    const chRow = this.deps.repos.channels.findById(m.channelId)
    const chLlm = parseChannelLlm(chRow?.llmJson)
    if (chLlm) {
      if (!configWithCtx.model && chLlm.model) configWithCtx.model = chLlm.model
      if (!configWithCtx.provider && chLlm.provider) configWithCtx.provider = chLlm.provider
      if (!configWithCtx.effort && chLlm.effort) configWithCtx.effort = chLlm.effort
    }
    const agentWithCtx: AgentInfo = { ...agent, config: configWithCtx }
    const runtime = new AgentRuntime(agent, this.deps.implFactory(agentWithCtx), {
      mailbox,
      taskEngine: this.getTaskEngine(),
      bus,
      workspace,
      memory,
      // 平台代投:人类 requireReply 的回执落时间线(人类无信箱,route 无人可投)
      // v17:同一回调也是**群聊回复的唯一出口** —— 关联 ID 齐备时写 chat_messages
      // (sender=agent,自动 @提问者)并发布 chat.message;关联缺失时退回纯时间线行为。
      platformReply: (reply) => {
        const message = buildMessage(m.channelId, 'ROLE_AGENT', [{ text: reply.text }], {
          'x-aw-from-agent': agent.id,
          'x-aw-in-reply-to': reply.inReplyTo,
          'x-aw-to-label': reply.toLabel,
          'x-aw-relayed': 'true',
          ...(reply.sourceChatMessageId ? { 'x-aw-source-chat-message-id': reply.sourceChatMessageId } : {}),
          ...(reply.requesterUserId ? { 'x-aw-requester-user-id': reply.requesterUserId } : {}),
        })
        this.deps.repos.messages.create({
          id: message.messageId,
          channelId: m.channelId,
          taskId: null,
          fromAgentId: agent.id,
          toAgentId: null,
          role: message.role,
          parts: message.parts,
          metadata: message.metadata,
        })
        bus.notifyMessage(message)
        // 群聊回复关联:metadata 齐备(或可经 mailbox id 反查)→ 写群聊事实表 + 通知提问者
        try {
          this.agentReplyToChat({
            channelId: m.channelId,
            agentId: agent.id,
            agentName: agent.name,
            text: reply.text,
            sourceChatMessageId: reply.sourceChatMessageId,
            requesterUserId: reply.requesterUserId,
            inReplyTo: reply.inReplyTo,
          })
        }
        catch (err) {
          // 群聊写入失败不得影响既有时间线回执(降级为纯时间线行为,消息已落 messages 表)
          log.error('[chat] Agent 群聊回复写入失败(时间线回执已落库):', err)
        }
        // 人类调用已收口:解除该 Agent 的发起者作用域限制(§13.3)。
        // 仅当这次回复对应的正是当前记录的那次人类调用时清除(invocationId 比对),
        // 避免把随后到达的另一次调用的作用域误删;老路径无 deliveryId 时按"收口即清除"。
        {
          const active = this.activeInvocationScopes.get(agent.id)
          if (active && (!reply.deliveryId || active.invocationId === reply.deliveryId)) {
            this.activeInvocationScopes.delete(agent.id)
          }
        }
      },
      // 监督信号(§7.1 supervise.watchdog)与 Harness 重建(§7.1 harness.restarted)
      // 必须落 Channel 共享记忆 —— watchdog 只在内存态可见等于"零观测"。
      onSupervisionSignal: e => this.recordSupervisionSignal(e),
      onHarnessRestart: e => this.recordHarnessRestartEvent(e),
    })
    cr.addAgent(runtime)
    this.agentIndex.set(runtimeKey(m.channelId, agent.id), runtime)
    runtime.start()
    // lead 惰性重组时复活调度器:lead 曾因 120s 空闲被清扫卸载(stopAndDetach 会把
    // cr.scheduler 置 null)后,若无人重建调度循环,频道进入"worker 活着、lead 不派活"
    // 的僵尸态 —— 后续任务只写进 lead 信箱却永远无人消费派发(实测 task 积压 600s+)。
    // lead 一旦重新装配,立即补齐 SchedulerLoop(幂等;与 ensureChannelActive 同源语义)。
    if (agent.role === 'lead' && !cr.scheduler) this.reviveScheduler(m.channelId)
    return runtime
  }

  /** 按需装配实例运行时(幂等):已装配返回缓存,否则从实例行 wire;禁用/不存在返回 undefined */
  protected ensureAgentRuntime(channelId: string, agentId: string): AgentRuntime | undefined {
    const key = runtimeKey(channelId, agentId)
    const existing = this.agentIndex.get(key)
    if (existing) return existing
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m || m.enabled !== 1) return undefined
    return this.wireMember(m)
  }

  protected runtimeOf(channelId: string, agentId: string): AgentRuntime | undefined {
    return this.agentIndex.get(runtimeKey(channelId, agentId))
  }

  /** 激活 channel:装配 lead 运行时 + 装配并启动 SchedulerLoop(幂等) */
  ensureChannelActive(channelId: string, options?: SchedulerLoopOptions): void {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel || channel.enabled !== 1 || !channel.leadAgentId) return
    const cr = this.ensureChannelRuntime(channelId)
    if (cr.scheduler) return
    const lead = this.ensureAgentRuntime(channelId, channel.leadAgentId)
    if (!lead) return
    // 必须再查一次:`ensureAgentRuntime → wireMember` 在装配 lead 时会经
    // `reviveScheduler` 挂上**第一个** SchedulerLoop;此处若不再判空就会挂上第二个,
    // 把第一个变成无人持有的孤儿循环 —— 重复监督/重复派单,且 shutdown 只停
    // cr.scheduler 指向的那个,孤儿循环会在 DB 关闭后继续 tick。
    // (attachScheduler 内部也有同一判空,这里保留可读的显式守卫。)
    if (cr.scheduler) return
    this.attachScheduler(cr, channelId, lead, options)
  }

  /**
   * 复活 lead 的 SchedulerLoop(幂等)。
   *
   * 由 `wireMember` 在 lead 运行时装配完成后调用:lead 因空闲被清扫卸载
   * (`stopAndDetach` 会把 `cr.scheduler` 置 null)后,若无人重建调度循环,频道进入
   * "worker 活着、lead 不派活"的僵尸态(后续任务只写进 lead 信箱却永远无人消费)。
   *
   * 与 `ensureChannelActive` 的关键区别:**不调用 `ensureAgentRuntime`**。
   * 本方法正是在"lead 正在被装配"的窗口内被调用的(此时 `cr.scheduler` 仍为 null),
   * 若再走 `ensureAgentRuntime → wireMember` 就会递归;而外层 `ensureChannelActive`
   * 返回后还会再 `new SchedulerLoop` 覆盖 `cr.scheduler`,导致两个循环都被 `start()`
   * (重复派活)。所以这里只认**已经装配好**的 lead 运行时(`runtimeOf`)。
   */
  protected reviveScheduler(channelId: string, options?: SchedulerLoopOptions): void {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel || channel.enabled !== 1 || !channel.leadAgentId) return
    const cr = this.ensureChannelRuntime(channelId)
    if (cr.scheduler) return
    const lead = this.runtimeOf(channelId, channel.leadAgentId)
    if (!lead || lead.role !== 'lead') return
    this.attachScheduler(cr, channelId, lead, options)
  }

  /**
   * 装配并启动 SchedulerLoop(**幂等**:调用方无需自行判空)。
   *
   * 幂等判空是安全底线而非冗余:同一 channel 的装配有两条路径 ——
   * `ensureChannelActive` 与 `wireMember → reviveScheduler`。lead 首次装配时两条
   * 路径会在同一窗口内先后到达,若不判空,后到的会把 cr.scheduler 覆盖成第二个循环,
   * 前一个成为无人持有的孤儿:重复监督/重复派单,且 shutdown 停不掉它
   * (DB 关闭后继续 tick,打出「statement has been finalized」)。
   */
  protected attachScheduler(
    cr: ChannelRuntime,
    channelId: string,
    lead: AgentRuntime,
    options?: SchedulerLoopOptions,
  ): void {
    // shutdown 之后不得再挂新调度器:shutdown 会停掉全部循环并置空 cr.scheduler,
    // 但此窗口内仍可能有在途的懒装配(channelRuntime loader / 定时任务 / 在飞投递)
    // 经 wireMember → reviveScheduler 重新挂载。
    if (this.shutdownStarted) return
    if (cr.scheduler) return
    const loop = new SchedulerLoop(cr, lead, {
      // 停滞窗口默认取 workshop.stall_ms(默认 5 分钟,可经设置调整):
      // 它决定"多久算停滞"以及"多久之后收口",是运维最需要按现场调的一个值;
      // 以前写死在 SchedulerLoop 构造默认值里,mock/规则引擎路径上最长要 10 分钟才可见。
      ...(Number.isFinite(workshopSettings().stall_ms) ? { stallMs: workshopSettings().stall_ms } : {}),
      ...options,
      // 停滞看门狗活性源:agent 最近一次工具 invoke 时刻(工具调用即健康推进)
      toolActivityOf: (agentId: string) => this.lastToolInvokeAt.get(agentId) ?? null,
      // 调度快照的邮件上下文(lead 观察 worker 间通信的唯一来源;DB 为事实源)
      supervisionMail: limit => this.deps.repos.messages
        .listRecentByChannel(channelId, limit)
        .map(rowToChannelMail),
      // Lead 决策留痕(§7.1 lead.wait/guide/reassign/cancel → Channel shared memory)
      onLeadDecision: e => this.recordLeadDecision(channelId, e),
    })
    loop.setLoopResubmitCallback((title, description) => {
      this.submitChannelTask({ channelId, title, description }).catch((err) => {
        // 清理竞态:channel 已删除/lead 已卸载时的到期重放 → 静默(NOT_FOUND 为预期)
        const code = (err as { code?: string }).code
        if (code === 'NOT_FOUND' || code === 'NO_LEAD_AGENT') return
        log.error(`[AgentChannelManager:${channelId}] loop 重新提交失败:`, err)
      })
    })
    cr.scheduler = loop
    loop.start()
  }

  /** 停止并卸载某实例运行时(强制;删除实例/channel 时用) */
  protected async stopAndDetach(channelId: string, agentId: string): Promise<void> {
    const key = runtimeKey(channelId, agentId)
    const runtime = this.agentIndex.get(key)
    if (!runtime) return
    const cr = this.channels.get(channelId)
    const scheduler = runtime.role === 'lead' ? cr?.scheduler : null
    if (scheduler) {
      await scheduler.stopAndWait()
      cr!.scheduler = null
    }
    // 先摘除再停机:runtime.stop() 会关闭 mailbox,若成员仍在 route 视野内,
    // 停机窗口内到达的消息会被 closed mailbox 静默吞掉但 delivered 照常上报
    // (发送方收到成功假象);先 detach 让 route 立即按"成员不存在"如实失败
    cr?.detachAgent(agentId)
    await runtime.stop()
    this.agentIndex.delete(key)
    if (cr && cr.getAgents().length === 0 && !cr.scheduler) {
      this.channels.delete(channelId)
      this.buses.delete(channelId)
    }
  }

  /** 卸载实例运行时(空闲后释放内存,杀 omp 子进程);busy/有 pending/lead 有活跃任务 → 跳过 */
  async unloadAgent(channelId: string, agentId: string): Promise<void> {
    const runtime = this.runtimeOf(channelId, agentId)
    if (!runtime) return
    if (runtime.getState() !== 'idle') return
    if (this.deps.repos.messages.listPendingByChannelAgent(channelId, agentId).length > 0) return
    // §6.1 Runtime 卸载闸门(五条件)。§11 harness_continuity_enabled=false 时退回
    // 旧行为(只看 runtime idle),仅用于异常回滚 —— 默认必须走完整闸门。
    if (harnessContinuityEnabled()) {
      const tasks = this.getTaskEngine().list(runtime.channelId)
      const hasAssignedWork = tasks.some(t =>
        t.assigneeId === agentId
        && t.state !== 'COMPLETED'
        && t.state !== 'CANCELED'
        && t.state !== 'FAILED')
      // Worker runtimes can transiently report idle between harness turns while
      // their task is still WORKING/WAITING. Never unload a continuity lease in
      // that window; this is role-independent and prevents session churn.
      if (hasAssignedWork) return
      // 在飞的监督尝试同样持有 Harness 租约(§4.1 IDLE 之外的态都在飞)。
      if (runtime.role === 'lead' && runtime.hasActiveSupervisionAttempt?.()) return
    }
    await this.stopAndDetach(channelId, agentId)
  }

  async unloadIdleAgents(): Promise<void> {
    for (const rt of [...this.agentIndex.values()]) {
      await this.unloadAgent(rt.channelId, rt.agentId)
    }
  }

  startIdleSweeper(options?: { intervalMs?: number, graceMs?: number }): () => void {
    const intervalMs = options?.intervalMs ?? 60_000
    const graceMs = options?.graceMs ?? 120_000
    const idleSince = new Map<string, number>()
    this.idleSweeperTimer = setInterval(() => {
      const now = Date.now()
      for (const rt of [...this.agentIndex.values()]) {
        // 存活校准优先:休眠/强杀后子进程 exit 事件可能不达,周期探 OS 实际存在性,
        // 死进程收敛为已退出(在途回合归位,下一回合自动重生),避免 stuck busy/死客户端空转
        try {
          rt.reconcileProcess()
        }
        catch (err) {
          log.error(`[AgentChannelManager] 校准 ${rt.channelId}/${rt.agentId} 进程存活失败:`, err)
        }
        const key = runtimeKey(rt.channelId, rt.agentId)
        if (rt.getState() === 'idle') {
          const since = idleSince.get(key) ?? now
          idleSince.set(key, since)
          if (now - since >= graceMs) {
            idleSince.delete(key)
            this.unloadAgent(rt.channelId, rt.agentId).catch((err) => {
              log.error(`[AgentChannelManager] 卸载 ${rt.channelId}/${rt.agentId} 失败:`, err)
            })
          }
        }
        else {
          idleSince.delete(key)
        }
      }
    }, intervalMs)
    return () => {
      if (this.idleSweeperTimer) {
        clearInterval(this.idleSweeperTimer)
        this.idleSweeperTimer = null
      }
    }
  }
}
