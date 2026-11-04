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
import type { AgentChannelManager } from '../runtime/manager'
import type { ProjectChannelRow, ProjectDeliverableRow, ProjectRow, ProjectWorkItemRow } from '../db/project.repo'
import {
  createProjectRepo,
  createProjectChannelRepo,
  createProjectDeliverableRepo,
  createProjectWorkItemRepo,
  createProjectAttemptRepo,
} from '../db/project.repo'
import { AppError } from '../../../utils/errors'

export interface ProjectActor {
  id: string
  role?: string
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

  constructor(
    private readonly manager: AgentChannelManager,
    db: DatabaseSync,
  ) {
    this.projects = createProjectRepo(db)
    this.bindings = createProjectChannelRepo(db)
    this.deliverables = createProjectDeliverableRepo(db)
    this.workItems = createProjectWorkItemRepo(db)
    this.attempts = createProjectAttemptRepo(db)
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
