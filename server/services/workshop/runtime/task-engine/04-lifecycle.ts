/**
 * TaskEngineLayer04 —— 完成 / 改派 / 取消 / 子任务回调
 * (分层 5/5,承 TaskEngineLayer03;方法体与原文件逐行一致)
 */
import { TaskEngineLayer03 } from './03-transition'
import type { A2AArtifact } from '../../types/a2a'
import type { WorkspaceTask } from '../../types/task'
import { AppError } from '../../../../utils/errors'
import { extractTaskMode, isGoalSummaryArtifact, synthesizeGoalSummary } from '../execution-mode'
import { rowToTask } from './helpers'

export abstract class TaskEngineLayer04 extends TaskEngineLayer03 {
  /** 完成任务:WORKING → COMPLETED(终态)+ 进度置 100(广播由上层 ChannelBus 监听 onTaskEvent 承担);
   *  WAITING → COMPLETED 仅在所有子任务有交付且 Lead 已提交验收总结时允许。
   *  goal 模式父任务收口保底:lead 未自带结构化「目标完成总结」时平台合成同构交付物
   *  (mock/omp/规则引擎三条完成路径共用此处,确保 goal 完成标志恒存在)。 */
  complete(taskId: string, artifacts?: A2AArtifact[]): WorkspaceTask {
    const task = this.requireTask(taskId)
    if (task.state === 'COMPLETED') return task
    if (task.state === 'CANCELED' || task.state === 'FAILED') {
      throw new AppError(409, 'TASK_TERMINAL', `任务 ${taskId.slice(0, 8)} 已处于终态 ${task.state},不能再完成`)
    }
    const children = this.repos.tasks
      .listByChannel(task.channelId)
      .filter(t => t.parentId === task.id)
    const allArtifacts = [...task.artifacts, ...(artifacts ?? [])]
    const modeInfo = extractTaskMode(task)
    const hasDeliverable = allArtifacts.some(a => a.name !== 'input'
      && a.parts.some(p => 'text' in p ? p.text.trim().length > 0 : true))
    if (children.length > 0) {
      // 父任务不是“所有子任务终态”就可完成：worker 的 COMPLETED 只是交付，
      // Leader 必须检查每个交付并提交自己的验收总结后，才可收口父任务。
      const pending = children.filter(t => t.state !== 'COMPLETED')
      if (pending.length > 0) {
        throw new AppError(400, 'INVALID_STATE', `父任务仍有 ${pending.length} 个未通过验收的子任务(失败/取消也需 Lead 明确处理)`)
      }
      const missingDeliverables = children.filter((child) => {
        const row = this.repos.tasks.findById(child.id)
        if (!row) return true
        const completed = rowToTask(row)
        return !completed.artifacts.some(a => a.name !== 'input'
          && a.parts.some(p => 'text' in p ? p.text.trim().length > 0 : true))
      })
      if (missingDeliverables.length > 0) {
        throw new AppError(400, 'WORKER_DELIVERABLE_MISSING', `子任务缺少可验收交付物: ${missingDeliverables.map(c => c.title).join(', ')}`)
      }
      // goal 模式的显式 complete 决策本身是 Lead 的接受动作；若未附总结，
      // 下方会合成 goal-summary。普通分解任务必须附 Lead 验收总结。
      const hasLeadAcceptance = allArtifacts.some(a => a.name !== 'input'
        && a.parts.some(p => 'text' in p ? p.text.trim().length > 0 : true))
      if (!hasLeadAcceptance && modeInfo?.mode !== 'goal') {
        throw new AppError(400, 'LEAD_ACCEPTANCE_REQUIRED', '父任务必须由 Lead 提交验收总结后才能完成')
      }
    }
    else if (!hasDeliverable && modeInfo?.mode !== 'goal') {
      throw new AppError(400, 'TASK_DELIVERABLE_REQUIRED', '任务完成前必须提交非空 deliverable/summary artifact')
    }
    // goal 收口保底:已有总结(lead 自写/前置合成)则原样保留
    if (modeInfo?.mode === 'goal') {
      const hasSummary = [...task.artifacts, ...(artifacts ?? [])].some(isGoalSummaryArtifact)
      if (!hasSummary) {
        artifacts = [...(artifacts ?? []), synthesizeGoalSummary(
          task,
          children.filter(c => c.state === 'COMPLETED').map(rowToTask),
          modeInfo.config.goalCriteria ?? '任务描述中的需求已全部完成',
        )]
      }
    }
    // 先置进度 100 再迁移:transition 广播的 task.status 帧直接携带 100,前端实体一次对齐
    // (若先迁移后补进度,状态帧读到的是完成前进度,补写又无广播 → 前端进度滞后)
    if (artifacts && artifacts.length > 0) {
      this.repos.tasks.update(taskId, { artifacts: [...task.artifacts, ...artifacts], progress: 100 })
    }
    else {
      this.repos.tasks.update(taskId, { progress: 100 })
    }
    this.transition(taskId, 'COMPLETED', task.assigneeId)
    return this.requireTask(taskId)
  }

  /**
   * 重新指派(lead 对 worker 队列的"调配"):
   *  - SUBMITTED/ASSIGNED(排队中)→ 直接换 assignee(retryCount 不变;排队调配非重试)
   *  - WORKING/WAITING → 拒绝(执行中的任务须先 cancel)
   *  - COMPLETED/CANCELED → 拒绝(真终态)
   * 旧 assignee 队列中的 pending 投递一并作废,只向新 assignee 投递 assign。
   */
  reassign(taskId: string, toAgentId: string): WorkspaceTask {
    const task = this.requireTask(taskId)
    if (task.state === 'COMPLETED' || task.state === 'CANCELED') {
      throw new AppError(400, 'INVALID_STATE', `终态任务不可重新指派(${task.state})`)
    }
    if (task.state === 'WORKING' || task.state === 'WAITING') {
      throw new AppError(400, 'INVALID_STATE', `任务 ${task.state} 执行/等待中,须先取消再调配`)
    }
    const isRetry = task.state === 'FAILED'
    if (isRetry) this.transition(taskId, 'ASSIGNED', task.assigneeId)
    const updated = this.repos.tasks.update(taskId, {
      assigneeId: toAgentId,
      retryCount: isRetry ? task.retryCount + 1 : task.retryCount,
    })
    if (!updated) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    // 旧 assignee 队列中的 assign 投递已过期:作废后仅向新 assignee 投递
    this.repos.messages.consumePendingByTask(taskId)
    this.deliverTaskMessage({
      channelId: task.channelId,
      taskId: task.id,
      fromAgentId: task.creatorId || null,
      toAgentId: toAgentId,
      title: task.title,
      description: task.description,
      kind: 'assign',
    })
    return rowToTask(updated)
  }

  /** 取消任务:CANCELED(终态)+ 作废队列中的过期投递(assignee 不再消费)+ 投递 cancel 通知 */
  cancel(taskId: string, by: string, reason = 'LEAD_CANCEL'): WorkspaceTask {
    const task = this.requireTask(taskId)
    if (task.state === 'CANCELED') return task
    if (task.state === 'COMPLETED' || task.state === 'FAILED') {
      throw new AppError(409, 'TASK_TERMINAL', `任务 ${taskId.slice(0, 8)} 已处于终态 ${task.state},不能取消`)
    }
    this.repos.tasks.update(taskId, { closeReason: reason })
    this.transition(taskId, 'CANCELED', by)
    // 队列中可能仍有该任务的 assign 投递:作废,避免 assignee 消费到已取消任务
    this.repos.messages.consumePendingByTask(taskId)
    this.deliverTaskMessage({
      channelId: task.channelId,
      taskId: task.id,
      fromAgentId: by || null,
      toAgentId: task.assigneeId,
      title: task.title,
      description: task.description,
      kind: 'cancel',
    })
    return this.requireTask(taskId)
  }

  /** 普通根任务超时:活动后代取消,根任务以 FAILED 保留明确超时语义。 */
  timeoutTree(taskId: string, by: string): WorkspaceTask[] {
    const root = this.requireTask(taskId)
    const children = this.cancelTreeChildren(root.id, root.channelId, by, 'ROOT_TIMEOUT')
    const latest = this.get(root.id)
    if (latest && latest.state !== 'COMPLETED' && latest.state !== 'FAILED' && latest.state !== 'CANCELED') {
      this.repos.tasks.update(root.id, { closeReason: 'ROOT_TIMEOUT' })
      if (latest.state === 'SUBMITTED' || latest.state === 'ASSIGNED' || latest.state === 'WAITING') {
        this.transition(root.id, 'WORKING', by)
      }
      this.transition(root.id, 'FAILED', by)
      children.push(this.requireTask(root.id))
    }
    return children
  }

  private cancelTreeChildren(rootId: string, channelId: string, by: string, reason: string): WorkspaceTask[] {
    const ordered: string[] = []
    const visit = (id: string): void => {
      for (const child of this.repos.tasks.listChildrenMeta(channelId, id)) {
        visit(child.id)
        ordered.push(child.id)
      }
    }
    visit(rootId)
    const canceled: WorkspaceTask[] = []
    for (const id of ordered) {
      const current = this.get(id)
      if (!current || current.state === 'COMPLETED' || current.state === 'FAILED' || current.state === 'CANCELED') continue
      canceled.push(this.cancel(id, by, reason))
    }
    return canceled
  }

  /** 取消整棵任务树:后代优先,已终态结果保留。 */
  cancelTree(taskId: string, by: string, reason = 'LEAD_CANCEL'): WorkspaceTask[] {
    const root = this.requireTask(taskId)
    const canceled = this.cancelTreeChildren(root.id, root.channelId, by, reason)
    const current = this.get(root.id)
    if (current && current.state !== 'COMPLETED' && current.state !== 'FAILED' && current.state !== 'CANCELED') {
      canceled.push(this.cancel(root.id, by, reason))
    }
    return canceled
  }

  /**
   * 子任务完成:向父 assignee 投递 child-completed 消息;
   * 最后一个未完成子任务完成时,父任务 WAITING → WORKING(lead 接续汇总)。
   */
  onChildCompleted(child: WorkspaceTask): void {
    const parentId = child.parentId
    if (!parentId) return
    const parent = this.get(parentId)
    if (!parent || parent.state === 'COMPLETED' || parent.state === 'FAILED' || parent.state === 'CANCELED') return
    this.deliverTaskMessage({
      channelId: child.channelId,
      taskId: parent.id,
      fromAgentId: child.assigneeId,
      toAgentId: parent.assigneeId,
      title: child.title,
      description: child.description,
      kind: 'child-completed',
      childTaskId: child.id,
    })
    // 统计未完成子任务数(排除 COMPLETED/CANCELED);为 0 即最后一个完成。
    // 子任务直查(免全 channel 扫描);完成闸门仅需 state → 元数据投影足够。
    const siblings = this.repos.tasks.listChildrenMeta(parent.channelId, parent.id)
    const incomplete = siblings.filter(t => t.state !== 'COMPLETED' && t.state !== 'CANCELED')
    if (incomplete.length === 0 && parent.state === 'WAITING') {
      this.transition(parent.id, 'WORKING', child.assigneeId)
    }
  }

  protected requireTask(taskId: string): WorkspaceTask {
    const task = this.get(taskId)
    if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    return task
  }
}
