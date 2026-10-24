/**
 * Ontology Service —— 草稿生命周期 / 校验 / 编译预览 / 规则审批 / 版本发布。
 *
 * 治理不变量(验收逐条断言):
 *  1) 自审禁止:审查人 ≠ 草稿发起人(单管理员实例豁免并打 solo_operator 标记);
 *  2) 硬约束/阻断级守卫只接受 approved_for_control(第二人批准);
 *  3) 发布 = 不可变快照(同版本改内容 → 409);运行中本体更新不改在跑版本;
 *  4) 草稿编辑乐观锁(rev),并发写 → 409 而非静默覆盖;
 *  5) 每次状态迁移/发布/审批都落 ontology_publish_log(actuator 三态 + 归因)。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { ensureDataDir } from '@/shared/config/home.mjs'
import type {
  BindingDraft,
  CompileOptions,
  ControlGuard,
  EvidenceRecord,
  OntologyCompileResult,
  OntologyDraftDoc,
  OntologyRole,
  OntologyState,
  OntologyTarget,
} from './contracts'
import {
  ONTOLOGY_SCHEMA_VERSION,
  RULE_ERROR_CODES,
  RULE_TRANSITIONS,
  draftContentHash,
  emptyDraftDoc,
  parseDraftDoc,
} from './contracts'
import { dimensionOf } from '@/shared/dimensions'
import { compileOntology, ontologyPackHash } from './compiler'
import { evaluateGuards, extractGuardSet, type GuardEvaluationInput, type GuardEvaluationResult } from './guards'
import {
  getOntologyRepo,
  parseDraftRow,
  type DraftRow,
  type EvidenceRow,
  type VersionRow,
} from './repo'
import { detectBindingDrift, validateDraftBindings } from './semantic-binding.service'
import { getDcwController } from '../dcw/dcw-controller'
import { validateDraftDoc, type DraftValidationReport } from './validator'

export interface Actor {
  userId: string
  role: 'admin' | 'editor' | 'user'
  /** agent 发起时携带其 channel 属主(归因与撤权收敛) */
  actorKind?: 'user' | 'agent' | 'system'
  initiatorUserId?: string
}

/** REST 调用者 → 治理 Actor(角色收敛到三档,未知角色按 user) */
export function actorFromUser(user: { id: string, role: string }): Actor {
  const role: Actor['role'] = user.role === 'admin' || user.role === 'editor' ? user.role : 'user'
  return { userId: user.id, role, actorKind: 'user' }
}

const EDITOR_ROLES = new Set(['admin', 'editor'])

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function requireEditor(actor: Actor, what: string): void {
  if (!EDITOR_ROLES.has(actor.role)) {
    throw new AppError(403, 'FORBIDDEN_ROLE', `${what} 需要 admin 或 editor 角色`)
  }
}

function requireAdmin(actor: Actor, what: string): void {
  if (actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', `${what} 仅管理员可执行`)
}

/**
 * 单管理员部署豁免自审(打 solo_operator 标记,审计可追溯)。
 *
 * 用户与角色在独立的 users.sqlite(user.repository),不在 workshop 主库。
 * env `AW_ONTOLOGY_SOLO_OPERATOR=1|0` 可显式覆盖(部署/测试用);否则按管理员人数判断。
 */
function isSoloOperator(): boolean {
  const override = process.env.AW_ONTOLOGY_SOLO_OPERATOR
  if (override === '1') return true
  if (override === '0') return false
  try {
    // 用户/角色在独立的 users.sqlite(不在 workshop 主库);只读短连接统计管理员人数
    const db = new DatabaseSync(join(ensureDataDir(), 'users.sqlite'), { readOnly: true })
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = \'admin\' AND status = \'active\'').get() as { n: number } | undefined
      return (row?.n ?? 0) <= 1
    }
    finally { db.close() }
  }
  catch { return true }
}

function log(input: {
  ontologyId: string
  version?: number
  action: string
  actor: Actor
  soloOperator?: boolean
  approvalId?: string | null
  detail?: Record<string, unknown>
}): void {
  getOntologyRepo().appendPublishLog({
    id: newId('opl'),
    ontologyId: input.ontologyId,
    version: input.version ?? 0,
    action: input.action,
    actor: input.actor.userId,
    actorKind: input.actor.actorKind ?? 'user',
    soloOperator: input.soloOperator ? 1 : 0,
    approvalId: input.approvalId ?? null,
    detailJson: JSON.stringify({ ...input.detail, initiatorUserId: input.actor.initiatorUserId ?? '' }),
    createdAt: new Date().toISOString(),
  })
}

// ===== 草稿 =====

export interface CreateDraftInput {
  ontologyId: string
  /** 草稿属主(缺省=调用者;admin 可代建) */
  ownerId?: string
  baseVersion?: number
  /** 从已发布版本克隆(基于上一版继续演进) */
  cloneFromVersion?: boolean
  lineId?: string
  name?: string
}

export function createDraft(actor: Actor, input: CreateDraftInput): DraftRow {
  requireEditor(actor, '创建本体草稿')
  const ontologyId = input.ontologyId.trim()
  if (!/^[a-z][a-z0-9_-]{1,79}$/.test(ontologyId)) {
    throw new AppError(422, 'ONTOLOGY_INVALID', 'ontologyId 必须形如 ont-pva-line01(小写字母开头,允许数字/下划线/连字符)')
  }
  const ownerId = input.ownerId || actor.userId
  const repo = getOntologyRepo()
  const active = repo.getActiveDraft(ontologyId, ownerId)
  if (active) {
    throw new AppError(409, 'DRAFT_ALREADY_ACTIVE', `本体 ${ontologyId} 已有活跃草稿(${active.id}, rev=${active.rev});请继续编辑`)
  }
  let doc: OntologyDraftDoc = emptyDraftDoc(ontologyId, input.lineId ?? '')
  if (input.name) doc.name = input.name
  if (input.cloneFromVersion) {
    const latest = repo.latestVersion(ontologyId, 'published')
    if (!latest) throw new AppError(404, 'VERSION_NOT_FOUND', `本体 ${ontologyId} 还没有已发布版本可克隆`)
    doc = cloneVersionDoc(latest)
    input = { ...input, baseVersion: latest.version }
  }
  const row = repo.insertDraft({
    id: newId('ontd'),
    ontologyId,
    baseVersion: input.baseVersion ?? null,
    draftJson: JSON.stringify(doc),
    ownerUserId: ownerId,
  })
  log({ ontologyId, version: input.baseVersion ?? 0, action: 'draft.create', actor, detail: { draftId: row.id } })
  return row
}

function cloneVersionDoc(version: VersionRow): OntologyDraftDoc {
  const repo = getOntologyRepo()
  const entities = repo.listEntities(version.id, version.version)
  const relations = repo.listRelations(version.id, version.version)
  const rules = repo.listRules(version.id, version.version)
  const bindings = repo.listBindings(version.id, version.version).map(row => ({
    id: row.id,
    entityKey: row.entityKey,
    platformKind: row.platformKind as BindingDraft['platformKind'],
    platformId: row.platformId,
    targetSub: row.targetSub,
    scope: row.scope,
    direction: row.direction as BindingDraft['direction'],
    unitDeclared: row.unitDeclared,
    unitTarget: row.unitTarget,
    scale: row.scale,
    offset: row.offset,
  }))
  return {
    schemaVersion: ONTOLOGY_SCHEMA_VERSION,
    name: version.name || version.id,
    lineId: version.lineId,
    entities,
    relations,
    rules,
    bindings,
    note: '',
  }
}

export function getDraft(draftId: string): DraftRow {
  const row = getOntologyRepo().getDraft(draftId)
  if (!row) throw new AppError(404, 'DRAFT_NOT_FOUND', `草稿 ${draftId} 不存在`)
  return row
}

export function requireDraftAccess(draft: DraftRow, actor: Actor, opts: { write?: boolean } = {}): void {
  if (draft.ownerUserId && draft.ownerUserId !== actor.userId && actor.role !== 'admin') {
    throw new AppError(403, 'DRAFT_SCOPE_VIOLATION', `草稿 ${draft.id} 属于其他用户;只有属主或管理员可${opts.write ? '修改' : '查看'}`)
  }
}

export function listDrafts(actor: Actor, filter: { ontologyId?: string } = {}): DraftRow[] {
  const repo = getOntologyRepo()
  if (actor.role === 'admin') return repo.listDrafts(filter)
  return repo.listDrafts({ ...filter, ownerUserId: actor.userId })
}

export interface DraftDetail {
  draft: DraftRow
  doc: OntologyDraftDoc
  validation: DraftValidationReport
  bindings: ReturnType<typeof validateDraftBindings>
}

export function getDraftDetail(draftId: string, actor: Actor): DraftDetail {
  const draft = getDraft(draftId)
  requireDraftAccess(draft, actor)
  const doc = parseDraftRow(draft)
  const validation = validateDraftDoc(doc)
  // 绑定活体校验只对「目标仍存在」的 kind 有意义;device/spec_variable 等无目录面会报不存在,
  // 因此这里只报告,不阻断非绑定编辑。
  const bindings = validateDraftBindings(doc, { lineId: doc.lineId })
  return { draft, doc, validation, bindings }
}

export interface UpdateDraftInput {
  doc: unknown
  expectedRev: number
  /** 保存前是否强制活体绑定校验通过(默认 true:不允许落库已知失效的绑定) */
  strictBindings?: boolean
}

export function updateDraft(draftId: string, actor: Actor, input: UpdateDraftInput): DraftDetail {
  requireEditor(actor, '修改本体草稿')
  const draft = getDraft(draftId)
  requireDraftAccess(draft, actor, { write: true })
  let doc: OntologyDraftDoc
  try {
    doc = parseDraftDoc(input.doc)
  }
  catch (err) {
    throw new AppError(422, RULE_ERROR_CODES.INVALID, `本体文档形状非法:${(err as Error).message}`)
  }
  const validation = validateDraftDoc(doc)
  if (!validation.ok) {
    const first = validation.issues.filter(i => i.severity === 'error').slice(0, 5)
      .map(i => `[${i.code}] ${i.path}: ${i.message}`).join('; ')
    throw new AppError(422, RULE_ERROR_CODES.INVALID, `本体文档校验未通过:${first}`)
  }
  const bindings = validateDraftBindings(doc, { lineId: doc.lineId })
  if ((input.strictBindings ?? true) && !bindings.ok) {
    const first = bindings.failures.slice(0, 5).map(f => `[${f.code}] ${f.message}`).join('; ')
    throw new AppError(422, 'ONTOLOGY_BINDING_INVALID', `语义绑定校验未通过:${first}`)
  }
  const updated = getOntologyRepo().updateDraft(draftId, JSON.stringify(doc), input.expectedRev)
  log({ ontologyId: updated.ontologyId, version: updated.baseVersion ?? 0, action: 'draft.update', actor, detail: { draftId, rev: updated.rev } })
  return { draft: updated, doc, validation, bindings }
}

export function deleteDraft(draftId: string, actor: Actor): void {
  requireEditor(actor, '删除本体草稿')
  const draft = getDraft(draftId)
  requireDraftAccess(draft, actor, { write: true })
  getOntologyRepo().deleteDraft(draftId)
  log({ ontologyId: draft.ontologyId, action: 'draft.delete', actor, detail: { draftId } })
}

// ===== 校验 / 编译预览 =====

export function validateDraft(draftId: string, actor: Actor): DraftValidationReport & { bindings: ReturnType<typeof validateDraftBindings> } {
  const detail = getDraftDetail(draftId, actor)
  return { ...detail.validation, bindings: detail.bindings }
}

export interface CompilePreview {
  result: OntologyCompileResult
  guards: ControlGuard[]
  contentHash: string
  packHash: string
}

export function compileDraft(draftId: string, actor: Actor, options: Partial<CompileOptions> = {}): CompilePreview {
  const draft = getDraft(draftId)
  requireDraftAccess(draft, actor)
  const doc = parseDraftRow(draft)
  const version = draft.baseVersion ? (draft.baseVersion + 1) : 1
  const result = compileOntology(doc, {
    ontologyId: draft.ontologyId,
    version,
    scope: { lineId: doc.lineId },
    approvedOnly: options.approvedOnly ?? false,
    currentBounds: options.currentBounds,
    createdAt: options.createdAt,
  })
  const contentHash = draftContentHash(doc)
  return { result, guards: result.artifacts.controlGuard.guards, contentHash, packHash: ontologyPackHash({ rulePackHash: result.rulePackHash, contentHash }) }
}

// ===== 证据 =====

export interface AppendEvidenceInput {
  targetKind: 'entity' | 'relation' | 'rule' | 'binding'
  targetKey: string
  level: EvidenceRecord['level']
  source: EvidenceRecord['source']
  sourceRef?: string
  note?: string
}

export function appendEvidence(draftId: string, actor: Actor, input: AppendEvidenceInput): DraftDetail {
  requireEditor(actor, '登记本体证据')
  const draft = getDraft(draftId)
  requireDraftAccess(draft, actor, { write: true })
  const doc = parseDraftRow(draft)
  const record: EvidenceRecord = {
    id: newId('ev'),
    level: input.level,
    source: input.source,
    sourceRefHash: input.sourceRef ? ontologyPackHash({ rulePackHash: input.sourceRef, contentHash: input.level }) : '',
    createdAt: new Date().toISOString(),
    note: input.note,
  }
  if (input.targetKind === 'rule') {
    const rule = doc.rules.find(r => r.id === input.targetKey || r.key === input.targetKey)
    if (!rule) throw new AppError(404, 'RULE_NOT_FOUND', `草稿 ${draftId} 中没有规则「${input.targetKey}」`)
    rule.evidence = [...rule.evidence, record]
  }
  else if (input.targetKind === 'relation') {
    const relation = doc.relations.find(r => r.id === input.targetKey)
    if (!relation) throw new AppError(404, 'RELATION_NOT_FOUND', `草稿 ${draftId} 中没有关系「${input.targetKey}」`)
    relation.evidence = [...relation.evidence, record]
  }
  else if (input.targetKind === 'entity') {
    const entity = doc.entities.find(e => e.key === input.targetKey)
    if (!entity) throw new AppError(404, 'ENTITY_NOT_FOUND', `草稿 ${draftId} 中没有实体「${input.targetKey}」`)
  }
  const ledgerRow: EvidenceRow = {
    id: record.id,
    ontologyId: draft.ontologyId,
    targetKind: input.targetKind,
    targetKey: input.targetKey,
    level: record.level,
    sourceType: record.source.type,
    sourceRef: input.sourceRef ?? '',
    sourceRefHash: record.sourceRefHash,
    detailJson: JSON.stringify({ source: record.source, note: input.note ?? '' }),
    createdBy: actor.userId,
    createdAt: record.createdAt,
  }
  // 追加行与草稿更新保持同一 rev 语义:先落账本,再以乐观锁写回草稿
  getOntologyRepo().appendEvidence(ledgerRow)
  const updated = getOntologyRepo().updateDraft(draftId, JSON.stringify(doc), draft.rev)
  log({ ontologyId: draft.ontologyId, action: 'evidence.append', actor, detail: { draftId, targetKind: input.targetKind, targetKey: input.targetKey, level: input.level } })
  return { draft: updated, doc, validation: validateDraftDoc(doc), bindings: validateDraftBindings(doc, { lineId: doc.lineId }) }
}

export function listEvidence(ontologyId: string, filter: { targetKind?: string, targetKey?: string } = {}): EvidenceRow[] {
  return getOntologyRepo().listEvidence(ontologyId, filter)
}

// ===== 规则生命周期 =====

export interface TransitionInput {
  to: OntologyState
  /** approved_for_control 必须携带已批准的审批单 id */
  approvalId?: string
  comment?: string
}

export function transitionRule(draftId: string, ruleId: string, actor: Actor, input: TransitionInput): DraftDetail {
  requireEditor(actor, '规则状态迁移')
  // 审查/批准是**治理动作**,允许第二人对他人草稿执行(自审由 ownerUserId 比对单独拦截);
  // 编辑类动作(updateDraft/appendEvidence)才是属主私有。
  const draft = getDraft(draftId)
  const doc = parseDraftRow(draft)
  const rule = doc.rules.find(r => r.id === ruleId || r.key === ruleId)
  if (!rule) throw new AppError(404, 'RULE_NOT_FOUND', `草稿 ${draftId} 中没有规则「${ruleId}」`)

  const allowed = RULE_TRANSITIONS[rule.status] ?? []
  if (!allowed.includes(input.to)) {
    throw new AppError(409, 'RULE_LIFECYCLE_CONFLICT',
      `规则 ${rule.id} 当前状态 ${rule.status},不能迁移到 ${input.to};合法目标:${allowed.join(', ') || '(终态)'}`)
  }
  const evidenceMax = rule.evidence.reduce((rank, e) => {
    const order = ['candidate_influence', 'observed_correlation', 'validated_control']
    return Math.max(rank, order.indexOf(e.level))
  }, -1)

  if (input.to === 'reviewed') {
    // 自审禁止(单管理员实例豁免并打标)
    const solo = isSoloOperator()
    if (draft.ownerUserId === actor.userId && !solo) {
      throw new AppError(403, 'SELF_REVIEW_FORBIDDEN',
        `规则 ${rule.id} 的起草人不能自审(本体草稿属主=${draft.ownerUserId});请由另一名编辑/管理员审查`)
    }
    if (!solo) requireEditor(actor, '规则审查')
    doc.rules = doc.rules.map(r => r.id === rule.id ? { ...r, status: 'reviewed' as OntologyState } : r)
    log({ ontologyId: draft.ontologyId, action: 'rule.transition', actor, soloOperator: solo, detail: { draftId, ruleId, from: rule.status, to: 'reviewed', comment: input.comment ?? '' } })
  }
  else if (input.to === 'validated') {
    if (evidenceMax < 1) {
      throw new AppError(422, RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT,
        `规则 ${rule.id} 缺少可解析的证据(至少需要 observed_correlation:数据统计/工件系数);当前最高级别 ${rule.evidence[evidenceMax]?.level ?? '无'}`)
    }
    doc.rules = doc.rules.map(r => r.id === rule.id ? { ...r, status: 'validated' as OntologyState } : r)
    log({ ontologyId: draft.ontologyId, action: 'rule.transition', actor, detail: { draftId, ruleId, from: rule.status, to: 'validated', comment: input.comment ?? '' } })
  }
  else if (input.to === 'approved_for_control') {
    if (evidenceMax < 2) {
      throw new AppError(422, RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT,
        `规则 ${rule.id} 缺少 validated_control 级证据(run+crosscheck+outcome 全链);当前最高级别 ${rule.evidence[evidenceMax]?.level ?? '无'}`)
    }
    if (!input.approvalId) {
      throw new AppError(403, 'APPROVAL_REQUIRED',
        `规则 ${rule.id} 进入 approved_for_control 必须有第二人批准单;请先 requestRuleApproval 并取得已批准的 approvalId`)
    }
    const decision = latestApprovalDecision(draft.ontologyId, input.approvalId)
    if (!decision) throw new AppError(404, 'APPROVAL_NOT_FOUND', `审批单 ${input.approvalId} 不存在`)
    if (decision.decision !== 'approved') {
      throw new AppError(409, 'APPROVAL_NOT_GRANTED', `审批单 ${input.approvalId} 当前结论为 ${decision.decision};不能据以批准规则`)
    }
    if (decision.approver === draft.ownerUserId && !isSoloOperator()) {
      throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', `审批人 ${decision.approver} 是草稿属主,不能自我批准控制级规则`)
    }
    if (decision.ruleId !== rule.id) {
      throw new AppError(409, 'APPROVAL_SCOPE_MISMATCH', `审批单 ${input.approvalId} 针对规则 ${decision.ruleId},与本次规则 ${rule.id} 不一致`)
    }
    doc.rules = doc.rules.map(r => r.id === rule.id ? { ...r, status: 'approved_for_control' as OntologyState } : r)
    log({
      ontologyId: draft.ontologyId, action: 'rule.approve', actor, approvalId: input.approvalId,
      detail: { draftId, ruleId, from: rule.status, to: 'approved_for_control', comment: input.comment ?? '' },
    })
  }
  else {
    doc.rules = doc.rules.map(r => r.id === rule.id ? { ...r, status: input.to } : r)
    log({ ontologyId: draft.ontologyId, action: 'rule.transition', actor, detail: { draftId, ruleId, from: rule.status, to: input.to, comment: input.comment ?? '' } })
  }

  const updated = getOntologyRepo().updateDraft(draftId, JSON.stringify(doc), draft.rev)
  return { draft: updated, doc, validation: validateDraftDoc(doc), bindings: validateDraftBindings(doc, { lineId: doc.lineId }) }
}

// ===== 审批单(第二人批准) =====

export interface ApprovalRequestRow { approvalId: string, ruleId: string, requester: string, createdAt: string, detail?: Record<string, unknown> }

export function requestRuleApproval(draftId: string, ruleId: string, actor: Actor): { approvalId: string, ruleId: string } {
  requireEditor(actor, '申请规则批准')
  const draft = getDraft(draftId)
  requireDraftAccess(draft, actor, { write: true })
  const doc = parseDraftRow(draft)
  const rule = doc.rules.find(r => r.id === ruleId || r.key === ruleId)
  if (!rule) throw new AppError(404, 'RULE_NOT_FOUND', `草稿 ${draftId} 中没有规则「${ruleId}」`)
  if (rule.status !== 'validated') {
    throw new AppError(409, 'RULE_LIFECYCLE_CONFLICT', `只有 validated 状态的规则可申请控制级批准;当前 ${rule.status}`)
  }
  const approvalId = newId('oap')
  log({
    ontologyId: draft.ontologyId, action: 'rule.approve_request', actor, approvalId,
    detail: { draftId, ruleId: rule.id, ruleKey: rule.key, requester: actor.userId },
  })
  return { approvalId, ruleId: rule.id }
}

export function latestApprovalDecision(ontologyId: string, approvalId: string): { decision: string, approver: string, ruleId: string } | null {
  const rows = getOntologyRepo().listPublishLog(ontologyId, 500).filter(r => r.approvalId === approvalId)
  const request = rows.find(r => r.action === 'rule.approve_request')
  if (!request) return null
  const ruleId = (JSON.parse(request.detailJson || '{}') as { ruleId?: string }).ruleId ?? ''
  const decision = rows.filter(r => r.action === 'rule.approve' || r.action === 'rule.reject')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!decision) return { decision: 'pending', approver: '', ruleId }
  return { decision: decision.action === 'rule.approve' ? 'approved' : 'rejected', approver: decision.actor, ruleId }
}

export function decideRuleApproval(draftId: string, approvalId: string, approver: Actor, decision: { approved: boolean, comment?: string }): { approvalId: string, decision: string } {
  requireEditor(approver, '裁决规则批准')
  const draft = getDraft(draftId)
  const current = latestApprovalDecision(draft.ontologyId, approvalId)
  if (!current) throw new AppError(404, 'APPROVAL_NOT_FOUND', `审批单 ${approvalId} 不存在`)
  if (current.decision !== 'pending') {
    throw new AppError(409, 'APPROVAL_ALREADY_DECIDED', `审批单 ${approvalId} 已裁决(${current.decision})`)
  }
  const solo = isSoloOperator()
  if (draft.ownerUserId === approver.userId && !solo) {
    throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', '起草人不能裁决自己的批准申请(需要第二人)')
  }
  const action = decision.approved ? 'rule.approve' : 'rule.reject'
  log({
    ontologyId: draft.ontologyId, action, actor: approver, approvalId, soloOperator: solo,
    detail: { draftId, ruleId: current.ruleId, comment: decision.comment ?? '' },
  })
  return { approvalId, decision: decision.approved ? 'approved' : 'rejected' }
}

// ===== 发布 =====

export interface PublishResult {
  version: VersionRow
  compile: OntologyCompileResult
  packHash: string
  draft: DraftRow
}

export function publishDraft(
  draftId: string,
  actor: Actor,
  options: { currentBounds?: CompileOptions['currentBounds'] } = {},
): PublishResult {
  requireAdmin(actor, '发布本体版本')
  const draft = getDraft(draftId)
  requireDraftAccess(draft, actor, { write: true })
  const doc = parseDraftRow(draft)

  const validation = validateDraftDoc(doc)
  if (!validation.ok) {
    throw new AppError(422, 'VALIDATION_BLOCKED',
      `本体文档校验未通过,不能发布:${validation.issues.filter(i => i.severity === 'error').slice(0, 5).map(i => `[${i.code}] ${i.message}`).join('; ')}`)
  }
  const bindings = validateDraftBindings(doc, { lineId: doc.lineId })
  if (!bindings.ok) {
    throw new AppError(422, 'ONTOLOGY_BINDING_INVALID',
      `语义绑定校验未通过,不能发布:${bindings.failures.slice(0, 5).map(f => `[${f.code}] ${f.message}`).join('; ')}`)
  }
  if (!doc.lineId && actor.role !== 'admin') {
    throw new AppError(403, 'LINE_REQUIRED', '全局本体(lineId 为空)仅管理员可发布')
  }

  const repo = getOntologyRepo()
  const versionNumber = repo.nextVersionNumber(draft.ontologyId)
  const compile = compileOntology(doc, {
    ontologyId: draft.ontologyId,
    version: versionNumber,
    scope: { lineId: doc.lineId },
    currentBounds: options.currentBounds,
    approvedOnly: true,
  })
  // 未获批规则绝不可进入发布版控制约束(即使整体 status 只是 warning/rejected)
  const notApproved = compile.issues.filter(i => i.code === RULE_ERROR_CODES.NOT_APPROVED)
  if (notApproved.length > 0) {
    throw new AppError(422, RULE_ERROR_CODES.NOT_APPROVED,
      `存在未获批规则,不能进入发布版控制约束:${notApproved.slice(0, 5).map(i => i.message).join('; ')}`)
  }
  if (compile.status === 'rejected') {
    throw new AppError(422, 'VALIDATION_BLOCKED',
      `编译结果 rejected,不能发布:${compile.issues.slice(0, 5).map(i => `[${i.code}] ${i.message}`).join('; ')}`)
  }

  const contentHash = draftContentHash(doc)
  const packHash = ontologyPackHash({ rulePackHash: compile.rulePackHash, contentHash })
  const parent = repo.latestVersion(draft.ontologyId)
  const compiledJson = JSON.stringify({
    schemaVersion: ONTOLOGY_SCHEMA_VERSION,
    ontologyId: draft.ontologyId,
    ontologyVersion: versionNumber,
    contentHash,
    rulePackHash: compile.rulePackHash,
    packHash,
    status: compile.status,
    compiledAt: new Date().toISOString(),
    artifacts: compile.artifacts,
    issues: compile.issues,
    counts: {
      compiled: compile.compiledCount, guard: compile.guardCount,
      explained: compile.explainedCount, rejected: compile.rejectedCount,
    },
  })
  const changelog = JSON.stringify(buildChangelog(parent, doc, compile))

  let version: VersionRow
  try {
    version = repo.publishSnapshot({
      version: {
        id: draft.ontologyId, version: versionNumber, name: doc.name, lineId: doc.lineId,
        parentVersion: parent?.version ?? null, contentHash, compiledJson, changelogJson: changelog,
        status: 'published', ownerUserId: draft.ownerUserId, publishedBy: actor.userId,
        createdAt: '', updatedAt: '',
      },
      entities: doc.entities.map(e => ({ ...e, dimension: e.dimension || dimensionOf(e.unit) })),
      relations: doc.relations,
      rules: doc.rules,
      bindings: doc.bindings,
      traces: compile.traces,
      guards: compile.artifacts.controlGuard.guards,
      createdBy: actor.userId,
    })
  }
  catch (err) {
    throw new AppError(409, 'ONTOLOGY_VERSION_CONFLICT',
      `本体 ${draft.ontologyId} 版本 ${versionNumber} 并发发布冲突,请重新读取后重试(${(err as Error).message})`)
  }

  // 草稿保留为新版本的工作副本(baseVersion 前移,rev++),便于继续演进
  repo.updateDraftMeta(draftId, { baseVersion: versionNumber })
  const refreshed = repo.updateDraft(draftId, JSON.stringify(doc), draft.rev)

  log({
    ontologyId: draft.ontologyId, version: versionNumber, action: 'publish', actor,
    detail: {
      draftId, contentHash, packHash, compiled: compile.compiledCount, guards: compile.guardCount,
      rejected: compile.rejectedCount, explained: compile.explainedCount,
    },
  })
  return { version, compile, packHash, draft: refreshed }
}

function buildChangelog(parent: VersionRow | undefined, doc: OntologyDraftDoc, compile: OntologyCompileResult) {
  return {
    generatedAt: new Date().toISOString(),
    parentVersion: parent?.version ?? null,
    counts: {
      entities: doc.entities.length, relations: doc.relations.length,
      rules: doc.rules.length, bindings: doc.bindings.length,
    },
    ruleDecisions: compile.traces.map(t => ({ ruleId: t.ruleId, decision: t.decision, code: t.decisionCode })),
    artifacts: {
      mvBounds: Object.keys(compile.artifacts.problemIr.mvBounds),
      cvBounds: Object.keys(compile.artifacts.problemIr.cvBounds),
      guards: compile.artifacts.controlGuard.guards.map(g => g.id),
      featureCandidates: compile.artifacts.processModel.featureCandidates.length,
      delayPriors: compile.artifacts.processModel.delayPriors.length,
    },
  }
}

// ===== 版本读取 / 比较 / 退役 =====

export function listVersions(ontologyId: string): VersionRow[] {
  return getOntologyRepo().listVersions(ontologyId)
}

export function getVersion(ontologyId: string, version: number): VersionRow {
  const row = getOntologyRepo().getVersion(ontologyId, version)
  if (!row) throw new AppError(404, 'VERSION_NOT_FOUND', `本体 ${ontologyId}@${version} 不存在`)
  return row
}

export interface VersionDiff {
  from: number
  to: number
  entities: { added: string[], removed: string[], changed: string[] }
  relations: { added: string[], removed: string[], changed: string[] }
  rules: { added: string[], removed: string[], changed: string[] }
  bindings: { added: string[], removed: string[], changed: string[] }
}

function diffSections<T>(a: T[], b: T[], keyOf: (item: T) => string): { added: string[], removed: string[], changed: string[] } {
  const mapA = new Map(a.map(item => [keyOf(item), item]))
  const mapB = new Map(b.map(item => [keyOf(item), item]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [key, item] of mapB) {
    if (!mapA.has(key)) added.push(key)
    else if (JSON.stringify(mapA.get(key)) !== JSON.stringify(item)) changed.push(key)
  }
  for (const key of mapA.keys()) if (!mapB.has(key)) removed.push(key)
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

export function compareVersions(ontologyId: string, from: number, to: number): VersionDiff {
  const repo = getOntologyRepo()
  const a = getVersion(ontologyId, from)
  const b = getVersion(ontologyId, to)
  return {
    from, to,
    entities: diffSections(repo.listEntities(a.id, a.version), repo.listEntities(b.id, b.version), e => e.key),
    relations: diffSections(repo.listRelations(a.id, a.version), repo.listRelations(b.id, b.version), r => r.id),
    rules: diffSections(repo.listRules(a.id, a.version), repo.listRules(b.id, b.version), r => r.id),
    bindings: diffSections(repo.listBindings(a.id, a.version), repo.listBindings(b.id, b.version), r => r.id),
  }
}

export function retireVersion(ontologyId: string, version: number, actor: Actor): void {
  requireAdmin(actor, '退役本体版本')
  const row = getVersion(ontologyId, version)
  if (row.status !== 'published') {
    throw new AppError(409, 'VERSION_NOT_PUBLISHED', `本体 ${ontologyId}@${version} 状态为 ${row.status},只有 published 可退役`)
  }
  const ok = getOntologyRepo().transitionVersion(ontologyId, version, 'retired', 'published')
  if (!ok) throw new AppError(409, 'VERSION_TRANSITION_CONFLICT', `本体 ${ontologyId}@${version} 并发状态变更,请重试`)
  log({ ontologyId, version, action: 'retire', actor })
}

export function listOntologies(lineId?: string) {
  return getOntologyRepo().listAllOntologyIds(lineId)
}

// ===== 运行时消费面 =====

export interface ActiveOntology {
  version: VersionRow
  guards: ControlGuard[]
  artifacts: OntologyCompileResult['artifacts']
  packHash: string
}

/** 取某产线当前生效的已发布本体(该线最新的 published 版本;无则 null) */
export function resolveActiveOntology(lineId: string): ActiveOntology | null {
  const repo = getOntologyRepo()
  const version = repo.latestPublishedForLine(lineId)
  if (!version) return null
  const compiled = JSON.parse(version.compiledJson || '{}') as {
    artifacts?: OntologyCompileResult['artifacts']
    packHash?: string
    controlGuard?: { guards?: ControlGuard[] }
  }
  const guards = extractGuardSet(compiled)
  const artifacts = compiled.artifacts ?? { processModel: { featureCandidates: [], delayPriors: [], monotonicity: [] }, problemIr: { templateRef: 'linear_mpc_quadratic@1', mvBounds: {}, cvBounds: {}, softRegularization: [] }, sceneContract: { variables: [], constraints: [], inferredRelations: [] }, controlGuard: { guards } }
  return { version, guards, artifacts, packHash: compiled.packHash ?? version.contentHash }
}

/** 运行时守卫求值(供求解/下发前置检查调用) */
export function evaluateOntologyGuards(lineId: string, input: Omit<GuardEvaluationInput, 'scope'> & { recipeId?: string, conditionId?: string }): GuardEvaluationResult & { packHash: string } {
  const active = resolveActiveOntology(lineId)
  if (!active) return { ok: true, blocked: false, violations: [], evaluated: 0, skipped: 0, packHash: '' }
  const result = evaluateGuards(active.guards, { ...input, scope: { lineId, recipeId: input.recipeId, conditionId: input.conditionId } })
  return { ...result, packHash: active.packHash }
}

/**
 * Profile 漂移校验:Profile 冻结时记录的 packHash 必须与当前已发布版本一致。
 * 不一致 → 409 ONTOLOGY_PACK_DRIFTED(只拒不放行;与 D12 工件 hash 独立比对同构)。
 */
export function assertOntologyUnchanged(refs: Array<{ ontologyId: string, ontologyVersion: number, rulePackHash?: string, contentHash?: string }> | undefined): void {
  if (!refs || refs.length === 0) return
  const repo = getOntologyRepo()
  for (const ref of refs) {
    const row = repo.getVersion(ref.ontologyId, ref.ontologyVersion)
    if (!row) {
      throw new AppError(409, 'ONTOLOGY_PACK_DRIFTED', `Profile 引用的本体 ${ref.ontologyId}@${ref.ontologyVersion} 已不存在`)
    }
    if (row.status !== 'published') {
      throw new AppError(409, 'ONTOLOGY_PACK_DRIFTED', `Profile 引用的本体 ${ref.ontologyId}@${ref.ontologyVersion} 状态为 ${row.status}(需 published)`)
    }
    if (ref.contentHash && row.contentHash !== ref.contentHash) {
      throw new AppError(409, 'ONTOLOGY_PACK_DRIFTED',
        `Profile 引用的本体 ${ref.ontologyId}@${ref.ontologyVersion} 内容已变(冻结 ${ref.contentHash.slice(0, 12)} ≠ 当前 ${row.contentHash.slice(0, 12)})`)
    }
  }
}

/** 绑定漂移巡检(发布前与周期巡检共用) */
export function verifyVersionBindings(ontologyId: string, version: number): { ok: boolean, drifted: Array<{ bindingId: string, reason: string }> } {
  const repo = getOntologyRepo()
  const row = getVersion(ontologyId, version)
  const report = detectBindingDrift(repo.listBindings(row.id, row.version))
  for (const drift of report.drifted) repo.markBindingStatus(drift.bindingId, 'drifted')
  return report
}

/**
 * 下发意图的守卫检查(运行时真正生效的落点之一)。
 *
 * 输入是**平台节点级**的动作(from→to 工程值),经语义绑定映射到本体实体 key,
 * 再用本体实体 key 观测当前状态并求值。返回 blocked 时调用方必须拒绝下发。
 *
 * 映射规则:
 *  - 守卫的 when.variableKey 绑定到 dcw_node → 取该节点 readValue/value 作观测;
 *    绑定到 daq_node → 无同步读值(交 fail-closed:未知状态 + 提速 = 阻断);
 *  - 守卫的 forbid.variableKey 绑定到 dcw_node → 由 from/to 计算增量。
 */
export function evaluateOntologyGuardsForNodes(
  lineId: string,
  moves: Array<{ nodeId: string, from: number | null, to: number }>,
  opts: { recipeId?: string, conditionId?: string } = {},
): GuardEvaluationResult & { packHash: string, unmapped: string[] } {
  const active = resolveActiveOntology(lineId)
  if (!active || active.guards.length === 0) {
    return { ok: true, blocked: false, violations: [], evaluated: 0, skipped: 0, packHash: '', unmapped: [] }
  }
  const repo = getOntologyRepo()
  const bindings = repo.listBindings(active.version.id, active.version.version)
  const byEntity = new Map<string, typeof bindings>()
  for (const b of bindings) {
    const list = byEntity.get(b.entityKey) ?? []
    list.push(b)
    byEntity.set(b.entityKey, list)
  }
  const nodeOf = (entityKey: string): string | null => {
    const list = byEntity.get(entityKey) ?? []
    // 优先写通道(dcw),其次任意通道
    const dcw = list.find(b => b.platformKind === 'dcw_node')
    const any = dcw ?? list[0]
    return any ? any.platformId : null
  }
  const moveOf = (nodeId: string | null) => (nodeId ? moves.find(m => m.nodeId === nodeId) : undefined)

  const values: GuardEvaluationInput['values'] = {}
  const deltas: Record<string, number> = {}
  const unmapped: string[] = []
  for (const guard of active.guards) {
    const whenNode = nodeOf(guard.when.variableKey)
    if (!whenNode) {
      unmapped.push(guard.when.variableKey)
      continue
    }
    const node = getDcwNodeReadValue(whenNode)
    if (node !== undefined) values[guard.when.variableKey] = node
    const forbidNode = nodeOf(guard.forbid.variableKey)
    const move = moveOf(forbidNode)
    if (move) {
      const from = typeof move.from === 'number' && Number.isFinite(move.from) ? move.from : move.to
      deltas[guard.forbid.variableKey] = move.to - from
    }
  }
  const result = evaluateGuards(active.guards, { values, deltas, scope: { lineId, recipeId: opts.recipeId, conditionId: opts.conditionId } })
  return { ...result, packHash: active.packHash, unmapped }
}

/** 读 dcw 节点当前值(工程值);节点不存在返回 undefined */
function getDcwNodeReadValue(nodeId: string): number | undefined {
  try {
    const node = getDcwController().byId(nodeId)
    if (!node) return undefined
    const value = typeof node.readValue === 'number' ? node.readValue : (typeof node.value === 'number' ? node.value : undefined)
    return value
  }
  catch { return undefined }
}

/** 供 Agent 上下文/工具用的场景子图(只含绑定面实体 + 命中规则摘要) */
export interface SceneSubgraph {
  ontologyId: string
  version: number
  lineId: string
  entities: Array<{ key: string, kind: string, name: string, unit: string, role: string | undefined, bindings: Array<{ platformKind: string, platformId: string, targetSub: string, direction: string }> }>
  relations: Array<{ id: string, kind: string, srcKey: string, dstKey: string, evidenceTier: string }>
  rules: Array<{ id: string, key: string, kind: string, status: string, decision: string, message: string }>
  guards: Array<{ id: string, ruleId: string, message: string, onViolate: string }>
}

export function sceneSubgraph(lineId: string, opts: { limit?: number } = {}): SceneSubgraph | null {
  const active = resolveActiveOntology(lineId)
  if (!active) return null
  const repo = getOntologyRepo()
  const entities = repo.listEntities(active.version.id, active.version.version)
  const relations = repo.listRelations(active.version.id, active.version.version)
  const rules = repo.listRules(active.version.id, active.version.version)
  const bindings = repo.listBindings(active.version.id, active.version.version)
  const traces = repo.listTraces(active.version.id, active.version.version)
  const traceOf = new Map(traces.map(t => [t.ruleId, t]))
  const bindingsOf = new Map<string, SceneSubgraph['entities'][number]['bindings']>()
  for (const b of bindings) {
    const list = bindingsOf.get(b.entityKey) ?? []
    list.push({ platformKind: b.platformKind, platformId: b.platformId, targetSub: b.targetSub, direction: b.direction })
    bindingsOf.set(b.entityKey, list)
  }
  const limit = opts.limit ?? 200
  return {
    ontologyId: active.version.id,
    version: active.version.version,
    lineId,
    entities: entities.slice(0, limit).map(e => ({
      key: e.key, kind: e.kind, name: e.name, unit: e.unit, role: e.role,
      bindings: bindingsOf.get(e.key) ?? [],
    })),
    relations: relations.map(r => ({ id: r.id, kind: r.kind, srcKey: r.srcKey, dstKey: r.dstKey, evidenceTier: r.properties.evidenceTier })),
    rules: rules.map((r) => {
      const trace = traceOf.get(r.id)
      return {
        id: r.id, key: r.key, kind: r.kind, status: r.status,
        decision: trace?.decision ?? 'unknown', message: trace?.message ?? '',
      }
    }),
    guards: active.guards.map(g => ({ id: g.id, ruleId: g.ruleId, message: g.message, onViolate: g.onViolate })),
  }
}

/** AML 派生:特征候选 + 时滞先验(供训练编排消费) */
export function deriveTrainingPriors(lineId: string): {
  featureCandidates: Array<{ entityKey: string, role: string, relation: string, evidenceLevel: string, priorDelayMs?: number, variabilityChecked: boolean }>
  delayPriors: Array<{ entityKey: string, delayMs: number, basis: string, variabilityChecked: boolean }>
  monotonicity: Array<{ output: string, input: string, direction: string }>
} | null {
  const active = resolveActiveOntology(lineId)
  if (!active) return null
  return {
    featureCandidates: active.artifacts.processModel.featureCandidates,
    delayPriors: active.artifacts.processModel.delayPriors,
    monotonicity: active.artifacts.processModel.monotonicity,
  }
}

export type { OntologyRole, OntologyTarget }
