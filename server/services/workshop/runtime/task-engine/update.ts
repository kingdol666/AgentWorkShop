/**
 * TaskEngineUpdate —— 任务更新 / 重投递 / 投递辅助
 * (拆分层,承 TaskEngineViews;方法体与原文件逐行一致)
 */
import { TaskEngineViews } from './views'
import type { A2AArtifact, Part } from '../../types/a2a'
import type { WorkspaceTask } from '../../types/task'
import { AppError } from '../../../../utils/errors'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { randomUUID } from 'node:crypto'
import { rowToTask } from './helpers'
import { fenceToMetadata } from './lease'

export abstract class TaskEngineUpdate extends TaskEngineViews {
  /**
   * 修改待执行任务(title/description;lead 对 worker 队列的"改")。
   * 仅 SUBMITTED/ASSIGNED 可改(执行中/终态拒绝);
   * 作废旧 pending 投递并重发 assign,保证 assignee 队列里的任务内容与 DB 一致。
   */
  updateTask(
    taskId: string,
    patch: { title?: string, description?: string },
    by: string,
  ): WorkspaceTask {
    const task = this.requireTask(taskId)
    if (task.state !== 'SUBMITTED' && task.state !== 'ASSIGNED') {
      throw new AppError(400, 'INVALID_STATE', `仅待执行任务可修改(${task.state} 不可改)`)
    }
    if (patch.title === undefined && patch.description === undefined) {
      return task
    }
    const updated = this.repos.tasks.update(taskId, {
      title: patch.title ?? task.title,
      description: patch.description !== undefined ? patch.description : task.description,
    })
    if (!updated) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    // 作废旧投递 + 重发 assign(队列中的任务内容随之为新内容)
    this.repos.messages.consumePendingByTask(taskId)
    this.deliverTaskMessage({
      channelId: task.channelId,
      taskId,
      fromAgentId: by || null,
      toAgentId: task.assigneeId,
      title: updated.title,
      description: updated.description ?? undefined,
      kind: 'assign',
    })
    return rowToTask(updated)
  }

  /**
   * 断线重连重投:非终态任务若无 pending assign 投递(消息已被消费但任务未完成,
   * 如崩溃/异常路径),作废残留投递后向 assignee 重发 assign,由消费方终态检查保证幂等。
   */
  redeliverAssign(taskId: string): WorkspaceTask {
    const task = this.requireTask(taskId)
    if (TERMINAL_TASK_STATES[task.state]) {
      throw new AppError(400, 'INVALID_STATE', `终态任务不可重投(${task.state})`)
    }
    this.repos.messages.consumePendingByTask(taskId)
    this.deliverTaskMessage({
      channelId: task.channelId,
      taskId: task.id,
      fromAgentId: task.creatorId || null,
      toAgentId: task.assigneeId,
      title: task.title,
      description: task.description ?? undefined,
      kind: 'assign',
    })
    return this.requireTask(taskId)
  }

  /** 任务投递消息的文本 parts:title + 可选 description */
  protected taskParts(title: string, description?: string): Part[] {
    const parts: Part[] = [{ text: title }]
    if (description) parts.push({ text: description })
    return parts
  }

  /** 向指定 agent 投递任务语义消息(assign/cancel/child-completed 统一入口) */
  protected deliverTaskMessage(input: {
    channelId: string
    taskId: string
    fromAgentId: string | null
    toAgentId: string
    title: string
    description?: string
    kind: 'assign' | 'cancel' | 'child-completed'
    childTaskId?: string
  }): void {
    const metadata: Record<string, unknown> = {
      'x-aw-task-kind': input.kind,
      'x-aw-task-id': input.taskId,
    }
    if (input.childTaskId) metadata['x-aw-child-task-id'] = input.childTaskId
    // §5.1:任务消息携带 generation/lease,worker 回合原样回传;运行时据此丢弃
    // 重新分配之后到达的旧 worker 事件( fencing)。
    const task = this.repos.tasks.findById(input.taskId)
    if (task) Object.assign(metadata, fenceToMetadata(rowToTask(task)))
    this.repos.messages.create({
      channelId: input.channelId,
      taskId: input.taskId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      role: 'ROLE_USER',
      parts: this.taskParts(input.title, input.description),
      metadata,
    })
  }

  /** 初始成果:提交时附带 parts 作为首个 artifact(无 parts 则为空) */
  protected initialArtifacts(parts?: Part[]): A2AArtifact[] {
    if (!parts || parts.length === 0) return []
    return [{ artifactId: randomUUID(), name: 'input', parts }]
  }
}
