/**
 * SchedulerLoopTick —— 内部:回合推进 / 监督节流指纹 / 收口判定
 * (拆分层,承 SchedulerLoopState;方法体与原文件逐行一致)
 */
import { SchedulerLoopState } from './state'
import type { SupervisionSnapshot } from '../../agents/agent-interface'
import { IDLE_TICK_CAP_MS, LEAD_DECISION_RETRY_MS, log } from './helpers'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { findModeTask } from '../execution-mode'
import { isOrdinaryRoot } from '../task-engine/policy'
import { workshopSettings } from '../../settings'

export abstract class SchedulerLoopTick extends SchedulerLoopState {
  /** HITL 等待豁免登记:同一根任务只发一次顺延日志(落定后清理) */
  protected hitlDeferred = new Set<string>()
  /** 每个根被 HITL 顺延的次数(上限后恢复 ROOT_TIMEOUT,避免 hold 模式永久挂起) */
  protected hitlDeferrals = new Map<string, number>()
  protected async runRound(): Promise<void> {
    this.running = true
    try {
      await this.lead.withExecLock(() => this.tickRound())
    }
    catch (err) {
      log.error(`[SchedulerLoop:${this.lead.agentId}] 一轮调度失败:`, err)
    }
    finally {
      this.running = false
      // Release the tracked promise before a pending wake starts the next round.
      // Otherwise launchRound sees the just-finished promise and drops the wake.
      this.activeRound = null
      if (this.started) {
        if (this.pendingWake) {
          // 事件驱动:执行期间有新信号 → 立即下一轮(节奏不退避)
          this.pendingWake = false
          this.launchRound()
        }
        else {
          // 定时驱动:空闲退避(指纹不变 → 间隔翻倍至 8s 上限;有事件 wake() 即刻打断)
          this.scheduleNext(Math.min(this.tickMs * 2 ** this.idleStreak, IDLE_TICK_CAP_MS))
        }
      }
    }
  }

  protected async tickRound(): Promise<void> {
    this.tick += 1
    const snapshot = this.collectSnapshot()
    // 普通根任务绝对 deadline 优先于 Lead supervise，防止旧决策在超时后继续派发。
    // 排队根豁免(2026-10-05 实测缺陷修复):deadline 语义是「执行预算」而非「提交后总时长」,
    // 预算刷新发生在入场(dispatch SUBMITTED→WORKING)时刻 —— 因此**从未入场的排队根**
    // (SUBMITTED 且非 activeRoot)不应参与过期判定,否则前序根占住执行位时,
    // 后面从未运行的任务会被静默判死(实测:同一工作包两次入队两次 ROOT_TIMEOUT)。
    const expiredRoots = snapshot.tasks.filter(task =>
      isOrdinaryRoot(task)
      && !TERMINAL_TASK_STATES[task.state]
      && task.deadlineAt
      && Date.parse(task.deadlineAt) <= Date.now()
      // SUBMITTED = 从未入场(入场即 WORKING),deadline 语义是执行预算而非提交后总时长,
      // 预算刷新发生在入场时刻 —— 因此一切 SUBMITTED 根都不参与过期判定。
      // 旧条件只豁免「非队头」的排队根:队头 SUBMITTED 根(=activeRootId 指向者)在
      // lead 入场饥饿时(2026-10-06 组合大考实测)照样被处决 —— 饿死 15 分钟后被
      // ROOT_TIMEOUT 收口,与 D1 入场缺陷叠加成"必死"组合。入场兜底见 manager
      // rescueStaleRoots:两者配合后,SUBMITTED 根要么被兜底唤醒入场,要么被用户显式处理。
      && task.state !== 'SUBMITTED')
    if (expiredRoots.length > 0) {
      // HITL 等待豁免(鲁棒性增强):频道内有待批审批(整包方案/单参下发)时,根任务
      // 执行预算顺延一个 root_timeout,不做 ROOT_TIMEOUT 收口 —— 审批自身有 fail-closed
      // 超时(security.recipe_dispatch_timeout_ms),人类思考期不应处决整棵任务树。
      // 豁免仅在「有待批」时生效;审批落定(批准执行/超时关闭)后预算仍耗尽则照常收口。
      // 2026-10-28:此前的 listPending() 无任何过滤 —— 任意 channel 的一张待批单都会让
      // 本 channel 的每个超期根每 tick 顺延并提前 return(不派发/不判超时);hold 模式下
      // 一张无人处理的单可让全平台调度永久停摆。现在只统计本 channel 成员的待批。
      const hitlPending = await (async () => {
        try {
          const { getToolApprovals } = await import('../../agents/tool-approvals')
          const memberIds = new Set(snapshot.members.map(m => m.agentId))
          return getToolApprovals().listPending().some(a => memberIds.has(a.agentId))
        }
        catch { return false }
      })()
      const MAX_HITL_DEFERRALS = 3
      const deferrable = hitlPending
        ? expiredRoots.filter(r => (this.hitlDeferrals.get(r.id) ?? 0) < MAX_HITL_DEFERRALS)
        : []
      if (deferrable.length > 0) {
        // 2026-10-30 修复:原实现要求「全部可顺延」(deferrable.length === expiredRoots.length)
        // 才顺延 —— 只要有一根达顺延上限,连仍受审批保护的根一起 ROOT_TIMEOUT 处决,
        // 留下悬空审批单(人类随后批准,决议落在已死树上,审批面无任务可归)。
        // 改为逐根分流:可顺延的刷新预算(消耗一次顺延),已达上限的照常收口 ——
        // 与"人类思考期不应处决受审批保护的树"语义逐根对齐。
        const budget = new Date(Date.now() + (Number(workshopSettings().root_timeout_ms) || 900_000)).toISOString()
        const deferredIds = new Set(deferrable.map(r => r.id))
        for (const root of deferrable) {
          this.hitlDeferrals.set(root.id, (this.hitlDeferrals.get(root.id) ?? 0) + 1)
          if (!this.hitlDeferred.has(root.id)) {
            this.hitlDeferred.add(root.id)
            log.warn(`[SchedulerLoop:${this.lead.agentId}] 根任务 ${root.id.slice(0, 8)} 预算耗尽,但本频道有 HITL 待批 —— 执行预算顺延至 ${budget}(第 ${this.hitlDeferrals.get(root.id)}/${MAX_HITL_DEFERRALS} 次)`)
          }
          try {
            // 能力探测(mirror execute.ts):极简 TaskEngine 替身可能缺 refreshDeadline,缺失时跳过
            const engine = this.lead.taskEngine as { refreshDeadline?: (id: string, iso: string) => unknown }
            engine.refreshDeadline?.(root.id, budget)
          }
          catch { /* 任务恰好终态:下一 tick 自然收敛 */ }
        }
        for (const root of expiredRoots) {
          if (deferredIds.has(root.id)) continue
          const closed = this.lead.taskEngine.timeoutTree(root.id, this.lead.agentId)
          for (const task of closed) {
            this.channelRuntime.getAgents().find(a => a.agentId === task.assigneeId)?.abortTask?.(task.id)
          }
          // 已收口的根清掉顺延记账(与下方全清语义一致,只是范围收窄到本轮处决的根)
          this.hitlDeferrals.delete(root.id)
          this.hitlDeferred.delete(root.id)
        }
        this.lead.refreshStatus()
        return
      }
      this.hitlDeferred.clear()
      this.hitlDeferrals.clear()
      for (const root of expiredRoots) {
        const closed = this.lead.taskEngine.timeoutTree(root.id, this.lead.agentId)
        for (const task of closed) {
          this.channelRuntime.getAgents().find(a => a.agentId === task.assigneeId)?.abortTask?.(task.id)
        }
      }
      this.lead.refreshStatus()
      return
    }
    // 状态 Map 生命周期修剪:终态/已删任务的条目随轮清理(长会话内存有界)。
    // progressSeen 全程只增不减;notified/lastProgress/loopCompletedTaskIds 统一按任务集收敛。
    const liveIds = new Set(snapshot.tasks.map(t => t.id))
    for (const map of [this.progressSeen, this.lastProgress]) {
      for (const key of map.keys()) {
        if (!liveIds.has(key)) map.delete(key)
      }
    }
    for (const key of this.notified) {
      if (!liveIds.has(key)) this.notified.delete(key)
    }
    for (const key of this.loopCompletedTaskIds) {
      if (!liveIds.has(key)) this.loopCompletedTaskIds.delete(key)
    }
    // 空闲判定指纹(与 supervise 节流同源):任务/成员/邮件信号均未变 → 退避
    const fp = this.superviseFingerprint(snapshot)
    if (fp === this.lastRoundFingerprint) this.idleStreak++
    else {
      this.idleStreak = 0
      this.lastRoundFingerprint = fp
    }

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
        log.error(`[SchedulerLoop:${this.lead.agentId}] 执行决策失败:`, decision, err)
      }
    }
  }

  /**
   * supervise 智能节流(token 效率,纯指纹驱动):任务/成员/邮件变化才请求 Lead；
   * 规则引擎仅负责故障恢复，不承担常规派单或父任务验收。首轮必跑。
   */
  protected superviseFingerprint(snapshot: SupervisionSnapshot): string {
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

  protected shouldSupervise(snapshot: SupervisionSnapshot): boolean {
    if (this.lead.supervise === null) return false // no Lead decision capability: recovery only
    if (this.lastSuperviseAt === 0) return true
    const fingerprint = this.superviseFingerprint(snapshot)
    if (fingerprint !== this.lastFingerprint) {
      const [, previousMembers, previousMail] = this.lastFingerprint.split('#')
      const [, currentMembers, currentMail] = fingerprint.split('#')
      const activeRoot = snapshot.activeRootId ? snapshot.tasks.find(t => t.id === snapshot.activeRootId) : null
      const activeRootAlive = Boolean(activeRoot) && !TERMINAL_TASK_STATES[activeRoot!.state]
      const terminalTaskOnlyChange = snapshot.tasks.every(task => TERMINAL_TASK_STATES[task.state])
        && !activeRootAlive
        && previousMembers === currentMembers
        && previousMail === currentMail
      if (!terminalTaskOnlyChange) return true
    }

    // Retry incomplete acceptance periodically, including the WORKING parent state
    // used after the final child completes.
    if (this.hasReviewableParent(snapshot)) {
      if (Date.now() - this.lastCloseOutAt >= 30_000) {
        this.lastCloseOutAt = Date.now()
        return true
      }
      return false
    }

    // Failed/empty triage does not trigger blind dispatch. Retry the Lead after backoff.
    // activeRootId 只排除「仍活跃」的根:它指向的根已终态(如 ROOT_TIMEOUT)时不得再排除
    // 其他未规划根 —— 否则中止回合遗留的 SUBMITTED 根会因指纹不变而永无重试,直到新根超时。
    const activeRoot = snapshot.activeRootId ? snapshot.tasks.find(t => t.id === snapshot.activeRootId) : null
    const activeRootAlive = Boolean(activeRoot) && !TERMINAL_TASK_STATES[activeRoot!.state]
    const hasUnplannedLeadRoot = snapshot.tasks.some((task) => {
      if (task.parentId || task.assigneeId !== this.lead.agentId) return false
      if (snapshot.activeRootId && activeRootAlive && task.id !== snapshot.activeRootId) return false
      if (task.state !== 'SUBMITTED' && task.state !== 'WORKING') return false
      return !snapshot.tasks.some(child => child.parentId === task.id)
    })
    return hasUnplannedLeadRoot && Date.now() - this.lastSuperviseAt >= LEAD_DECISION_RETRY_MS
  }

  protected lastCloseOutAt = 0

  /** 存在子任务已全部终态但尚未由 Lead 明确验收的父任务。
   *  口径=「全部终态即提醒」:失败/取消分支此刻正是需要 Lead 行动的信号——
   *  Lead 拥有 supersede(显式替代)工具可处置后再收口(整改计划阶段1 F2)。 */
  protected hasReviewableParent(snapshot: SupervisionSnapshot): boolean {
    return snapshot.tasks.some((t) => {
      if ((t.state !== 'WAITING' && t.state !== 'WORKING') || t.assigneeId !== this.lead.agentId) return false
      if (snapshot.activeRootId && t.id !== snapshot.activeRootId) return false
      const children = snapshot.tasks.filter(c => c.parentId === t.id)
      if (children.length === 0) return false
      return children.every(c => TERMINAL_TASK_STATES[c.state] === true)
    })
  }
}
