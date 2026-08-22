/**
 * SchedulerLoop — lead 常驻调度循环(统一调度核心)。
 * 定时 tick + 事件唤醒(wake 去抖合并);每轮在 lead.execLock 串行化下:
 * 收集快照 → lead.supervise 决策(未实现/抛错回退内置规则引擎)→ 逐条执行决策。
 * 支持三种执行模式:goal(满意度判断)/ loop(循环重放)/ pipeline(流水线)。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T5。
 */
import { randomUUID } from 'node:crypto'
import { TERMINAL_TASK_STATES } from '../types/task'
import type { A2AMessage, ChannelMail } from '../types/a2a'
import type { SupervisionDecision, SupervisionSnapshot, ExecutionMode, AgentWorkspace } from '../agents/agent-interface'
import { AppError } from '../../../utils/errors'
import type { ChannelRuntime } from './channel-runtime'
import type { AgentRuntime } from './agent-runtime'
import {
  extractTaskMode,
  findModeTask,
  LoopController,
  type ModeConfig,
} from './execution-mode'

/** 调度快照注入的最近邮件条数(倒序;控制 supervise prompt 体量) */
const MAIL_SNAPSHOT_LIMIT = 20

/** 成员摘要(快照内;含队列上下文,供 lead 最优调配) */
interface MemberView {
  agentId: string
  name: string
  role: 'lead' | 'worker'
  state: 'idle' | 'busy' | 'stopped'
  /** 待执行队列长度(SUBMITTED/ASSIGNED;FIFO) */
  queued: number
  /** 执行中任务 id(空闲为 null) */
  currentTaskId: string | null
  /** 已完成任务数 */
  completedCount: number
}

export interface SchedulerLoopOptions {
  tickMs?: number
  stallMs?: number
  /** supervise 最小间隔 ms(默认 20s;防 LLM 忙轮转烧 token) */
  /** 调度快照邮件提供者(manager 注入;返回最新在前);未注入则快照 mail 为空 */
  supervisionMail?: (limit: number) => ChannelMail[]
}

export class SchedulerLoop {
  private readonly tickMs: number
  private readonly stallMs: number
  private readonly supervisionMail: ((limit: number) => ChannelMail[]) | null
  /** supervise 节流:最小间隔与最近一次执行时刻/信号指纹(token 效率) */
  private lastSuperviseAt = 0
  private lastFingerprint = ''
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  private running = false
  private pendingWake = false
  private tick = 0
  /** 已催办一次的 WORKING 任务(再次停滞 → cancel) */
  private readonly notified = new Set<string>()
  /** WORKING 任务最近一次 progress 与时间(停滞检测) */
  private readonly lastProgress = new Map<string, { progress: number, at: number }>()
  /** 成员空闲起始时间(最久空闲 worker 排序) */
  private readonly idleSince = new Map<string, number>()
  /** 当前活跃的执行模式(null = 默认无模式) */
  private activeMode: ExecutionMode | null = null
  private activeModeConfig: ModeConfig = {}
  /** loop 模式控制器 */
  private loopController: LoopController | null = null
  /** 已通知 loop 控制器的完成任务,避免每轮 tick 重复计数 */
  private readonly loopCompletedTaskIds = new Set<string>()
  /** loop 模式下重新提交任务的回调 */
  private onLoopResubmit: ((title: string, description: string) => void) | null = null

  constructor(
    private readonly channelRuntime: ChannelRuntime,
    private readonly lead: AgentRuntime,
    options: SchedulerLoopOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 1000
    this.stallMs = options.stallMs ?? 300000
    this.supervisionMail = options.supervisionMail ?? null
  }

  /** 启动定时 tick */
  start(): void {
    if (this.started) return
    this.started = true
    this.timer = setInterval(() => this.wake(), this.tickMs)
  }

  /** 事件唤醒:一轮执行中到达的唤醒信号合并到下一轮(去抖) */
  wake(): void {
    if (!this.started) return
    if (this.running) {
      this.pendingWake = true
      return
    }
    void this.runRound()
  }

  stop(): void {
    this.started = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.loopController) {
      this.loopController.stop()
      this.loopController = null
    }
    this.loopCompletedTaskIds.clear()
  }

  /** 设置 loop 模式重新提交回调(manager 注入 submitChannelTask) */
  setLoopResubmitCallback(fn: (title: string, description: string) => void): void {
    this.onLoopResubmit = fn
  }

  // ===== 内部 =====

  private async runRound(): Promise<void> {
    this.running = true
    try {
      await this.lead.withExecLock(() => this.tickRound())
    }
    catch (err) {
      console.error(`[SchedulerLoop:${this.lead.agentId}] 一轮调度失败:`, err)
    }
    finally {
      this.running = false
      if (this.pendingWake && this.started) {
        this.pendingWake = false
        void this.runRound()
      }
    }
  }

  private async tickRound(): Promise<void> {
    this.tick += 1
    const snapshot = this.collectSnapshot()

    // 检测当前活跃的执行模式
    const modeTask = findModeTask(snapshot.tasks, this.lead.agentId)
    if (modeTask) {
      this.activeMode = modeTask.mode
      this.activeModeConfig = modeTask.config
    }

    // loop 模式:检测主任务完成 → 触发循环控制器
    this.checkLoopCompletion(snapshot)

    const decisions = await this.decide(snapshot)
    for (const decision of decisions) {
      try {
        this.execute(decision)
      }
      catch (err) {
        console.error(`[SchedulerLoop:${this.lead.agentId}] 执行决策失败:`, decision, err)
      }
    }
  }

  /**
   * supervise 智能节流(token 效率,纯指纹驱动):
   *  - 信号指纹 = 任务状态集合 · 成员状态/队列 · 最新邮件 id,不含 progress 渐变
   *    (worker 进度上报不值得唤醒 lead;状态翻转/新邮件才是需要行动的信号);
   *  - 指纹无变化 → 跳过 LLM supervise,只跑规则引擎(停滞检测/兜底派发照常);
   *  - 指纹变化 → 立即 supervise(mock 剧本的秒级状态机与 LLM 决策跟进都不被拖延);
   *  - 首轮必跑。
   */
  private superviseFingerprint(snapshot: SupervisionSnapshot): string {
    const tasks = snapshot.tasks
      .map(t => `${t.id}:${t.state}`)
      .sort()
      .join('|')
    const members = snapshot.members
      .map(m => `${m.agentId}:${m.state}:${m.queued ?? 0}`)
      .sort()
      .join('|')
    const mailTop = snapshot.mail?.[0]?.messageId ?? ''
    return `${tasks}#${members}#${mailTop}`
  }

  private shouldSupervise(snapshot: SupervisionSnapshot): boolean {
    if (this.lead.supervise === null) return false // 无 LLM 决策能力,规则引擎自走
    if (this.lastSuperviseAt === 0) return true // 首轮
    // 收尾挂起例外:父任务 WAITING 且子任务全部终态(有完成交付)——指纹虽稳定,
    // lead 也必须获得监督回合做目标判定收尾(否则作废尝试会永久阻塞 goal 闭环)。
    // 30s 冷却:LLM 反复不收尾时不会每 tick 消耗回合
    if (this.hasCloseableParent(snapshot)) {
      if (Date.now() - this.lastCloseOutAt >= 30_000) {
        this.lastCloseOutAt = Date.now()
        return true
      }
      return false
    }
    return this.superviseFingerprint(snapshot) !== this.lastFingerprint
  }

  private lastCloseOutAt = 0

  /** 存在"子任务全部终态且至少一个完成交付"的 WAITING 父任务(待 lead 判定收尾) */
  private hasCloseableParent(snapshot: SupervisionSnapshot): boolean {
    return snapshot.tasks.some((t) => {
      if (t.state !== 'WAITING') return false
      const children = snapshot.tasks.filter(c => c.parentId === t.id)
      if (children.length === 0) return false
      return children.every(c => TERMINAL_TASK_STATES[c.state] === true)
        && children.some(c => c.state === 'COMPLETED')
    })
  }

  /**
   * 决策:lead.supervise 优先(真实 harness 的 LLM 调度);
   * supervise 未实现/抛错 → 内置规则引擎;
   * supervise 返回空但有可调度任务且无任何进展(如 LLM 拒绝/漏看)→ 规则引擎兜底补齐,
   * 保证系统不因单轮 LLM 决策失败而停滞(harness 无关的安全网)。
   * 节流:指纹无变化 → 跳过 LLM(本轮仅规则引擎)。
   */
  private async decide(snapshot: SupervisionSnapshot): Promise<SupervisionDecision[]> {
    try {
      if (!this.shouldSupervise(snapshot)) return this.ruleEngine(snapshot)
      this.lastSuperviseAt = Date.now()
      this.lastFingerprint = this.superviseFingerprint(snapshot)
      const decisions = await this.lead.supervise(snapshot)
      if (decisions === null) return this.ruleEngine(snapshot)
      if (decisions.length > 0) return decisions
      // 空决策 + 规则引擎发现可行动作 → 兜底(LLM 优先,规则保底推进)
      const fallback = this.ruleEngine(snapshot)
      return fallback.length > 0
        ? fallback
        : decisions
    }
    catch (err) {
      console.error(`[SchedulerLoop:${this.lead.agentId}] lead supervise 抛错,回退规则引擎:`, err)
      return this.ruleEngine(snapshot)
    }
  }

  /** 收集快照:全 channel 任务 + 成员状态与队列视图(含未装配成员,标 idle)+ pendingChildren */
  private collectSnapshot(): SupervisionSnapshot {
    const now = Date.now()
    const tasks = this.lead.taskEngine.list(this.channelRuntime.channelId)
    // 已装配成员的实时状态
    const wired = new Map(this.channelRuntime.getAgents().map(a => [a.agentId, a.getState()]))
    // channel 全部 enabled 成员(含未装配懒加载成员 → idle,lead 可据此 dispatch);
    // 队列视图来自 tasks 表(未装配成员的排队任务同样可见)
    const members: MemberView[] = this.channelRuntime.listChannelAgents().map((m) => {
      const view = this.lead.taskEngine.queueViewOf(this.channelRuntime.channelId, m.agentId)
      return {
        agentId: m.agentId,
        name: m.name,
        role: m.role,
        state: wired.get(m.agentId) ?? 'idle',
        queued: view.queued.length,
        currentTaskId: view.current?.id ?? null,
        completedCount: view.completed.length,
      }
    })
    const pendingChildren: Record<string, number> = {}
    for (const task of tasks) {
      if (!task.parentId) continue
      if (TERMINAL_TASK_STATES[task.state]) continue
      pendingChildren[task.parentId] = (pendingChildren[task.parentId] ?? 0) + 1
    }
    return {
      tick: this.tick,
      now,
      tasks,
      members,
      pendingChildren,
      // 最近邮件(最新在前):lead 观察 worker 间通信/回执,判断结果是否已产出
      mail: this.supervisionMail ? this.supervisionMail(MAIL_SNAPSHOT_LIMIT) : [],
    }
  }

  /** 内置规则引擎兜底(harness 无关) */
  private ruleEngine(snapshot: SupervisionSnapshot): SupervisionDecision[] {
    const decisions: SupervisionDecision[] = []
    const { tasks, members, now } = snapshot
    this.refreshIdle(members, now)
    // 本轮可用空闲 worker 池:dispatch/reassign 消费后即从池中移除,
    // 保证一轮内不会把多个任务重复分给同一个"看似空闲"的 worker(其状态尚未翻 busy)。
    const pool = members.filter(m => m.role === 'worker' && m.state === 'idle')

    // 任务按 createdAt ASC 迭代(list 顺序)= 外部提交 FIFO:先提交先分解先分发。
    for (const task of tasks) {
      // SUBMITTED or WORKING 且 assignee=lead 且无子任务 → dispatch 给最优空闲 worker
      const hasChildren = tasks.some(t2 => t2.parentId === task.id)
      if ((task.state === 'SUBMITTED' || task.state === 'WORKING')
        && task.assigneeId === this.lead.agentId
        && !hasChildren) {
        const worker = this.pickWorker(pool, now)
        if (worker) {
          decisions.push({
            kind: 'dispatch',
            parentTaskId: task.id,
            assigneeId: worker.agentId,
            title: task.title,
            description: task.description,
          })
        }
      }
      // FAILED 且 retryCount<3:优先换人重试;仅剩原 assignee 空闲(如单 worker channel)
      // → 由原 assignee 重试(reassign 到自己,走 FAILED→ASSIGNED 恢复);无人可用 → cancel(允许终结)
      if (task.state === 'FAILED') {
        if (task.retryCount < 3) {
          const other = this.pickWorker(pool, now, task.assigneeId)
          if (other) {
            decisions.push({ kind: 'reassign', taskId: task.id, toAgentId: other.agentId })
          }
          else {
            const same = this.pickWorker(pool, now)
            if (same && same.agentId === task.assigneeId) {
              decisions.push({ kind: 'reassign', taskId: task.id, toAgentId: same.agentId })
            }
            else {
              decisions.push({ kind: 'cancel', taskId: task.id })
            }
          }
        }
        else {
          decisions.push({ kind: 'cancel', taskId: task.id })
        }
      }
    }

    // WORKING 停滞检测:progress 停滞超过 stallMs → notify 催一次;再超时 → cancel。
    // 活跃度感知:assignee 正 busy(执行中,含多轮协作/等待回执的长任务)不算停滞 ——
    // progress 数字不是唯一生命信号,看门狗只回收真正被遗弃的任务(idle/stopped 挂着 WORKING)。
    const assigneeState = new Map(this.channelRuntime.getAgents().map(a => [a.agentId, a.getState()]))
    for (const task of tasks) {
      if (task.state !== 'WORKING') continue
      if (assigneeState.get(task.assigneeId) === 'busy') {
        // 执行中:刷新时间戳,防止累计误判(协作回合可能远超 stallMs)
        this.lastProgress.set(task.id, { progress: task.progress, at: now })
        this.notified.delete(task.id)
        continue
      }
      const prev = this.lastProgress.get(task.id)
      if (!prev || prev.progress !== task.progress) {
        this.lastProgress.set(task.id, { progress: task.progress, at: now })
        continue
      }
      if (now - prev.at <= this.stallMs) continue
      if (!this.notified.has(task.id)) {
        this.notified.add(task.id)
        this.lastProgress.set(task.id, { progress: task.progress, at: now })
        decisions.push({
          kind: 'notify',
          toAgentId: task.assigneeId,
          parts: [{ text: `任务「${task.title}」停滞超过 ${this.stallMs}ms,请推进` }],
        })
      }
      else {
        this.notified.delete(task.id)
        this.lastProgress.delete(task.id)
        decisions.push({ kind: 'cancel', taskId: task.id })
      }
    }

    // 子任务全完成且父任务(WAITING/WORKING)→ complete 父
    for (const task of tasks) {
      const children = tasks.filter(t => t.parentId === task.id)
      if (children.length === 0) continue
      if (task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELED') continue
      const allDone = children.every(c => c.state === 'COMPLETED')
      if (allDone && (task.state === 'WAITING' || task.state === 'WORKING')) {
        // goal/pipeline 父任务的完成判定属于 lead 模式剧本(goal 需满意度判定、
        // pipeline 需全部阶段收敛),规则引擎不越权提前收口;loop 与无模式照旧兜底
        const modeInfo = extractTaskMode(task)
        if (modeInfo && (modeInfo.mode === 'goal' || modeInfo.mode === 'pipeline')) continue
        decisions.push({ kind: 'complete', taskId: task.id })
      }
    }

    // 父任务终结:子任务全部终态且存在不可重试的 FAILED/CANCELED
    // → 父任务无法交付 → cancel 父任务(避免 WAITING 永挂;lead 可重新提交)。
    // 已有 COMPLETED 交付的父任务不自动取消——作废尝试(FAILED/CANCELED)不阻塞,
    // 收尾判定属于 lead(goal 模式按目标达成度而非子任务簿记收尾)
    for (const task of tasks) {
      const children = tasks.filter(t => t.parentId === task.id)
      if (children.length === 0) continue
      if (task.state !== 'WAITING' && task.state !== 'WORKING') continue
      const allTerminal = children.every(c => TERMINAL_TASK_STATES[c.state] === true)
      const anyUnsuccessful = children.some(c => c.state !== 'COMPLETED')
      const hasRetryableFailure = children.some(c => c.state === 'FAILED' && c.retryCount < 3)
      const hasCompletedDeliverable = children.some(c => c.state === 'COMPLETED')
      if (allTerminal && anyUnsuccessful && !hasRetryableFailure && !hasCompletedDeliverable) {
        decisions.push({ kind: 'cancel', taskId: task.id })
      }
    }

    return decisions
  }

  /** 执行单条决策(身份=lead,经 TaskEngine 与 ChannelRuntime) */
  private execute(decision: SupervisionDecision): void {
    switch (decision.kind) {
      case 'dispatch': {
        if (!decision.parentTaskId) {
          throw new AppError(400, 'INVALID_DECISION', 'dispatch 决策缺少 parentTaskId')
        }
        // HITL 竞态守卫:快照后成员可能已被用户/lead 移除,目标不存在则跳过本轮
        // (任务保持 SUBMITTED/WORKING,下一轮快照重新决策;避免派发给幽灵成员)
        // listChannelAgents 仅返回 enabled=1 成员,存在即可用
        const target = this.channelRuntime.listChannelAgents().find(a => a.agentId === decision.assigneeId)
        if (!target) {
          console.warn(`[SchedulerLoop:${this.lead.agentId}] dispatch 目标成员已不存在/禁用,跳过: ${decision.assigneeId}`)
          break
        }
        const parent = this.lead.taskEngine.get(decision.parentTaskId)
        if (!parent) throw new AppError(404, 'NOT_FOUND', `父任务不存在: ${decision.parentTaskId}`)
        // lead 自动接取:SUBMITTED → WORKING(§2.2 状态机,dispatch 需父任务处于 WORKING/WAITING)
        if (parent.state === 'SUBMITTED') {
          this.lead.taskEngine.transition(parent.id, 'WORKING', this.lead.agentId)
        }
        this.lead.taskEngine.dispatch(parent, {
          assigneeId: decision.assigneeId,
          title: decision.title,
          description: decision.description,
          parts: decision.parts,
        })
        this.wakeAgent(decision.assigneeId)
        break
      }
      case 'reassign': {
        // HITL 竞态守卫:目标成员被移除/禁用时跳过重派(任务保持 FAILED,留待 lead/用户重试)
        // listChannelAgents 仅返回 enabled=1 成员,存在即可用
        const target = this.channelRuntime.listChannelAgents().find(a => a.agentId === decision.toAgentId)
        if (!target) {
          console.warn(`[SchedulerLoop:${this.lead.agentId}] reassign 目标成员已不存在/禁用,跳过: ${decision.toAgentId}`)
          break
        }
        this.lead.taskEngine.reassign(decision.taskId, decision.toAgentId)
        this.wakeAgent(decision.toAgentId)
        break
      }
      case 'cancel': {
        const task = this.lead.taskEngine.get(decision.taskId)
        this.lead.taskEngine.cancel(decision.taskId, this.lead.agentId)
        // lead 终态同步:经调度器判定取消同样不经 processMessage,重广播队列上下文
        this.lead.refreshStatus()
        if (task) {
          const assignee = this.channelRuntime.getAgents().find(a => a.agentId === task.assigneeId)
          if (assignee && assignee.getState() === 'busy') assignee.abortCurrent()
        }
        break
      }
      case 'complete': {
        // 幂等守卫:LLM lead 可能对已终态任务重复 complete(快照滞后/重复决策)——
        // 静默跳过而非报错,避免调度噪音(正确性不受影响:终态即目标状态)
        const existing = this.lead.taskEngine.get(decision.taskId)
        if (existing && ['COMPLETED', 'CANCELED', 'FAILED'].includes(existing.state)) {
          break
        }
        const completed = this.lead.taskEngine.complete(decision.taskId, decision.artifacts)
        // lead 状态同步:complete 由调度器直接收口(不经 processMessage),终态迁移后
        // 重广播 lead 队列上下文(current→null/completed+1),前端实时反映 lead 判定完成
        this.lead.refreshStatus()
        // 汇总成果走统一事件流(与 harness 事件同构,monitor/WS 可见)
        for (const artifact of decision.artifacts ?? []) {
          this.lead.emitExternal({ kind: 'artifact', artifact }, this.lead.agentId)
        }
        // lead 终态记忆沉淀:调度器直接收口不经过 processMessage,此处补齐 harvest(异常不阻塞调度)
        void this.lead.recordTaskMemory(completed).catch(() => {})
        if (completed.parentId) {
          this.lead.taskEngine.onChildCompleted(completed)
          const parent = this.lead.taskEngine.get(completed.parentId)
          if (parent) this.wakeAgent(parent.assigneeId)
        }
        break
      }
      case 'notify': {
        const message: A2AMessage = {
          messageId: randomUUID(),
          contextId: this.channelRuntime.channelId,
          role: 'ROLE_AGENT',
          parts: decision.parts,
          metadata: {
            'x-aw-target-agent': decision.toAgentId,
            'x-aw-from-agent': this.lead.agentId,
          },
        }
        this.channelRuntime.route(message)
        break
      }
      // 团队成员管理决策(lead 自主扩容/调参/裁撤;经 AgentWorkspace 与工具桥同源路径)。
      // fire-and-forget:成员落库即刻对下一轮快照可见,dispatch 在后续 tick 自然衔接。
      case 'spawn_agent': {
        const ws: AgentWorkspace = this.lead.workspace
        void ws.createTeamMember({
          name: decision.name,
          harness: decision.harness,
          config: decision.config,
          templateId: decision.templateId,
          reason: decision.reason,
        }).catch((err) => {
          console.error(`[SchedulerLoop:${this.lead.agentId}] spawn_agent 决策执行失败:`, err)
        })
        break
      }
      case 'update_agent': {
        const ws: AgentWorkspace = this.lead.workspace
        void ws.updateTeamMember(decision.agentId, {
          name: decision.name,
          config: decision.config,
          enabled: decision.enabled === undefined ? undefined : (decision.enabled ? 1 : 0),
          reason: decision.reason,
        }).catch((err) => {
          console.error(`[SchedulerLoop:${this.lead.agentId}] update_agent 决策执行失败:`, err)
        })
        break
      }
      case 'remove_agent': {
        const ws: AgentWorkspace = this.lead.workspace
        void ws.removeTeamMember(decision.agentId, decision.reason).catch((err) => {
          console.error(`[SchedulerLoop:${this.lead.agentId}] remove_agent 决策执行失败:`, err)
        })
        break
      }
    }
  }

  private wakeAgent(agentId: string): void {
    this.channelRuntime.wakeAgent(agentId)
  }

  private refreshIdle(members: SupervisionSnapshot['members'], now: number): void {
    for (const m of members) {
      if (m.state === 'idle') {
        if (!this.idleSince.has(m.agentId)) this.idleSince.set(m.agentId, now)
      }
      else {
        this.idleSince.delete(m.agentId)
      }
    }
  }

  /**
   * 从本轮空闲池选最优 worker 并消费(选中即移出,一轮不重复用):
   * 队列最短优先(负载均衡),空闲最久次之(FIFO 兜底)。
   */
  private pickWorker(pool: SupervisionSnapshot['members'], now: number, exclude?: string) {
    const idx = pool.findIndex(w => w.agentId !== exclude)
    if (idx < 0) return undefined
    let best = idx
    for (let i = idx + 1; i < pool.length; i++) {
      const a = pool[i]!
      const b = pool[best]!
      const byQueue = (a.queued ?? 0) - (b.queued ?? 0)
      const byIdle = (this.idleSince.get(a.agentId) ?? now) - (this.idleSince.get(b.agentId) ?? now)
      if (byQueue < 0 || (byQueue === 0 && byIdle < 0)) best = i
    }
    return pool.splice(best, 1)[0]
  }

  /** loop 模式:检测主任务完成 → 启动循环控制器重放 */
  private checkLoopCompletion(snapshot: SupervisionSnapshot): void {
    if (this.activeMode !== 'loop') return

    // 找到当前循环新完成的 COMPLETED 主任务(尚未通知过控制器)
    const current = snapshot.tasks.find((t) => {
      if (t.assigneeId !== this.lead.agentId) return false
      if (t.state !== 'COMPLETED') return false
      if (this.loopCompletedTaskIds.has(t.id)) return false
      const modeInfo = extractTaskMode(t)
      return !!modeInfo && modeInfo.mode === 'loop'
    })
    if (!current) {
      // 无新的完成事件,但控制器可能已达到最大次数:清空以允许后续新 loop 任务重新开始
      if (this.loopController?.exhausted) {
        this.loopController = null
      }
      return
    }

    // 同一主任务只通知一次(防每轮 tick 重复计数)
    this.loopCompletedTaskIds.add(current.id)

    // 已有控制器 → 让控制器推进下一轮
    if (this.loopController) {
      this.loopController.onTaskCompleted()
      return
    }

    // 创建 loop 控制器 → 每次主任务完成后等待 intervalMs 再重新提交相同任务
    const modeInfo = extractTaskMode(current)!
    const intervalMs = Math.min(86_400_000, Math.max(100, Math.floor(modeInfo.config.intervalMs ?? 60_000)))
    const maxIterations = modeInfo.config.maxIterations ?? Number.POSITIVE_INFINITY
    if (this.onLoopResubmit) {
      this.loopController = new LoopController(
        this.channelRuntime.channelId,
        current.title,
        current.description ?? '',
        intervalMs,
        maxIterations,
        this.onLoopResubmit,
      )
      this.loopController.onTaskCompleted()
    }
  }
}
