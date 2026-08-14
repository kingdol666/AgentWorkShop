/**
 * SchedulerLoop — lead 常驻调度循环(统一调度核心)。
 * 定时 tick + 事件唤醒(wake 去抖合并);每轮在 lead.execLock 串行化下:
 * 收集快照 → lead.supervise 决策(未实现/抛错回退内置规则引擎)→ 逐条执行决策。
 * 支持三种执行模式:goal(满意度判断)/ loop(循环重放)/ pipeline(流水线)。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T5。
 */
import { randomUUID } from 'node:crypto'
import type { A2AMessage } from '../types/a2a'
import type { SupervisionDecision, SupervisionSnapshot, ExecutionMode } from '../agents/agent-interface'
import { AppError } from '../../../utils/errors'
import type { ChannelRuntime } from './channel-runtime'
import type { AgentRuntime } from './agent-runtime'
import {
  extractTaskMode,
  buildModeAwarePrompt,
  findModeTask,
  LoopController,
  type ModeConfig,
} from './execution-mode'

/** 成员摘要(快照内) */
interface MemberView {
  agentId: string
  name: string
  role: 'lead' | 'worker'
  state: 'idle' | 'busy' | 'stopped'
}

export interface SchedulerLoopOptions {
  tickMs?: number
  stallMs?: number
}

export class SchedulerLoop {
  private readonly tickMs: number
  private readonly stallMs: number
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
  /** loop 模式下重新提交任务的回调 */
  private onLoopResubmit: ((title: string, description: string) => void) | null = null

  constructor(
    private readonly channelRuntime: ChannelRuntime,
    private readonly lead: AgentRuntime,
    options: SchedulerLoopOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 1000
    this.stallMs = options.stallMs ?? 300000
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

  /** 决策:lead.supervise 优先;未实现/抛错 → 内置规则引擎 */
  private async decide(snapshot: SupervisionSnapshot): Promise<SupervisionDecision[]> {
    try {
      const decisions = await this.lead.supervise(snapshot)
      if (decisions === null) return this.ruleEngine(snapshot)
      return decisions
    }
    catch (err) {
      console.error(`[SchedulerLoop:${this.lead.agentId}] lead supervise 抛错,回退规则引擎:`, err)
      return this.ruleEngine(snapshot)
    }
  }

  /** 收集快照:全 channel 任务 + 成员状态(含未装配成员,标 idle)+ pendingChildren */
  private collectSnapshot(): SupervisionSnapshot {
    const now = Date.now()
    const tasks = this.lead.taskEngine.list(this.channelRuntime.channelId)
    // 已装配成员的实时状态
    const wired = new Map(this.channelRuntime.getAgents().map(a => [a.agentId, a.getState()]))
    // channel 全部 enabled 成员(含未装配懒加载成员 → idle,lead 可据此 dispatch)
    const members: MemberView[] = this.channelRuntime.listChannelAgents().map((m) => {
      const state = wired.get(m.agentId)
      return { agentId: m.agentId, name: m.name, role: m.role, state: state ?? 'idle' }
    })
    const pendingChildren: Record<string, number> = {}
    for (const task of tasks) {
      if (!task.parentId) continue
      if (task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELED') continue
      pendingChildren[task.parentId] = (pendingChildren[task.parentId] ?? 0) + 1
    }
    return { tick: this.tick, now, tasks, members, pendingChildren }
  }

  /** 内置规则引擎兜底(harness 无关) */
  private ruleEngine(snapshot: SupervisionSnapshot): SupervisionDecision[] {
    const decisions: SupervisionDecision[] = []
    const { tasks, members, now } = snapshot
    this.refreshIdle(members, now)
    const idleWorkers = members.filter(m => m.role === 'worker' && m.state === 'idle')

    for (const task of tasks) {
      // SUBMITTED or WORKING 且 assignee=lead 且有空闲 worker 且无子任务 → dispatch 给最久空闲 worker
      const hasChildren = tasks.some(t2 => t2.parentId === task.id)
      if ((task.state === 'SUBMITTED' || task.state === 'WORKING')
        && task.assigneeId === this.lead.agentId
        && !hasChildren) {
        const worker = this.pickIdleWorker(idleWorkers, now)
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
      // FAILED 且 retryCount<3 且空闲 worker → reassign;否则 cancel
      if (task.state === 'FAILED') {
        if (task.retryCount < 3) {
          const worker = this.pickIdleWorker(idleWorkers, now, task.assigneeId)
          if (worker) {
            decisions.push({ kind: 'reassign', taskId: task.id, toAgentId: worker.agentId })
          }
          else {
            decisions.push({ kind: 'cancel', taskId: task.id })
          }
        }
        else {
          decisions.push({ kind: 'cancel', taskId: task.id })
        }
      }
    }

    // WORKING 停滞检测:progress 停滞超过 stallMs → notify 催一次;再超时 → cancel
    for (const task of tasks) {
      if (task.state !== 'WORKING') continue
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
        decisions.push({ kind: 'complete', taskId: task.id })
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
        this.lead.taskEngine.reassign(decision.taskId, decision.toAgentId)
        this.wakeAgent(decision.toAgentId)
        break
      }
      case 'cancel': {
        const task = this.lead.taskEngine.get(decision.taskId)
        this.lead.taskEngine.cancel(decision.taskId, this.lead.agentId)
        if (task) {
          const assignee = this.channelRuntime.getAgents().find(a => a.agentId === task.assigneeId)
          if (assignee && assignee.getState() === 'busy') assignee.abortCurrent()
        }
        break
      }
      case 'complete': {
        const completed = this.lead.taskEngine.complete(decision.taskId, decision.artifacts)
        // 汇总成果走统一事件流(与 harness 事件同构,monitor/WS 可见)
        for (const artifact of decision.artifacts ?? []) {
          this.lead.emitExternal({ kind: 'artifact', artifact }, this.lead.agentId)
        }
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
    }
  }

  private wakeAgent(agentId: string): void {
    this.channelRuntime.wakeAgent(agentId)
  }

  private refreshIdle(members: MemberView[], now: number): void {
    for (const m of members) {
      if (m.state === 'idle') {
        if (!this.idleSince.has(m.agentId)) this.idleSince.set(m.agentId, now)
      }
      else {
        this.idleSince.delete(m.agentId)
      }
    }
  }

  private pickIdleWorker(idleWorkers: MemberView[], now: number, exclude?: string): MemberView | undefined {
    const pool = exclude ? idleWorkers.filter(w => w.agentId !== exclude) : idleWorkers
    if (pool.length === 0) return undefined
    return [...pool].sort(
      (a, b) => (this.idleSince.get(a.agentId) ?? now) - (this.idleSince.get(b.agentId) ?? now),
    )[0]
  }

  /** loop 模式:检测主任务完成 → 启动循环控制器重放 */
  private checkLoopCompletion(snapshot: SupervisionSnapshot): void {
    if (this.activeMode !== 'loop') return
    // 查找已完成的 loop 模式主任务
    for (const task of snapshot.tasks) {
      if (task.assigneeId !== this.lead.agentId) continue
      if (task.state !== 'COMPLETED') continue
      const modeInfo = extractTaskMode(task)
      if (!modeInfo || modeInfo.mode !== 'loop') continue
      // 已有 loopController 在跑 → 跳过
      if (this.loopController) continue
      // 创建 loop 控制器 → 在 intervalMs 后重新提交相同任务
      const intervalMs = modeInfo.config.intervalMs ?? 60_000
      const maxIterations = modeInfo.config.maxIterations ?? Number.POSITIVE_INFINITY
      if (this.onLoopResubmit) {
        this.loopController = new LoopController(
          this.channelRuntime.channelId,
          task.title,
          task.description ?? '',
          intervalMs,
          maxIterations,
          this.onLoopResubmit,
        )
        this.loopController.onTaskCompleted()
      }
    }
  }

  /** 获取当前模式的额外 prompt(注入 lead 的 supervise 上下文) */
  getModePrompt(snapshot: SupervisionSnapshot): string {
    if (!this.activeMode) return ''
    return buildModeAwarePrompt(this.activeMode, this.activeModeConfig, snapshot, this.lead.agentId)
  }
}
