/**
 * SchedulerLoopLayer02 —— 监督快照采集与决策分发
 * (分层 3/5,承 SchedulerLoopLayer01;方法体与原文件逐行一致)
 */
import { SchedulerLoopLayer01 } from './01-tick'
import type { MemberView, SchedulerDecision } from './types'
import type { SupervisionSnapshot } from '../../agents/agent-interface'
import { MAIL_SNAPSHOT_LIMIT, log } from './helpers'
import { TERMINAL_TASK_STATES } from '../../types/task'

export abstract class SchedulerLoopLayer02 extends SchedulerLoopLayer01 {
  /**
   * Lead 决策唯一拥有正常任务分流、派单和验收权。规则引擎仅处理失败重试/停滞恢复；
   * supervise 未实现/抛错/空决策时不能自动把任务派给 worker，也不能把父任务标记完成。
   * 指纹无变化时跳过 LLM，但恢复性规则仍可运行。
   */
  protected async decide(snapshot: SupervisionSnapshot): Promise<SchedulerDecision[]> {
    try {
      if (!this.shouldSupervise(snapshot)) return this.ruleEngine(snapshot)
      this.lastSuperviseAt = Date.now()
      this.lastFingerprint = this.superviseFingerprint(snapshot)
      const decisions = await this.lead.supervise(snapshot)
      if (decisions === null) return this.ruleEngine(snapshot)
      if (decisions.length > 0) return decisions
      // 空决策表示 Lead 本轮决定不采取行动；只允许非破坏性/故障恢复规则补充，
      // 常规派单和父任务验收永不由兜底猜测。
      return this.ruleEngine(snapshot)
    }
    catch (err) {
      log.error(`[SchedulerLoop:${this.lead.agentId}] lead supervise 抛错,仅运行故障恢复规则(不盲派/验收):`, err)
      return this.ruleEngine(snapshot)
    }
  }

  /** 收集快照:全 channel 任务 + 成员状态与队列视图(含未装配成员,标 idle)+ pendingChildren */
  protected collectSnapshot(): SupervisionSnapshot {
    const now = Date.now()
    // lite 快照:元数据投影,免每 tick 对全部任务做 artifacts/history JSON 大列解析
    // (调度决策/规则引擎仅消费状态/进度/标题/描述;LLM 交付预览降级,状态信息仍完整)
    const tasks = this.lead.taskEngine.listForSupervision(this.channelRuntime.channelId, this.lead.agentId)
    // 已装配成员的实时状态
    const wired = new Map(this.channelRuntime.getAgents().map(a => [a.agentId, a.getState()]))
    // channel 全部 enabled 成员(含未装配懒加载成员 → idle,lead 可据此 dispatch);
    // 队列视图来自 tasks 表(未装配成员的排队任务同样可见)
    // 队列视图批量化:一次 list(channel) 聚合全部成员(原每成员一次查询)
    const views = this.lead.taskEngine.queueViewsOfLite(this.channelRuntime.channelId)
    const emptyView = { queued: [] as typeof tasks, current: undefined, completed: [] as typeof tasks }
    const members: MemberView[] = this.channelRuntime.listChannelAgents().map((m) => {
      const view = views.get(m.agentId) ?? emptyView
      const current = view.current
      const progress = current?.progress ?? null
      // 进度基线更新:progress 变化或首次记录时刷新时间;不变则保留起始时刻
      if (current && progress != null) {
        const seen = this.progressSeen.get(current.id)
        if (!seen || seen.progress !== progress) {
          this.progressSeen.set(current.id, { progress, at: now })
        }
      }
      // 停滞识别:执行中任务长期无进度变化(i.e. progress 与上次观测相同且超 stallMs)。
      // busy 状态不再无限豁免 —— 一个进程活着但 LLM 回合内卡死、progress 从不变化的
      // worker 是最危险场景(worker 自认为在跑,lead 无从知晓),必须给 lead 明确信号。
      const seen = current ? this.progressSeen.get(current.id) : undefined
      const stalled = current != null
        && seen != null
        && seen.progress === progress
        && now - seen.at > this.stallMs
      return {
        agentId: m.agentId,
        name: m.name,
        role: m.role,
        state: wired.get(m.agentId) ?? 'idle',
        queued: view.queued.length,
        currentTaskId: current?.id ?? null,
        currentTaskTitle: current?.title ?? null,
        currentTaskProgress: progress,
        completedCount: view.completed.length,
        stalled,
      }
    })
    const pendingChildren: Record<string, number> = {}
    for (const task of tasks) {
      if (!task.parentId) continue
      if (TERMINAL_TASK_STATES[task.state]) continue
      pendingChildren[task.parentId] = (pendingChildren[task.parentId] ?? 0) + 1
    }
    const roots = this.lead.taskEngine.rootQueue(this.channelRuntime.channelId)
    return {
      tick: this.tick,
      now,
      activeRootId: roots.activeRoot?.id ?? null,
      queuedRootIds: roots.queuedRoots.map(t => t.id),
      tasks,
      members,
      pendingChildren,
      // 最近邮件(最新在前):lead 观察 worker 间通信/回执,判断结果是否已产出
      mail: this.supervisionMail ? this.supervisionMail(MAIL_SNAPSHOT_LIMIT) : [],
    }
  }
}
