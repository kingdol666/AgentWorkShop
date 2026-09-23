/**
 * SchedulerLoopLayer01 —— 内部:回合推进 / 监督节流指纹 / 收口判定
 * (分层 2/5,承 SchedulerLoopLayer00;方法体与原文件逐行一致)
 */
import { SchedulerLoopLayer00 } from './00-state'
import type { SupervisionSnapshot } from '../../agents/agent-interface'
import { IDLE_TICK_CAP_MS, LEAD_DECISION_RETRY_MS, log } from './helpers'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { findModeTask } from '../execution-mode'

export abstract class SchedulerLoopLayer01 extends SchedulerLoopLayer00 {
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
      if (this.started) {
        if (this.pendingWake) {
          // 事件驱动:执行期间有新信号 → 立即下一轮(节奏不退避)
          this.pendingWake = false
          void this.runRound()
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
    if (fingerprint !== this.lastFingerprint) return true

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
    const hasUnplannedLeadRoot = snapshot.tasks.some((task) => {
      if (task.parentId || task.assigneeId !== this.lead.agentId) return false
      if (task.state !== 'SUBMITTED' && task.state !== 'WORKING') return false
      return !snapshot.tasks.some(child => child.parentId === task.id)
    })
    return hasUnplannedLeadRoot && Date.now() - this.lastSuperviseAt >= LEAD_DECISION_RETRY_MS
  }

  protected lastCloseOutAt = 0

  /** 存在子任务已全部终态但尚未由 Lead 明确验收的 WAITING 父任务 */
  protected hasReviewableParent(snapshot: SupervisionSnapshot): boolean {
    return snapshot.tasks.some((t) => {
      if ((t.state !== 'WAITING' && t.state !== 'WORKING') || t.assigneeId !== this.lead.agentId) return false
      const children = snapshot.tasks.filter(c => c.parentId === t.id)
      if (children.length === 0) return false
      return children.every(c => TERMINAL_TASK_STATES[c.state] === true)
    })
  }
}
