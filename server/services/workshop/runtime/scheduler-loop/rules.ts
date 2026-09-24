/**
 * SchedulerLoopRules —— 规则引擎:快照 → 调度决策
 * (拆分层,承 SchedulerLoopSnapshot;方法体与原文件逐行一致)
 */
import { SchedulerLoopSnapshot } from './snapshot'
import type { SchedulerDecision } from './types'
import type { SupervisionDecision, SupervisionSnapshot } from '../../agents/agent-interface'

export abstract class SchedulerLoopRules extends SchedulerLoopSnapshot {
  /** 内置规则引擎兜底(harness 无关) */
  protected ruleEngine(snapshot: SupervisionSnapshot): SchedulerDecision[] {
    const decisions: SupervisionDecision[] = []
    const { tasks, members, now } = snapshot
    this.refreshIdle(members, now)
    // 本轮可用空闲 worker 池:dispatch/reassign 消费后即从池中移除,
    // 保证一轮内不会把多个任务重复分给同一个"看似空闲"的 worker(其状态尚未翻 busy)。
    const pool = members.filter(m => m.role === 'worker' && m.state === 'idle')

    // 任务按 createdAt ASC 迭代(list 顺序)= 外部提交 FIFO:先提交先分解先分发。
    for (const task of tasks) {
      // FAILED 且 retryCount<3:优先换人重试;仅剩原 assignee 空闲(如单 worker channel)
      // → 由原 assignee 重试(reassign 到自己,走 FAILED→ASSIGNED 恢复);无人可用 → cancel(允许终结)
      if (task.state === 'FAILED') {
        // Roots are Lead-owned orchestration records. A failed root is surfaced to Lead/user;
        // never auto-assign a root to a worker as if it were a child execution.
        if (!task.parentId) continue
        // ROOT_TIMEOUT 已是超时收口结果,不能被恢复规则重新派发。
        if (task.closeReason === 'ROOT_TIMEOUT') continue
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
    // 活跃度感知:assignee 正 busy(执行中,含多轮协作/等待回执的长任务)不算"被遗弃"——
    // 看门狗不回收 busy(取消忙碌中的回合是破坏性的)。
    // 但 busy 且 progress 长期不变(progressSeen 基线)代表"在跑但无产出信号",
    // 用 progressSeen 独立追踪:给 lead 发一次 notify 提醒介入(可见性修复:杜绝
    //  worker 自己觉得在跑、lead 却毫无感知)。是否 cancel 由 lead(supervise)判断,
    // 规则引擎对 busy 不强制取消 —— 只留可见信号,不做破坏性动作。
    const assigneeState = new Map(this.channelRuntime.getAgents().map(a => [a.agentId, a.getState()]))
    for (const task of tasks) {
      if (task.state !== 'WORKING') continue
      // 工具调用即活性:最近 stallMs 内有工具invoke的任务视为健康推进,刷新基线并跳过看门狗。
      // 真实 LLM worker 的长工具链(真实 PLC 写+等待回读)不更新 progress 数字,且回合间隙
      // runtime 会短暂 idle——仅凭 progress 停滞会把健康任务误回收(实测 live-line 闭环任务
      // 交付物已含 CLOSEDLOOP-OK 却被Canceled)。真停滞(无工具活动+无进度)仍走 notify→cancel。
      const lastTool = this.toolActivityOf?.(task.assigneeId) ?? 0
      const toolActive = lastTool > 0 && now - lastTool <= this.stallMs
      if (toolActive) {
        this.lastProgress.set(task.id, { progress: task.progress, at: now })
        this.progressSeen.set(task.id, { progress: task.progress, at: now })
        this.notified.delete(task.id)
        continue
      }
      if (assigneeState.get(task.assigneeId) === 'busy') {
        // busy 且 progress 长期不变:催一次 lead 介入(notify 到 assignee 本人,请其推进/汇报);
        // 尚未到基准时间或 progress 已变 → 刷新基线
        const seen = this.progressSeen.get(task.id)
        if (seen && seen.progress === task.progress && now - seen.at > this.stallMs) {
          if (!this.notified.has(task.id)) {
            this.notified.add(task.id)
            decisions.push({
              kind: 'notify',
              toAgentId: task.assigneeId,
              parts: [{ text: `任务「${task.title}」进度 ${task.progress}% 已 ${Math.round((now - seen.at) / 1000)}s 未变化,请确认是否仍在推进;若卡住请说明阻塞并请求协助` }],
            })
          }
          // 已催过一次仍无变化:不重复催(避免每 tick 打扰),把最终裁决交给 lead
        }
        else {
          this.notified.delete(task.id)
          this.lastProgress.set(task.id, { progress: task.progress, at: now })
        }
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
        // 交回裁决:这里**不能无条件 cancel**。
        // 直接派发给 worker 的任务(无父任务)是由 worker 自己调 complete_task 收口的;
        // 它的回合结束时若漏了这一步,任务会停在 WORKING,assignee 也不再 busy ——
        // 旧实现直接 cancel,把**已经产出的交付物一起作废**(实测:omp worker 干到
        // progress=90、产物齐全,却因没走收口动作被整单取消;换成真实 harness lead 时
        // 由 lead 的监督回合兜住,所以只在 mock/规则引擎这条路径上暴露)。
        // 现在按"有没有真干过活"分流:干过 → 收口(成果保留);没干过 → 仍然取消(防永挂)。
        const didWork = (task.artifacts ?? []).some(a => a.name !== 'input'
          && (a.parts ?? []).some(p => 'text' in p ? p.text.trim().length > 0 : true))
        decisions.push(didWork ? { kind: 'complete', taskId: task.id } : { kind: 'cancel', taskId: task.id })
      }
    }

    // Parent tasks are never auto-accepted by the recovery engine. A COMPLETED child
    // means only that its worker submitted a deliverable; the lead must inspect the
    // bounded artifacts in the next supervision snapshot and explicitly complete,
    // reassign, or dispatch a revision. The same rule applies to goal/pipeline parents.

    return decisions
  }
}
