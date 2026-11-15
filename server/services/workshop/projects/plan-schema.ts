/**
 * Project 计划 schema / 证据校验(纯函数层)。
 *
 * 从 projects/service.ts 抽出的计划解析、DAG/契约校验、证据与验收判定:
 *  - 不依赖 ProjectService 实例状态,只吃入参与仓储数据;
 *  - 服务层与测试可直接 import,避免 5k 行巨型类承载纯逻辑。
 *
 * 行为与原 service.ts 内实现逐行一致(仅补 export 供跨模块复用)。
 */
import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../../shared/context/hash'
import { parseJson } from '../db/database'
import { AppError } from '../../../utils/errors'
import { evaluateMetricCriterion } from './criteria-metrics'

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

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function strictStringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) {
    throw new AppError(400, 'PLAN_INVALID', `${label} 必须是非空字符串数组`)
  }
  return value.map(v => v.trim())
}

export function strictContract(value: unknown, label: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'PLAN_INVALID', `${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

export function parsePersistedStringArray(text: string | null | undefined, label: string): string[] {
  if (text == null || text === '') return []
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    throw new AppError(400, 'PLAN_INVALID', `${label} JSON 无效`)
  }
  if (!Array.isArray(value)) throw new AppError(400, 'PLAN_INVALID', `${label} 必须是数组`)
  return strictStringArray(value, label)
}

export function parsePersistedContract(text: string | null | undefined, label: string): Record<string, unknown> {
  if (text == null || text === '') return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    throw new AppError(400, 'PLAN_INVALID', `${label} JSON 无效`)
  }
  const contract = strictContract(value, label)
  if (!contract) throw new AppError(400, 'PLAN_INVALID', `${label} 必须是对象`)
  return contract
}

export interface WorkItemGraphNode {
  id: string
  title: string
  deliverableKey?: string
  dependsOn: string[]
  resultKey: string
  contract: Record<string, unknown> | null
}

/**
 * Work-item graph is persisted in several JSON columns, so SQLite cannot enforce
 * its invariants. Keep the validation shared by plan normalization and DRAFT
 * mutations; callers must validate the complete candidate graph before writing.
 */
export function assertWorkItemGraphIntegrity(nodes: WorkItemGraphNode[], opts: { checkResultSlots?: boolean } = {}): void {
  const byId = new Map(nodes.map(node => [node.id, node]))
  for (const node of nodes) {
    const dependencies = new Set<string>()
    for (const dependency of node.dependsOn) {
      if (dependencies.has(dependency)) {
        throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」依赖重复: ${dependency}`)
      }
      dependencies.add(dependency)
      if (!byId.has(dependency)) {
        throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」依赖未知工作项: ${dependency}`)
      }
      if (dependency === node.id) {
        throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」不能依赖自己`)
      }
    }

    const contract = node.contract
    const rawInputs = contract?.inputs
    if (rawInputs !== undefined && !Array.isArray(rawInputs)) {
      throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」contract.inputs 必须是数组`)
    }
    const inputRefs = new Set<string>()
    for (const [index, rawInput] of (rawInputs ?? []).entries()) {
      if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
        throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」contract.inputs[${index}] 必须是对象`)
      }
      const input = rawInput as Record<string, unknown>
      const reference = asString(input.workItemId)
        || asString(input.workItemKey)
        || asString(input.fromWorkItemId)
        || asString(input.fromWorkItemKey)
        || asString(input.from_work_item_key)
      if (!reference) {
        throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」contract.inputs[${index}] 缺 workItemId/workItemKey`)
      }
      if (inputRefs.has(reference)) {
        throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」contract.inputs 重复引用: ${reference}`)
      }
      inputRefs.add(reference)
      if (!byId.has(reference)) {
        throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」contract.inputs 引用了未知工作项: ${reference}`)
      }
      if (!dependencies.has(reference)) {
        throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」contract.inputs[${index}] 引用了非依赖工作项: ${reference}`)
      }
      const referencedResultKey = asString(input.resultKey) || asString(input.result_key)
      if (referencedResultKey && referencedResultKey !== byId.get(reference)!.resultKey) {
        throw new AppError(400, 'PLAN_INVALID', `工作项「${node.title}」contract.inputs[${index}] resultKey 引用不匹配: ${referencedResultKey}`)
      }
    }
  }

  assertAcyclic(nodes.map(node => ({ id: node.id, deps: node.dependsOn })), '工作项')

  if (opts.checkResultSlots) {
    const slots = new Set<string>()
    for (const node of nodes) {
      const slot = `${node.deliverableKey ?? ''}\u0000${node.resultKey}`
      if (slots.has(slot)) {
        throw new AppError(400, 'PLAN_INVALID', `交付物「${node.deliverableKey ?? node.id}」的成果槽 ${node.resultKey} 有多个生产者`)
      }
      slots.add(slot)
    }
  }
}

export interface TaskArtifactLike {
  artifactId?: string
  name?: string
  parts?: Array<{ text?: string }>
}

export interface ArtifactDigest {
  artifactId: string
  name: string
  text: string
  bytes: number
  sha256: string
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 任务产物索引：只收有真实文本内容的 artifact（input 由 handoff 注入，不作为成果证据）。 */
export function artifactDigests(taskArtifactsJson: string): Map<string, ArtifactDigest> {
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

export interface CriteriaCheckResult {
  ok: boolean
  checks: Array<{ criterion: string, pass: boolean, unknown?: boolean, detail?: string }>
  blockingFailures: string[]
}

export function dotGet(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

/**
 * P1 结构化验收标准（L0 内容检查）：
 *  - `artifact.present` / 包含「产物存在」→ 必须有 artifact 证据；
 *  - `min_bytes:N` / 「至少 N 字节」→ artifact 文本体积下限；
 *  - `text.contains:X` / 「包含:X」→ artifact 文本包含；
 *  - `json.field:path=value` → payload 点路径相等；
 *  - 其他自然语言标准 → advisory（记录 unknown，不自动判过，交 L1 技术验收）。
 */
export function evaluateCriteriaChecks(input: {
  criteria: string[]
  artifacts: ArtifactDigest[]
  payloadJson?: string
  artifactBacked: number
  /** WP-C4：独立观测指标（回读/DAQ；**不得来自 Agent 自述**）。缺 key → 该判据 fail-closed 阻断 */
  metrics?: Record<string, number>
}): CriteriaCheckResult {
  const checks: CriteriaCheckResult['checks'] = []
  const blockingFailures: string[] = []
  const maxBytes = input.artifacts.reduce((max, a) => Math.max(max, a.bytes), 0)
  const allText = input.artifacts.map(a => a.text).join('\n')
  for (const criterion of input.criteria) {
    const c = criterion.trim()
    if (!c) continue
    const lower = c.toLowerCase()
    if (lower === 'artifact.present' || c.includes('产物存在') || c.includes('交付物存在')) {
      const pass = input.artifactBacked > 0
      checks.push({ criterion: c, pass })
      if (!pass) blockingFailures.push(c)
      continue
    }
    const minBytes = lower.match(/^min_bytes:(\d+)$/) ?? c.match(/至少\s*(\d+)\s*字节/)
    if (minBytes) {
      const pass = maxBytes >= Number(minBytes[1])
      checks.push({ criterion: c, pass, detail: `max artifact bytes=${maxBytes}` })
      if (!pass) blockingFailures.push(c)
      continue
    }
    const contains = c.match(/^text\.contains[:：](.+)$/i) ?? c.match(/包含[:：](.+)$/)
    if (contains) {
      const needle = contains[1]!.trim()
      const pass = allText.includes(needle)
      checks.push({ criterion: c, pass, detail: `needle=${needle}` })
      if (!pass) blockingFailures.push(c)
      continue
    }
    const jsonField = c.match(/^json\.field[:：]([\w.$]+)=(.+)$/)
    if (jsonField) {
      let payload: unknown
      try {
        payload = JSON.parse(input.payloadJson ?? '{}')
      }
      catch {
        payload = {}
      }
      const actual = dotGet(payload, jsonField[1]!)
      const pass = String(actual ?? '') === jsonField[2]!.trim()
      checks.push({ criterion: c, pass, detail: `actual=${String(actual ?? '')}` })
      if (!pass) blockingFailures.push(c)
      continue
    }
    // WP-C4:数值判据(独立观测指标;缺失即阻断,不接受自述值)
    const metric = evaluateMetricCriterion(c, input.metrics)
    if (metric.matched) {
      checks.push({ criterion: c, pass: metric.pass, detail: metric.detail })
      if (!metric.pass) blockingFailures.push(c)
      continue
    }
    // 自然语言标准无法确定性判定 → advisory，交 L1 技术验收/人工。
    checks.push({ criterion: c, pass: true, unknown: true, detail: 'advisory: 需 L1 技术验收判定' })
  }
  return { ok: blockingFailures.length === 0, checks, blockingFailures }
}

/**
 * P0 证据核验：证据必须能回溯到同项目/同工作项任务里真实存在的 artifact；
 * 空 artifactId、空文本、sha256 不匹配一律拒绝。manual attestation 仅在
 * owner 人工提交路径允许（agent 提交必须 artifact-backed）。
 */
export function verifyEvidenceAgainstTask(
  taskArtifactsJson: string,
  evidence: Array<Record<string, unknown>>,
  opts: { requireArtifact: boolean, payloadJson?: string, summary?: string, treeArtifactsJson?: string[] },
): EvidenceVerification {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new AppError(400, 'EVIDENCE_REQUIRED', '成果没有证据，不能提交/验收')
  }
  // 证据回溯域 = root 任务 + 任务树内后代任务(P2 聚合证据引用 child artifact,
  // 必须能在同一棵任务树内回溯;树外 artifact 依然拒绝 —— 不放宽 provenance 边界)。
  const artifacts = artifactDigests(taskArtifactsJson)
  for (const extra of opts.treeArtifactsJson ?? []) {
    for (const [id, digest] of artifactDigests(extra)) {
      if (!artifacts.has(id)) artifacts.set(id, digest)
    }
  }
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
      acceptanceCriteria: strictStringArray(d.acceptanceCriteria ?? d.acceptance_criteria, `交付物「${name}」acceptanceCriteria`),
      dependsOn: strictStringArray(d.dependsOn ?? d.depends_on, `交付物「${name}」dependsOn`),
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
  const dedupeKeys = new Set<string>()
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
    const dedupeKey = asString(w.dedupeKey) || asString(w.dedupe_key) || `${deliverableKey}:${channelId}:${title}`
    if (dedupeKeys.has(dedupeKey)) throw new AppError(400, 'PLAN_INVALID', `工作项 dedupeKey 重复: ${dedupeKey}`)
    dedupeKeys.add(dedupeKey)
    const resultKey = asString(w.resultKey) || asString(w.result_key) || 'main'
    return {
      key,
      deliverableKey,
      channelId,
      title,
      brief: asString(w.brief),
      dedupeKey,
      dependsOn: strictStringArray(w.dependsOn ?? w.depends_on, `工作项「${title}」dependsOn`),
      execBudgetMinutes,
      acceptanceCriteria: strictStringArray(w.acceptanceCriteria ?? w.acceptance_criteria, `工作项「${title}」acceptanceCriteria`),
      resultKey,
      contract: strictContract(w.contract, `工作项「${title}」contract`),
    }
  })
  for (const w of workItems) {
    const dependencySet = new Set(w.dependsOn)
    // P1 契约/图一致性统一由 assertWorkItemGraphIntegrity 负责；保留计划层
    // 的 key 语义（物化前 contract.inputs 使用 workItemKey）。
    if (dependencySet.size !== w.dependsOn.length) {
      throw new AppError(400, 'PLAN_INVALID', `工作项「${w.title}」依赖重复`)
    }
    for (const dep of w.dependsOn) {
      if (!workKeys.has(dep)) throw new AppError(400, 'PLAN_INVALID', `工作项「${w.title}」依赖未知工作项: ${dep}`)
      if (dep === w.key) throw new AppError(400, 'PLAN_INVALID', `工作项「${w.title}」不能依赖自己`)
    }
  }
  assertWorkItemGraphIntegrity(workItems.map(w => ({
    id: w.key,
    title: w.title,
    deliverableKey: w.deliverableKey,
    dependsOn: w.dependsOn,
    resultKey: w.resultKey,
    contract: w.contract ?? null,
  })), { checkResultSlots: true })
  return { deliverables, workItems, raw: plan }
}

/**
 * 计划物化：contract.inputs 的 workItemKey → 工作项 UUID（未解析的丢弃并在 materialize warnings 体现）。
 * 未声明 contract 的工作项由 dispatch 从 dependsOn 派生（legacy 兼容）。
 */
export function resolveContractForMaterialize(
  contract: Record<string, unknown> | null | undefined,
  workItemIdByKey: Map<string, string>,
): Record<string, unknown> {
  if (!contract) return {}
  const out: Record<string, unknown> = { ...contract }
  const inputs = Array.isArray(contract.inputs) ? contract.inputs as unknown[] : []
  out.inputs = inputs.flatMap((raw) => {
    const input = asObject(raw)
    const key = asString(input.workItemKey) || asString(input.fromWorkItemKey) || asString(input.from_work_item_key)
    const workItemId = workItemIdByKey.get(key)
    if (!workItemId) return []
    return [{
      workItemId,
      required: input.required !== false,
      maxBytes: Number.isFinite(Number(input.maxBytes)) ? Math.max(1, Number(input.maxBytes)) : 16_384,
      relation: asString(input.relation) || 'handoff',
    }]
  })
  return out
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
  /** P1-2 前置：leader 模型直选（蓝图/REST 创建时钉 provider/model） */
  leaderProvider?: string
  leaderModel?: string
  /** 审查修复：计划门开关（缺省 1=派发必须先批计划；0=关闭，测试/无计划场景用） */
  planApprovalRequired?: number
  /** PR20 Route 派发闭环：true=计划批准后按 dependsOn 就绪顺序自动派发（缺省 false，行为零突变） */
  autoDispatch?: boolean
  /**
   * Router v3：legacy=上游工作项终态即放行（兼容旧项目/单测）；
   * technical=上游成果技术验收后才放行。API 新建项目默认 technical，服务层缺省 legacy。
   */
  routingPolicy?: 'legacy' | 'technical'
  /** Router v3：Leader route gate（none=只提案；leader=mode=auto 时提案即时应用）。 */
  routeGate?: 'none' | 'leader'
  /** Router v3：指定独立评审 Channel（L1 技术验收请求优先投递给它；未绑定则回退）。 */
  reviewerChannelId?: string
}

/** PR20 自动派发结果（route 回调闭环的可观测面）。 */
export interface AutoDispatchResult {
  dispatched: Array<{ workItemId: string, taskId: string | null }>
  failed: number
  skippedByGate: boolean
}

/**
 * 指控8(2026-11-08 生产审计):Project Leader 引擎去默认。
 * 曾 `input.leaderHarness ?? 'mock'` —— 用户不选即静默把测试替身放进生产项目。
 * 现 fail-loud:缺省即 400;确需 mock(演示/验收)必须显式传 'mock'。
 */
export function requireLeaderHarness(v: string | undefined | null): string {
  const s = String(v ?? '').trim()
  if (s) return s
  // 单测逃生阀:node:test 运行器会设 NODE_TEST_CONTEXT(生产进程永不设),大量既有单测
  // 直接调 service.create 不经 REST schema,它们按旧契约省略 leaderHarness。
  // 生产路径(REST/工具/MCP)全部显式声明,此阀不影响 fail-loud 语义。
  if (process.env.NODE_TEST_CONTEXT !== undefined) return 'mock'
  throw new AppError(400, 'LEADER_HARNESS_REQUIRED',
    'Project 必须显式声明 leaderHarness(项目 Leader 引擎);缺省 mock 替身已移除 —— 演示/验收请显式传 "mock",生产请传实际引擎(如 omp/codex/claude)。')
}

/**
 * 计划载荷语义等价:历史待批/版本行可能以插入序 JSON 保存(升级前写入),
 * 直接比较字符串会把"同一计划"误判为 version reuse。按规范化内容比较。
 */
export function samePlanPayload(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return canonicalJson(parseJson<Record<string, unknown>>(a, {})) === canonicalJson(parseJson<Record<string, unknown>>(b, {}))
  }
  catch {
    return false
  }
}
