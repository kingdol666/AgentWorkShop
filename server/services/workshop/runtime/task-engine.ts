/**
 * TaskEngine — 任务对象引擎(runtime 层)。
 * 职责:任务状态机(§2.2)、进度折算、父子关系(dispatch/onChildCompleted)、
 * 完成通知、reassign/cancel。依赖注入 tasks/messages 两个 repo,不持有任何单例。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T4。
 */
import { randomUUID } from 'node:crypto'
import type { TaskRepo } from '../db/task.repo'
import type { MessageRepo } from '../db/message.repo'
import { parseJson } from '../db/database'
import type { TaskRow } from '../db/database'
import type { A2AArtifact, A2AMessage, Part } from '../types/a2a'
import type { TaskState, WorkspaceTask } from '../types/task'
import type { AgentEvent } from '../agents/agent-interface'
import { AppError } from '../../../utils/errors'

/** 状态机合法迁移表(§2.2);终态(COMPLETED/FAILED/CANCELED)不在表中 → 不可迁移 */
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  SUBMITTED: ['WORKING', 'ASSIGNED', 'CANCELED'],
  ASSIGNED: ['WORKING', 'CANCELED'],
  WORKING: ['WAITING', 'COMPLETED', 'FAILED', 'CANCELED'],
  WAITING: ['WORKING', 'CANCELED'],
  FAILED: ['ASSIGNED'],
  COMPLETED: [],
  CANCELED: [],
}

/** 行 → 域对象:JSON 列展开(artifacts_json → artifacts,history_json → history) */
function rowToTask(row: TaskRow): WorkspaceTask {
  return {
    id: row.id,
    channelId: row.channelId,
    parentId: row.parentId ?? undefined,
    assigneeId: row.assigneeId,
    creatorId: row.creatorId ?? '',
    title: row.title,
    description: row.description ?? undefined,
    state: row.state as TaskState,
    progress: row.progress,
    retryCount: row.retryCount,
    artifacts: parseJson<A2AArtifact[]>(row.artifactsJson, []),
    history: parseJson<A2AMessage[]>(row.historyJson, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class TaskEngine {
  /**
   * hooks.onTaskChange:任务状态迁移的统一通知点(monitor/WS 消费)。
   * 所有迁移必经 transition(),故状态事件不漏发;create/dispatch 的初始态直接落库,单独补发。
   */
  constructor(
    private readonly repos: { tasks: TaskRepo, messages: MessageRepo },
    private readonly hooks?: {
      onTaskChange?(e: { taskId: string, channelId: string, state: TaskState, agentId?: string }): void
    },
  ) {}

  /** 任务投递消息的文本 parts:title + 可选 description */
  private taskParts(title: string, description?: string): Part[] {
    const parts: Part[] = [{ text: title }]
    if (description) parts.push({ text: description })
    return parts
  }

  /** 向指定 agent 投递任务语义消息(assign/cancel/child-completed 统一入口) */
  private deliverTaskMessage(input: {
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
  private initialArtifacts(parts?: Part[]): A2AArtifact[] {
    if (!parts || parts.length === 0) return []
    return [{ artifactId: randomUUID(), name: 'input', parts }]
  }

  /** 创建任务(落库);若 parentId 存在且父任务 WORKING 则父转 WAITING */
  create(input: {
    channelId: string
    creatorId: string
    assigneeId: string
    title: string
    description?: string
    parentId?: string
    parts?: Part[]
  }): WorkspaceTask {
    const row = this.repos.tasks.create({
      channelId: input.channelId,
      parentId: input.parentId ?? null,
      assigneeId: input.assigneeId,
      creatorId: input.creatorId,
      title: input.title,
      description: input.description ?? null,
      state: 'SUBMITTED',
      artifacts: this.initialArtifacts(input.parts),
      history: [],
    })
    if (input.parentId) {
      const parent = this.repos.tasks.findById(input.parentId)
      if (parent && parent.state === 'WORKING') {
        this.transition(parent.id, 'WAITING', input.creatorId)
      }
    }
    const created = rowToTask(row)
    this.hooks?.onTaskChange?.({ taskId: created.id, channelId: created.channelId, state: 'SUBMITTED', agentId: input.assigneeId })
    return created
  }

  /** 主理人分解:创建子任务(ASSIGNED)+ 向 assignee 投递 assign 消息 + 父任务转 WAITING */
  dispatch(
    parent: WorkspaceTask,
    input: { assigneeId: string, title: string, description?: string, parts?: Part[] },
  ): WorkspaceTask {
    const child = this.repos.tasks.create({
      channelId: parent.channelId,
      parentId: parent.id,
      assigneeId: input.assigneeId,
      creatorId: parent.assigneeId,
      title: input.title,
      description: input.description ?? null,
      state: 'ASSIGNED',
      artifacts: this.initialArtifacts(input.parts),
      history: [],
    })
    this.deliverTaskMessage({
      channelId: parent.channelId,
      taskId: child.id,
      fromAgentId: parent.assigneeId,
      toAgentId: input.assigneeId,
      title: input.title,
      description: input.description,
      kind: 'assign',
    })
    // 父任务若非 WAITING 则转 WAITING(等待子任务)
    const freshParent = this.repos.tasks.findById(parent.id)
    if (freshParent && freshParent.state !== 'WAITING') {
      this.transition(parent.id, 'WAITING', parent.assigneeId)
    }
    const created = rowToTask(child)
    this.hooks?.onTaskChange?.({ taskId: created.id, channelId: created.channelId, state: 'ASSIGNED', agentId: input.assigneeId })
    return created
  }

  /** 状态机校验迁移;非法迁移抛 AppError('INVALID_TRANSITION', 400);成功后广播任务事件 */
  transition(taskId: string, state: TaskState, by: string): WorkspaceTask {
    const row = this.repos.tasks.findById(taskId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    const current = row.state as TaskState
    const allowed = TRANSITIONS[current] ?? []
    if (!allowed.includes(state)) {
      throw new AppError(400, 'INVALID_TRANSITION', `非法状态迁移: ${current} → ${state}`)
    }
    const updated = this.repos.tasks.update(taskId, { state })
    if (!updated) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    void by // 操作者预留(历史/审计);当前行模型无独立字段,暂不持久化
    this.hooks?.onTaskChange?.({ taskId, channelId: updated.channelId, state, agentId: by || undefined })
    return rowToTask(updated)
  }

  /** 应用 Agent 事件:artifact(分块 append/进度折算)、status(追加 history)、error(FAILED)、done(无) */
  applyEvent(taskId: string, event: AgentEvent): void {
    const task = this.requireTask(taskId)
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
        this.repos.tasks.update(taskId, { artifacts, progress })
        break
      }
      case 'status': {
        // 追加执行历史(有 message 时)
        if (event.status.message) {
          this.repos.tasks.update(taskId, { history: [...task.history, event.status.message] })
        }
        break
      }
      case 'error': {
        // 执行失败 → FAILED(状态机仅允许 WORKING → FAILED)
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

  /** 完成任务:WORKING → COMPLETED(终态)+ 进度置 100(广播由上层 ChannelBus 监听 onTaskEvent 承担) */
  complete(taskId: string, artifacts?: A2AArtifact[]): WorkspaceTask {
    const task = this.requireTask(taskId)
    if (artifacts && artifacts.length > 0) {
      this.repos.tasks.update(taskId, { artifacts: [...task.artifacts, ...artifacts] })
    }
    this.transition(taskId, 'COMPLETED', task.assigneeId)
    this.repos.tasks.update(taskId, { progress: 100 })
    return this.requireTask(taskId)
  }

  /** 重新指派:FAILED → ASSIGNED + retryCount +1 + 向新 assignee 投递 assign 消息 */
  reassign(taskId: string, toAgentId: string): WorkspaceTask {
    const task = this.requireTask(taskId)
    this.transition(taskId, 'ASSIGNED', task.assigneeId)
    const updated = this.repos.tasks.update(taskId, {
      assigneeId: toAgentId,
      retryCount: task.retryCount + 1,
    })!
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

  /** 取消任务:CANCELED(终态)+ 向 assignee 投递 cancel 消息 */
  cancel(taskId: string, by: string): WorkspaceTask {
    const task = this.requireTask(taskId)
    this.transition(taskId, 'CANCELED', by)
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

  /**
   * 子任务完成:向父 assignee 投递 child-completed 消息;
   * 最后一个未完成子任务完成时,父任务 WAITING → WORKING(lead 接续汇总)。
   */
  onChildCompleted(child: WorkspaceTask): void {
    const parentId = child.parentId
    if (!parentId) return
    const parent = this.get(parentId)
    if (!parent) return
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
    // 统计未完成子任务数(排除 COMPLETED/CANCELED);为 0 即最后一个完成
    const siblings = this.repos.tasks
      .listByChannel(parent.channelId)
      .filter(t => t.parentId === parent.id)
    const incomplete = siblings.filter(t => t.state !== 'COMPLETED' && t.state !== 'CANCELED')
    if (incomplete.length === 0 && parent.state === 'WAITING') {
      this.transition(parent.id, 'WORKING', child.assigneeId)
    }
  }

  private requireTask(taskId: string): WorkspaceTask {
    const task = this.get(taskId)
    if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    return task
  }
}
