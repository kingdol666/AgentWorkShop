/**
 * ProjectService —— V1 项目核心（项目办公室 + 生命周期 + 成员 Channel 绑定）。
 *
 * 边界（2026-11-03 v3.0）：
 *  - 普通 private Channel 承载 Project Leader（agent_kind='project_leader'）；
 *  - 不引入 channels.kind；不挂 Channel SchedulerLoop；
 *  - 项目状态唯一写者；所有变更走本服务；
 *  - V1 不做 leader 自建 Channel、不做自主 replan。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { AgentChannelManager } from '../runtime/manager'
import type { ProjectApprovalRow, ProjectChannelRow, ProjectDeliverableRow, ProjectDecisionRow, ProjectEventRow, ProjectResultRow, ProjectRow, ProjectWorkItemRow } from '../db/project.repo'
import {
  createProjectRepo,
  createProjectChannelRepo,
  createProjectDeliverableRepo,
  createProjectWorkItemRepo,
  createProjectAttemptRepo,
  createProjectResultRepo,
  createProjectApprovalRepo,
  createProjectDecisionRepo,
  createProjectEventRepo,
} from '../db/project.repo'
import { createTaskRepo } from '../db/task.repo'
import { withTransaction } from '../db/transaction'
import { parseJson } from '../db/database'
import { AppError } from '../../../utils/errors'

export interface ProjectActor {
  id: string
  role?: string
  /** 项目 leader agent 身份（review 路径用） */
  agentId?: string
}

export interface CreateProjectInput {
  name: string
  description?: string
  objective: string
  successCriteria?: string[]
  mode?: 'observe' | 'supervised' | 'auto'
  leaderHarness?: string
  leaderConfig?: Record<string, unknown>
}

export class ProjectService {
  private readonly projects
  private readonly bindings
  private readonly deliverables
  private readonly workItems
  private readonly attempts
  private readonly results
  private readonly approvals
  private readonly decisions
  private readonly events
  private readonly tasks

  constructor(
    private readonly manager: AgentChannelManager,
    private readonly db: DatabaseSync,
  ) {
    this.projects = createProjectRepo(db)
    this.bindings = createProjectChannelRepo(db)
    this.deliverables = createProjectDeliverableRepo(db)
    this.workItems = createProjectWorkItemRepo(db)
    this.attempts = createProjectAttemptRepo(db)
    this.results = createProjectResultRepo(db)
    this.approvals = createProjectApprovalRepo(db)
    this.decisions = createProjectDecisionRepo(db)
    this.events = createProjectEventRepo(db)
    this.tasks = createTaskRepo(db)
  }

  list(actor: ProjectActor): ProjectRow[] {
    return actor.role === 'admin' ? this.projects.listAll() : this.projects.listByOwner(actor.id)
  }

  get(id: string, actor: ProjectActor): ProjectRow {
    const p = this.projects.findById(id)
    if (!p) throw new AppError(404, 'NOT_FOUND', `Project 不存在: ${id}`)
    this.requireOwner(p, actor)
    return p
  }

  async create(input: CreateProjectInput, actor: ProjectActor): Promise<ProjectRow> {
    const name = input.name.trim()
    const objective = input.objective.trim()
    if (!name) throw new AppError(400, 'BAD_REQUEST', 'Project 名称不能为空')
    if (!objective) throw new AppError(400, 'BAD_REQUEST', 'Project 目标不能为空')
    const project = this.projects.create({
      name,
      description: input.description,
      objective,
      successCriteriaJson: JSON.stringify(input.successCriteria ?? []),
      mode: input.mode ?? 'supervised',
      ownerUserId: actor.id,
      planApprovalRequired: 1,
      configJson: JSON.stringify({ leaderHarness: input.leaderHarness ?? 'mock' }),
    })

    try {
      const office = await this.manager.createChannel({
        name: `${name} · 项目办公室`,
        description: `Project office for ${name}`,
        scenarioPrompt: [
          `# 项目章程`,
          `目标：${objective}`,
          input.successCriteria?.length ? `成功标准：${input.successCriteria.join('；')}` : '',
          '你是项目总工（Project Leader）。只做项目级规划、派发建议、成果复核与升级；',
          '不执行 Channel 内任务，不直接写工业参数，不直接改项目状态。',
        ].filter(Boolean).join('\n'),
        leadAgent: {
          name: 'Project Leader',
          harness: input.leaderHarness ?? 'mock',
          config: { ...(input.leaderConfig ?? {}), systemPromptPrefix: '你是项目总工（Project Leader），只做项目级规划与复核。' },
          agentKind: 'project_leader',
        },
        ownerUserId: actor.id,
        actor,
      })
      // 办公室私聊开启：Project 页侧栏/owner 指令需要 chat；默认 private。
      await this.manager.updateChannel(office.channelId, { chatEnabled: 1 }, actor)
      const updated = this.projects.update(project.id, {
        officeChannelId: office.channelId,
        leadAgentId: office.leadAgentId ?? null,
      })
      if (!updated) throw new AppError(500, 'INTERNAL', 'Project 创建后无法回填办公室指针')
      return updated
    }
    catch (err) {
      // 失败不留可激活的半成品：标记 archived，owner 可见并重试。
      this.projects.update(project.id, { status: 'archived' })
      throw err
    }
  }

  activate(id: string, actor: ProjectActor): ProjectRow {
    const p = this.get(id, actor)
    if (p.status === 'active') return p
    if (p.status !== 'draft' && p.status !== 'paused') {
      throw new AppError(409, 'PROJECT_STATE_INVALID', `Project 状态 ${p.status} 不能激活`)
    }
    if (!p.officeChannelId || !p.leadAgentId) {
      throw new AppError(409, 'PROJECT_OFFICE_MISSING', 'Project 缺少办公室频道/Leader，不能激活')
    }
    const office = this.manager.getChannelForUser(p.officeChannelId, actor.id)
    if (!office || office.enabled !== 1) {
      throw new AppError(409, 'PROJECT_OFFICE_DISABLED', 'Project 办公室频道不存在或已禁用')
    }
    const activeBindings = this.bindings.listByProject(id).filter(b => b.status === 'active')
    if (activeBindings.length === 0) {
      throw new AppError(409, 'PROJECT_NO_CHANNELS', '至少绑定一个成员 Channel 才能激活')
    }
    const required = this.deliverables.listByProject(id).filter(d => d.required === 1)
    if (required.length === 0) {
      throw new AppError(409, 'PROJECT_NO_DELIVERABLES', '至少定义一个必选交付物才能激活（V1 plan 审批在 PR4 接入）')
    }
    return this.projects.update(id, { status: 'active' })!
  }

  pause(id: string, actor: ProjectActor): ProjectRow {
    const p = this.get(id, actor)
    if (p.status !== 'active') throw new AppError(409, 'PROJECT_STATE_INVALID', `Project 状态 ${p.status} 不能暂停`)
    return this.projects.update(id, { status: 'paused' })!
  }

  resume(id: string, actor: ProjectActor): ProjectRow {
    const p = this.get(id, actor)
    if (p.status !== 'paused') throw new AppError(409, 'PROJECT_STATE_INVALID', `Project 状态 ${p.status} 不能恢复`)
    return this.projects.update(id, { status: 'active' })!
  }

  archive(id: string, actor: ProjectActor): ProjectRow {
    const p = this.get(id, actor)
    if (p.status === 'archived') return p
    // V1：只允许从非 active 状态归档；active 先 pause/complete。
    if (p.status === 'active') throw new AppError(409, 'PROJECT_STATE_INVALID', 'active 项目先暂停或完成再归档')
    for (const b of this.bindings.listByProject(id)) {
      if (b.status === 'active') this.bindings.setStatus(id, b.channelId, 'archived')
    }
    return this.projects.update(id, { status: 'archived' })!
  }

  listChannels(id: string, actor: ProjectActor): ProjectChannelRow[] {
    this.get(id, actor)
    return this.bindings.listByProject(id)
  }

  listDeliverables(id: string, actor: ProjectActor): ProjectDeliverableRow[] {
    this.get(id, actor)
    return this.deliverables.listByProject(id)
  }

  createDeliverable(id: string, actor: ProjectActor, input: {
    name: string
    description?: string
    ownerChannelId?: string
    required?: boolean
    acceptanceCriteria?: string[]
    dueAt?: string
    dependsOn?: string[]
  }): ProjectDeliverableRow {
    const p = this.get(id, actor)
    if (p.status === 'archived' || p.status === 'completed') {
      throw new AppError(409, 'PROJECT_STATE_INVALID', `Project 状态 ${p.status} 不能新增交付物`)
    }
    if (!input.name?.trim()) throw new AppError(400, 'BAD_REQUEST', '交付物名称不能为空')
    if (input.ownerChannelId) {
      const bound = this.bindings.listByProject(id).find(b => b.channelId === input.ownerChannelId && b.status === 'active')
      if (!bound) throw new AppError(409, 'CHANNEL_NOT_IN_PROJECT', '交付物所属 Channel 未绑定到该项目')
    }
    return this.deliverables.create({
      projectId: id,
      name: input.name.trim(),
      description: input.description,
      ownerChannelId: input.ownerChannelId,
      required: input.required === false ? 0 : 1,
      acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria ?? []),
      dueAt: input.dueAt ?? null,
      dependsOnJson: JSON.stringify(input.dependsOn ?? []),
      createdBy: actor.id,
    })
  }

  listWorkItems(id: string, actor: ProjectActor): ProjectWorkItemRow[] {
    this.get(id, actor)
    return this.workItems.listByProject(id)
  }

  createWorkItem(id: string, actor: ProjectActor, input: {
    deliverableId: string
    channelId: string
    title: string
    brief?: string
    priority?: number
    weight?: number
    dependsOn?: string[]
    acceptanceCriteria?: string[]
    resultKey?: string
    execBudgetMinutes?: number
    dedupeKey?: string
  }): ProjectWorkItemRow {
    const p = this.get(id, actor)
    if (p.status === 'archived' || p.status === 'completed') {
      throw new AppError(409, 'PROJECT_STATE_INVALID', `Project 状态 ${p.status} 不能新增工作项`)
    }
    const d = this.deliverables.listByProject(id).find(x => x.id === input.deliverableId)
    if (!d) throw new AppError(404, 'NOT_FOUND', '交付物不存在或不属于该项目')
    const bound = this.bindings.listByProject(id).find(b => b.channelId === input.channelId && b.status === 'active')
    if (!bound) throw new AppError(409, 'CHANNEL_NOT_IN_PROJECT', '工作项目标 Channel 未绑定到该项目')
    if (!input.title?.trim()) throw new AppError(400, 'BAD_REQUEST', '工作项标题不能为空')
    return this.workItems.create({
      projectId: id,
      deliverableId: d.id,
      channelId: input.channelId,
      title: input.title.trim(),
      brief: input.brief,
      priority: input.priority,
      weight: input.weight,
      dependsOnJson: JSON.stringify(input.dependsOn ?? []),
      acceptanceJson: JSON.stringify(input.acceptanceCriteria ?? []),
      resultKey: input.resultKey,
      planVersion: p.planVersion,
      execBudgetMinutes: input.execBudgetMinutes,
      traceId: input.dedupeKey ?? `work:${d.id}:${input.title.trim()}`,
      dedupeKey: input.dedupeKey ?? `${d.id}:${input.title.trim()}`,
      createdBy: actor.id,
    })
  }

  /**
   * 派发工作项到成员 Channel root task。
   * V1 只允许 project active；同一 work item 只允许一个 live attempt；
   * planVersion 在项目已有 approved plan 时必须匹配。
   */
  async dispatchWorkItem(id: string, workItemId: string, actor: ProjectActor): Promise<ProjectWorkItemRow> {
    const p = this.get(id, actor)
    if (p.status !== 'active') throw new AppError(409, 'PROJECT_NOT_ACTIVE', `Project 状态 ${p.status} 不能派发`)
    const wi = this.workItems.findById(workItemId)
    if (!wi || wi.projectId !== id) throw new AppError(404, 'NOT_FOUND', '工作项不存在或不属于该项目')
    if (wi.currentAttemptId) {
      const live = this.attempts.findLiveByWorkItem(wi.id)
      if (live) throw new AppError(409, 'WORK_ITEM_IN_FLIGHT', '工作项已有在飞 attempt')
    }
    if (p.planVersion > 0 && wi.planVersion !== p.planVersion) {
      throw new AppError(409, 'PLAN_VERSION_STALE', `工作项计划版本 ${wi.planVersion} != 当前 ${p.planVersion}`)
    }
    const deps = parseJson<string[]>(wi.dependsOnJson, [])
    for (const depId of deps) {
      const dep = this.workItems.findById(depId)
      if (!dep || !['COMPLETED', 'CANCELED', 'SUPERSEDED'].includes(dep.state)) {
        throw new AppError(409, 'DEPENDENCY_NOT_READY', `依赖工作项 ${depId} 未完成`)
      }
    }
    const d = this.deliverables.listByProject(id).find(x => x.id === wi.deliverableId)
    if (!d) throw new AppError(404, 'NOT_FOUND', '工作项交付物不存在')
    const bound = this.bindings.listByProject(id).find(b => b.channelId === wi.channelId && b.status === 'active')
    if (!bound) throw new AppError(409, 'CHANNEL_NOT_IN_PROJECT', '目标 Channel 未绑定到该项目')
    const channel = this.manager.getChannelForUser(wi.channelId, actor.id)
    if (!channel || channel.enabled !== 1) throw new AppError(409, 'CHANNEL_DISABLED', '目标 Channel 不存在或已禁用')
    if (!channel.leadAgentId) throw new AppError(409, 'CHANNEL_NO_LEAD', '目标 Channel 没有 lead')

    const attemptNo = this.attempts.listByWorkItem(wi.id).reduce((max, a) => Math.max(max, a.attemptNo), 0) + 1
    const sourceKey = `pw:${wi.id}:${attemptNo}`
    const traceId = wi.traceId || `trace:${wi.id}`
    const attempt = this.attempts.create({
      projectId: id, workItemId: wi.id, attemptNo, channelId: wi.channelId, sourceKey, traceId,
    })
    try {
      const { task } = await this.manager.submitProjectRoot({
        projectId: id,
        workItemId: wi.id,
        attemptNo,
        sourceKey,
        traceId,
        channelId: wi.channelId,
        title: wi.title,
        description: wi.brief,
        execBudgetMinutes: wi.execBudgetMinutes,
      })
      this.attempts.setDispatched(attempt.id, task.id)
      return this.workItems.update(wi.id, {
        state: 'DISPATCHED',
        stateReason: null,
        currentAttemptId: attempt.id,
        traceId,
        planVersion: p.planVersion,
      })!
    }
    catch (err) {
      this.attempts.close(attempt.id, 'CLOSED', err instanceof Error ? err.message : String(err))
      this.workItems.update(wi.id, {
        state: 'BLOCKED',
        stateReason: err instanceof Error ? err.message : String(err),
        currentAttemptId: null,
      })
      throw err
    }
  }

  listResults(id: string, actor: ProjectActor): ProjectResultRow[] {
    this.get(id, actor)
    return this.results.listByProject(id)
  }

  listApprovals(id: string, actor: ProjectActor): ProjectApprovalRow[] {
    this.get(id, actor)
    return this.approvals.listPending(id)
  }

  listDecisions(id: string, actor: ProjectActor): ProjectDecisionRow[] {
    this.get(id, actor)
    return this.decisions.listByProject(id)
  }

  listEvents(id: string, actor: ProjectActor): ProjectEventRow[] {
    this.get(id, actor)
    return this.events.listByProject(id)
  }

  /**
   * 确定性对账：root task 终态 → 工作项状态；COMPLETED 自动生成成果 draft；
   * 逾期/缺失 attempt → BLOCKED；过期审批收敛。V1 不做 LLM 决策。
   */
  reconcile(id: string, actor: ProjectActor): { workItems: ProjectWorkItemRow[], expiredApprovals: number } {
    this.get(id, actor)
    return this.reconcileWith(id, actor)
  }

  /** 插件定时器用：跳过 owner 校验，actor=system。 */
  reconcileInternal(id: string): { workItems: ProjectWorkItemRow[], expiredApprovals: number } {
    return this.reconcileWith(id, { id: 'system', role: 'system' })
  }

  listActiveProjects(): ProjectRow[] {
    return this.projects.listAll().filter(p => p.status === 'active')
  }

  private reconcileWith(id: string, actor: ProjectActor): { workItems: ProjectWorkItemRow[], expiredApprovals: number } {
    for (const wi of this.workItems.listByProject(id)) {
      if (['COMPLETED', 'FAILED', 'CANCELED', 'SUPERSEDED'].includes(wi.state)) continue
      if (wi.deadlineAt && Date.parse(wi.deadlineAt) < Date.now()) {
        this.workItems.update(wi.id, { state: 'BLOCKED', stateReason: 'OVERDUE' })
        this.record(id, 'work.overdue', actor, { workItemId: wi.id }, wi.traceId, 'work.overdue', `work:${wi.id}:overdue`, { workItemId: wi.id })
        continue
      }
      const attempt = wi.currentAttemptId ? this.attempts.findById(wi.currentAttemptId) : undefined
      if (!attempt || !attempt.channelTaskId) {
        this.workItems.update(wi.id, { state: 'BLOCKED', stateReason: 'ATTEMPT_MISSING' })
        this.record(id, 'work.blocked', actor, { workItemId: wi.id, reason: 'ATTEMPT_MISSING' }, wi.traceId, 'work.blocked', `work:${wi.id}:attempt-missing`, { workItemId: wi.id, reason: 'ATTEMPT_MISSING' })
        continue
      }
      const task = this.tasks.findById(attempt.channelTaskId)
      if (!task) {
        this.workItems.update(wi.id, { state: 'BLOCKED', stateReason: 'TASK_MISSING' })
        this.record(id, 'work.blocked', actor, { workItemId: wi.id, reason: 'TASK_MISSING' }, wi.traceId, 'work.blocked', `work:${wi.id}:task-missing`, { workItemId: wi.id, reason: 'TASK_MISSING' })
        continue
      }
      if (task.state === 'COMPLETED') {
        this.workItems.update(wi.id, { state: 'COMPLETED', stateReason: null, closedAt: new Date().toISOString(), closeReason: 'ROOT_COMPLETED' })
        this.ensureDraftFromTask(task.id)
        this.record(id, 'work.completed', actor, { workItemId: wi.id, taskId: task.id }, wi.traceId, 'work.completed', `work:${wi.id}:completed`, { workItemId: wi.id, taskId: task.id })
        continue
      }
      if (task.state === 'FAILED' || task.state === 'CANCELED') {
        this.workItems.update(wi.id, { state: task.state, stateReason: task.closeReason ?? task.state, closedAt: new Date().toISOString(), closeReason: task.closeReason ?? task.state })
        this.record(id, 'work.failed', actor, { workItemId: wi.id, taskId: task.id, state: task.state }, wi.traceId, 'work.failed', `work:${wi.id}:${task.state.toLowerCase()}`, { workItemId: wi.id, taskId: task.id, state: task.state })
        continue
      }
      if (task.state === 'WORKING' || task.state === 'WAITING' || task.state === 'ASSIGNED') {
        if (wi.state !== 'RUNNING') this.workItems.update(wi.id, { state: 'RUNNING', stateReason: null })
        continue
      }
    }
    const expiredApprovals = this.approvals.expire(id)
    if (expiredApprovals > 0) {
      this.record(id, 'approval.expired', actor, { expiredApprovals }, '', 'approval.expired', `approval:expired:${Date.now()}`, { expiredApprovals })
    }
    return { workItems: this.workItems.listByProject(id), expiredApprovals }
  }

  /** root COMPLETED 时自动生成 draft；同 work item/attempt/key 幂等。 */
  ensureDraftFromTask(taskId: string): ProjectResultRow | undefined {
    const task = this.tasks.findById(taskId)
    if (!task || task.state !== 'COMPLETED' || task.source !== 'project' || !task.projectId || !task.projectWorkItemId) return undefined
    const wi = this.workItems.findById(task.projectWorkItemId)
    if (!wi) return undefined
    const attemptNo = task.projectAttemptNo ?? 0
    const existing = this.results.findByWorkItemAttempt(wi.id, attemptNo, wi.resultKey)
    if (existing) return existing
    const project = this.projects.findById(task.projectId)
    if (!project) return undefined
    const channel = this.manager.getChannelForUser(wi.channelId, project.ownerUserId)
    const artifacts = parseJson<Array<{ artifactId?: string, name?: string, parts?: Array<{ text?: string }> }>>(task.artifactsJson, [])
    const usable = artifacts.filter(a => a.name !== 'input')
    const summary = usable
      .flatMap(a => (a.parts ?? []).map(p => p.text ?? ''))
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000) || task.title
    const evidence = usable.map(a => ({ artifactId: a.artifactId ?? '', name: a.name ?? '', kind: 'artifact' }))
    const version = this.results.nextVersion(task.projectId, wi.deliverableId, wi.channelId, wi.resultKey)
    const result = this.results.create({
      projectId: task.projectId,
      deliverableId: wi.deliverableId,
      channelId: wi.channelId,
      lineId: channel?.lineId ?? '',
      workItemId: wi.id,
      attemptNo,
      resultKey: wi.resultKey,
      version,
      title: `${wi.title} 成果`,
      summary,
      payloadJson: JSON.stringify({ taskId: task.id, artifactNames: usable.map(a => a.name ?? '') }),
      evidenceJson: JSON.stringify(evidence),
      status: 'draft',
      sourceTaskId: task.id,
      authorAgentId: task.assigneeId,
      traceId: task.traceId,
    })
    this.record(task.projectId, 'result.draft', { id: 'system', role: 'system' }, { resultId: result.id, taskId: task.id }, task.traceId, 'result.draft', `result:${result.id}:draft`, { resultId: result.id, workItemId: wi.id })
    return result
  }

  submitResult(id: string, resultId: string, actor: ProjectActor, input: {
    title?: string
    summary?: string
    method?: string
    dataWindow?: Record<string, unknown>
    sampleCount?: number | null
    confidence?: number | null
    validityScope?: string
    payload?: Record<string, unknown>
    evidence?: Array<Record<string, unknown>>
    changeSummary?: string
    openQuestions?: string
  }): ProjectResultRow {
    this.get(id, actor)
    const result = this.results.findById(resultId)
    if (!result || result.projectId !== id) throw new AppError(404, 'NOT_FOUND', '成果不存在或不属于该项目')
    if (!['draft', 'rejected'].includes(result.status)) {
      throw new AppError(409, 'RESULT_STATE_INVALID', `成果状态 ${result.status} 不能提交`)
    }
    this.results.submit(resultId, {
      title: input.title ?? result.title,
      summary: input.summary ?? result.summary,
      method: input.method ?? result.method,
      dataWindowJson: JSON.stringify(input.dataWindow ?? parseJson(result.dataWindowJson, {})),
      sampleCount: input.sampleCount ?? result.sampleCount,
      confidence: input.confidence ?? result.confidence,
      validityScope: input.validityScope ?? result.validityScope,
      payloadJson: JSON.stringify(input.payload ?? parseJson(result.payloadJson, {})),
      evidenceJson: JSON.stringify(input.evidence ?? parseJson(result.evidenceJson, [])),
      changeSummary: input.changeSummary ?? result.changeSummary,
      openQuestions: input.openQuestions ?? result.openQuestions,
      status: 'submitted',
    })
    this.record(id, 'result.submit', actor, { resultId }, result.traceId, 'result.submitted', `result:${resultId}:submitted`, { resultId })
    return this.results.findById(resultId)!
  }

  reviewResult(id: string, resultId: string, actor: ProjectActor, decision: 'reviewed' | 'rejected', reason = ''): ProjectResultRow {
    const p = this.projects.findById(id)
    if (!p) throw new AppError(404, 'NOT_FOUND', `Project 不存在: ${id}`)
    const allowed = actor.role === 'admin' || actor.id === p.ownerUserId || (actor.agentId && actor.agentId === p.leadAgentId)
    if (!allowed) throw new AppError(403, 'FORBIDDEN', '仅项目 owner/admin 或 project leader 可复核')
    const result = this.results.findById(resultId)
    if (!result || result.projectId !== id) throw new AppError(404, 'NOT_FOUND', '成果不存在或不属于该项目')
    if (result.status !== 'submitted') throw new AppError(409, 'RESULT_STATE_INVALID', `成果状态 ${result.status} 不能复核`)
    this.results.setStatus(resultId, decision, {
      reviewedBy: actor.agentId ?? actor.id,
      reviewedAt: new Date().toISOString(),
      rejectReason: decision === 'rejected' ? reason : null,
    })
    this.record(id, decision === 'reviewed' ? 'result.reviewed' : 'result.rejected', actor, { resultId, reason }, result.traceId, decision === 'reviewed' ? 'result.reviewed' : 'result.rejected', `result:${resultId}:${decision}`, { resultId, reason })
    return this.results.findById(resultId)!
  }

  requestProjectComplete(id: string, actor: ProjectActor): ProjectApprovalRow {
    this.get(id, actor)
    const deliverables = this.deliverables.listByProject(id).filter(d => d.required === 1)
    const missing = deliverables.filter(d => !['approved', 'waived'].includes(d.status))
    if (missing.length > 0) {
      throw new AppError(409, 'DELIVERABLES_INCOMPLETE', `必选交付物未验收: ${missing.map(d => d.name).join(', ')}`)
    }
    const items = this.workItems.listByProject(id)
    const open = items.filter(w => !['COMPLETED', 'CANCELED', 'SUPERSEDED'].includes(w.state))
    if (open.length > 0) {
      throw new AppError(409, 'WORK_ITEMS_INCOMPLETE', `工作项未终态: ${open.map(w => w.title).join(', ')}`)
    }
    const pending = this.approvals.listPending(id).find(a => a.kind === 'project_complete' && a.subjectId === id)
    if (pending) return pending
    const approval = this.approvals.create({
      projectId: id,
      kind: 'project_complete',
      subjectType: 'project',
      subjectId: id,
      requestedByAgentId: actor.agentId ?? null,
      requestedByUserId: actor.agentId ? null : actor.id,
      payloadJson: JSON.stringify({ deliverables: deliverables.map(d => ({ id: d.id, status: d.status })), workItems: items.length }),
      reason: 'project completion acceptance',
      traceId: `project:${id}:complete`,
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    })
    this.record(id, 'project.complete_requested', actor, { approvalId: approval.id }, approval.traceId, 'project.complete_requested', `project:${id}:complete:requested`, { approvalId: approval.id })
    return approval
  }

  requestPlanApproval(id: string, actor: ProjectActor, input: { version: number, plan: Record<string, unknown> }): ProjectApprovalRow {
    const p = this.get(id, actor)
    if (!Number.isInteger(input.version) || input.version <= 0) throw new AppError(400, 'BAD_REQUEST', 'plan version 必须为正整数')
    if (input.version <= p.planVersion) throw new AppError(409, 'PLAN_VERSION_STALE', `plan version ${input.version} <= 当前 ${p.planVersion}`)
    const subjectId = `plan:${id}:${input.version}`
    const pending = this.approvals.listPending(id).find(a => a.kind === 'plan_approval' && a.subjectId === subjectId)
    if (pending) return pending
    const approval = this.approvals.create({
      projectId: id,
      kind: 'plan_approval',
      subjectType: 'plan',
      subjectId,
      subjectVersion: input.version,
      requestedByAgentId: actor.agentId ?? null,
      requestedByUserId: actor.agentId ? null : actor.id,
      payloadJson: JSON.stringify(input.plan),
      reason: 'project plan approval',
      traceId: `plan:${id}:${input.version}`,
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    })
    this.record(id, 'plan.requested', actor, { approvalId: approval.id, version: input.version }, approval.traceId, 'plan.requested', `plan:${id}:${input.version}:requested`, { approvalId: approval.id, version: input.version })
    return approval
  }

  requestAcceptance(id: string, resultId: string, actor: ProjectActor): ProjectApprovalRow {
    const p = this.get(id, actor)
    const result = this.results.findById(resultId)
    if (!result || result.projectId !== id) throw new AppError(404, 'NOT_FOUND', '成果不存在或不属于该项目')
    if (result.status !== 'reviewed') throw new AppError(409, 'RESULT_STATE_INVALID', `成果状态 ${result.status} 不能申请验收`)
    const evidence = parseJson<unknown[]>(result.evidenceJson, [])
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new AppError(400, 'EVIDENCE_REQUIRED', '成果没有证据，不能申请验收')
    }
    const pending = this.approvals.listPending(id).find(a => a.kind === 'deliverable_acceptance' && a.subjectId === resultId)
    if (pending) return pending
    const approval = this.approvals.create({
      projectId: id,
      kind: 'deliverable_acceptance',
      subjectType: 'result',
      subjectId: resultId,
      subjectVersion: result.version,
      requestedByAgentId: actor.agentId ?? null,
      requestedByUserId: actor.agentId ? null : actor.id,
      payloadJson: JSON.stringify({ resultId, version: result.version }),
      reason: 'deliverable acceptance',
      traceId: result.traceId,
      expiresAt: p.configJson ? new Date(Date.now() + 24 * 3600_000).toISOString() : null,
    })
    this.record(id, 'approval.requested', actor, { approvalId: approval.id, kind: approval.kind, resultId }, result.traceId, 'approval.requested', `approval:${approval.id}:requested`, { approvalId: approval.id, resultId })
    return approval
  }

  decideApproval(id: string, approvalId: string, actor: ProjectActor, approve: boolean, reason = ''): ProjectApprovalRow {
    const p = this.get(id, actor)
    const approval = this.approvals.findById(approvalId)
    if (!approval || approval.projectId !== id) throw new AppError(404, 'NOT_FOUND', '审批不存在或不属于该项目')
    if (approval.status !== 'pending') throw new AppError(409, 'APPROVAL_STATE_INVALID', `审批状态 ${approval.status} 不能决策`)
    if (approval.kind === 'deliverable_acceptance') {
      const result = this.results.findById(approval.subjectId)
      if (result?.authorUserId && result.authorUserId === actor.id) {
        throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', '不能批准自己提交的成果')
      }
    }
    const won = this.approvals.decide(approvalId, id, approve ? 'approved' : 'rejected', actor.id, reason)
    if (!won) throw new AppError(409, 'APPROVAL_STATE_INVALID', '审批已被处理或已过期')
    if (approval.kind === 'deliverable_acceptance') {
      const result = this.results.findById(approval.subjectId)
      if (result) {
        if (approve) {
          this.results.setStatus(result.id, 'approved', {
            approvedBy: actor.id,
            approvedAt: new Date().toISOString(),
            reviewedBy: result.reviewedBy,
            reviewedAt: result.reviewedAt,
          })
          this.deliverables.setStatus(result.deliverableId, 'approved')
        }
        else {
          this.results.setStatus(result.id, 'rejected', {
            reviewedBy: result.reviewedBy,
            reviewedAt: result.reviewedAt,
            rejectReason: reason || 'owner rejected',
          })
          this.deliverables.setStatus(result.deliverableId, 'rejected')
        }
      }
    }
    else if (approval.kind === 'project_complete' && approve) {
      this.projects.update(id, { status: 'completed' })
    }
    else if (approval.kind === 'plan_approval' && approve) {
      this.projects.update(id, { planVersion: approval.subjectVersion ?? p.planVersion, planJson: approval.payloadJson })
    }
    this.record(id, approve ? 'approval.approved' : 'approval.rejected', actor, { approvalId, kind: approval.kind, reason }, approval.traceId, approve ? 'approval.approved' : 'approval.rejected', `approval:${approvalId}:${approve ? 'approved' : 'rejected'}`, { approvalId, kind: approval.kind, reason })
    return this.approvals.findById(approvalId)!
  }

  supersedeResult(id: string, resultId: string, actor: ProjectActor, reason = ''): ProjectResultRow {
    this.get(id, actor)
    const result = this.results.findById(resultId)
    if (!result || result.projectId !== id) throw new AppError(404, 'NOT_FOUND', '成果不存在或不属于该项目')
    if (result.status === 'superseded') return result
    this.results.setStatus(resultId, 'superseded', {
      reviewedBy: result.reviewedBy,
      reviewedAt: result.reviewedAt,
      approvedBy: result.approvedBy,
      approvedAt: result.approvedAt,
      rejectReason: reason || 'superseded',
    })
    this.record(id, 'result.superseded', actor, { resultId, reason }, result.traceId, 'result.superseded', `result:${resultId}:superseded`, { resultId, reason })
    return this.results.findById(resultId)!
  }

  private record(projectId: string, decisionType: string, actor: ProjectActor, args: Record<string, unknown>, traceId: string, eventType: string, eventKey: string, payload: Record<string, unknown>): void {
    const argsJson = JSON.stringify(args)
    const argsSha256 = createHash('sha256').update(argsJson).digest('hex')
    withTransaction(this.db, () => {
      this.decisions.append({
        projectId,
        source: actor.agentId ? 'leader' : actor.role === 'system' ? 'service' : 'owner',
        decisionType,
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.agentId ? null : actor.id === 'system' ? null : actor.id,
        argsJson,
        argsSha256,
        state: 'applied',
        outcome: 'applied',
        traceId,
      })
      this.events.append({ projectId, type: eventType, eventKey, payloadJson: JSON.stringify(payload), traceId })
    })
  }

  bindChannel(id: string, channelId: string, actor: ProjectActor, charter = ''): ProjectChannelRow {
    const p = this.get(id, actor)
    if (p.officeChannelId === channelId) throw new AppError(400, 'PROJECT_OFFICE_NOT_MEMBER', '项目办公室不能作为成员 Channel')
    const channel = this.manager.getChannelForUser(channelId, actor.id)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `Channel 不存在: ${channelId}`)
    if (channel.ownerUserId !== actor.id && actor.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', '只能绑定自己的 Channel')
    }
    if (!channel.leadAgentId) throw new AppError(409, 'CHANNEL_NO_LEAD', '成员 Channel 必须已有 lead')
    const existing = this.bindings.findActiveByChannel(channelId)
    if (existing && existing.projectId !== id) {
      throw new AppError(409, 'CHANNEL_ALREADY_BOUND', `Channel 已属于项目 ${existing.projectId}`)
    }
    if (existing && existing.projectId === id) return existing
    const old = this.bindings.findOne(id, channelId)
    if (old) {
      this.bindings.setStatus(id, channelId, 'active')
      return { ...old, status: 'active', detachedAt: null, charter }
    }
    return this.bindings.add({ projectId: id, channelId, bindingType: 'user_bound', charter, addedBy: actor.id })
  }

  unbindChannel(id: string, channelId: string, actor: ProjectActor): void {
    const p = this.get(id, actor)
    if (p.officeChannelId === channelId) throw new AppError(400, 'PROJECT_OFFICE_NOT_MEMBER', '不能解绑项目办公室')
    const b = this.bindings.findOne(id, channelId)
    if (!b || b.status !== 'active') throw new AppError(404, 'NOT_FOUND', 'Channel 未绑定到该项目')
    this.bindings.setStatus(id, channelId, 'detached')
  }

  /** REST 删除/禁用/替换 lead 前调用：active 项目的办公室频道不可变。 */
  assertOfficeChannelMutable(channelId: string): void {
    const p = this.projects.listAll().find(x => x.officeChannelId === channelId)
    if (p && p.status === 'active') {
      throw new AppError(409, 'PROJECT_OFFICE_PROTECTED', 'active 项目的办公室频道不可删除/禁用/替换 lead；请先暂停或归档项目')
    }
  }

  assertNotOfficeChannel(channelId: string): void {
    if (this.projects.listAll().some(x => x.officeChannelId === channelId)) {
      throw new AppError(409, 'PROJECT_OFFICE_NOT_MEMBER', '项目办公室频道不能作为普通工作频道使用')
    }
  }

  private requireOwner(p: ProjectRow, actor: ProjectActor): void {
    if (actor.role === 'admin') return
    if (p.ownerUserId !== actor.id) throw new AppError(403, 'FORBIDDEN', '仅项目 owner/admin 可操作')
  }
}

let projectService: ProjectService | null = null

export function initProjectService(manager: AgentChannelManager, db: DatabaseSync): ProjectService {
  projectService = new ProjectService(manager, db)
  return projectService
}

export function getProjectService(): ProjectService {
  if (!projectService) throw new AppError(503, 'PROJECT_SERVICE_UNAVAILABLE', 'ProjectService 未装配')
  return projectService
}
