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
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { harnessContinuityEnabled, rootQueueEnabled, workshopSettings } from '../../settings'
import { TERMINAL_TASK_STATES, type TaskState } from '../../types/task'
import { composeChannelSystemPrompt } from '../../aml/twin/prompt-composer'
import { createChannelSessionRepo } from '../../db/channel-session.repo'
import { shouldRescueBusyStuck } from './rescue-policy'
import { SessionContextService, formatBriefText } from '../../sessions/context'

/**
 * 有原生会话持久化的引擎 → session 注入用 brief 档（只注身份+关键事实，历史归引擎）。
 * 未知引擎缺省 full：平台三层装配是无持久化引擎的安全缺省。
 */
const SESSION_BRIEF_PROFILE_ENGINES = new Set(['claude'])

export abstract class ManagerRuntimeWiring extends ManagerBus {
  private sessionContextService: SessionContextService | null = null

  /** Session Context 单例（按需建；repo 持有 db，不额外连接） */
  protected getSessionContextService(): SessionContextService {
    if (!this.sessionContextService) {
      this.sessionContextService = new SessionContextService(
        this.deps.db,
        createChannelSessionRepo(this.deps.db),
      )
    }
    return this.sessionContextService
  }

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
    // v18 频道绑定产线:注入产线简报(只读上下文;全员可 line_context 看实时全景,写仍需节点授权)
    try {
      const boundLineId = this.deps.repos.channels.findById(m.channelId)?.lineId ?? ''
      const line = boundLineId ? getDcwLineRepo().byId(boundLineId) : undefined
      if (line) {
        const brief = `\n\n## 绑定产线(只读上下文)\n本频道已绑定产线「${line.name}」(${line.id})${line.description ? ` — ${line.description}` : ''}。全员可用 line_context 查看该产线实时全景(运行状态/活动批次/当前配方与参数窗口),ops_log / recipe_log / recipe_versions 查运维日志与配方历史(频道绑定 = 只读授权);参数下发等写操作仍需节点授权(lead 可用 team_grant_nodes/grant_node_ids 授予)。`
        configWithCtx.scenarioPrompt = (scenarioPrompt ? `${scenarioPrompt}\n` : '') + brief
      }
      else if (scenarioPrompt) {
        configWithCtx.scenarioPrompt = scenarioPrompt
      }
    }
    catch {
      // 产线仓储未就绪等异常:退回纯场景 prompt,不阻断装配
      if (scenarioPrompt) configWithCtx.scenarioPrompt = scenarioPrompt
    }
    // AML 解耦:训练/工艺优化 Channel 的动态工况提示词(模式+goal+绑定节点调试元数据组装;
    // 模式/绑定变更经 twin-profile PATCH 回收成员运行时生效,与 scenarioPrompt 同链路)。
    try {
      const composed = composeChannelSystemPrompt(m.channelId, agent.id, scenarioPrompt)
      if (composed) configWithCtx.systemPromptPrefix = composed
    }
    catch { /* 非工业 Channel/组装依赖未就绪:不注入 */ }
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
      // Session Context：按 sessionId 装配平台上下文块；异常降级为 legacy 回合，不阻断执行。
      // profile 按引擎能力选择（harness 无关的唯一开关点）：有原生会话持久化的引擎
      // 只注入 brief 层（历史归引擎会话），其余引擎 full 三层装配。
      sessionContext: (sessionId) => {
        try {
          const brief = this.getSessionContextService().briefOf(sessionId)
          if (!brief) return null
          const profile = SESSION_BRIEF_PROFILE_ENGINES.has(agent.harness) ? 'brief' as const : 'full' as const
          return { block: formatBriefText(brief, profile), summary: brief.nextStep }
        }
        catch {
          return null
        }
      },
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
          ...(reply.sessionId ? { 'x-aw-session-id': reply.sessionId } : {}),
        })
        this.deps.repos.messages.create({
          id: message.messageId,
          channelId: m.channelId,
          taskId: null,
          sessionId: reply.sessionId ?? null,
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
        this.clearInvocationScope(agent.id, reply.deliveryId ?? null)
      },
      // C-P1-2(2026-10-28 审查):回合结束(无论是否产生回执)都收口人类调用作用域。
      // 无回执的回合(模型只调工具/报错/被停)不会再触发 platformReply,旧实现在这条
      // 失败路径上让 scope 永久驻留 → lead 管理面/worker 写面被陈旧限制封锁。
      onInvocationSettled: e => this.clearInvocationScope(e.agentId, e.deliveryId ?? null),
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
    if (agent.role === 'lead' && agent.agentKind !== 'project_leader' && !cr.scheduler) this.reviveScheduler(m.channelId)
    return runtime
  }

  /** 按需装配实例运行时(幂等):已装配返回缓存,否则从实例行 wire;禁用/不存在/停机中返回 undefined */
  protected ensureAgentRuntime(channelId: string, agentId: string): AgentRuntime | undefined {
    const key = runtimeKey(channelId, agentId)
    // 停机窗口墓碑:既不返回半关闭的旧运行时,也不重建新运行时(否则消息进闭箱)
    if (this.stoppingAgents.has(key) || this.channels.get(channelId)?.schedulerStoppingInProgress) return undefined
    const existing = this.agentIndex.get(key)
    if (existing) {
      // 活性守卫(2026-11-10 P1):已停止的实例不能直接复用 —— 旧实现无条件返回它,
      // route 只 enqueue/wake,永远不会再 start(AgentRuntime.start 在 started=true
      // 时早退,而 stop() 不复位),表现为"群聊 delivered/consumed 但没有回合"。
      if (String(existing.getState?.() ?? '') !== 'stopped') return existing
      log.warn(`[AgentChannelManager] 命中已停止的运行时,摘除后重装配 ${channelId.slice(0, 8)}/${agentId.slice(0, 8)}`)
      this.agentIndex.delete(key)
      this.channels.get(channelId)?.detachAgent(agentId)
    }
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m || m.enabled !== 1) return undefined
    // WP2 守卫 A：频道已停用（任务实例终态回收/频道关闭）→ 拒绝按需重装配，
    // 防「已停用频道被直接寻址复活」。
    const ch = this.deps.repos.channels.findById(channelId)
    if (ch && ch.enabled !== 1) return undefined
    // WP2 守卫 B：会话克隆（名字带 ·session· 标记）只在所属会话仍 active 时可装配；
    // 已关闭会话的克隆不可被任何寻址路径重新拉起（历史行仍保留审计）。
    if (String(m.name ?? '').includes('·session·')) {
      try {
        const active = this.deps.db.prepare(
          `SELECT 1 AS ok FROM channel_sessions WHERE channel_id = ? AND status = 'active' AND member_map_json LIKE ? LIMIT 1`,
        ).get(channelId, `%${agentId}%`) as { ok?: number } | undefined
        if (!active) {
          log.warn(`[AgentChannelManager] 拒绝装配已关闭会话的克隆 ${channelId.slice(0, 8)}/${agentId.slice(0, 8)}`)
          return undefined
        }
      }
      catch { /* 查询失败按可装配处理（不阻断正常装配） */ }
    }
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
    if (cr.schedulerStoppingInProgress) return
    if (cr.scheduler) return
    const lead = this.ensureAgentRuntime(channelId, channel.leadAgentId)
    if (!lead) return
    // 项目办公室：Project Leader 只由 mailbox 驱动，不挂 Channel SchedulerLoop。
    if (lead.agentKind === 'project_leader') return
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
    if (cr.schedulerStoppingInProgress) return
    if (cr.scheduler) return
    const lead = this.runtimeOf(channelId, channel.leadAgentId)
    if (!lead || lead.role !== 'lead' || lead.agentKind === 'project_leader') return
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
    if (this.shutdownStarted || cr.schedulerStoppingInProgress) return
    if (cr.scheduler) return
    if (lead.agentKind === 'project_leader') return
    const loop = new SchedulerLoop(cr, lead, {
      // 停滞窗口默认取 workshop.stall_ms(默认 5 分钟,可经设置调整):
      // 它决定"多久算停滞"以及"多久之后收口",是运维最需要按现场调的一个值;
      // 以前写死在 SchedulerLoop 构造默认值里,mock/规则引擎路径上最长要 10 分钟才可见。
      ...(Number.isFinite(workshopSettings().stall_ms) ? { stallMs: workshopSettings().stall_ms } : {}),
      ...options,
      // 停滞看门狗活性源:agent 最近一次工具 invoke 时刻(工具调用即健康推进)。
      // C-P1-3:取 REST/MCP 回程与全引擎分发入口打点的并集 —— omp 原生/pi 从不过 REST。
      toolActivityOf: (agentId: string) => this.toolActivityOf(agentId),
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
    // C-P1-1(2026-10-28 审查):所有"摘除"动作在第一个 await 之前同步完成。
    // 旧实现把 agentIndex.delete 放在 await stop() 之后,停机窗口内:
    //   route → ensureAgentRuntime 命中旧索引 → enqueue 进正在关闭的信箱 → 假送达 + 永久丢失;
    //   即便先 detach,loader 也能按 agentIndex 缓存把旧运行时装回去。
    // 现在的顺序 = 立墓碑 → 摘索引 → 摘频道成员 → 清人类调用作用域 → 后台停机。
    this.stoppingAgents.add(key)
    this.agentIndex.delete(key)
    const cr = this.channels.get(channelId)
    cr?.detachAgent(agentId)
    this.clearInvocationScope(agentId)
    let releaseSchedulerStarts: (() => void) | null = null
    try {
      if (runtime.role === 'lead' && cr) {
        releaseSchedulerStarts = await cr.stopSchedulersAndWait()
      }
      await runtime.stop()
    }
    finally {
      releaseSchedulerStarts?.()
      // 停机完成即允许惰性复活(新消息触发 wireMember 重建)
      this.stoppingAgents.delete(key)
    }
    if (cr && cr.getAgents().length === 0 && !cr.scheduler) {
      this.channels.delete(channelId)
      this.buses.delete(channelId)
    }
  }

  /** 卸载实例运行时(空闲后释放内存,杀 omp 子进程);busy/有 pending/lead 有活跃任务 → 跳过 */
  async unloadAgent(channelId: string, agentId: string): Promise<void> {
    const runtime = this.runtimeOf(channelId, agentId)
    if (!runtime) return
    // 项目办公室 leader 常驻：项目 active 期间不参与 idle 卸载（pause/archive 走显式停止）。
    if (runtime.agentKind === 'project_leader') return
    if (runtime.getState() !== 'idle') return
    if (this.deps.repos.messages.listPendingByChannelAgent(channelId, agentId).length > 0) return
    // 生产化(2026-10-09):挂起中的 HITL 审批卡视为活跃 —— 真人审批常超空闲宽限
    // (~120s),而 stopAndDetach → runtime.stop() → cancelAllForAgent 会把卡收敛为
    // 「回合已被中止」的拒绝(误杀人工裁决,hold 模式也拦不住这条路径)。动态 import
    // 取审批单例,避免与 tool-approvals → platform-notice → manager 的静态环。
    // 删除实例/频道仍走 stopAndDetach 直达(管理动作,保持 fail-closed 收敛语义)。
    try {
      const { getToolApprovals } = await import('../../agents/tool-approvals')
      if (getToolApprovals().listPending(agentId).length > 0) return
    }
    catch { /* 审批面未装配(测试/降级)→ 按原语义放行 */ }
    // 检查-卸载竞态:上面有 await(动态 import),期间 route 可能把群聊消息投进这个
    // 信箱并标记 delivered,随后 stopAndDetach 关箱 → 消息永久滞留。卸载前**重新**
    // 校验同一判据(廉价,且不改变五重闸门语义)。
    if (this.deps.repos.messages.listPendingByChannelAgent(channelId, agentId).length > 0) return
    if (this.runtimeOf(channelId, agentId)?.getState() !== 'idle') return
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
      void this.rescueStaleRoots().catch((err) => {
        log.error(`[AgentChannelManager] D1 兜底扫异常(下轮继续):`, err)
      })
    }, intervalMs)
    return () => {
      if (this.idleSweeperTimer) {
        clearInterval(this.idleSweeperTimer)
        this.idleSweeperTimer = null
      }
    }
  }

  /**
   * D1 兜底(2026-10-06):lead 根任务的入场依赖 omp 监督回合;会话握手抖动/自停/卸载时
   * 队列根无限滞留 SUBMITTED(实测两例,activate+immediate 消息 nudge 即愈 —— 证明
   * 「lead 领到消息的回合」是稳健入场路径)。把人工救援固化为管理层周期扫:
   * 无活跃根 + 最老排队根滞留 >90s → ensureChannelActive(幂等复活 lead 运行时与
   * 调度循环)+ immediate 领取提示唤醒消费循环。健康频道入场在秒级完成,不会触发;
   * 同一根 10 分钟冷却,防消息刷屏。
   */
  protected rescueSeen = new Map<string, number>()

  /**
   * WP11：受权运维入口——对单个 Channel 立即跑一次 D1 救援扫（与周期扫同一路径，幂等）。
   * 供 REST 触发（无需等 5min 周期）；actor 非空时校验频道可写。
   */
  async rescueChannelNow(channelId: string): Promise<void> {
    const ch = this.deps.repos.channels.findById(channelId)
    if (!ch) throw new Error(`Channel 不存在: ${channelId}`)
    await this.rescueStaleRoots(channelId)
  }

  protected async rescueStaleRoots(onlyChannelId?: string): Promise<void> {
    if (!rootQueueEnabled()) return
    const now = Date.now()
    // 2026-11-05：90s 固定阈值会在真实 LLM 长回合里误杀忙碌 lead（上一轮产品落地页
    // 实测：lead 读 skill/生成长 HTML 时被反复卸载）。默认放宽到 5min，并允许
    // AW_ROOT_RESCUE_STALE_MS 覆盖；忙碌 lead 一律跳过（见下）。
    const configured = Number(process.env.AW_ROOT_RESCUE_STALE_MS ?? 0)
    const RESCUE_STALE_MS = Number.isFinite(configured) && configured >= 60_000 ? configured : 300_000
    const RESCUE_COOLDOWN_MS = 10 * 60_000
    if (this.rescueSeen.size > 500) this.rescueSeen.clear()
    for (const channel of this.deps.repos.channels.list()) {
      if (onlyChannelId && channel.id !== onlyChannelId) continue
      if (channel.enabled !== 1 || !channel.leadAgentId) continue
      let roots
      try {
        roots = this.deps.repos.tasks.listRoots(channel.id)
      }
      catch { continue }
      // 入场资格 = 队头**开放**根。两种滞留形态都要覆盖:
      //  ① SUBMITTED(assign 消息已投但没人消费);
      //  ② WAITING 且**无开放子任务、无在飞监督尝试** —— 2026-11-10 现场盲区:
      //     这种 root 既不触发 shouldSupervise(只认 SUBMITTED/WORKING),规则引擎
      //     对 children=0 直接 continue,deadline 未到也不收口 → 40 分钟无人发现。
      // 必须先滤掉终态根(FAILED 旧根占着 seq=1 会挡住重开的 seq=2 根,实测)。
      const head = roots.find(r => !TERMINAL_TASK_STATES[r.state as TaskState])
      if (!head || head.assigneeId !== channel.leadAgentId) continue
      const openChildren = this.getTaskEngine().list(channel.id)
        .filter(t => t.parentId === head.id && !TERMINAL_TASK_STATES[t.state as TaskState])
      const leadRtPre = this.runtimeOf(channel.id, channel.leadAgentId)
      const orphanWaiting = head.state === 'WAITING'
        && openChildren.length === 0
        && !leadRtPre?.hasActiveSupervisionAttempt?.()
      if (head.state !== 'SUBMITTED' && !orphanWaiting) continue
      if (now - Date.parse(head.createdAt) < RESCUE_STALE_MS) continue
      // 忙碌 lead 不救援：root 仍是 SUBMITTED 可能只是「消息已消费、回合尚未把状态推进」，
      // 此时卸载会打断正在生成的长任务（D1 反复卸载的直接根因）。
      const leadRt = this.runtimeOf(channel.id, channel.leadAgentId)
      if (leadRt?.getState?.() === 'busy') {
        // WP9：区分「健康长回合」与「卡死 busy」——后者（长时间无回合推进）允许受控重组。
        const cfgMs = Number(process.env.AW_RESCUE_BUSY_STUCK_MS ?? 0)
        const minBusyMs = Number.isFinite(cfgMs) && cfgMs >= 60_000
          ? cfgMs
          : Math.max(30 * 60_000, Number(workshopSettings().supervise_hard_timeout_ms) || 900_000)
        const contr = leadRt.getContinuity?.()
        const stuck = shouldRescueBusyStuck({ busy: true, lastUsedAt: contr?.lastUsedAt, now, minBusyMs })
        if (!stuck) {
          log.warn(`[AgentChannelManager] D1 兜底跳过:lead 正忙(channel ${channel.id.slice(0, 8)} root ${head.id.slice(0, 8)})`)
          continue
        }
        log.warn(`[AgentChannelManager] D1 兜底:lead 长时间 busy 无推进(自 ${contr?.lastUsedAt ?? '?'})，按 busy-stuck 强制重组(root ${head.id.slice(0, 8)})`)
      }
      const last = this.rescueSeen.get(head.id) ?? 0
      if (now - last < RESCUE_COOLDOWN_MS) continue
      this.rescueSeen.set(head.id, now)
      log.warn(`[AgentChannelManager] D1 兜底:channel ${channel.id.slice(0, 8)} 排队根 ${head.id.slice(0, 8)}「${String(head.title).slice(0, 40)}」滞留 SUBMITTED —— 复活 lead 并投递 assign 领取消息`)
      try {
        // 一律卸载后重组:restore 恢复的运行时可能 state 显示 idle 但消费循环从未启动
        // (自停态恢复不 start,实测消息表 pending 永滞而 omp RPC 仍应答 compact)——
        // 与其猜状态,不如给一次干净的 stop→dispose→重新 wire→start()。
        // 救援路径本身罕见(90s 滞留 + 10min 冷却),omp 冷启动 30~90s 代价可接受。
        if (this.runtimeOf(channel.id, channel.leadAgentId)) {
          log.warn(`[AgentChannelManager] D1 兜底:强制摘除既有 lead 运行时后重组(消费循环可疑失活)`)
          // 必须走强制摘除:unloadAgent 的五重闸门里 hasAssignedWork 会看到"这个滞留
          // root 本身就是 lead 的非终态任务"而直接 return —— 注释里的"卸载重组"在
          // SUBMITTED root 场景永远是空操作(2026-11-10 实测确认)。
          await this.stopAndDetach(channel.id, channel.leadAgentId)
        }
        this.ensureChannelActive(channel.id)
        // 入场即刷新执行预算(deadline 语义=执行预算,预算从入场起算):滞留根的旧预算
        // 早已耗尽,不刷新则 tick 的过期收口会在 WORKING 后立即处决它。
        try {
          const engine = this.getTaskEngine() as { refreshDeadline?: (id: string, iso: string) => unknown }
          const budgetMs = head.source === 'project' && head.deadlineAt
            ? Math.max(10_000, new Date(head.deadlineAt).getTime() - new Date(head.createdAt).getTime())
            : Math.max(10_000, Number(workshopSettings().root_timeout_ms ?? 900_000))
          engine.refreshDeadline?.(head.id, new Date(Date.now() + budgetMs).toISOString())
        }
        catch { /* 极简引擎替身缺方法:跳过,入场后由既有预算语义接管 */ }
      }
      catch (err) {
        log.warn(`[AgentChannelManager] D1 兜底复活失败(下轮重试): ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      // 正规 assign 消息(与人类直发 worker 同构):FIFO 准入已满足(无活跃根+最老 seq),
      // assign 语义让 lead 消息路径自动 SUBMITTED→WORKING(补 RUNNING 中间态可见性),
      // 回合载荷=任务简报,走消息消费循环的稳健入场路径。
      // 2026-10-30 修复(救援竞争):上面 unloadAgent 是秒级 await,窗口内旧运行时的在途
      // 消费/监督决策可能已把该根 SUBMITTED→WORKING(甚至继续派发子任务)。投递前必须
      // 复读:非 SUBMITTED 说明入场已发生,再投 assign 会复活出同任务的第二回合并发执行
      // (双份 history/artifact 交错、重复派发子任务;lease 栅栏对无栅栏字段的救援 assign
      // 不设防)。复读与 route 之间无 await,单进程下原子。
      const freshHead = this.deps.repos.tasks.findById(head.id)
      if (!freshHead || String(freshHead.state) !== 'SUBMITTED') {
        log.warn(`[AgentChannelManager] D1 兜底:根任务 ${head.id.slice(0, 8)} 在重组窗口内已入场(state=${freshHead ? String(freshHead.state) : '缺失'}),跳过重复投递`)
        continue
      }
      const brief = [head.title, head.description ?? ''].filter(Boolean).join('\n')
      const rescueMessage = buildMessage(
        channel.id,
        'ROLE_USER',
        [{ text: brief || head.title }],
        {
          'x-aw-target-agent': channel.leadAgentId,
          'x-aw-msg-priority': 'immediate',
          'x-aw-task-kind': 'assign',
          'x-aw-task-id': head.id,
          'x-aw-from-label': '调度兜底',
        },
      )
      rescueMessage.taskId = head.id
      const delivered = this.route(channel.id, rescueMessage)
      if (!delivered.includes(channel.leadAgentId)) {
        log.warn(`[AgentChannelManager] D1 兜底 assign 消息投递失败(下轮重试): root=${head.id.slice(0, 8)}`)
      }
    }
  }
}
