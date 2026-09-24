/**
 * TaskEngineLayer03 —— 状态跃迁与事件应用
 * (分层 4/5,承 TaskEngineLayer02;方法体与原文件逐行一致)
 */
import { TaskEngineLayer02 } from './02-create'
import type { AgentEvent } from '../../agents/agent-interface'
import type { TaskState, WorkspaceTask } from '../../types/task'
import { AppError } from '../../../../utils/errors'
import { TASK_HISTORY_CAP, TRANSITIONS, log, rowToTask } from './helpers'
import { TERMINAL_TASK_STATES } from '../../types/task'
import type { ExecutionFence } from './lease'
import { fenceMatches } from './lease'

export abstract class TaskEngineLayer03 extends TaskEngineLayer02 {
  /** 状态机校验迁移;非法迁移抛 AppError('INVALID_TRANSITION', 400);成功后广播任务事件 */
  transition(taskId: string, state: TaskState, by: string): WorkspaceTask {
    const row = this.repos.tasks.findById(taskId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    const current = row.state as TaskState
    const allowed = TRANSITIONS[current] ?? []
    if (!allowed.includes(state)) {
      throw new AppError(400, 'INVALID_TRANSITION', `非法状态迁移: ${current} → ${state}`)
    }
    // 单 WORKING 不变量(软守卫):同一 assignee 同时只应有一个 WORKING 任务。
    // 消费循环串行结构上已保证;此处观测异常路径(调度竞态/恢复残留)并告警,
    // 不阻断迁移(阻断会让恢复路径卡死,告警 + 事件可观测足以及时纠偏)。
    if (state === 'WORKING' && current !== 'WORKING') {
      const clash = this.repos.tasks
        .listByChannelAssignee(row.channelId, row.assigneeId)
        .find(r => r.id !== taskId && r.state === 'WORKING')
      if (clash) {
        log.warn(`[TaskEngine] 单 WORKING 不变量被突破:assignee=${row.assigneeId.slice(0, 8)} 已有 WORKING 任务 ${clash.id.slice(0, 8)},又迁移 ${taskId.slice(0, 8)} → WORKING(by=${by.slice(0, 8)})`)
      }
    }
    const updated = this.repos.tasks.update(taskId, TERMINAL_TASK_STATES[state]
      // 终态即结束执行:撤销租约(§2.1/§11 active_execution_leases),旧 worker 的
      // 任何后续事件都会因 generation/lease 不再匹配而被丢弃。
      ? { state, executionLeaseRevokedAt: new Date().toISOString() }
      : { state })
    if (!updated) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    void by // 操作者预留(历史/审计);当前行模型无独立字段,暂不持久化
    const view = rowToTask(updated)
    this.hooks?.onTaskChange?.({ taskId, channelId: updated.channelId, state, agentId: by || undefined, task: view })
    return view
  }

  /** 应用 Agent 事件:artifact(分块 append/进度折算)、status(追加 history)、error(FAILED)、done(无) */
  applyEvent(taskId: string, event: AgentEvent, fence?: ExecutionFence): void {
    const task = this.requireTask(taskId)
    // §5.1 执行代次栅栏:携带 generation/lease 的事件必须与任务当前 assignment 一致,
    // 否则是「旧 worker 的迟到事件」——在运行中 reassign 之后绝不允许它写入新执行的结果。
    if (!fenceMatches(task, fence)) {
      log.warn(`[TaskEngine] 丢弃迟到事件:task=${taskId.slice(0, 8)} kind=${event.kind} fence=${fence?.leaseId?.slice(0, 8) ?? '-'} current=${task.executionLeaseId?.slice(0, 8) ?? '-'}`)
      return
    }
    // 终态设防(数据状态驱动不变量):COMPLETED/FAILED/CANCELED 是封闭终态,
    // 迟到事件(cancel→abort 后队列里已映射的 delta/artifact 仍会吐尽)不得
    // 再写入 —— 否则 CANCELED 任务长出"新交付物",状态数据被污染
    if (task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELED') {
      if (event.kind !== 'error' && event.kind !== 'done') return
    }
    switch (event.kind) {
      case 'artifact': {
        const { artifact, append, totalChunks } = event
        const artifacts = [...task.artifacts]
        let progress = task.progress
        if (append) {
          // 追加到同名(或同 id)artifact 的 parts;否则作为新 artifact push
          const idx = artifacts.findIndex(
            a =>
              (artifact.name != null && a.name === artifact.name)
              || a.artifactId === artifact.artifactId,
          )
          if (idx >= 0) {
            const existing = artifacts[idx]!
            artifacts[idx] = { ...existing, parts: [...existing.parts, ...artifact.parts] }
          }
          else {
            artifacts.push(artifact)
          }
          // totalChunks 声明总分块数 → progress = 已收 parts / 总数(每块 1 part 时即分块数)
          if (totalChunks != null && totalChunks > 0) {
            const merged = idx >= 0 ? artifacts[idx] : artifact
            progress = Math.min(100, Math.round(((merged?.parts.length ?? 0) / totalChunks) * 100))
          }
        }
        else {
          artifacts.push(artifact)
        }
        const updatedRow = this.repos.tasks.update(taskId, { artifacts, progress })
        // §7.1 child.artifact:交付物事件必须无条件可见 —— 旧实现只在 progress 变化时
        // 广播,于是「非 append 且未声明 totalChunks」的交付物既不更新进度也不广播,
        // 过程记忆里永远看不到 artifact。
        // 但 **progress 只在真的变化时才放进载荷**:否则同值进度帧会重复下发
        // (task.progress 与前端实体进度对齐依赖"变化才广播"的既有口径)。
        const progressChanged = progress !== task.progress
        this.hooks?.onTaskChange?.({
          taskId,
          channelId: task.channelId,
          ...(progressChanged ? { progress } : {}),
          agentId: task.assigneeId,
          artifactName: artifact.name,
          artifactId: artifact.artifactId,
          task: updatedRow ? rowToTask(updatedRow) : undefined,
        })
        break
      }
      case 'status': {
        // 追加执行历史(有 message 时);条数封顶防 history_json 无限膨胀
        // (每事件整列重写,长任务的 O(n²) 写放大在此收口;完整流在 channel_events)
        if (event.status.message) {
          const history = [...task.history, event.status.message]
          if (history.length > TASK_HISTORY_CAP) history.splice(0, history.length - TASK_HISTORY_CAP)
          this.repos.tasks.update(taskId, { history })
        }
        break
      }
      case 'error': {
        // 执行失败 → FAILED(状态机仅允许 WORKING → FAILED)。
        // 终态幂等:任务已被平台收口(取消/完成/已失败)后到来的错误事件(如
        // 取消触发的 abort 让 omp 回合报 "Interrupted by user")直接忽略 ——
        // 否则会对已 CANCELED 任务撞状态机抛非法迁移(崩溃噪声 + 触发无谓重投)
        if (task.state !== 'WORKING') break
        this.transition(taskId, 'FAILED', task.assigneeId)
        break
      }
      case 'done': {
        // 状态由 complete/fail 显式迁移,done 不改变状态
        break
      }
      case 'message': {
        // 消息事件不改变任务状态/历史(历史由 status 承载)
        break
      }
    }
  }

  list(channelId: string): WorkspaceTask[] {
    return this.repos.tasks.listByChannel(channelId).map(rowToTask)
  }

  get(taskId: string): WorkspaceTask | undefined {
    const row = this.repos.tasks.findById(taskId)
    return row ? rowToTask(row) : undefined
  }
}
