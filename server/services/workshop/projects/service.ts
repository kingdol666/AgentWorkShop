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
import type { ProjectApprovalRow, ProjectChannelRow, ProjectDeliverableRow, ProjectDecisionRow, ProjectEventRow, ProjectMemberRow, ProjectResultRow, ProjectRow, ProjectWorkItemRow } from '../db/project.repo'
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
  createProjectMemberRepo,
} from '../db/project.repo'
import { createTaskRepo } from '../db/task.repo'
import { createProjectKernelRepo } from '../db/project-kernel.repo'
import type { TaskRow } from '../db/database'
import { withTransaction } from '../db/transaction'
import { parseJson } from '../db/database'
import { AppError } from '../../../utils/errors'
import { argsDigest } from './digest'
import { PROJECT_GATED_WRITE_TOOL_NAMES } from './tool-surface'
import { evaluateWorkItemReadiness } from './readiness'
import { selectReadyWithContext } from './route-dispatcher'

export interface ProjectActor {
  id: string
  role?: string
  /** 项目 leader agent 身份（review 路径用） */
  agentId?: string
}

export interface ProjectServiceDeps {
  /**
   * C11 line grant：人类 actor 的可见产线集。
   * null=不限（特权）；Set=按集过滤（空 line_id 对非 admin 隐藏，S4 同口径）；
   * undefined=未启用 grant 过滤（单测/兼容路径保持原行为）。
   */
  lineAccessOf?: (userId: string) => Set<string> | null
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
  /** 契约图边：上游交付物 key（technical 口径下上游验收后才放行下游）。 */
  dependsOn: string[]
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
  /** P1 handoff 契约（inputs/output/acceptance）；未提供时为 null。 */
  contract?: Record<string, unknown> | null
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

interface TaskArtifactLike {
  artifactId?: string
  name?: string
  parts?: Array<{ text?: string }>
}

interface ArtifactDigest {
  artifactId: string
  name: string
  text: string
  bytes: number
  sha256: string
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 任务产物索引：只收有真实文本内容的 artifact（input 由 handoff 注入，不作为成果证据）。 */
function artifactDigests(taskArtifactsJson: string): Map<string, ArtifactDigest> {
  const rows = parseJson<TaskArtifactLike[]>(taskArtifactsJson, [])
  const out = new Map<string, ArtifactDigest>()
  for (const a of rows) {
    const artifactId = String(a.artifactId ?? '')
    if (!artifactId) continue
    const text = (a.parts ?? []).map(p => p.text ?? '').join('')
    if (!text.trim()) continue
    out.set(artifactId, {
      artifactId,
      name: String(a.name ?? ''),
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: sha256Hex(text),
    })
  }
  return out
}

export interface EvidenceVerification {
  contentSha256: string
  checkedAt: string
  criteriaCheckJson: string
  artifactBacked: number
  manual: number
}

/**
 * P0 证据核验：证据必须能回溯到同项目/同工作项任务里真实存在的 artifact；
 * 空 artifactId、空文本、sha256 不匹配一律拒绝。manual attestation 仅在
 * owner 人工提交路径允许（agent 提交必须 artifact-backed）。
 */
export function verifyEvidenceAgainstTask(
  taskArtifactsJson: string,
  evidence: Array<Record<string, unknown>>,
  opts: { requireArtifact: boolean, payloadJson?: string, summary?: string },
): EvidenceVerification {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new AppError(400, 'EVIDENCE_REQUIRED', '成果没有证据，不能提交/验收')
  }
  const artifacts = artifactDigests(taskArtifactsJson)
  let artifactBacked = 0
  let manual = 0
  const problems: string[] = []
  for (const [i, item] of evidence.entries()) {
    const artifactId = String(item.artifactId ?? '')
    if (artifactId) {
      const artifact = artifacts.get(artifactId)
      if (!artifact) {
        problems.push(`evidence[${i}] artifact ${artifactId} 不存在或内容为空`)
        continue
      }
      const declared = String(item.sha256 ?? '')
      if (declared && declared !== artifact.sha256) {
        problems.push(`evidence[${i}] sha256 不匹配`)
        continue
      }
      artifactBacked += 1
      continue
    }
    if (item.kind === 'manual' && typeof item.note === 'string' && item.note.trim()) {
      manual += 1
      continue
    }
    problems.push(`evidence[${i}] 既没有可回溯 artifactId，也不是 manual attestation`)
  }
  if (problems.length > 0) {
    throw new AppError(400, 'EVIDENCE_UNVERIFIED', `证据不可回溯：${problems.slice(0, 5).join('；')}`)
  }
  if (opts.requireArtifact && artifactBacked === 0) {
    throw new AppError(400, 'EVIDENCE_UNVERIFIED', 'Agent 提交的成果必须至少有一份真实 artifact 证据')
  }
  if (artifactBacked === 0 && manual === 0) {
    throw new AppError(400, 'EVIDENCE_UNVERIFIED', '证据为空壳（无 artifact、无 manual attestation）')
  }
  const checkedAt = new Date().toISOString()
  return {
    contentSha256: sha256Hex(`${opts.summary ?? ''}\n${opts.payloadJson ?? ''}\n${JSON.stringify(evidence)}`),
    checkedAt,
    criteriaCheckJson: JSON.stringify({ ok: true, artifactBacked, manual, checkedAt }),
    artifactBacked,
    manual,
  }
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
      dependsOn: asStringArray(d.dependsOn ?? d.depends_on),
    }
  })
  for (const d of deliverables) {
    for (const dep of d.dependsOn) {
      if (!deliverableKeys.has(dep)) throw new AppError(400, 'PLAN_INVALID', `交付物「${d.name}」依赖未知交付物: ${dep}`)
      if (dep === d.key) throw new AppError(400, 'PLAN_INVALID', `交付物「${d.name}」不能依赖自己`)
    }
  }
  assertAcyclic(deliverables.map(d => ({ id: d.key, deps: d.dependsOn })), '交付物')

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
      contract: Object.keys(asObject(w.contract)).length > 0 ? asObject(w.contract) : null,
    }
  })
  for (const w of workItems) {
    for (const dep of w.dependsOn) {
      if (!workKeys.has(dep)) throw new AppError(400, 'PLAN_INVALID', `工作项「${w.title}」依赖未知工作项: ${dep}`)
      if (dep === w.key) throw new AppError(400, 'PLAN_INVALID', `工作项「${w.title}」不能依赖自己`)
    }
  }
  assertAcyclic(workItems.map(w => ({ id: w.key, deps: w.dependsOn })), '工作项')
  return { deliverables, workItems, raw: plan }
}

/** 执行图/契约图统一环检测（DFS 三色）。 */
export function assertAcyclic(nodes: Array<{ id: string, deps: string[] }>, label: string): void {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const state = new Map<string, 0 | 1 | 2>()
  const visit = (id: string, path: string[]): void => {
    const mark = state.get(id) ?? 0
    if (mark === 2) return
    if (mark === 1) {
      throw new AppError(400, 'PLAN_INVALID', `${label}依赖成环: ${[...path, id].join(' -> ')}`)
    }
    state.set(id, 1)
    const node = byId.get(id)
    if (node) {
      for (const dep of node.deps) {
        if (byId.has(dep)) visit(dep, [...path, id])
      }
    }
    state.set(id, 2)
  }
  for (const n of nodes) visit(n.id, [])
}

export interface CreateProjectInput {
  name: string
  description?: string
  objective: string
  successCriteria?: string[]
  mode?: 'observe' | 'supervised' | 'auto'
  leaderHarness?: string
  leaderConfig?: Record<string, unknown>
  /** 审查修复：计划门开关（缺省 1=派发必须先批计划；0=关闭，测试/无计划场景用） */
  planApprovalRequired?: number
  /** PR20 Route 派发闭环：true=计划批准后按 dependsOn 就绪顺序自动派发（缺省 false，行为零突变） */
  autoDispatch?: boolean
  /**
   * Router v3：legacy=上游工作项终态即放行（兼容旧项目/单测）；
   * technical=上游成果技术验收后才放行。API 新建项目默认 technical，服务层缺省 legacy。
   */
  routingPolicy?: 'legacy' | 'technical'
}

/** PR20 自动派发结果（route 回调闭环的可观测面）。 */
export interface AutoDispatchResult {
  dispatched: Array<{ workItemId: string, taskId: string | null }>
  failed: number
  skippedByGate: boolean
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
  private readonly members
  private readonly tasks
  /** PR17 M4 内核仓储：ledger / plan_versions / effects / health。 */
  private readonly kernelRepo

  constructor(
    private readonly manager: AgentChannelManager,
    private readonly db: DatabaseSync,
    private readonly deps: ProjectServiceDeps = {},
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
    this.members = createProjectMemberRepo(db)
    this.tasks = createTaskRepo(db)
    this.kernelRepo = createProjectKernelRepo(db)
  }

  list(actor: ProjectActor): ProjectRow[] {
    return actor.role === 'admin' ? this.projects.listAll() : this.projects.listByOwner(actor.id)
  }

  get(id: string, actor: ProjectActor): ProjectRow {
    const p = this.projects.findById(id)
    if (!p) throw new AppError(404, 'NOT_FOUND', `Project 不存在: ${id}`)
    this.requireRead(p, actor)
    return p
  }

  /** PR10 团队协作：成员（viewer/approver）可读项目；写操作仍要求 owner（requireOwner）。 */
  listMembers(id: string, actor: ProjectActor): ProjectMemberRow[] {
    this.get(id, actor)
    return this.members.listByProject(id)
  }

  addMember(id: string, actor: ProjectActor, input: { userId: string, role?: string }): ProjectMemberRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    const userId = input.userId?.trim()
    if (!userId) throw new AppError(400, 'BAD_REQUEST', 'userId 不能为空')
    if (userId === p.ownerUserId) throw new AppError(409, 'MEMBER_CONFLICT', 'owner 已隐式具有全部权限，不能重复添加')
    const existing = this.members.findOne(id, userId)
    if (existing) {
      if (input.role && existing.role !== input.role) this.members.setRole(id, userId, input.role)
      return this.members.findOne(id, userId)!
    }
    return this.members.add({ projectId: id, userId, role: input.role ?? 'viewer', addedBy: actor.id })
  }

  removeMember(id: string, userId: string, actor: ProjectActor): void {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    this.members.remove(id, userId)
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
      planApprovalRequired: input.planApprovalRequired === 0 ? 0 : 1,
      autoDispatch: input.autoDispatch ? 1 : 0,
      routingPolicy: input.routingPolicy ?? 'legacy',
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
    this.requireOwner(p, actor)
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
    this.requireOwner(p, actor)
    if (p.status !== 'active') throw new AppError(409, 'PROJECT_STATE_INVALID', `Project 状态 ${p.status} 不能暂停`)
    return this.projects.update(id, { status: 'paused' })!
  }

  resume(id: string, actor: ProjectActor): ProjectRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    if (p.status !== 'paused') throw new AppError(409, 'PROJECT_STATE_INVALID', `Project 状态 ${p.status} 不能恢复`)
    return this.projects.update(id, { status: 'active' })!
  }

  archive(id: string, actor: ProjectActor): ProjectRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
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
    this.requireOwner(p, actor)
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

  /** 审查修复（完成门豁免入口）：owner 可豁免交付物（waived），使项目完成门可达。 */
  waiveDeliverable(id: string, deliverableId: string, actor: ProjectActor, reason: string): ProjectDeliverableRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    const d = this.deliverables.findById(deliverableId)
    if (!d || d.projectId !== id) throw new AppError(404, 'NOT_FOUND', '交付物不存在或不属于该项目')
    if (d.status === 'approved') throw new AppError(409, 'DELIVERABLE_STATE_INVALID', '已验收交付物不能豁免')
    if (!reason.trim()) throw new AppError(400, 'BAD_REQUEST', '豁免必须给出理由')
    this.deliverables.setStatus(deliverableId, 'waived', reason)
    this.record(id, 'deliverable.waived', actor, { deliverableId, reason }, '', 'deliverable.waived', `deliverable:${deliverableId}:waived`, { deliverableId, reason })
    return this.deliverables.findById(deliverableId)!
  }

  /** 审查修复（完成门豁免入口）：owner 可取消工作项（含 FAILED 卡死场景），attempt 一并闭合。 */
  cancelWorkItem(id: string, workItemId: string, actor: ProjectActor, reason: string): ProjectWorkItemRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    const wi = this.workItems.findById(workItemId)
    if (!wi || wi.projectId !== id) throw new AppError(404, 'NOT_FOUND', '工作项不存在或不属于该项目')
    if (['COMPLETED', 'CANCELED', 'SUPERSEDED'].includes(wi.state)) return wi
    if (!reason.trim()) throw new AppError(400, 'BAD_REQUEST', '取消必须给出理由')
    withTransaction(this.db, () => {
      this.workItems.update(workItemId, {
        state: 'CANCELED',
        stateReason: reason,
        closedAt: new Date().toISOString(),
        closeReason: 'OWNER_CANCELED',
      })
      if (wi.currentAttemptId) {
        const attempt = this.attempts.findById(wi.currentAttemptId)
        if (attempt && !attempt.closedAt) this.attempts.close(attempt.id, 'CLOSED', reason)
      }
      this.record(id, 'work.canceled', actor, { workItemId, reason }, wi.traceId, 'work.canceled', `work:${workItemId}:canceled`, { workItemId, reason })
    })
    return this.workItems.findById(workItemId)!
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
    this.requireOwner(p, actor)
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
   * 派发工作项到成员 Channel root task（owner 手动入口）。
   * V1 只允许 project active；同一 work item 只允许一个 live attempt；
   * planVersion 在项目已有 approved plan 时必须匹配。
   */
  async dispatchWorkItem(id: string, workItemId: string, actor: ProjectActor): Promise<ProjectWorkItemRow> {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    return this.dispatchWorkItemAs(id, workItemId, actor, p, { auto: false })
  }

  /**
   * 派发内部路径（手动/自动共用；授权校验由入口完成）。
   * PR20：手动派发落 `work.dispatched`、自动派发落 `work.dispatch_auto`（此前两者均无事件）。
   */
  private async dispatchWorkItemAs(
    id: string,
    workItemId: string,
    actor: ProjectActor,
    p: ProjectRow,
    opts: { auto: boolean },
  ): Promise<ProjectWorkItemRow> {
    if (p.status !== 'active') throw new AppError(409, 'PROJECT_NOT_ACTIVE', `Project 状态 ${p.status} 不能派发`)
    // 审查修复（计划门）：要求批准计划的项目，plan 未批前不得派发任何工作项。
    if (p.planApprovalRequired === 1 && p.planVersion === 0) {
      throw new AppError(409, 'PLAN_NOT_APPROVED', '项目要求先批准计划（plan_approval）才能派发工作项')
    }
    const wi = this.workItems.findById(workItemId)
    if (!wi || wi.projectId !== id) throw new AppError(404, 'NOT_FOUND', '工作项不存在或不属于该项目')
    const liveAttempt = wi.currentAttemptId ? this.attempts.findLiveByWorkItem(wi.id) : undefined
    if (liveAttempt) throw new AppError(409, 'WORK_ITEM_IN_FLIGHT', '工作项已有在飞 attempt')
    // 兼容既有语义：owner 手动重派 FAILED/BLOCKED 工作项视为显式 retry（attempt 已闭合；
    // current_attempt_id 可能是旧闭合 attempt 的残留指针，必须一并清掉）。
    if ((wi.state === 'FAILED' || wi.state === 'BLOCKED') && !liveAttempt) {
      this.workItems.update(wi.id, { state: 'DRAFT', stateReason: null, deferredUntil: null, currentAttemptId: null })
      wi.state = 'DRAFT'
      wi.stateReason = null
      wi.deferredUntil = null
      wi.currentAttemptId = null
    }
    if (p.planVersion > 0 && wi.planVersion !== p.planVersion) {
      if (wi.state === 'DRAFT') {
        // 审查修复：批准前手建的 DRAFT 工作项派发时自动对齐当前批准版本（避免死锁）；
        // 非 DRAFT（已执行过旧版本）的重派仍拒绝，防止悄然按新计划重跑。
        this.workItems.update(wi.id, { planVersion: p.planVersion })
        this.record(id, 'work.plan_aligned', actor, { workItemId: wi.id, from: wi.planVersion, to: p.planVersion }, wi.traceId, 'work.plan_aligned', `work:${wi.id}:aligned:v${p.planVersion}`, { workItemId: wi.id, planVersion: p.planVersion })
        wi.planVersion = p.planVersion
      }
      else {
        throw new AppError(409, 'PLAN_VERSION_STALE', `工作项计划版本 ${wi.planVersion} != 当前 ${p.planVersion}`)
      }
    }
    // Router v3 P0：手动/自动共用同一就绪谓词（legacy/technical 由项目策略决定）。
    const readiness = evaluateWorkItemReadiness(wi, {
      items: this.workItems.listByProject(id),
      results: this.results.listByProject(id),
      deliverables: this.deliverables.listByProject(id),
      routingPolicy: p.routingPolicy,
    })
    if (!readiness.ready) {
      throw new AppError(409, 'DEPENDENCY_NOT_READY', `工作项未就绪(${readiness.waitingOn})：${readiness.reason}`)
    }
    // PR20 语义分界：上方校验 = 「当前不可派」（保持 DRAFT，自动派发下轮重选）；
    // 下方环境类失败（交付物/绑定/频道/lead/submitProjectRoot）= 永久前置失败 →
    // BLOCKED + work.blocked（SLOW 邮箱评估，plan v3.0 §5.1 DISPATCHING→BLOCKED 行）。
    let attempt: ReturnType<ProjectService['attempts']['create']> | undefined
    let stage: 'precheck' | 'submit' = 'precheck'
    try {
      const d = this.deliverables.listByProject(id).find(x => x.id === wi.deliverableId)
      if (!d) throw new AppError(404, 'NOT_FOUND', '工作项交付物不存在')
      const bound = this.bindings.listByProject(id).find(b => b.channelId === wi.channelId && b.status === 'active')
      if (!bound) throw new AppError(409, 'CHANNEL_NOT_IN_PROJECT', '目标 Channel 未绑定到该项目')
      // PR20：按项目 owner 视角取 Channel（system actor 无 Channel 所有权，不能传 actor.id）。
      const channel = this.manager.getChannelForUser(wi.channelId, p.ownerUserId)
      if (!channel || channel.enabled !== 1) throw new AppError(409, 'CHANNEL_DISABLED', '目标 Channel 不存在或已禁用')
      if (!channel.leadAgentId) throw new AppError(409, 'CHANNEL_NO_LEAD', '目标 Channel 没有 lead')

      const attemptNo = this.attempts.listByWorkItem(wi.id).reduce((max, a) => Math.max(max, a.attemptNo), 0) + 1
      const sourceKey = `pw:${wi.id}:${attemptNo}`
      const traceId = wi.traceId || `trace:${wi.id}`
      // P0 派发 CAS：attempt 创建 + 工作项 DRAFT→DISPATCHING 同一事务；
      // 只有赢得 claim 的调用才能继续 submitProjectRoot（并发第二路会唯一索引/claim 失败回滚）。
      withTransaction(this.db, () => {
        attempt = this.attempts.create({
          projectId: id, workItemId: wi.id, attemptNo, channelId: wi.channelId, sourceKey, traceId,
        })
        if (!this.workItems.claimForDispatch(wi.id, attempt.id)) {
          throw new AppError(409, 'WORK_ITEM_IN_FLIGHT', '工作项已被其他派发者领取')
        }
      })
      stage = 'submit'
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
      this.attempts.setDispatched(attempt!.id, task.id)
      const evtType = opts.auto ? 'work.dispatch_auto' : 'work.dispatched'
      this.record(id, evtType, actor, { workItemId: wi.id, taskId: task.id, attemptNo }, traceId, evtType, `work:${wi.id}:${opts.auto ? 'auto' : 'dispatched'}:a${attemptNo}`, { workItemId: wi.id, taskId: task.id, attemptNo, auto: opts.auto })
      return this.workItems.update(wi.id, {
        state: 'DISPATCHED',
        stateReason: null,
        currentAttemptId: attempt!.id,
        traceId,
        planVersion: p.planVersion,
        deferredUntil: null,
      })!
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string }).code ?? ''
      const errno = (err as { errno?: number }).errno
      // claim 未赢（并发/已派发）：不算失败，不动工作项状态，直接向上抛。
      if (code === 'WORK_ITEM_IN_FLIGHT') throw err
      const transient = stage === 'submit'
      const current = this.workItems.findById(wi.id)
      const ownsClaim = !attempt || current?.currentAttemptId === attempt.id
      if (attempt) {
        const retryable = transient && (current?.attemptCount ?? 0) < (current?.maxAttempts ?? 3)
        const backoffMs = Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, (current?.attemptCount ?? 1) - 1))
        this.attempts.closeWithFailure(attempt.id, {
          reason: message,
          failureClass: transient ? 'TRANSIENT' : 'CONTRACT',
          retryable,
          nextRetryAt: retryable ? new Date(Date.now() + backoffMs).toISOString() : null,
        })
        if (!ownsClaim) throw err
        const nextState = retryable ? 'DRAFT' : 'BLOCKED'
        this.workItems.update(wi.id, {
          state: nextState,
          stateReason: message,
          currentAttemptId: null,
          deferredUntil: retryable ? new Date(Date.now() + backoffMs).toISOString() : null,
        })
        const evtType = retryable ? 'work.retry_scheduled' : 'work.blocked'
        this.record(id, evtType, actor, { workItemId: wi.id, reason: message, failureClass: transient ? 'TRANSIENT' : 'CONTRACT', retryable }, wi.traceId || `trace:${wi.id}`, evtType, `work:${wi.id}:${retryable ? 'retry' : 'blocked'}:a${attempt.attemptNo}`, { workItemId: wi.id, reason: message, stage, failureClass: transient ? 'TRANSIENT' : 'CONTRACT', retryable, errno })
      }
      else {
        this.workItems.update(wi.id, {
          state: 'BLOCKED',
          stateReason: message,
          currentAttemptId: null,
        })
        this.record(id, 'work.blocked', actor, { workItemId: wi.id, reason: message }, wi.traceId || `trace:${wi.id}`, 'work.blocked', `work:${wi.id}:blocked:${Date.now()}`, { workItemId: wi.id, reason: message, stage, errno })
      }
      throw err
    }
  }

  listResults(id: string, actor: ProjectActor): ProjectResultRow[] {
    this.get(id, actor)
    return this.filterResultsByGrant(this.results.listByProject(id), actor)
  }

  /** C11 line grant：成果列表按人类 actor 可见产线集过滤（agents 走 agentReadResults，不受此影响）。 */
  private filterResultsByGrant(rows: ProjectResultRow[], actor: ProjectActor): ProjectResultRow[] {
    const visible = this.lineVisibleOf(actor)
    if (visible === undefined || visible === null) return rows
    return rows.filter(r => r.lineId !== '' && visible.has(r.lineId))
  }

  /** undefined=未启用过滤（兼容/单测）；null=不限（admin/agent）；Set=授权产线集。 */
  private lineVisibleOf(actor: ProjectActor): Set<string> | null | undefined {
    if (actor.role === 'admin' || actor.agentId) return null
    return this.deps.lineAccessOf?.(actor.id)
  }

  /** 单成果操作门（C11）：无该产线授权 → 403；未启用过滤或特权路径直通。 */
  private assertResultLineVisible(result: ProjectResultRow, actor: ProjectActor): void {
    const visible = this.lineVisibleOf(actor)
    if (visible === undefined || visible === null) return
    if (result.lineId === '' || !visible.has(result.lineId)) {
      throw new AppError(403, 'LINE_FORBIDDEN', `无该成果产线授权（line ${result.lineId || '-'}）`)
    }
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

  /** PR11 周报：一页纸数字（交付物/工作项/成果/审批/进度/阻塞/近 7 天事件），与库严格同源。 */
  projectWeeklyReport(id: string, actor: ProjectActor) {
    const p = this.get(id, actor)
    const nowIso = new Date().toISOString()
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const countBy = <T>(rows: T[], key: (row: T) => string): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const r of rows) {
        const k = key(r) || '-'
        out[k] = (out[k] ?? 0) + 1
      }
      return out
    }
    const deliverables = this.deliverables.listByProject(id)
    const items = this.workItems.listByProject(id)
    const results = this.filterResultsByGrant(this.results.listByProject(id), actor)
    const pendingApprovals = this.approvals.listPending(id)
    const weekEvents = this.events.listByProject(id).filter(e => e.createdAt >= weekAgo)
    const required = deliverables.filter(d => d.required === 1)
    const scoreable = items.filter(w => !['CANCELED', 'SUPERSEDED'].includes(w.state))
    const completed = scoreable.filter(w => w.state === 'COMPLETED')
    const blocked = items.filter(w => w.state === 'BLOCKED')
    return {
      projectId: p.id,
      name: p.name,
      status: p.status,
      planVersion: p.planVersion,
      generatedAt: nowIso,
      week: { from: weekAgo, to: nowIso },
      deliverables: {
        total: deliverables.length,
        requiredTotal: required.length,
        requiredApproved: required.filter(d => ['approved', 'waived'].includes(d.status)).length,
        byStatus: countBy(deliverables, d => d.status),
      },
      workItems: {
        total: items.length,
        completed: completed.length,
        blocked: blocked.length,
        byState: countBy(items, w => w.state),
      },
      results: { total: results.length, byStatus: countBy(results, r => r.status) },
      approvals: { pending: pendingApprovals.length, items: pendingApprovals.map(a => ({ id: a.id, kind: a.kind, subjectId: a.subjectId })) },
      progress: {
        ratio: scoreable.length > 0 ? Math.round((completed.length / scoreable.length) * 100) / 100 : 0,
        completedWorkItems: completed.length,
        scoreableWorkItems: scoreable.length,
      },
      blockedItems: blocked.map(w => ({ id: w.id, title: w.title, reason: w.stateReason })),
      recentEvents: { count: weekEvents.length, items: weekEvents.slice(-20).map(e => ({ seq: e.seq, type: e.type, at: e.createdAt, traceId: e.traceId })) },
    }
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

  /** PR20：按项目串行化的自动派发链（submitProjectRoot 非事务窗口的防双派闸；后到调用排队等前序完成）。 */
  private readonly autoDispatchChains = new Map<string, Promise<AutoDispatchResult>>()

  /**
   * PR20 Route 自动派发入口（幂等可并发调用）：同项目调用经 promise 链串行，
   * 后到调用在前序完成后**重新选择**就绪项再跑（不跳过 —— 内核 tick 与 30s
   * Reconciler 双路触发不会互吞派发窗口）。
   */
  autoDispatchProject(id: string): Promise<AutoDispatchResult> {
    const prev = this.autoDispatchChains.get(id) ?? Promise.resolve()
    const next = prev.catch(() => { /* 前序失败不阻断本轮 */ }).then(() => this.doAutoDispatch(id))
    this.autoDispatchChains.set(id, next)
    void next.then(() => {
      if (this.autoDispatchChains.get(id) === next) this.autoDispatchChains.delete(id)
    }, () => {
      if (this.autoDispatchChains.get(id) === next) this.autoDispatchChains.delete(id)
    })
    return next
  }

  /**
   * 实际派发体：计划已批 + auto_dispatch=1 的 active 项目，对 selectReadyWorkItems
   * 选出的就绪项按序调用内部派发路径（system actor）。单项失败已由派发路径置
   * BLOCKED 并落 work.blocked（SLOW 邮箱评估），隔离继续。
   * 项目完成仍走 owner 审批门 —— 自动派发永不自动完成项目。
   */
  private async doAutoDispatch(id: string): Promise<AutoDispatchResult> {
    const out: AutoDispatchResult = { dispatched: [], failed: 0, skippedByGate: false }
    const p = this.projects.findById(id)
    if (!p || p.status !== 'active' || p.autoDispatch !== 1) {
      out.skippedByGate = true
      return out
    }
    if (p.planApprovalRequired === 1 && p.planVersion === 0) {
      out.skippedByGate = true
      return out
    }
    const items = this.workItems.listByProject(id)
    const ready = selectReadyWithContext({
      items,
      results: this.results.listByProject(id),
      deliverables: this.deliverables.listByProject(id),
      routingPolicy: p.routingPolicy,
    })
    // Router v3 P0 容量：Channel root FIFO 决定每 Channel 并发 1；项目 4；每 tick 2。
    const limits = { perChannel: 1, perProject: 4, perTick: 2 }
    const inFlight = items.filter(w => ['DISPATCHING', 'DISPATCHED', 'RUNNING'].includes(w.state))
    let projectSlots = Math.max(0, limits.perProject - inFlight.length)
    let tickSlots = limits.perTick
    const channelInFlight = new Map<string, number>()
    for (const w of inFlight) channelInFlight.set(w.channelId, (channelInFlight.get(w.channelId) ?? 0) + 1)
    const systemActor = { id: 'system', role: 'system' } as const
    for (const wi of ready) {
      if (projectSlots <= 0 || tickSlots <= 0) break
      if ((channelInFlight.get(wi.channelId) ?? 0) >= limits.perChannel) continue
      try {
        const row = await this.dispatchWorkItemAs(id, wi.id, systemActor, p, { auto: true })
        const attempt = row.currentAttemptId ? this.attempts.findById(row.currentAttemptId) : undefined
        out.dispatched.push({ workItemId: wi.id, taskId: attempt?.channelTaskId ?? null })
        projectSlots -= 1
        tickSlots -= 1
        channelInFlight.set(wi.channelId, (channelInFlight.get(wi.channelId) ?? 0) + 1)
      }
      catch {
        // 派发失败路径已落 BLOCKED/retry 事件；继续其余就绪项（R5）。
        out.failed += 1
      }
    }
    return out
  }

  /**
   * Router v3 P0 任务回调 sink：TaskEngine 状态迁移 → 项目侧（durable outbox + 立即收敛）。
   * 只处理 source=project 的任务；回调异常不得影响任务状态机（调用方 try/catch + 本方法自吞）。
   * 语义：at-least-once；reconcile/派发均幂等，重复回调等效一次。
   */
  onTaskStateChange(taskId: string, state: string): void {
    try {
      const task = this.tasks.findById(taskId)
      if (!task || task.source !== 'project' || !task.projectId) return
      const relevant = state === 'WORKING' || state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELED'
      if (!relevant) return
      const projectId = task.projectId
      this.kernelRepo.effects.enqueue({
        projectId,
        dedupeKey: `task-callback:${taskId}:${state}`,
        kind: 'task_callback',
        payload: { taskId, state },
        traceId: task.traceId,
      })
      // 立即收敛（tick/30s reconciler 仍为兜底；事件丢失由 outbox/tick 收敛）。
      queueMicrotask(() => {
        void this.runRouteLoop(projectId).catch(() => { /* 兜底路径在下一 tick */ })
      })
    }
    catch {
      /* 回调是旁路，不得拖垮任务状态机 */
    }
  }

  /**
   * PR20 route 回调闭环：对账收敛（root 终态 → 工作项状态 → 成果 draft）后立即
   * 尝试派发下一批就绪项。内核 tick（10s）与 30s Reconciler 双路调用本方法，
   * 「Channel 完成回调 → 派发下一项」延迟上界 ≈ 1 个对账周期。
   */
  async runRouteLoop(id: string): Promise<{
    reconcile: { workItems: ProjectWorkItemRow[], expiredApprovals: number }
    autoDispatch: Awaited<ReturnType<ProjectService['autoDispatchProject']>>
  }> {
    const reconcile = this.reconcileInternal(id)
    const autoDispatch = await this.autoDispatchProject(id)
    return { reconcile, autoDispatch }
  }

  listActiveProjects(): ProjectRow[] {
    return this.projects.listAll().filter(p => p.status === 'active')
  }

  private reconcileWith(id: string, actor: ProjectActor): { workItems: ProjectWorkItemRow[], expiredApprovals: number } {
    // B8 审计 fail-closed：每个工作项的状态迁移与 decisions/events 同事务，逐项隔离。
    for (const wi of this.workItems.listByProject(id)) {
      if (['COMPLETED', 'FAILED', 'CANCELED', 'SUPERSEDED'].includes(wi.state)) continue
      // 审查修复：DRAFT（从未派发）不是异常，Reconciler 不得将其 BLOCKED（此前每 30s 死循环写审计）。
      if (wi.state === 'DRAFT' && !wi.currentAttemptId) continue
      if (wi.deadlineAt && Date.parse(wi.deadlineAt) < Date.now()) {
        withTransaction(this.db, () => {
          this.workItems.update(wi.id, { state: 'BLOCKED', stateReason: 'OVERDUE' })
          this.record(id, 'work.overdue', actor, { workItemId: wi.id }, wi.traceId, 'work.overdue', `work:${wi.id}:overdue`, { workItemId: wi.id })
        })
        continue
      }
      const attempt = wi.currentAttemptId ? this.attempts.findById(wi.currentAttemptId) : undefined
      if (!attempt || !attempt.channelTaskId) {
        withTransaction(this.db, () => {
          this.workItems.update(wi.id, { state: 'BLOCKED', stateReason: 'ATTEMPT_MISSING' })
          this.record(id, 'work.blocked', actor, { workItemId: wi.id, reason: 'ATTEMPT_MISSING' }, wi.traceId, 'work.blocked', `work:${wi.id}:attempt-missing`, { workItemId: wi.id, reason: 'ATTEMPT_MISSING' })
        })
        continue
      }
      const task = this.tasks.findById(attempt.channelTaskId)
      if (!task) {
        withTransaction(this.db, () => {
          this.workItems.update(wi.id, { state: 'BLOCKED', stateReason: 'TASK_MISSING' })
          this.record(id, 'work.blocked', actor, { workItemId: wi.id, reason: 'TASK_MISSING' }, wi.traceId, 'work.blocked', `work:${wi.id}:task-missing`, { workItemId: wi.id, reason: 'TASK_MISSING' })
        })
        continue
      }
      if (task.state === 'COMPLETED') {
        withTransaction(this.db, () => {
          this.workItems.update(wi.id, { state: 'COMPLETED', stateReason: null, closedAt: new Date().toISOString(), closeReason: 'ROOT_COMPLETED' })
          // 审查修复：attempt 必须闭合，否则 live 唯一索引让 FAILED/COMPLETED 工作项永久 IN_FLIGHT。
          if (attempt) this.attempts.close(attempt.id, 'CLOSED')
          this.ensureDraftFromTask(task.id)
          this.record(id, 'work.completed', actor, { workItemId: wi.id, taskId: task.id }, wi.traceId, 'work.completed', `work:${wi.id}:completed`, { workItemId: wi.id, taskId: task.id })
        })
        continue
      }
      if (task.state === 'FAILED' || task.state === 'CANCELED') {
        withTransaction(this.db, () => {
          this.workItems.update(wi.id, { state: task.state, stateReason: task.closeReason ?? task.state, closedAt: new Date().toISOString(), closeReason: task.closeReason ?? task.state })
          if (attempt) this.attempts.close(attempt.id, 'CLOSED', task.closeReason ?? task.state)
          this.record(id, 'work.failed', actor, { workItemId: wi.id, taskId: task.id, state: task.state }, wi.traceId, 'work.failed', `work:${wi.id}:${task.state.toLowerCase()}`, { workItemId: wi.id, taskId: task.id, state: task.state })
        })
        continue
      }
      if (task.state === 'WORKING' || task.state === 'WAITING' || task.state === 'ASSIGNED') {
        if (wi.state !== 'RUNNING') this.workItems.update(wi.id, { state: 'RUNNING', stateReason: null })
        continue
      }
    }
    let expiredApprovals = 0
    withTransaction(this.db, () => {
      expiredApprovals = this.approvals.expire(id)
      if (expiredApprovals > 0) {
        this.record(id, 'approval.expired', actor, { expiredApprovals }, '', 'approval.expired', `approval:expired:${Date.now()}`, { expiredApprovals })
      }
    })
    // PR20：派发由 runRouteLoop（reconcile 之后的 await 步骤）统一执行；
    // 本方法保持纯对账，fire-and-forget 派发会让「谁派发」不可观测且吞掉结果。
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
    const rootArtifacts = artifactDigests(task.artifactsJson)
    const usable = [...rootArtifacts.values()].filter(a => a.name !== 'input')
    // P2 轻量聚合：root COMPLETED 时把直接子任务的真实 artifact 一并纳入证据（只存引用/摘要）。
    const childRows = this.db.prepare(
      `SELECT id, assignee_id AS assigneeId, artifacts_json AS artifactsJson FROM tasks
       WHERE parent_id = ? AND state = 'COMPLETED' ORDER BY created_at ASC`,
    ).all(task.id) as Array<{ id: string, assigneeId: string, artifactsJson: string }>
    const childEvidence: Array<Record<string, unknown>> = []
    for (const child of childRows) {
      for (const artifact of artifactDigests(child.artifactsJson).values()) {
        if (childEvidence.length >= 20) break
        childEvidence.push({
          artifactId: artifact.artifactId, name: artifact.name, kind: 'artifact',
          bytes: artifact.bytes, sha256: artifact.sha256, source: 'child', childTaskId: child.id, workerAgentId: child.assigneeId,
        })
      }
    }
    const summary = usable.map(a => a.text).join('\n').slice(0, 8000) || task.title
    const evidence: Array<Record<string, unknown>> = [
      ...usable.map(a => ({ artifactId: a.artifactId, name: a.name, kind: 'artifact', bytes: a.bytes, sha256: a.sha256, source: 'root' })),
      ...childEvidence,
    ]
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
    this.assertResultLineVisible(result, actor)
    if (!['draft', 'rejected'].includes(result.status)) {
      throw new AppError(409, 'RESULT_STATE_INVALID', `成果状态 ${result.status} 不能提交`)
    }
    const p = this.projects.findById(id)!
    this.requireOwner(p, actor)
    const evidence = input.evidence ?? parseJson<Array<Record<string, unknown>>>(result.evidenceJson, [])
    const payloadJson = JSON.stringify(input.payload ?? parseJson(result.payloadJson, {}))
    const summary = input.summary ?? result.summary
    const sourceTask = this.tasks.findById(result.sourceTaskId)
    const verification = verifyEvidenceAgainstTask(sourceTask?.artifactsJson ?? '[]', evidence, {
      requireArtifact: false, payloadJson, summary,
    })
    // B8：状态迁移 + 审计同事务，审计失败整体回滚。
    let updated!: ProjectResultRow
    withTransaction(this.db, () => {
      this.results.submit(resultId, {
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
        // 审查修复（自批可达）：人类提交者落 authorUserId，使「不能批准自己提交的成果」在生产可达。
        authorUserId: actor.agentId ? null : actor.id,
      })
      this.results.markEvidenceVerified(resultId, {
        contentSha256: verification.contentSha256,
        checkedAt: verification.checkedAt,
        criteriaCheckJson: verification.criteriaCheckJson,
      })
      this.record(id, 'result.submit', actor, { resultId }, result.traceId, 'result.submitted', `result:${resultId}:submitted`, { resultId })
      updated = this.results.findById(resultId)!
    })
    return updated
  }

  reviewResult(id: string, resultId: string, actor: ProjectActor, decision: 'reviewed' | 'rejected', reason = ''): ProjectResultRow {
    const p = this.projects.findById(id)
    if (!p) throw new AppError(404, 'NOT_FOUND', `Project 不存在: ${id}`)
    const allowed = actor.role === 'admin' || actor.id === p.ownerUserId || (actor.agentId && actor.agentId === p.leadAgentId)
    if (!allowed) throw new AppError(403, 'FORBIDDEN', '仅项目 owner/admin 或 project leader 可复核')
    const result = this.results.findById(resultId)
    if (!result || result.projectId !== id) throw new AppError(404, 'NOT_FOUND', '成果不存在或不属于该项目')
    this.assertResultLineVisible(result, actor)
    if (result.status !== 'submitted') throw new AppError(409, 'RESULT_STATE_INVALID', `成果状态 ${result.status} 不能复核`)
    // B8：复核迁移 + 审计同事务。
    let updated!: ProjectResultRow
    withTransaction(this.db, () => {
      this.results.setStatus(resultId, decision, {
        reviewedBy: actor.agentId ?? actor.id,
        reviewedAt: new Date().toISOString(),
        rejectReason: decision === 'rejected' ? reason : null,
      })
      this.record(id, decision === 'reviewed' ? 'result.reviewed' : 'result.rejected', actor, { resultId, reason }, result.traceId, decision === 'reviewed' ? 'result.reviewed' : 'result.rejected', `result:${resultId}:${decision}`, { resultId, reason })
      updated = this.results.findById(resultId)!
    })
    return updated
  }

  requestProjectComplete(id: string, actor: ProjectActor): ProjectApprovalRow {
    this.get(id, actor)
    this.requireOwner(this.projects.findById(id)!, actor)
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
    this.requireOwner(p, actor)
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
    // PR17 不变量 12：计划版本不可变快照（draft，待审批）。
    this.kernelRepo.planVersions.upsert(
      id,
      input.version,
      JSON.stringify(input.plan),
      createHash('sha256').update(JSON.stringify(input.plan)).digest('hex'),
    )
    this.record(id, 'plan.requested', actor, { approvalId: approval.id, version: input.version }, approval.traceId, 'plan.requested', `plan:${id}:${input.version}:requested`, { approvalId: approval.id, version: input.version })
    return approval
  }

  requestAcceptance(id: string, resultId: string, actor: ProjectActor): ProjectApprovalRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    const result = this.assertAcceptanceGates(id, resultId)
    this.assertResultLineVisible(result, actor)
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
    this.requireDecider(p, actor)
    const approval = this.approvals.findById(approvalId)
    if (!approval || approval.projectId !== id) throw new AppError(404, 'NOT_FOUND', '审批不存在或不属于该项目')
    if (approval.status !== 'pending') throw new AppError(409, 'APPROVAL_STATE_INVALID', `审批状态 ${approval.status} 不能决策`)
    if (approval.kind === 'deliverable_acceptance') {
      const result = this.results.findById(approval.subjectId)
      if (result?.authorUserId && result.authorUserId === actor.id) {
        throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', '不能批准自己提交的成果')
      }
    }
    // B8：审批决策（CAS）+ 全部副作用 + 审计同一事务；任一失败整体回滚（审批回到 pending）。
    let updated!: ProjectApprovalRow
    withTransaction(this.db, () => {
      const won = this.approvals.decide(approvalId, id, approve ? 'approved' : 'rejected', actor.id, reason)
      if (!won) throw new AppError(409, 'APPROVAL_STATE_INVALID', '审批已被处理或已过期')
      if (approval.kind === 'deliverable_acceptance') {
        const result = this.results.findById(approval.subjectId)
        if (result) {
          this.assertResultLineVisible(result, actor)
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
        // PR17 不变量 12：先收编旧 approved，再批准新版本（部分唯一索引要求单 approved）。
        this.kernelRepo.planVersions.supersedeOthers(id, version)
        this.kernelRepo.planVersions.markApproved(id, version, actor.id)
        // leader 提案的 proposal decision 与审批联动收口（CAS）。
        for (const d of this.decisions.listByProject(id)) {
          if (d.approvalId === approvalId && d.state === 'proposed') this.decisions.markApplied(d.id, 'applied', 'approved plan')
        }
        this.materializeApprovedPlan(updated ?? { ...p, planVersion: version, planJson: approval.payloadJson }, version, approval.payloadJson)
      }
      else if (approval.kind === 'plan_approval' && !approve) {
        this.kernelRepo.planVersions.markRejected(id, approval.subjectVersion ?? p.planVersion)
      }
      this.record(id, approve ? 'approval.approved' : 'approval.rejected', actor, { approvalId, kind: approval.kind, reason }, approval.traceId, approve ? 'approval.approved' : 'approval.rejected', `approval:${approvalId}:${approve ? 'approved' : 'rejected'}`, { approvalId, kind: approval.kind, reason })
      updated = this.approvals.findById(approvalId)!
    })
    return updated
  }

  supersedeResult(id: string, resultId: string, actor: ProjectActor, reason = ''): ProjectResultRow {
    this.get(id, actor)
    this.requireOwner(this.projects.findById(id)!, actor)
    const result = this.results.findById(resultId)
    if (!result || result.projectId !== id) throw new AppError(404, 'NOT_FOUND', '成果不存在或不属于该项目')
    this.assertResultLineVisible(result, actor)
    if (result.status === 'superseded') return result
    let updated!: ProjectResultRow
    withTransaction(this.db, () => {
      this.results.setStatus(resultId, 'superseded', {
        reviewedBy: result.reviewedBy,
        reviewedAt: result.reviewedAt,
        approvedBy: result.approvedBy,
        approvedAt: result.approvedAt,
        rejectReason: reason || 'superseded',
      })
      this.record(id, 'result.superseded', actor, { resultId, reason }, result.traceId, 'result.superseded', `result:${resultId}:superseded`, { resultId, reason })
      updated = this.results.findById(resultId)!
    })
    return updated
  }

  // ===== PR14：plan §7.1 API 补全（update/snapshot/trace/审批历史） =====

  /** PATCH 项目基本信息（owner-only）。 */
  updateProject(id: string, actor: ProjectActor, patch: {
    name?: string
    description?: string
    objective?: string
    mode?: 'observe' | 'supervised' | 'auto'
    /** PR20：route 自动派发开关（owner-only；切换落 project.updated 审计） */
    autoDispatch?: boolean
  }): ProjectRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    const name = patch.name?.trim()
    if (name !== undefined && !name) throw new AppError(400, 'BAD_REQUEST', '名称不能为空')
    const objective = patch.objective?.trim()
    if (objective !== undefined && !objective) throw new AppError(400, 'BAD_REQUEST', '目标不能为空')
    const next = this.projects.update(id, {
      ...(name !== undefined ? { name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(objective !== undefined ? { objective } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.autoDispatch !== undefined ? { autoDispatch: patch.autoDispatch ? 1 : 0 } : {}),
    })
    if (!next) throw new AppError(404, 'NOT_FOUND', `Project 不存在: ${id}`)
    this.record(id, 'project.updated', actor, { patch }, '', 'project.updated', `project:${id}:updated:${Date.now()}`, { fields: Object.keys(patch) })
    return next
  }

  /** PATCH 交付物（owner-only；planned/rejected 态可编辑）。 */
  updateDeliverableItem(id: string, deliverableId: string, actor: ProjectActor, patch: {
    name?: string
    description?: string
    required?: boolean
    acceptanceCriteria?: string[]
    dueAt?: string | null
  }): ProjectDeliverableRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    const d = this.deliverables.findById(deliverableId)
    if (!d || d.projectId !== id) throw new AppError(404, 'NOT_FOUND', '交付物不存在或不属于该项目')
    if (!['planned', 'rejected'].includes(d.status)) {
      throw new AppError(409, 'DELIVERABLE_STATE_INVALID', `交付物状态 ${d.status} 不能编辑`)
    }
    const name = patch.name?.trim()
    if (name !== undefined && !name) throw new AppError(400, 'BAD_REQUEST', '名称不能为空')
    const next = this.deliverables.update(deliverableId, {
      ...(name !== undefined ? { name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.required !== undefined ? { required: patch.required ? 1 : 0 } : {}),
      ...(patch.acceptanceCriteria !== undefined ? { acceptanceCriteriaJson: JSON.stringify(patch.acceptanceCriteria) } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
    })
    if (!next) throw new AppError(404, 'NOT_FOUND', '交付物不存在')
    this.record(id, 'deliverable.updated', actor, { deliverableId, patch }, '', 'deliverable.updated', `deliverable:${deliverableId}:updated:${Date.now()}`, { fields: Object.keys(patch) })
    return next
  }

  /** PATCH 工作项（owner-only；DRAFT 态可编辑——派发后锁定契约）。 */
  updateWorkItem(id: string, workItemId: string, actor: ProjectActor, patch: {
    title?: string
    brief?: string
    execBudgetMinutes?: number
    dependsOn?: string[]
    priority?: number
  }): ProjectWorkItemRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
    const wi = this.workItems.findById(workItemId)
    if (!wi || wi.projectId !== id) throw new AppError(404, 'NOT_FOUND', '工作项不存在或不属于该项目')
    if (wi.state !== 'DRAFT') {
      throw new AppError(409, 'WORK_ITEM_STATE_INVALID', `工作项状态 ${wi.state} 不能编辑（派发后契约锁定）`)
    }
    const title = patch.title?.trim()
    if (title !== undefined && !title) throw new AppError(400, 'BAD_REQUEST', '标题不能为空')
    const budget = patch.execBudgetMinutes
    if (budget !== undefined && (!Number.isFinite(budget) || budget < 1 || budget > 24 * 60)) {
      throw new AppError(400, 'BAD_REQUEST', 'execBudgetMinutes 必须在 1–1440')
    }
    const next = this.workItems.update(workItemId, {
      ...(title !== undefined ? { title } : {}),
      ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
      ...(budget !== undefined ? { execBudgetMinutes: Math.floor(budget) } : {}),
      ...(patch.dependsOn !== undefined ? { dependsOnJson: JSON.stringify(patch.dependsOn) } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    })
    if (!next) throw new AppError(404, 'NOT_FOUND', '工作项不存在')
    this.record(id, 'work.updated', actor, { workItemId, patch }, wi.traceId, 'work.updated', `work:${workItemId}:updated:${Date.now()}`, { fields: Object.keys(patch) })
    return next
  }

  /** plan §7.1 snapshot：项目只读聚合（详情页单请求加载）。 */
  projectSnapshot(id: string, actor: ProjectActor) {
    const p = this.get(id, actor)
    const report = this.projectWeeklyReport(id, actor)
    return {
      project: {
        id: p.id, name: p.name, description: p.description, objective: p.objective,
        successCriteria: parseJson(p.successCriteriaJson, []), status: p.status, mode: p.mode,
        ownerUserId: p.ownerUserId, officeChannelId: p.officeChannelId, leadAgentId: p.leadAgentId,
        planVersion: p.planVersion, plan: parseJson(p.planJson, {}), createdAt: p.createdAt,
        autoDispatch: p.autoDispatch === 1,
      },
      channels: this.bindings.listByProject(id),
      members: this.members.listByProject(id),
      deliverables: this.deliverables.listByProject(id),
      workItems: this.workItems.listByProject(id),
      results: this.filterResultsByGrant(this.results.listByProject(id), actor),
      approvals: { pending: this.approvals.listPending(id), history: this.approvals.listByProject(id) },
      report,
      // PR17 M4 内核摘要（additive；HealthBoard + effects + ledger 概览）
      kernel: {
        health: this.kernelRepo.health.list(id),
        effects: this.kernelRepo.effects.countByStatus(id),
        ledger: { count: this.kernelRepo.ledger.count(id), lastAt: this.kernelRepo.ledger.lastAt(id) },
        planApprovedVersion: this.kernelRepo.planVersions.getApproved(id)?.version ?? null,
      },
    }
  }

  /** plan §7.1 trace：按 traceId 聚合 decisions/events/tasks（为什么可读）。 */
  traceLookup(id: string, traceId: string, actor: ProjectActor) {
    this.get(id, actor)
    const trimmed = traceId.trim()
    if (!trimmed) throw new AppError(400, 'BAD_REQUEST', 'traceId 不能为空')
    const decisions = this.decisions.listByProject(id).filter(d => d.traceId === trimmed)
    const events = this.events.listByProject(id).filter(e => e.traceId === trimmed)
    const tasks = this.db.prepare(
      `SELECT id, channel_id AS channelId, title, state, progress, source, project_work_item_id AS workItemId, project_attempt_no AS attemptNo, created_at AS createdAt
       FROM tasks WHERE trace_id = ? ORDER BY created_at ASC`,
    ).all(trimmed) as Array<Record<string, unknown>>
    return {
      traceId: trimmed,
      decisions,
      events,
      tasks,
      summary: { decisions: decisions.length, events: events.length, tasks: tasks.length },
    }
  }

  /** PR14：审批历史（scope=all 含已决策/过期，倒序）。 */
  listApprovalHistory(id: string, actor: ProjectActor): ProjectApprovalRow[] {
    this.get(id, actor)
    return this.approvals.listByProject(id)
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
          actorKind: this.actorKindOf(projectId, { id: agentId, agentId }),
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
    const verification = verifyEvidenceAgainstTask(task.artifactsJson, evidence, {
      requireArtifact: true, payloadJson, summary,
    })
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
    this.results.markEvidenceVerified(result.id, {
      contentSha256: verification.contentSha256,
      checkedAt: verification.checkedAt,
      criteriaCheckJson: verification.criteriaCheckJson,
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
      // PR17 不变量 12：leader 提案的版本同样落不可变快照（draft，待 owner 批准）。
      this.kernelRepo.planVersions.upsert(
        ctx.project.id,
        version,
        argsJson,
        createHash('sha256').update(argsJson).digest('hex'),
        ctx.project.planVersion > 0 ? ctx.project.planVersion : null,
      )
      proposal = this.decisions.append({
        projectId: ctx.project.id,
        source: 'leader',
        decisionType: kind === 'replan' ? 'replan.proposed' : 'plan.proposed',
        actorAgentId: agentId,
        actorKind: this.actorKindOf(ctx.project.id, { id: agentId, agentId }),
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
      actorKind: this.actorKindOf(ctx.project.id, { id: agentId, agentId }),
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
  async applyProposal(projectId: string, decisionId: string, actor: ProjectActor): Promise<{ workItem?: ProjectWorkItemRow, dispatched: boolean, channelId?: string }> {
    const p = this.get(projectId, actor)
    this.requireOwner(p, actor)
    const decision = this.decisions.findById(projectId, decisionId)
    if (!decision) throw new AppError(404, 'NOT_FOUND', '提案不存在或不属于该项目')
    if (decision.state !== 'proposed') throw new AppError(409, 'PROPOSAL_STATE_INVALID', `提案状态 ${decision.state} 不能应用`)
    // M5：channel.proposed —— owner 应用后创建成员频道并绑定（leader 只能提案）。
    if (decision.decisionType === 'channel.proposed') {
      const args = parseJson<Record<string, unknown>>(decision.argsJson, {})
      const name = String(args.name ?? '').trim()
      if (!name) throw new AppError(400, 'BAD_REQUEST', '提案缺频道名')
      this.assertChannelNameAvailable(p, name)
      if (!this.decisions.markApplied(decisionId, 'applied', 'owner applied channel proposal')) {
        throw new AppError(409, 'PROPOSAL_STATE_INVALID', '提案已被处理')
      }
      const config = parseJson<Record<string, unknown>>(p.configJson, {})
      try {
        const created = await this.manager.createChannel({
          name,
          description: `Project channel (leader proposal ${decisionId})`,
          scenarioPrompt: String(args.charter ?? ''),
          ownerUserId: p.ownerUserId,
          actor,
          leadAgent: {
            name: `${name}·Lead`,
            harness: typeof config.leaderHarness === 'string' ? config.leaderHarness : 'mock',
          },
        })
        this.bindChannel(projectId, created.channelId, actor, String(args.charter ?? ''))
        this.record(projectId, 'proposal.applied', actor, { decisionId, channelId: created.channelId }, decision.traceId, 'proposal.applied', `proposal:${decisionId}:applied`, { decisionId, channelId: created.channelId })
        return { channelId: created.channelId, dispatched: false }
      }
      catch (err) {
        this.events.append({
          projectId,
          type: 'channel.apply_failed',
          eventKey: `proposal:${decisionId}:channel_failed:${Date.now()}`,
          payloadJson: JSON.stringify({ decisionId, error: err instanceof Error ? err.message : String(err) }),
          traceId: decision.traceId,
        })
        throw err
      }
    }
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

  /** Leader 建频道提案（M5）：只写 proposed decision；owner 应用后由服务层创建并绑定。 */
  agentProposeChannel(agentId: string, input: { name: string, charter?: string }): ProjectDecisionRow {
    const ctx = this.requireAgentContext(agentId, 'leader')
    this.assertLeaderProjectMutable(ctx.project)
    const name = input.name?.trim()
    if (!name) throw new AppError(400, 'BAD_REQUEST', '频道名不能为空')
    this.assertChannelNameAvailable(ctx.project, name)
    const args = { name, charter: input.charter ?? '', proposedBy: agentId }
    const argsJson = JSON.stringify(args)
    return this.decisions.append({
      projectId: ctx.project.id,
      source: 'leader',
      decisionType: 'channel.proposed',
      actorAgentId: agentId,
      actorKind: this.actorKindOf(ctx.project.id, { id: agentId, agentId }),
      argsJson,
      argsSha256: createHash('sha256').update(argsJson).digest('hex'),
      state: 'proposed',
      outcome: 'pending',
      traceId: `proposal:channel:${name}`,
    })
  }

  /** 频道名唯一性（提案/应用两端口径一致）：不得与成员频道或办公室频道重名。 */
  private assertChannelNameAvailable(p: ProjectRow, name: string): void {
    const taken = new Set(this.listBoundChannels(p).map(c => c.name))
    const office = p.officeChannelId ? this.manager.getChannelForUser(p.officeChannelId, p.ownerUserId) : null
    if (office) taken.add(office.name)
    if (taken.has(name)) throw new AppError(409, 'CHANNEL_NAME_EXISTS', `频道名已存在: ${name}`)
  }

  /**
   * 执行层 write gate：项目来源任务默认 project_may_write=false；
   * 高风险写必须匹配 owner 已批准、未消费、未过期且 tool/args digest/attempt 一致的 write_intent。
   */
  authorizeProjectWrite(agentId: string, toolName: string, args: Record<string, unknown>, activeRootTaskId?: string | null): ProjectWriteVerdict {
    if (!PROJECT_GATED_WRITE_TOOL_NAMES.has(toolName)) return { allowed: true }
    // 审查修复（堵 submit_task 绕道）：判定主体从「任务来源」改为「Agent 项目上下文」——
    // 项目成员（leader/lead/worker）的高风险写一律 gate，无论其用 project 任务还是普通任务发起。
    const ctx = this.agentProjectContext(agentId)
    if (!ctx) return { allowed: true }
    const config = parseJson<Record<string, unknown>>(ctx.project.configJson, {})
    if (config.mayWrite === true) return { allowed: true }
    let origin: { task: TaskRow, project: ProjectRow } | null
    try {
      origin = this.projectOriginOf(agentId, activeRootTaskId)
    }
    catch (err) {
      return { allowed: false, code: 'PROJECT_WRITE_CONTEXT_INVALID', message: err instanceof Error ? err.message : String(err) }
    }
    if (!origin || !origin.task.projectWorkItemId) {
      return {
        allowed: false,
        code: 'PROJECT_WRITE_INTENT_REQUIRED',
        message: '项目成员的高风险写必须经项目来源任务 + owner 批准的 write_intent（不得用普通任务绕过）',
      }
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

  /**
   * P0 审计主体类型：不再把所有 agent 一律记成 leader；按 channel_agents 真实
   * agent_kind/role 落 project_leader / channel_lead / worker；用户按 owner/approver/admin。
   */
  private actorKindOf(projectId: string, actor: ProjectActor): string {
    if (actor.role === 'system') return 'system'
    if (actor.role === 'admin') return 'admin'
    if (actor.agentId) {
      const ident = this.agentIdentity(actor.agentId)
      if (ident?.agentKind === 'project_leader') return 'project_leader'
      return ident?.role === 'lead' ? 'channel_lead' : 'worker'
    }
    const p = this.projects.findById(projectId)
    if (p?.ownerUserId === actor.id) return 'owner'
    const m = this.members.findOne(projectId, actor.id)
    if (m?.role === 'approver') return 'approver'
    return 'user'
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
    const evidence = parseJson<Array<Record<string, unknown>>>(result.evidenceJson, [])
    const task = this.tasks.findById(result.sourceTaskId)
    // P0：验收前重跑证据 provenance（防提交后被篡改/空壳）。
    const verification = verifyEvidenceAgainstTask(task?.artifactsJson ?? '[]', evidence, {
      requireArtifact: Boolean(result.authorAgentId),
      payloadJson: result.payloadJson,
      summary: result.summary,
    })
    this.results.markEvidenceVerified(result.id, {
      contentSha256: verification.contentSha256,
      checkedAt: verification.checkedAt,
      criteriaCheckJson: verification.criteriaCheckJson,
    })
    return this.results.findById(resultId)!
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
      // 契约图边：交付物 key → UUID（第二轮回填，支持任意声明顺序）。
      for (const d of normalized.deliverables) {
        const id = deliverableIdByKey.get(d.key)
        if (!id) continue
        const deps = d.dependsOn.map(k => deliverableIdByKey.get(k)).filter((x): x is string => Boolean(x))
        this.deliverables.update(id, { dependsOnJson: JSON.stringify(deps) })
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
          contractJson: JSON.stringify(w.contract ?? {}),
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
      actorKind: this.actorKindOf(projectId, { id: agentId, agentId }),
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
      // 审查修复：decisions 幂等（同项目+类型+args 摘要不重复追加）——周期性 Reconciler 不再膨胀审计。
      if (!this.decisions.hasDuplicate(projectId, decisionType, argsSha256)) {
        this.decisions.append({
          projectId,
          source: actor.agentId ? 'leader' : actor.role === 'system' ? 'service' : 'owner',
          decisionType,
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.agentId ? null : actor.id === 'system' ? null : actor.id,
          actorKind: this.actorKindOf(projectId, actor),
          argsJson,
          argsSha256,
          state: 'applied',
          outcome: 'applied',
          traceId,
        })
      }
      this.events.append({ projectId, type: eventType, eventKey, payloadJson: JSON.stringify(payload), traceId })
      // PR17 S5：里程碑事件同步进 Progress Ledger（append-only；与决策/事件同事务）。
      const milestone = ledgerAssessmentOf(eventType, payload)
      if (milestone) {
        const pv = this.projects.findById(projectId)?.planVersion ?? 0
        this.kernelRepo.ledger.append({
          projectId,
          planVersion: pv,
          stepNo: 0,
          triggerType: actor.agentId ? 'event' : actor.role === 'system' ? 'tick' : 'owner',
          summary: eventType,
          facts: [{ eventType, ...payload }],
          assessment: milestone.assessment,
          nextAction: milestone.nextAction,
          traceId,
        })
      }
    })
  }

  bindChannel(id: string, channelId: string, actor: ProjectActor, charter = ''): ProjectChannelRow {
    const p = this.get(id, actor)
    this.requireOwner(p, actor)
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
    this.requireOwner(p, actor)
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

  /** PR10：读可见面 = owner/admin/项目成员（viewer/approver 均可读）。 */
  private requireRead(p: ProjectRow, actor: ProjectActor): void {
    if (actor.role === 'admin') return
    if (p.ownerUserId === actor.id) return
    if (this.members.findOne(p.id, actor.id)) return
    throw new AppError(403, 'FORBIDDEN', '仅项目 owner/admin/成员可访问')
  }

  /** PR10：审批决策权 = owner/admin 或成员中的 approver（viewer 不可决策）。 */
  private requireDecider(p: ProjectRow, actor: ProjectActor): void {
    if (actor.role === 'admin') return
    if (p.ownerUserId === actor.id) return
    const m = this.members.findOne(p.id, actor.id)
    if (m && m.role === 'approver') return
    throw new AppError(403, 'FORBIDDEN', '仅项目 owner/admin/approver 可决策审批')
  }

  // ===== PR17 M4 内核读面 =====

  /** S5 账本读面（owner/admin/成员可读）。 */
  ledgerTail(id: string, actor: ProjectActor, limit = 50) {
    const p = this.get(id, actor)
    return {
      project: { id: p.id, planVersion: p.planVersion, status: p.status },
      count: this.kernelRepo.ledger.count(id),
      items: this.kernelRepo.ledger.list(id, limit).map(r => ({
        ...r,
        facts: parseJson(r.factsJson, []) as unknown,
        assessment: parseJson(r.assessmentJson, {}) as Record<string, unknown>,
        evidence: parseJson(r.evidenceJson, []) as unknown,
      })),
    }
  }

  /** S7 HealthBoard 读面（owner/admin/成员可读）：组件健康 + effects 计数 + 计划版本。 */
  kernelStatus(id: string, actor: ProjectActor) {
    const p = this.get(id, actor)
    const approved = this.kernelRepo.planVersions.getApproved(id)
    return {
      project: { id: p.id, planVersion: p.planVersion, status: p.status },
      health: this.kernelRepo.health.list(id),
      effects: this.kernelRepo.effects.countByStatus(id),
      planVersions: {
        count: this.kernelRepo.planVersions.list(id, 100).length,
        approvedVersion: approved?.version ?? null,
      },
      ledger: { count: this.kernelRepo.ledger.count(id), lastAt: this.kernelRepo.ledger.lastAt(id) },
    }
  }

  /** PR17：owner 断言（内核手动 tick 等运维入口用）。 */
  assertProjectOwner(id: string, actor: ProjectActor): void {
    this.requireOwner(this.get(id, actor), actor)
  }
}

/**
 * PR17 S5/S6：里程碑事件 → Progress Ledger 的确定性评估（Magentic-One 进步账本，
 * 评估由规则产生；LLM 评估走 slow path 提案，仍需 owner 批准）。
 * 非里程碑事件返回 null（不写账本，避免账本膨胀）。
 */
export function ledgerAssessmentOf(
  eventType: string,
  payload: Record<string, unknown>,
): { assessment: Record<string, unknown>, nextAction: string } | null {
  switch (eventType) {
    case 'work.completed':
      return { assessment: { plan_valid: true, stuck: false, reason: '工作项完成' }, nextAction: '继续推进其余工作项' }
    case 'work.failed':
      return { assessment: { plan_valid: null, stuck: true, reason: `工作项失败:${payload.reason ?? ''}` }, nextAction: '复核失败原因，必要时重试或重规划' }
    case 'work.blocked':
      return { assessment: { plan_valid: null, stuck: true, reason: `工作项阻塞:${payload.reason ?? ''}` }, nextAction: '解除阻塞或调整依赖' }
    case 'work.overdue':
      return { assessment: { plan_valid: null, stuck: true, reason: '工作项超期' }, nextAction: '评估预算与重试' }
    case 'work.canceled':
      return { assessment: { plan_valid: null, stuck: false, reason: 'owner 取消工作项' }, nextAction: '确认计划是否需要调整' }
    case 'result.submitted':
    case 'result.reviewed':
      return { assessment: { plan_valid: true, stuck: false, reason: '成果进入评审流' }, nextAction: '等待 owner 验收' }
    case 'approval.approved':
      return { assessment: { plan_valid: true, stuck: false, reason: `审批通过:${payload.kind ?? ''}` }, nextAction: '按批准内容推进' }
    case 'approval.rejected':
      return { assessment: { plan_valid: null, stuck: true, reason: `审批拒绝:${payload.kind ?? ''}` }, nextAction: '按拒绝原因修订后重新提案' }
    case 'plan.applied':
      return { assessment: { plan_valid: true, stuck: false, reason: `计划 v${payload.version ?? ''} 物化完成` }, nextAction: '派发就绪工作项' }
    default:
      return null
  }
}

let projectService: ProjectService | null = null

export function initProjectService(manager: AgentChannelManager, db: DatabaseSync, deps: ProjectServiceDeps = {}): ProjectService {
  projectService = new ProjectService(manager, db, deps)
  return projectService
}

export function getProjectService(): ProjectService {
  if (!projectService) throw new AppError(503, 'PROJECT_SERVICE_UNAVAILABLE', 'ProjectService 未装配')
  return projectService
}
