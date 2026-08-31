/**
 * TaskEngine — 任务对象引擎(runtime 层)。
 * 职责:任务状态机(§2.2)、进度折算、父子关系(dispatch/onChildCompleted)、
 * 完成通知、reassign/cancel。依赖注入 tasks/messages 两个 repo,不持有任何单例。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T4。
 */
import { createLogger } from '../logger'
import { randomUUID } from 'node:crypto'
import type { TaskMetaRow, TaskRepo } from '../db/task.repo'
import type { MessageRepo } from '../db/message.repo'
import { parseJson } from '../db/database'
import type { TaskRow } from '../db/database'
import type { A2AArtifact, A2AMessage, Part } from '../types/a2a'
import type { AgentTaskQueueView, TaskState, WorkspaceTask } from '../types/task'
import { TERMINAL_TASK_STATES } from '../types/task'
import type { AgentEvent } from '../agents/agent-interface'
import { AppError } from '../../../utils/errors'
import { extractTaskMode, isGoalSummaryArtifact, synthesizeGoalSummary } from './execution-mode'

const log = createLogger('workshop.task-engine')

/** 状态机合法迁移表(§2.2);终态(COMPLETED/FAILED/CANCELED)不在表中 → 不可迁移
 *  例外:WAITING(父任务等待子任务合并)→ COMPLETED 属于正常闭环
 *  (触发条件=全部子任务终态;由 complete() 的 done-check 闸门兜底校验) */
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  SUBMITTED: ['WORKING', 'ASSIGNED', 'CANCELED'],
  ASSIGNED: ['WORKING', 'CANCELED'],
  WORKING: ['WAITING', 'COMPLETED', 'FAILED', 'CANCELED'],
  WAITING: ['WORKING', 'COMPLETED', 'CANCELED'],
  FAILED: ['ASSIGNED', 'CANCELED'],
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
    routeReason: row.routeReason || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 元数据行 → 域对象:免 JSON 大列解析(artifacts/history 置空,仅供调度快照/队列视图消费) */
function rowToTaskLite(row: TaskMetaRow): WorkspaceTask {
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
    artifacts: [],
    history: [],
    routeReason: row.routeReason || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 任务执行历史上限(applyEvent 整列重写模型下的写放大有界化) */
const TASK_HISTORY_CAP = 200

export class TaskEngine {
  /**
   * hooks.onTaskChange:任务状态迁移的统一通知点(monitor/WS 消费)。
   * 所有迁移必经 transition(),故状态事件不漏发;create/dispatch 的初始态直接落库,单独补发。
   */
  constructor(
    private readonly repos: { tasks: TaskRepo, messages: MessageRepo },
    private readonly hooks?: {
      /**
       * 任务变更广播(状态迁移带 state;进度变化带 progress;终态迁移经 transition
       * 统一触发)。状态/进度的实时同步唯一出口 —— 前端/WS/monitor 据此对齐实体。
       */
      onTaskChange?(e: { taskId: string, channelId: string, state?: TaskState, progress?: number, agentId?: string, task?: WorkspaceTask }): void
    },
  ) {}

  /** 单 agent 任务队列视图(queued FIFO / current / completed;派生只读投影,无第二份状态) */
  /** 批量队列视图:一次 list(channel) 聚合全部成员(调度快照热路径,消除 O(M) 次查询) */
  queueViewsOf(channelId: string): Map<string, AgentTaskQueueView> {
    const rows = this.repos.tasks.listByChannel(channelId)
    const views = new Map<string, AgentTaskQueueView>()
    for (const row of rows) {
      const task = rowToTask(row)
      let v = views.get(task.assigneeId)
      if (!v) {
        v = { agentId: task.assigneeId, channelId, queued: [], completed: [] }
        views.set(task.assigneeId, v)
      }
      if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') v.queued.push(task)
      else if (task.state === 'WORKING') v.current = task
      else if (task.state === 'COMPLETED') v.completed.push(task)
      // WAITING(等子任务)/FAILED/CANCELED 不计入队列
    }
    return views
  }

  /** 批量队列视图 lite 版(调度快照热路径):元数据投影,免 artifacts/history JSON 大列解析 */
  queueViewsOfLite(channelId: string): Map<string, AgentTaskQueueView> {
    const rows = this.repos.tasks.listByChannelMeta(channelId)
    const views = new Map<string, AgentTaskQueueView>()
    for (const row of rows) {
      const task = rowToTaskLite(row)
      let v = views.get(task.assigneeId)
      if (!v) {
        v = { agentId: task.assigneeId, channelId, queued: [], completed: [] }
        views.set(task.assigneeId, v)
      }
      if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') v.queued.push(task)
      else if (task.state === 'WORKING') v.current = task
      else if (task.state === 'COMPLETED') v.completed.push(task)
    }
    return views
  }

  /** 任务列表 lite 版(调度快照热路径):元数据投影,免 artifacts/history JSON 大列解析。
   *  调度决策/规则引擎/LLM 快照仅消费 id/state/parent/assignee/progress/title/description/retry;
   *  artifacts 置空 → LLM 交付预览行降级为无交付摘要(状态/进度/标题仍完整)。 */
  listLite(channelId: string): WorkspaceTask[] {
    return this.repos.tasks.listByChannelMeta(channelId).map(rowToTaskLite)
  }

  queueViewOf(channelId: string, agentId: string): AgentTaskQueueView {
    // META 投影:本视图在每次 agent 状态广播/队列上下文/调度收口时触发,
    // 全历史整行取回(含 artifacts/history 大 JSON 解析)是最高频的重复解析 ——
    // 队列消费方仅需 id/state/progress/title 等元数据,artifacts 置空即可
    const rows = this.repos.tasks.listByChannelAssigneeMeta(channelId, agentId)
    const queued: WorkspaceTask[] = []
    let current: WorkspaceTask | undefined
    const completed: WorkspaceTask[] = []
    for (const row of rows) {
      const task = rowToTaskLite(row)
      if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') queued.push(task)
      else if (task.state === 'WORKING') current = task
      else if (task.state === 'COMPLETED') completed.push(task)
      // WAITING(等子任务)/FAILED/CANCELED 不计入队列
    }
    return { agentId, channelId, queued, current, completed }
  }

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
    this.hooks?.onTaskChange?.({ taskId: created.id, channelId: created.channelId, state: 'SUBMITTED', agentId: input.assigneeId, task: created })
    return created
  }

  /** 主理人分解:创建子任务(ASSIGNED)+ 向 assignee 投递 assign 消息 + 父任务转 WAITING */
  dispatch(
    parent: WorkspaceTask,
    input: { assigneeId: string, title: string, description?: string, parts?: Part[], routeReason?: string },
  ): WorkspaceTask {
    // 判重下沉(单一入口守卫:REST / LLM 工具 / 调度器直通统一遵守):
    // 同父同标题在途子任务 → 409,快照滞后引发的重复派发在此收口(省 token 不重跑)。
    // 子任务直查(listChildrenMeta;idx_tasks_parent 支撑),免全 channel 扫描。
    const norm = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase()
    const siblingRow = this.repos.tasks.listChildrenMeta(parent.channelId, parent.id)
      .find(r => norm(r.title) === norm(input.title)
        && r.state !== 'COMPLETED' && r.state !== 'CANCELED' && r.state !== 'FAILED')
    if (siblingRow) {
      throw new AppError(409, 'DUPLICATE_DISPATCH', `子任务 "${input.title}" 已在执行中(状态 ${siblingRow.state},指派 ${siblingRow.assigneeId?.slice(0, 8) ?? '?'}),不要重复派发`)
    }
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
      routeReason: input.routeReason ?? '',
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
    this.hooks?.onTaskChange?.({ taskId: created.id, channelId: created.channelId, state: 'ASSIGNED', agentId: input.assigneeId, task: created })
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
    const updated = this.repos.tasks.update(taskId, { state })
    if (!updated) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    void by // 操作者预留(历史/审计);当前行模型无独立字段,暂不持久化
    const view = rowToTask(updated)
    this.hooks?.onTaskChange?.({ taskId, channelId: updated.channelId, state, agentId: by || undefined, task: view })
    return view
  }

  /** 应用 Agent 事件:artifact(分块 append/进度折算)、status(追加 history)、error(FAILED)、done(无) */
  applyEvent(taskId: string, event: AgentEvent): void {
    const task = this.requireTask(taskId)
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
        // 进度变化主动广播(applyEvent 不经 transition,落库进度须实时同步前端
        // task.progress;与 report_progress 的 notifyTask 同口径)
        if (progress !== task.progress) {
          this.hooks?.onTaskChange?.({ taskId, channelId: task.channelId, progress, agentId: task.assigneeId, task: updatedRow ? rowToTask(updatedRow) : undefined })
        }
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

  /** 完成任务:WORKING → COMPLETED(终态)+ 进度置 100(广播由上层 ChannelBus 监听 onTaskEvent 承担);
   *  WAITING → COMPLETED 仅子任务全部完成后允许(所有子任务 COMPLETED 或 CANCELED)。
   *  goal 模式父任务收口保底:lead 未自带结构化「目标完成总结」时平台合成同构交付物
   *  (mock/omp/规则引擎三条完成路径共用此处,确保 goal 完成标志恒存在)。 */
  complete(taskId: string, artifacts?: A2AArtifact[]): WorkspaceTask {
    const task = this.requireTask(taskId)
    const children = this.repos.tasks
      .listByChannel(task.channelId)
      .filter(t => t.parentId === task.id)
    if (task.state === 'WAITING') {
      // 子任务合并闸门:存在未完成的子任务时拒绝完成(避免父与子状态矛盾)
      const pending = children.filter(t => t.state !== 'COMPLETED' && t.state !== 'CANCELED')
      if (pending.length > 0) {
        throw new AppError(400, 'INVALID_STATE', `父任务存在 ${pending.length} 个未完成子任务,不能直接完成(先取消/完成子任务)`)
      }
    }
    // goal 收口保底:已有总结(lead 自写/前置合成)则原样保留
    const modeInfo = extractTaskMode(task)
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
  cancel(taskId: string, by: string): WorkspaceTask {
    const task = this.requireTask(taskId)
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
    // 统计未完成子任务数(排除 COMPLETED/CANCELED);为 0 即最后一个完成。
    // 子任务直查(免全 channel 扫描);完成闸门仅需 state → 元数据投影足够。
    const siblings = this.repos.tasks.listChildrenMeta(parent.channelId, parent.id)
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
