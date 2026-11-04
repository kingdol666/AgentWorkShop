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
import type { TaskRow } from '../db/database'
import { withTransaction } from '../db/transaction'
import { parseJson } from '../db/database'
import { AppError } from '../../../utils/errors'
import { argsDigest } from './digest'
import { PROJECT_GATED_WRITE_TOOL_NAMES } from './tool-surface'

export interface ProjectActor {
  id: string
  role?: string
  /** 项目 leader agent 身份（review 路径用） */
  agentId?: string
}

export interface AgentProjectIdentity {
  agentId: string
  channelId: string
  role: 'lead' | 'worker'
  agentKind: 'channel_agent' | 'project_leader'
}

export interface AgentProjectContext extends AgentProjectIdentity {
  project: ProjectRow
  isLeader: boolean
}

export interface ProjectWriteVerdict {
  allowed: boolean
  code?: string
  message?: string
  approvalId?: string
}

export interface NormalizedPlanDeliverable {
  key: string
  name: string
  description: string
  required: boolean
  channelId?: string
  acceptanceCriteria: string[]
}

export interface NormalizedPlanWorkItem {
  key: string
  deliverableKey: string
  channelId: string
  title: string
  brief: string
  dedupeKey?: string
  dependsOn: string[]
  execBudgetMinutes: number
  acceptanceCriteria: string[]
  resultKey: string
}

export interface NormalizedPlan {
  deliverables: NormalizedPlanDeliverable[]
  workItems: NormalizedPlanWorkItem[]
  raw: Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean)
    : []
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * 计划 schema 校验（leader proposal / owner apply 共用）。
 * 规则：交付物非空且 key/name 唯一；工作项必须引用已知交付物与 Channel；
 * 依赖必须指向本计划内工作项；规模设上限防上下文/事务膨胀。
 */
export function normalizeProjectPlan(plan: Record<string, unknown>): NormalizedPlan {
  const rawDeliverables = Array.isArray(plan.deliverables) ? plan.deliverables : []
  const rawWorkItems = Array.isArray(plan.work_items)
    ? plan.work_items
    : (Array.isArray(plan.workItems) ? plan.workItems : [])
  if (rawDeliverables.length === 0) throw new AppError(400, 'PLAN_INVALID', '计划必须包含至少一个交付物(deliverables)')
  if (rawDeliverables.length > 50) throw new AppError(400, 'PLAN_INVALID', '交付物数量超过上限 50')
  if (rawWorkItems.length > 200) throw new AppError(400, 'PLAN_INVALID', '工作项数量超过上限 200')

  const deliverableKeys = new Set<string>()
  const deliverables = rawDeliverables.map((item, index) => {
    const d = asObject(item)
    const key = asString(d.key) || asString(d.name)
    const name = asString(d.name) || key
    if (!key || !name) throw new AppError(400, 'PLAN_INVALID', `交付物 #${index + 1} 缺 key/name`)
    if (deliverableKeys.has(key)) throw new AppError(400, 'PLAN_INVALID', `交付物 key 重复: ${key}`)
    deliverableKeys.add(key)
    const channelId = asString(d.channelId) || asString(d.channel_id)
    return {
      key,
      name,
      description: asString(d.description),
      required: d.required !== false,
      channelId: channelId || undefined,
      acceptanceCriteria: asStringArray(d.acceptanceCriteria ?? d.acceptance_criteria),
    }
  })

  const workKeys = new Set<string>()
  const workItems = rawWorkItems.map((item, index) => {
    const w = asObject(item)
    const deliverableKey = asString(w.deliverableKey) || asString(w.deliverable_key)
    if (!deliverableKeys.has(deliverableKey)) {
      throw new AppError(400, 'PLAN_INVALID', `工作项 #${index + 1} 引用了未知交付物: ${deliverableKey || '(空)'}`)
    }
    const title = asString(w.title)
    if (!title) throw new AppError(400, 'PLAN_INVALID', `工作项 #${index + 1} 缺 title`)
    const key = asString(w.key) || `${deliverableKey}:${title}`
    if (workKeys.has(key)) throw new AppError(400, 'PLAN_INVALID', `工作项 key 重复: ${key}`)
    workKeys.add(key)
    const channelId = asString(w.channelId) || asString(w.channel_id)
    if (!channelId) throw new AppError(400, 'PLAN_INVALID', `工作项「${title}」缺 channelId`)
    const budgetRaw = Number(w.execBudgetMinutes ?? w.exec_budget_minutes ?? 60)
    const execBudgetMinutes = Number.isFinite(budgetRaw) ? Math.min(24 * 60, Math.max(1, Math.floor(budgetRaw))) : 60
    return {
      key,
      deliverableKey,
      channelId,
      title,
      brief: asString(w.brief),
      dedupeKey: asString(w.dedupeKey) || asString(w.dedupe_key) || undefined,
      dependsOn: asStringArray(w.dependsOn ?? w.depends_on),
      execBudgetMinutes,
      acceptanceCriteria: asStringArray(w.acceptanceCriteria ?? w.acceptance_criteria),
      resultKey: asString(w.resultKey) || asString(w.result_key) || 'main',
    }
  })
  for (const w of workItems) {
    for (const dep of w.dependsOn) {
      if (!workKeys.has(dep)) throw new AppError(400, 'PLAN_INVALID', `工作项「${w.title}」依赖未知工作项: ${dep}`)
    }
  }
  return { deliverables, workItems, raw: plan }
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
    this.assertCompletionGates(id)
    const deliverables = this.deliverables.listByProject(id).filter(d => d.required === 1)
    const items = this.workItems.listByProject(id)
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
    const result = this.assertAcceptanceGates(id, resultId)
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
      const version = approval.subjectVersion ?? p.planVersion
      const updated = this.projects.update(id, { planVersion: version, planJson: approval.payloadJson })
      // leader 提案的 proposal decision 与审批联动收口（CAS）。
      for (const d of this.decisions.listByProject(id)) {
        if (d.approvalId === approvalId && d.state === 'proposed') this.decisions.markApplied(d.id, 'applied', 'approved plan')
      }
      this.materializeApprovedPlan(updated ?? { ...p, planVersion: version, planJson: approval.payloadJson }, version, approval.payloadJson)
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

  // ===== Agent-facing surface（PR8：leader 提案 / member 提交 / write_intent） =====

  /** channel_agents 身份：agent_kind 是 Project 层标识，role 仍为 lead|worker。 */
  agentIdentity(agentId: string): AgentProjectIdentity | null {
    const row = this.db.prepare(
      `SELECT id, channel_id AS channelId, role, agent_kind AS agentKind FROM channel_agents WHERE id = ?`,
    ).get(agentId) as { id: string, channelId: string, role: string, agentKind: string } | undefined
    if (!row) return null
    return {
      agentId: row.id,
      channelId: row.channelId,
      role: row.role === 'lead' ? 'lead' : 'worker',
      agentKind: row.agentKind === 'project_leader' ? 'project_leader' : 'channel_agent',
    }
  }

  /** Agent → 项目上下文：leader 按办公室指针解析，成员按 active 绑定解析。 */
  agentProjectContext(agentId: string): AgentProjectContext | null {
    const ident = this.agentIdentity(agentId)
    if (!ident) return null
    if (ident.agentKind === 'project_leader') {
      const row = this.db.prepare(
        `SELECT id FROM projects WHERE lead_agent_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(agentId) as { id?: string } | undefined
      const project = row?.id ? this.projects.findById(row.id) : undefined
      if (!project) return null
      return { ...ident, project, isLeader: true }
    }
    const binding = this.bindings.findActiveByChannel(ident.channelId)
    if (!binding) return null
    const project = this.projects.findById(binding.projectId)
    if (!project) return null
    return { ...ident, project, isLeader: false }
  }

  /** 工具面/执行层共用的角色档位。 */
  agentToolMode(agentId: string): 'leader' | 'channel_lead' | 'worker' | 'none' {
    const ctx = this.agentProjectContext(agentId)
    if (!ctx) return 'none'
    if (ctx.isLeader) return 'leader'
    return ctx.role === 'lead' ? 'channel_lead' : 'worker'
  }

  /** 拒绝决策仍要留痕（plan §4.2：拒绝写 project_decisions(state='rejected') + audit）。 */
  recordToolRejection(projectId: string, agentId: string, toolName: string, reason: string): void {
    try {
      const argsJson = JSON.stringify({ tool: toolName, reason })
      const argsSha256 = createHash('sha256').update(argsJson).digest('hex')
      withTransaction(this.db, () => {
        this.decisions.append({
          projectId,
          source: 'leader',
          decisionType: 'tool.rejected',
          actorAgentId: agentId,
          argsJson,
          argsSha256,
          state: 'rejected',
          outcome: 'rejected',
          reason,
        })
        this.events.append({
          projectId,
          type: 'tool.rejected',
          eventKey: `tool:${agentId}:${toolName}:${Date.now()}`,
          payloadJson: argsJson,
        })
      })
    }
    catch {
      /* 审计失败不改变拒绝结果 */
    }
  }

  /** 提示词/工具共用的项目简报（不返回凭证/配置）。 */
  agentProjectBrief(agentId: string): {
    project: ProjectRow
    isLeader: boolean
    channelId: string
    role: 'lead' | 'worker'
    deliverables: ProjectDeliverableRow[]
    workItems: ProjectWorkItemRow[]
    pendingApprovals: number
  } {
    const ctx = this.requireAgentContext(agentId, 'any')
    const deliverables = this.deliverables.listByProject(ctx.project.id)
    const items = this.workItems.listByProject(ctx.project.id)
      .filter(w => ctx.isLeader || w.channelId === ctx.channelId)
    return {
      project: ctx.project,
      isLeader: ctx.isLeader,
      channelId: ctx.channelId,
      role: ctx.role,
      deliverables,
      workItems: items,
      pendingApprovals: this.approvals.listPending(ctx.project.id).length,
    }
  }

  agentProjectStatus(agentId: string): Record<string, unknown> {
    const brief = this.agentProjectBrief(agentId)
    const allItems = this.workItems.listByProject(brief.project.id)
    const allDeliverables = brief.deliverables
    return {
      project: {
        id: brief.project.id,
        name: brief.project.name,
        objective: brief.project.objective,
        successCriteria: parseJson(brief.project.successCriteriaJson, []),
        status: brief.project.status,
        mode: brief.project.mode,
        planVersion: brief.project.planVersion,
        plan: parseJson(brief.project.planJson, {}),
      },
      channels: this.listBoundChannels(brief.project).map(c => ({
        channelId: c.channelId, name: c.name, enabled: c.enabled, leadAgentId: c.leadAgentId,
      })),
      deliverables: allDeliverables.map(d => ({
        id: d.id, name: d.name, status: d.status, required: d.required === 1,
        ownerChannelId: d.ownerChannelId,
      })),
      workItems: allItems.map(w => ({
        id: w.id, title: w.title, state: w.state, channelId: w.channelId,
        deliverableId: w.deliverableId, planVersion: w.planVersion,
      })),
      pendingApprovals: this.approvals.listPending(brief.project.id).map(a => ({
        id: a.id, kind: a.kind, subjectId: a.subjectId, createdAt: a.createdAt,
      })),
    }
  }

  agentListChannels(agentId: string): Array<Record<string, unknown>> {
    const ctx = this.requireAgentContext(agentId, 'leader')
    return this.listBoundChannels(ctx.project).map(c => ({
      channelId: c.channelId, name: c.name, enabled: c.enabled,
      leadAgentId: c.leadAgentId, status: c.status,
    }))
  }

  agentReadDeliverables(agentId: string): Array<Record<string, unknown>> {
    const ctx = this.requireAgentContext(agentId, 'any')
    return this.deliverables.listByProject(ctx.project.id).map(d => ({
      id: d.id, name: d.name, description: d.description, status: d.status,
      required: d.required === 1, ownerChannelId: d.ownerChannelId,
      acceptanceCriteria: parseJson(d.acceptanceCriteriaJson, []),
    }))
  }

  agentReadWorkItems(agentId: string): Array<Record<string, unknown>> {
    const ctx = this.requireAgentContext(agentId, 'any')
    return this.workItems.listByProject(ctx.project.id)
      .filter(w => ctx.isLeader || w.channelId === ctx.channelId)
      .map(w => ({
        id: w.id, title: w.title, state: w.state, channelId: w.channelId,
        deliverableId: w.deliverableId, brief: w.brief, planVersion: w.planVersion,
        dependsOn: parseJson(w.dependsOnJson, []), execBudgetMinutes: w.execBudgetMinutes,
      }))
  }

  /** 成果读取：leader 全量；channel lead 本频道全状态+他频道 approved；worker 仅本频道 approved。 */
  agentReadResults(agentId: string): Array<Record<string, unknown>> {
    const ctx = this.requireAgentContext(agentId, 'any')
    const visible = this.results.listByProject(ctx.project.id).filter((r) => {
      if (ctx.isLeader) return true
      if (ctx.role === 'lead') return r.channelId === ctx.channelId ? r.status !== 'superseded' : r.status === 'approved'
      return r.channelId === ctx.channelId && r.status === 'approved'
    })
    return visible.map(r => ({
      id: r.id, title: r.title, status: r.status, channelId: r.channelId,
      deliverableId: r.deliverableId, workItemId: r.workItemId, attemptNo: r.attemptNo,
      version: r.version, summary: r.summary, confidence: r.confidence,
      evidence: parseJson(r.evidenceJson, []), approvedBy: r.approvedBy, approvedAt: r.approvedAt,
    }))
  }

  /** Channel lead 提交成果：只能本频道/本工作项/本 attempt；证据与大小设上限。 */
  agentSubmitResult(agentId: string, input: {
    resultId?: string
    taskId?: string
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
    const ctx = this.requireAgentContext(agentId, 'channel_lead')
    const task = this.resolveAgentProjectTask(ctx, input.taskId)
    const workItemId = task.projectWorkItemId!
    const wi = this.workItems.findById(workItemId)
    if (!wi || wi.projectId !== ctx.project.id) throw new AppError(404, 'NOT_FOUND', '工作项不存在')
    if (wi.channelId !== ctx.channelId) throw new AppError(403, 'RESULT_SCOPE_VIOLATION', '只能提交本频道工作项的成果')
    let result = input.resultId ? this.results.findById(input.resultId) : undefined
    if (!result) result = this.results.findByWorkItemAttempt(wi.id, task.projectAttemptNo ?? 0, wi.resultKey)
    if (!result && task.state === 'COMPLETED') result = this.ensureDraftFromTask(task.id)
    if (!result) {
      throw new AppError(409, 'RESULT_DRAFT_NOT_FOUND', `没有可提交的成果草稿；请先完成任务 ${task.id} 或等待 Reconciler 生成 draft`)
    }
    if (result.projectId !== ctx.project.id || result.channelId !== ctx.channelId) {
      throw new AppError(403, 'RESULT_SCOPE_VIOLATION', '成果不属于本项目/本频道')
    }
    if (!['draft', 'rejected'].includes(result.status)) {
      throw new AppError(409, 'RESULT_STATE_INVALID', `成果状态 ${result.status} 不能提交`)
    }
    const summary = input.summary ?? result.summary
    if (summary.length > 8_192) throw new AppError(400, 'RESULT_TOO_LARGE', 'summary 超过 8KB 上限')
    const evidence = input.evidence ?? parseJson<Array<Record<string, unknown>>>(result.evidenceJson, [])
    if (evidence.length > 50) throw new AppError(400, 'RESULT_TOO_LARGE', 'evidence 超过 50 条上限')
    const payloadJson = JSON.stringify(input.payload ?? parseJson(result.payloadJson, {}))
    if (payloadJson.length > 65_536) throw new AppError(400, 'RESULT_TOO_LARGE', 'payload 超过 64KB 上限')
    this.results.submit(result.id, {
      title: input.title ?? result.title,
      summary,
      method: input.method ?? result.method,
      dataWindowJson: JSON.stringify(input.dataWindow ?? parseJson(result.dataWindowJson, {})),
      sampleCount: input.sampleCount ?? result.sampleCount,
      confidence: input.confidence ?? result.confidence,
      validityScope: input.validityScope ?? result.validityScope,
      payloadJson,
      evidenceJson: JSON.stringify(evidence),
      changeSummary: input.changeSummary ?? result.changeSummary,
      openQuestions: input.openQuestions ?? result.openQuestions,
      status: 'submitted',
    })
    this.record(ctx.project.id, 'result.submit', { id: agentId, role: 'lead', agentId }, { resultId: result.id, taskId: task.id }, result.traceId, 'result.submitted', `result:${result.id}:submitted`, { resultId: result.id })
    return this.results.findById(result.id)!
  }

  /** Project leader 复核：只能 submitted → reviewed/rejected；不能 approve。 */
  agentReviewResult(agentId: string, resultId: string, decision: 'reviewed' | 'rejected', reason = ''): ProjectResultRow {
    const ctx = this.requireAgentContext(agentId, 'leader')
    if (decision !== 'reviewed' && decision !== 'rejected') {
      throw new AppError(400, 'BAD_REQUEST', 'decision 必须是 reviewed 或 rejected')
    }
    return this.reviewResult(ctx.project.id, resultId, { id: agentId, role: 'lead', agentId }, decision, reason)
  }

  /**
   * Leader 计划提案 → plan_approval（owner 批准后物化交付物/工作项）。
   * 同一 plan version 的 pending 审批幂等返回。
   */
  agentRequestPlan(agentId: string, plan: Record<string, unknown>, kind: 'plan' | 'replan' = 'plan'): { approval: ProjectApprovalRow, version: number, proposalId: string } {
    const ctx = this.requireAgentContext(agentId, 'leader')
    this.assertLeaderProjectMutable(ctx.project)
    const normalized = normalizeProjectPlan(plan)
    const version = ctx.project.planVersion + 1
    const subjectId = `plan:${ctx.project.id}:${version}`
    const pending = this.approvals.listPending(ctx.project.id).find(a => a.kind === 'plan_approval' && a.subjectId === subjectId)
    if (pending) {
      const existing = this.decisions.listByProject(ctx.project.id).find(d => d.approvalId === pending.id)
      return { approval: pending, version, proposalId: existing?.id ?? '' }
    }
    let approval!: ProjectApprovalRow
    let proposal!: ProjectDecisionRow
    withTransaction(this.db, () => {
      approval = this.approvals.create({
        projectId: ctx.project.id,
        kind: 'plan_approval',
        subjectType: 'plan',
        subjectId,
        subjectVersion: version,
        requestedByAgentId: agentId,
        payloadJson: JSON.stringify(normalized.raw),
        reason: 'project plan proposal',
        traceId: `plan:${ctx.project.id}:${version}`,
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      })
      const argsJson = JSON.stringify(normalized.raw)
      proposal = this.decisions.append({
        projectId: ctx.project.id,
        source: 'leader',
        decisionType: kind === 'replan' ? 'replan.proposed' : 'plan.proposed',
        actorAgentId: agentId,
        argsJson,
        argsSha256: createHash('sha256').update(argsJson).digest('hex'),
        state: 'proposed',
        outcome: 'pending',
        approvalId: approval.id,
        traceId: approval.traceId,
      })
      this.events.append({
        projectId: ctx.project.id,
        type: 'plan.proposed',
        eventKey: `plan:${ctx.project.id}:${version}:proposed`,
        payloadJson: JSON.stringify({ proposalId: proposal.id, approvalId: approval.id, version }),
        traceId: approval.traceId,
      })
    })
    return { approval, version, proposalId: proposal.id }
  }

  agentRequestProjectComplete(agentId: string): ProjectApprovalRow {
    const ctx = this.requireAgentContext(agentId, 'leader')
    if (ctx.project.status === 'completed') throw new AppError(409, 'PROJECT_STATE_INVALID', '项目已完成')
    if (ctx.project.status === 'archived') throw new AppError(409, 'PROJECT_STATE_INVALID', '项目已归档')
    this.assertCompletionGates(ctx.project.id)
    const pending = this.approvals.listPending(ctx.project.id)
      .find(a => a.kind === 'project_complete' && a.subjectId === ctx.project.id)
    if (pending) return pending
    let approval!: ProjectApprovalRow
    withTransaction(this.db, () => {
      approval = this.approvals.create({
        projectId: ctx.project.id,
        kind: 'project_complete',
        subjectType: 'project',
        subjectId: ctx.project.id,
        requestedByAgentId: agentId,
        payloadJson: JSON.stringify({ requestedBy: 'project_leader' }),
        reason: 'project completion acceptance',
        traceId: `project:${ctx.project.id}:complete`,
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      })
      this.appendAgentDecision(ctx.project.id, agentId, 'project.complete_requested', { approvalId: approval.id }, approval.traceId, 'project.complete_requested', `project:${ctx.project.id}:complete:requested`, { approvalId: approval.id })
    })
    return approval
  }

  agentRequestAcceptance(agentId: string, resultId: string): ProjectApprovalRow {
    const ctx = this.requireAgentContext(agentId, 'leader')
    const result = this.assertAcceptanceGates(ctx.project.id, resultId)
    const pending = this.approvals.listPending(ctx.project.id)
      .find(a => a.kind === 'deliverable_acceptance' && a.subjectId === result.id)
    if (pending) return pending
    let approval!: ProjectApprovalRow
    withTransaction(this.db, () => {
      approval = this.approvals.create({
        projectId: ctx.project.id,
        kind: 'deliverable_acceptance',
        subjectType: 'result',
        subjectId: result.id,
        subjectVersion: result.version,
        requestedByAgentId: agentId,
        payloadJson: JSON.stringify({ resultId: result.id, version: result.version }),
        reason: 'deliverable acceptance',
        traceId: result.traceId,
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      })
      this.appendAgentDecision(ctx.project.id, agentId, 'approval.requested', { approvalId: approval.id, kind: approval.kind, resultId: result.id }, result.traceId, 'approval.requested', `approval:${approval.id}:requested`, { approvalId: approval.id, resultId: result.id })
    })
    return approval
  }

  /** Channel lead 申请 write_intent：绑定工作项/attempt/tool/args digest，一次性消费。 */
  agentRequestWriteIntent(agentId: string, input: {
    tool: string
    args: Record<string, unknown>
    reason?: string
    taskId?: string
  }): { approval: ProjectApprovalRow, digest: string } {
    const ctx = this.requireAgentContext(agentId, 'channel_lead')
    if (ctx.project.status !== 'active') throw new AppError(409, 'PROJECT_NOT_ACTIVE', `Project 状态 ${ctx.project.status} 不能申请写意图`)
    if (!PROJECT_GATED_WRITE_TOOL_NAMES.has(input.tool)) {
      throw new AppError(400, 'WRITE_INTENT_NOT_REQUIRED', `${input.tool} 不在需要 write_intent 的高风险写清单内`)
    }
    const task = this.resolveAgentProjectTask(ctx, input.taskId)
    const digest = argsDigest(input.args)
    const existing = this.approvals.listPending(ctx.project.id)
      .find(a => a.kind === 'write_intent' && a.subjectId === task.projectWorkItemId)
    if (existing) {
      const payload = parseJson<Record<string, unknown>>(existing.payloadJson, {})
      if (payload.tool === input.tool && payload.digest === digest) return { approval: existing, digest }
      throw new AppError(409, 'WRITE_INTENT_PENDING', `该工作项已有待审批写意图(${existing.id})；等 owner 裁决或换参数重试`)
    }
    let approval!: ProjectApprovalRow
    withTransaction(this.db, () => {
      approval = this.approvals.create({
        projectId: ctx.project.id,
        kind: 'write_intent',
        subjectType: 'work_item',
        subjectId: task.projectWorkItemId!,
        subjectVersion: task.projectAttemptNo ?? null,
        requestedByAgentId: agentId,
        payloadJson: JSON.stringify({
          tool: input.tool,
          args: input.args,
          digest,
          workItemId: task.projectWorkItemId,
          attemptNo: task.projectAttemptNo,
          channelId: ctx.channelId,
          agentId,
          rootTaskId: task.id,
        }),
        argsDigest: digest,
        reason: input.reason ?? 'project write intent',
        traceId: task.traceId || '',
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      })
      this.appendAgentDecision(ctx.project.id, agentId, 'write_intent.requested', { approvalId: approval.id, tool: input.tool, digest }, task.traceId || '', 'write_intent.requested', `write_intent:${approval.id}:requested`, { approvalId: approval.id, tool: input.tool })
    })
    return { approval, digest }
  }

  /** Leader 派发提案：只写 proposed decision；owner 通过 applyProposal 物化。 */
  agentProposeDispatch(agentId: string, input: {
    deliverableId: string
    channelId: string
    title: string
    brief?: string
    dedupeKey?: string
    dependsOn?: string[]
    execBudgetMinutes?: number
    dispatch?: boolean
  }): ProjectDecisionRow {
    const ctx = this.requireAgentContext(agentId, 'leader')
    this.assertLeaderProjectMutable(ctx.project)
    const deliverable = this.deliverables.listByProject(ctx.project.id).find(d => d.id === input.deliverableId)
    if (!deliverable) throw new AppError(404, 'NOT_FOUND', '交付物不存在或不属于该项目')
    this.assertChannelBound(ctx.project.id, input.channelId)
    const title = input.title?.trim()
    if (!title) throw new AppError(400, 'BAD_REQUEST', '工作项标题不能为空')
    const dedupeKey = input.dedupeKey?.trim() || `${input.deliverableId}:${input.channelId}:${title}`
    const existing = this.workItems.listByProject(ctx.project.id).find(w => w.dedupeKey === dedupeKey)
    if (existing) throw new AppError(409, 'WORK_ITEM_EXISTS', `工作项已存在: ${existing.id}(${existing.state})`)
    const args = {
      deliverableId: input.deliverableId,
      channelId: input.channelId,
      title,
      brief: input.brief ?? '',
      dedupeKey,
      dependsOn: input.dependsOn ?? [],
      execBudgetMinutes: input.execBudgetMinutes ?? 60,
      dispatch: input.dispatch === true,
    }
    const argsJson = JSON.stringify(args)
    return this.decisions.append({
      projectId: ctx.project.id,
      source: 'leader',
      decisionType: 'dispatch.proposed',
      actorAgentId: agentId,
      argsJson,
      argsSha256: createHash('sha256').update(argsJson).digest('hex'),
      state: 'proposed',
      outcome: 'pending',
      traceId: `proposal:dispatch:${dedupeKey}`,
    })
  }

  /**
   * Owner 应用 leader 提案（dispatch.proposed）。
   * CAS：decision.state='proposed' → applied；工作项创建与状态迁移同事务失败回滚。
   */
  async applyProposal(projectId: string, decisionId: string, actor: ProjectActor): Promise<{ workItem?: ProjectWorkItemRow, dispatched: boolean }> {
    const p = this.get(projectId, actor)
    const decision = this.decisions.findById(projectId, decisionId)
    if (!decision) throw new AppError(404, 'NOT_FOUND', '提案不存在或不属于该项目')
    if (decision.state !== 'proposed') throw new AppError(409, 'PROPOSAL_STATE_INVALID', `提案状态 ${decision.state} 不能应用`)
    if (decision.decisionType !== 'dispatch.proposed') {
      throw new AppError(409, 'PROPOSAL_NOT_APPLICABLE', `提案类型 ${decision.decisionType} 不支持直接应用`)
    }
    const args = parseJson<Record<string, unknown>>(decision.argsJson, {})
    const deliverableId = String(args.deliverableId ?? '')
    const channelId = String(args.channelId ?? '')
    const title = String(args.title ?? '').trim()
    if (!deliverableId || !channelId || !title) throw new AppError(400, 'BAD_REQUEST', '提案缺 deliverableId/channelId/title')
    const deliverable = this.deliverables.listByProject(projectId).find(d => d.id === deliverableId)
    if (!deliverable) throw new AppError(404, 'NOT_FOUND', '交付物不存在或不属于该项目')
    this.assertChannelBound(projectId, channelId)
    const dedupeKey = String(args.dedupeKey ?? `${deliverableId}:${channelId}:${title}`)
    const existing = this.workItems.listByProject(projectId).find(w => w.dedupeKey === dedupeKey)
    if (existing) throw new AppError(409, 'WORK_ITEM_EXISTS', `工作项已存在: ${existing.id}(${existing.state})`)
    if (!this.decisions.markApplied(decisionId, 'applied', 'owner applied proposal')) {
      throw new AppError(409, 'PROPOSAL_STATE_INVALID', '提案已被处理')
    }
    const workItem = this.workItems.create({
      projectId,
      deliverableId,
      channelId,
      title,
      brief: String(args.brief ?? ''),
      dependsOnJson: JSON.stringify(Array.isArray(args.dependsOn) ? args.dependsOn : []),
      planVersion: p.planVersion,
      execBudgetMinutes: Number(args.execBudgetMinutes ?? 60),
      traceId: decision.traceId || `proposal:${decisionId}`,
      dedupeKey,
      createdBy: 'project_leader',
    })
    this.record(projectId, 'proposal.applied', actor, { decisionId, workItemId: workItem.id }, decision.traceId, 'proposal.applied', `proposal:${decisionId}:applied`, { decisionId, workItemId: workItem.id })
    let dispatched = false
    if (args.dispatch === true) {
      if (p.status !== 'active') throw new AppError(409, 'PROJECT_NOT_ACTIVE', `Project 状态 ${p.status} 不能派发；提案已应用为工作项`)
      await this.dispatchWorkItem(projectId, workItem.id, actor)
      dispatched = true
    }
    return { workItem: this.workItems.findById(workItem.id), dispatched }
  }

  /**
   * 执行层 write gate：项目来源任务默认 project_may_write=false；
   * 高风险写必须匹配 owner 已批准、未消费、未过期且 tool/args digest/attempt 一致的 write_intent。
   */
  authorizeProjectWrite(agentId: string, toolName: string, args: Record<string, unknown>, activeRootTaskId?: string | null): ProjectWriteVerdict {
    if (!PROJECT_GATED_WRITE_TOOL_NAMES.has(toolName)) return { allowed: true }
    let origin: { task: TaskRow, project: ProjectRow } | null
    try {
      origin = this.projectOriginOf(agentId, activeRootTaskId)
    }
    catch (err) {
      return { allowed: false, code: 'PROJECT_WRITE_CONTEXT_INVALID', message: err instanceof Error ? err.message : String(err) }
    }
    if (!origin) return { allowed: true }
    const config = parseJson<Record<string, unknown>>(origin.project.configJson, {})
    if (config.mayWrite === true) return { allowed: true }
    if (!origin.task.projectWorkItemId) {
      return { allowed: false, code: 'PROJECT_WRITE_CONTEXT_INVALID', message: '项目来源任务缺少工作项上下文，写入被拒绝' }
    }
    const digest = argsDigest(args)
    const row = this.db.prepare(
      `SELECT id, payload_json AS payloadJson FROM project_approvals
       WHERE project_id = ? AND kind = 'write_intent' AND subject_id = ? AND status = 'approved'
         AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC LIMIT 1`,
    ).get(origin.project.id, origin.task.projectWorkItemId, new Date().toISOString()) as { id: string, payloadJson: string } | undefined
    if (!row) {
      return {
        allowed: false,
        code: 'PROJECT_WRITE_INTENT_REQUIRED',
        message: `${toolName} 在项目来源任务中需要 owner 批准的 write_intent；请先调用 project_request_write_intent`,
      }
    }
    const payload = parseJson<Record<string, unknown>>(row.payloadJson, {})
    if (payload.tool !== toolName || payload.digest !== digest || Number(payload.attemptNo ?? -1) !== Number(origin.task.projectAttemptNo ?? -1)) {
      return {
        allowed: false,
        code: 'PROJECT_WRITE_INTENT_MISMATCH',
        message: `write_intent(${row.id}) 与本次调用不匹配(tool/args/attempt)`,
      }
    }
    if (!this.approvals.consume(row.id)) {
      return { allowed: false, code: 'PROJECT_WRITE_INTENT_CONSUMED', message: `write_intent(${row.id}) 已被消费` }
    }
    this.record(origin.project.id, 'write_intent.consumed', { id: agentId, role: 'lead', agentId }, { approvalId: row.id, tool: toolName }, origin.task.traceId ?? '', 'write_intent.consumed', `write_intent:${row.id}:consumed`, { approvalId: row.id, tool: toolName })
    return { allowed: true, approvalId: row.id }
  }

  private requireAgentContext(agentId: string, mode: 'leader' | 'channel_lead' | 'any'): AgentProjectContext {
    const ctx = this.agentProjectContext(agentId)
    if (!ctx) throw new AppError(403, 'PROJECT_CONTEXT_REQUIRED', '该 Agent 不属于任何项目上下文')
    if (mode === 'leader' && !ctx.isLeader) throw new AppError(403, 'PROJECT_LEADER_REQUIRED', '仅项目总工可执行该操作')
    if (mode === 'channel_lead' && (ctx.isLeader || ctx.role !== 'lead')) {
      throw new AppError(403, 'PROJECT_CHANNEL_LEAD_REQUIRED', '仅成员 Channel lead 可执行该操作')
    }
    return ctx
  }

  private assertLeaderProjectMutable(p: ProjectRow): void {
    if (p.status === 'completed' || p.status === 'archived') {
      throw new AppError(409, 'PROJECT_STATE_INVALID', `Project 状态 ${p.status} 不能提案`)
    }
  }

  private assertChannelBound(projectId: string, channelId: string): void {
    const bound = this.bindings.listByProject(projectId).find(b => b.channelId === channelId && b.status === 'active')
    if (!bound) throw new AppError(409, 'CHANNEL_NOT_IN_PROJECT', 'Channel 未绑定到该项目')
  }

  private listBoundChannels(p: ProjectRow): Array<{ channelId: string, name: string, enabled: number, leadAgentId: string | null, status: string }> {
    return this.bindings.listByProject(p.id)
      .filter(b => b.status === 'active')
      .map((b) => {
        const ch = this.manager.getChannelForUser(b.channelId, p.ownerUserId)
        return {
          channelId: b.channelId,
          name: ch?.name ?? b.channelId,
          enabled: ch?.enabled ?? 0,
          leadAgentId: ch?.leadAgentId ?? null,
          status: ch?.enabled === 1 ? 'enabled' : 'disabled',
        }
      })
  }

  private resolveAgentProjectTask(ctx: AgentProjectContext, taskId?: string): TaskRow {
    let task: TaskRow | undefined
    if (taskId) {
      task = this.tasks.findById(taskId)
    }
    else {
      const row = this.db.prepare(
        `SELECT id FROM tasks WHERE channel_id = ? AND assignee_id = ? AND source = 'project'
         ORDER BY created_at DESC LIMIT 1`,
      ).get(ctx.channelId, ctx.agentId) as { id?: string } | undefined
      task = row?.id ? this.tasks.findById(row.id) : undefined
    }
    if (!task) throw new AppError(409, 'PROJECT_TASK_CONTEXT_MISSING', '没有找到本 Agent 的项目任务上下文；请携带 task_id')
    if (task.channelId !== ctx.channelId || task.assigneeId !== ctx.agentId) {
      throw new AppError(403, 'PROJECT_TASK_SCOPE_VIOLATION', '任务不属于本 Agent/本频道')
    }
    if (task.source !== 'project' || task.projectId !== ctx.project.id || !task.projectWorkItemId) {
      throw new AppError(403, 'PROJECT_TASK_MISMATCH', '任务不是当前项目的项目来源任务')
    }
    return task
  }

  /** 项目来源解析：显式 root 优先；否则取该 Agent 最近一个项目 root（含终态，fail-closed）。 */
  private projectOriginOf(agentId: string, activeRootTaskId?: string | null): { task: TaskRow, project: ProjectRow } | null {
    let task: TaskRow | undefined
    if (activeRootTaskId) {
      task = this.tasks.findById(activeRootTaskId)
    }
    if (!task) {
      const row = this.db.prepare(
        `SELECT id FROM tasks WHERE channel_id = (SELECT channel_id FROM channel_agents WHERE id = ?)
           AND assignee_id = ? AND source = 'project' ORDER BY created_at DESC LIMIT 1`,
      ).get(agentId, agentId) as { id?: string } | undefined
      task = row?.id ? this.tasks.findById(row.id) : undefined
    }
    if (!task || task.source !== 'project') return null
    const project = task.projectId ? this.projects.findById(task.projectId) : undefined
    if (!project) throw new AppError(409, 'PROJECT_WRITE_CONTEXT_INVALID', '项目来源任务缺少有效项目上下文')
    return { task, project }
  }

  private assertCompletionGates(projectId: string): void {
    const deliverables = this.deliverables.listByProject(projectId).filter(d => d.required === 1)
    const missing = deliverables.filter(d => !['approved', 'waived'].includes(d.status))
    if (missing.length > 0) {
      throw new AppError(409, 'DELIVERABLES_INCOMPLETE', `必选交付物未验收: ${missing.map(d => d.name).join(', ')}`)
    }
    const items = this.workItems.listByProject(projectId)
    const open = items.filter(w => !['COMPLETED', 'CANCELED', 'SUPERSEDED'].includes(w.state))
    if (open.length > 0) {
      throw new AppError(409, 'WORK_ITEMS_INCOMPLETE', `工作项未终态: ${open.map(w => w.title).join(', ')}`)
    }
  }

  private assertAcceptanceGates(projectId: string, resultId: string): ProjectResultRow {
    const result = this.results.findById(resultId)
    if (!result || result.projectId !== projectId) throw new AppError(404, 'NOT_FOUND', '成果不存在或不属于该项目')
    if (result.status !== 'reviewed') throw new AppError(409, 'RESULT_STATE_INVALID', `成果状态 ${result.status} 不能申请验收`)
    const evidence = parseJson<unknown[]>(result.evidenceJson, [])
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new AppError(400, 'EVIDENCE_REQUIRED', '成果没有证据，不能申请验收')
    }
    return result
  }

  /**
   * Owner 批准计划后物化：交付物按 name 幂等、工作项按 dedupeKey 幂等、依赖二次回填。
   * 物化失败不推翻已落地的审批（CAS 已赢），只记录 plan.apply_failed 事件等待人工处理。
   */
  private materializeApprovedPlan(p: ProjectRow, version: number, planJson: string): void {
    const raw = parseJson<Record<string, unknown>>(planJson, {})
    if (!Array.isArray(raw.deliverables)) return
    try {
      const normalized = normalizeProjectPlan(raw)
      const channels = this.bindings.listByProject(p.id).filter(b => b.status === 'active')
      const resolveChannel = (ref: string): string | undefined => {
        if (channels.some(b => b.channelId === ref)) return ref
        for (const b of channels) {
          const ch = this.manager.getChannelForUser(b.channelId, p.ownerUserId)
          if (ch && ch.name === ref) return b.channelId
        }
        return undefined
      }
      const existingDeliverables = this.deliverables.listByProject(p.id)
      const deliverableByName = new Map(existingDeliverables.map(d => [d.name, d]))
      const deliverableIdByKey = new Map<string, string>()
      let createdDeliverables = 0
      for (const d of normalized.deliverables) {
        const existing = deliverableByName.get(d.name)
        if (existing) {
          deliverableIdByKey.set(d.key, existing.id)
          continue
        }
        const created = this.deliverables.create({
          projectId: p.id,
          name: d.name,
          description: d.description,
          ownerChannelId: d.channelId ? resolveChannel(d.channelId) : null,
          required: d.required ? 1 : 0,
          acceptanceCriteriaJson: JSON.stringify(d.acceptanceCriteria),
          createdBy: 'project_leader',
        })
        deliverableIdByKey.set(d.key, created.id)
        createdDeliverables += 1
      }
      const existingItems = this.workItems.listByProject(p.id)
      const itemByDedupe = new Map(existingItems.map(w => [w.dedupeKey, w]))
      const workItemIdByKey = new Map<string, string>()
      const warnings: string[] = []
      let createdWorkItems = 0
      for (const w of normalized.workItems) {
        const dedupeKey = w.dedupeKey ?? `${w.deliverableKey}:${w.channelId}:${w.title}`
        const existing = itemByDedupe.get(dedupeKey)
        if (existing) {
          workItemIdByKey.set(w.key, existing.id)
          continue
        }
        const deliverableId = deliverableIdByKey.get(w.deliverableKey)
        const channelId = resolveChannel(w.channelId)
        if (!deliverableId || !channelId) {
          warnings.push(`工作项「${w.title}」跳过：交付物或 Channel 未解析`)
          continue
        }
        const created = this.workItems.create({
          projectId: p.id,
          deliverableId,
          channelId,
          title: w.title,
          brief: w.brief,
          dependsOnJson: '[]',
          acceptanceJson: JSON.stringify(w.acceptanceCriteria),
          resultKey: w.resultKey,
          planVersion: version,
          execBudgetMinutes: w.execBudgetMinutes,
          traceId: `plan:${p.id}:${version}:${w.key}`,
          dedupeKey,
          createdBy: 'project_leader',
        })
        workItemIdByKey.set(w.key, created.id)
        createdWorkItems += 1
      }
      for (const w of normalized.workItems) {
        const id = workItemIdByKey.get(w.key)
        if (!id) continue
        const deps = w.dependsOn.map(k => workItemIdByKey.get(k)).filter((x): x is string => Boolean(x))
        if (deps.length !== w.dependsOn.length) warnings.push(`工作项「${w.title}」依赖未全部解析`)
        this.workItems.update(id, { dependsOnJson: JSON.stringify(deps) })
      }
      this.events.append({
        projectId: p.id,
        type: 'plan.applied',
        eventKey: `plan:${p.id}:${version}:applied`,
        payloadJson: JSON.stringify({ version, createdDeliverables, createdWorkItems, warnings }),
        traceId: `plan:${p.id}:${version}`,
      })
    }
    catch (err) {
      this.events.append({
        projectId: p.id,
        type: 'plan.apply_failed',
        eventKey: `plan:${p.id}:${version}:apply_failed`,
        payloadJson: JSON.stringify({ version, error: err instanceof Error ? err.message : String(err) }),
        traceId: `plan:${p.id}:${version}`,
      })
    }
  }

  private appendAgentDecision(projectId: string, agentId: string, decisionType: string, args: Record<string, unknown>, traceId: string, eventType: string, eventKey: string, payload: Record<string, unknown>): void {
    const argsJson = JSON.stringify(args)
    this.decisions.append({
      projectId,
      source: 'leader',
      decisionType,
      actorAgentId: agentId,
      argsJson,
      argsSha256: createHash('sha256').update(argsJson).digest('hex'),
      state: 'applied',
      outcome: 'applied',
      traceId,
    })
    this.events.append({ projectId, type: eventType, eventKey, payloadJson: JSON.stringify(payload), traceId })
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
