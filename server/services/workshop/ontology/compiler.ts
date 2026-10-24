/**
 * Ontology Compiler —— 本体图 → 四类产物 + Rule Trace。
 *
 * 铁律:
 *  1) **只收紧不放宽**:提供 currentBounds 时,任何放宽现行界/步限的规则被
 *     rejected(TIGHTEN_ONLY_VIOLATED);无现行界时不产生「放开」语义,只新增约束。
 *  2) **fail-closed**:每条规则必留一条 trace(compiled|guard|explained|rejected),
 *     禁止静默丢弃;rejected/explained 都带可行动 message。
 *  3) **不承诺后端不支持的能力**:线性耦合/复杂非线性一律 REJECTED_UNSUPPORTED_FORM,
 *     绝不伪装成盒约束(当前 IR 无自由 A_ub)。
 *  4) 产物只填既有 IR/Profile/SceneContract 的字段形状,不发明新约束族。
 */
import type {
  BoundsEntry,
  CompileIssue,
  CompileOptions,
  CompiledArtifacts,
  ControlGuard,
  OntologyCompileResult,
  OntologyDraftDoc,
  OntologyEntity,
  OntologyRelation,
  OntologyRule,
  OntologyRuleTrace,
  RuleDecision,
} from './contracts'
import {
  ONTOLOGY_SCHEMA_VERSION,
  RULE_ERROR_CODES,
  emptyArtifacts,
  evidenceLevelRank,
  unitsCompatible,
} from './contracts'
import { ruleEvidenceLevel, validateDraftDoc } from './validator'
import { canonicalJson, sha256 } from '../aml/twin/contracts'

const COMPARISON_RE = /^\s*([a-z][a-z0-9_.]*)\s*(<=|>=|<|>|==|!=)\s*(-?\d+(?:\.\d+)?)\s*$/

/** 把「X <= 阈值」阈值断言反演为守卫:违反条件 + 禁止继续同向增量 */
function invertComparison(op: string): ControlGuard['when']['op'] | null {
  switch (op) {
    case '<=': return 'gt'
    case '<': return 'gte'
    case '>=': return 'lt'
    case '>': return 'lte'
    case '==': return 'neq'
    case '!=': return 'eq'
    default: return null
  }
}

function scopeOf(rule: OntologyRule, options: CompileOptions) {
  return {
    lineId: rule.scope.lineId || options.scope?.lineId || '',
    recipeId: rule.scope.recipeId || options.scope?.recipeId || '',
    conditionId: rule.scope.conditionId || options.scope?.conditionId || '',
  }
}

function guardOnViolate(rule: OntologyRule, level: ReturnType<typeof ruleEvidenceLevel>, approvedOnly: boolean | undefined): ControlGuard['onViolate'] {
  if (approvedOnly && rule.status !== 'approved_for_control') return 'annotate'
  return evidenceLevelRank(level) >= evidenceLevelRank('observed_correlation') ? 'block_recommendation' : 'annotate'
}

function roleBucket(role: string | undefined): 'mv' | 'cv' | null {
  if (!role) return null
  if (role === 'control' || role === 'disturbance' || role === 'feature') return 'mv'
  if (role === 'target' || role === 'observation') return 'cv'
  return null
}

interface RuleOutcome {
  decision: RuleDecision
  code: string
  message: string
  hint?: string
  guard?: ControlGuard
  bound?: { bucket: 'mv' | 'cv', key: string, entry: BoundsEntry }
  rate?: { key: string, maxStep: number }
  soft?: string
  /** 产物落点引用(编译时回填,供 trace 溯源) */
  decidingRef?: string
}

function decideRule(
  rule: OntologyRule,
  entities: Map<string, OntologyEntity>,
  options: CompileOptions,
): RuleOutcome {
  const level = ruleEvidenceLevel(rule)
  const hardCapable = level === 'validated_control'
  const currentMv = options.currentBounds?.mv ?? {}
  const currentCv = options.currentBounds?.cv ?? {}
  const currentOf = (bucket: 'mv' | 'cv', key: string): BoundsEntry | undefined => (bucket === 'mv' ? currentMv : currentCv)[key]

  switch (rule.dsl.type) {
    case 'bound': {
      const entity = entities.get(rule.dsl.variableKey)
      if (!entity) return { decision: 'rejected', code: RULE_ERROR_CODES.UNKNOWN_ENTITY, message: `规则 ${rule.id} 引用的实体「${rule.dsl.variableKey}」不存在` }
      const bucket = roleBucket(entity.role)
      if (!bucket) {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.ROLE_UNRESOLVED,
          message: `实体「${entity.key}」缺少可判定角色(role=${entity.role ?? '空'}),无法决定产 mvBounds 还是 cvBounds`,
          hint: '为该实体补 role=control(可控)/target(质量目标)/disturbance/feature/observation',
        }
      }
      if (rule.dsl.unit && entity.unit && !unitsCompatible(rule.dsl.unit, entity.unit)) {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.UNIT_MISMATCH,
          message: `规则 ${rule.id} 的界单位「${rule.dsl.unit}」与实体单位「${entity.unit}」量纲不相容`,
          hint: '统一单位声明;数值换算请走 shared/units.ts(本体不做换算)',
        }
      }
      if (rule.constraintLevel === 'hard' && !hardCapable) {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT,
          message: `规则 ${rule.id} 声明硬约束,但证据最高级别为 ${level || '无'}`,
          hint: '硬约束只接受 validated_control(run+crosscheck+outcome 全链证据)',
        }
      }
      if (rule.constraintLevel === 'hard' && options.approvedOnly && rule.status !== 'approved_for_control') {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.NOT_APPROVED,
          message: `规则 ${rule.id} 尚未获批(当前状态 ${rule.status}),不能进入发布版求解约束`,
          hint: '先完成 proposed→reviewed→validated→approved_for_control 审批链(approved_for_control 需第二人批准)',
        }
      }
      if (rule.constraintLevel === 'soft') {
        return {
          decision: 'explained', code: '',
          message: `规则 ${rule.id} 为软约束,仅作为训练/评审参考,不写入求解约束`,
          soft: `soft bound ${rule.dsl.variableKey}: ${canonicalJson(rule.dsl)}`,
        }
      }
      const proposed: BoundsEntry = {}
      if (rule.dsl.min !== undefined) proposed.min = rule.dsl.min
      if (rule.dsl.max !== undefined) proposed.max = rule.dsl.max
      const current = currentOf(bucket, entity.key)
      if (current?.min !== undefined && proposed.min !== undefined && proposed.min < current.min) {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.TIGHTEN_ONLY,
          message: `规则 ${rule.id} 把 ${entity.key} 的下界从 ${current.min} 放宽到 ${proposed.min}`,
          hint: '本体产物只能收紧现行界;放宽需要新的 Profile 版本并由人审',
        }
      }
      if (current?.max !== undefined && proposed.max !== undefined && proposed.max > current.max) {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.TIGHTEN_ONLY,
          message: `规则 ${rule.id} 把 ${entity.key} 的上界从 ${current.max} 放宽到 ${proposed.max}`,
          hint: '本体产物只能收紧现行界;放宽需要新的 Profile 版本并由人审',
        }
      }
      return {
        decision: 'compiled', code: '',
        message: `规则 ${rule.id} 收紧 ${entity.key} 的${bucket === 'mv' ? '可调' : '目标'}界${current ? '(已与现行界求交)' : ''}`,
        bound: { bucket, key: entity.key, entry: proposed },
      }
    }
    case 'rate': {
      const entity = entities.get(rule.dsl.variableKey)
      if (!entity) return { decision: 'rejected', code: RULE_ERROR_CODES.UNKNOWN_ENTITY, message: `规则 ${rule.id} 引用的实体「${rule.dsl.variableKey}」不存在` }
      const bucket = roleBucket(entity.role)
      if (bucket !== 'mv') {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.ROLE_UNRESOLVED,
          message: `变化率规则 ${rule.id} 只能作用于可控变量(control/disturbance/feature),实体「${entity.key}」role=${entity.role ?? '空'}`,
          hint: '为策略变量补 role=control',
        }
      }
      if (rule.dsl.unit && entity.unit && !unitsCompatible(rule.dsl.unit, entity.unit)) {
        return { decision: 'rejected', code: RULE_ERROR_CODES.UNIT_MISMATCH, message: `规则 ${rule.id} 的步限单位「${rule.dsl.unit}」与实体单位「${entity.unit}」不相容` }
      }
      if (rule.constraintLevel === 'hard' && !hardCapable) {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT,
          message: `规则 ${rule.id} 声明硬步限,但证据最高级别为 ${level || '无'}`,
          hint: '硬步限只接受 validated_control',
        }
      }
      if (rule.constraintLevel === 'hard' && options.approvedOnly && rule.status !== 'approved_for_control') {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.NOT_APPROVED,
          message: `规则 ${rule.id} 尚未获批(当前状态 ${rule.status}),不能进入发布版步限`,
          hint: '先完成审批链',
        }
      }
      if (rule.constraintLevel === 'soft') {
        return { decision: 'explained', code: '', message: `规则 ${rule.id} 为软步限,仅作训练/评审参考`, soft: `soft rate ${entity.key}: ${rule.dsl.maxStep}` }
      }
      const current = currentOf('mv', entity.key)
      if (current?.maxStep !== undefined && rule.dsl.maxStep > current.maxStep) {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.TIGHTEN_ONLY,
          message: `规则 ${rule.id} 把 ${entity.key} 的步限从 ${current.maxStep} 放宽到 ${rule.dsl.maxStep}`,
          hint: '本体产物只能收紧步限;放宽需要新的 Profile 版本',
        }
      }
      return {
        decision: 'compiled', code: '',
        message: `规则 ${rule.id} 收紧 ${entity.key} 的最大单步 ${rule.dsl.maxStep}`,
        rate: { key: entity.key, maxStep: rule.dsl.maxStep },
      }
    }
    case 'linear_coupling':
      return {
        decision: 'rejected', code: RULE_ERROR_CODES.UNSUPPORTED_FORM,
        message: `规则 ${rule.id} 是线性耦合约束(${rule.dsl.variableKey} 随 ${rule.dsl.ofKey}),当前 ProblemIR 无自由 A_ub 形态`,
        hint: '需 IR v2 + OSQP A 矩阵支持(超出 v4.1 范围);可改写为状态条件守卫或落到孪生 PhysicsSpec',
      }
    case 'nonlinear': {
      const match = rule.dsl.expression.match(COMPARISON_RE)
      if (!match) {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.UNSUPPORTED_FORM,
          message: `规则 ${rule.id} 的非线性表达式无法由运行时守卫执行(仅支持「变量 比较 阈值」)`,
          hint: '改写为阈值形式,或落 PhysicsSpec 由后端支持',
        }
      }
      const lhs = match[1]!
      const inverted = invertComparison(match[2]!)
      const value = Number(match[3])
      if (!inverted || !Number.isFinite(value)) {
        return { decision: 'rejected', code: RULE_ERROR_CODES.UNSUPPORTED_FORM, message: `规则 ${rule.id} 的比较算子不受支持` }
      }
      if (!entities.has(lhs)) {
        return { decision: 'rejected', code: RULE_ERROR_CODES.UNKNOWN_ENTITY, message: `规则 ${rule.id} 引用的实体「${lhs}」不存在` }
      }
      const guard: ControlGuard = {
        id: `guard-${rule.id}`,
        ruleId: rule.id,
        when: { variableKey: lhs, op: inverted, value },
        forbid: { kind: 'nonzero_increment', variableKey: lhs },
        scope: scopeOf(rule, options),
        onViolate: guardOnViolate(rule, level, options.approvedOnly),
        message: `${rule.id}: ${rule.dsl.expression} 已越界,禁止继续同向调整`,
      }
      return { decision: 'guard', code: '', message: `规则 ${rule.id} 编译为运行时守卫(阈值 ${rule.dsl.expression})`, guard }
    }
    case 'state_condition': {
      if (!entities.has(rule.dsl.when.variableKey)) {
        return {
          decision: 'rejected', code: RULE_ERROR_CODES.OBSERVABLE_UNRESOLVED,
          message: `规则 ${rule.id} 的状态变量「${rule.dsl.when.variableKey}」未在本体中定义,无法观测`,
          hint: '先定义该状态实体并做语义绑定,或改用工况条件',
        }
      }
      if (!entities.has(rule.dsl.forbid.variableKey)) {
        return { decision: 'rejected', code: RULE_ERROR_CODES.UNKNOWN_ENTITY, message: `规则 ${rule.id} 的目标变量「${rule.dsl.forbid.variableKey}」不存在` }
      }
      const guard: ControlGuard = {
        id: `guard-${rule.id}`,
        ruleId: rule.id,
        when: rule.dsl.when,
        forbid: rule.dsl.forbid,
        scope: scopeOf(rule, options),
        onViolate: guardOnViolate(rule, level, options.approvedOnly),
        message: rule.dsl.message ?? `规则 ${rule.id}: 前置条件未满足,禁止调整「${rule.dsl.forbid.variableKey}」`,
      }
      return { decision: 'guard', code: '', message: `规则 ${rule.id} 编译为运行时守卫(条件未满足时禁止增量)`, guard }
    }
    case 'interlock':
      return {
        decision: 'explained', code: RULE_ERROR_CODES.PLC_LAYER,
        message: `规则 ${rule.id} 属于安全联锁,归 PLC/DCW 配置层(${rule.dsl.text})`,
        hint: '请在 DCW 节点限界或 PLC 联锁逻辑中落实;本体不会替代现场安全回路',
      }
    case 'informal':
      return { decision: 'explained', code: '', message: `规则 ${rule.id} 无法形式化,仅作解释与人工审核依据(${rule.dsl.text})` }
    default:
      return { decision: 'rejected', code: RULE_ERROR_CODES.INVALID, message: `规则 ${rule.id} 的 DSL 形态未知` }
  }
}

/** 由关系派生训练先验(特征候选/时滞/单调性) */
function deriveProcessModel(doc: OntologyDraftDoc, entities: Map<string, OntologyEntity>) {
  const featureCandidates: CompiledArtifacts['processModel']['featureCandidates'] = []
  const delayPriors: CompiledArtifacts['processModel']['delayPriors'] = []
  const monotonicity: CompiledArtifacts['processModel']['monotonicity'] = []
  const seenFeature = new Set<string>()

  for (const rel of doc.relations as OntologyRelation[]) {
    if (rel.kind !== 'influences') continue
    const dst = entities.get(rel.dstKey)
    const src = entities.get(rel.srcKey)
    if (dst?.role === 'target' || dst?.role === 'observation') {
      const dedupe = `${rel.srcKey}|${rel.dstKey}`
      if (!seenFeature.has(dedupe)) {
        seenFeature.add(dedupe)
        featureCandidates.push({
          entityKey: rel.srcKey,
          role: src?.role === 'disturbance' ? 'disturbance' : 'feature',
          relation: `influences→${rel.dstKey}`,
          evidenceLevel: rel.properties.evidenceTier,
          priorDelayMs: rel.properties.lagMs,
          variabilityChecked: rel.properties.variabilityChecked,
        })
      }
    }
    if (rel.properties.sign) {
      monotonicity.push({
        output: rel.dstKey,
        input: rel.srcKey,
        direction: rel.properties.sign === 'positive' ? 'increasing' : 'decreasing',
      })
    }
    if (rel.properties.lagMs !== undefined) {
      delayPriors.push({
        entityKey: rel.srcKey, delayMs: rel.properties.lagMs, basis: 'relation_lag',
        variabilityChecked: rel.properties.variabilityChecked,
      })
    }
    else if (rel.properties.transportDistanceM && rel.properties.nominalSpeedMps) {
      const delayMs = Math.round((rel.properties.transportDistanceM / rel.properties.nominalSpeedMps) * 1000)
      delayPriors.push({
        entityKey: rel.srcKey, delayMs, basis: 'tau_eq_D_over_v',
        variabilityChecked: rel.properties.variabilityChecked,
      })
    }
  }
  return { featureCandidates, delayPriors, monotonicity }
}

function traceId(ontologyId: string, version: number, ruleId: string): string {
  return `ort-${ontologyId}@${version}:${ruleId}`
}

function buildTrace(
  ontologyId: string, version: number, rulePackHash: string, rule: OntologyRule,
  outcome: RuleOutcome, createdAt: string,
): OntologyRuleTrace {
  const level = ruleEvidenceLevel(rule)
  const base: OntologyRuleTrace = {
    id: traceId(ontologyId, version, rule.id),
    ontologyId,
    version,
    rulePackHash,
    ruleId: rule.id,
    ruleKey: rule.key,
    ruleRevision: sha256(canonicalJson({ kind: rule.kind, dsl: rule.dsl, constraintLevel: rule.constraintLevel, evidence: rule.evidence.map(e => `${e.id}:${e.level}`) })),
    ruleKind: rule.kind,
    evidenceLevel: level,
    constraintLevel: rule.constraintLevel,
    decision: outcome.decision,
    decisionCode: outcome.code,
    message: outcome.hint ? `${outcome.message}。建议:${outcome.hint}` : outcome.message,
    bindings: [],
    artifacts: [],
    scope: { lineId: rule.scope.lineId, recipeId: rule.scope.recipeId, conditionId: rule.scope.conditionId },
    rowHash: '',
    createdAt,
  }
  base.rowHash = sha256(canonicalJson({ ...base, rowHash: '' }))
  return base
}

/** 编译入口(纯函数;不写库) */
export function compileOntology(doc: OntologyDraftDoc, options: CompileOptions): OntologyCompileResult {
  const createdAt = options.createdAt ?? new Date().toISOString()
  const validation = validateDraftDoc(doc)
  const rules = [...doc.rules].sort((a, b) => a.id.localeCompare(b.id))
  const rulePackHash = sha256(canonicalJson(rules.map(r => ({
    id: r.id, key: r.key, kind: r.kind, dsl: r.dsl, constraintLevel: r.constraintLevel,
    evidence: r.evidence.map(e => e.level),
  }))))

  if (!validation.ok) {
    return {
      status: 'rejected',
      ontologyId: options.ontologyId,
      ontologyVersion: options.version,
      contentHash: sha256(canonicalJson(doc)),
      rulePackHash,
      artifacts: emptyArtifacts(),
      traces: [],
      issues: validation.issues,
      compiledCount: 0,
      guardCount: 0,
      explainedCount: 0,
      rejectedCount: rules.length,
    }
  }

  const entities = new Map(doc.entities.map(e => [e.key, e]))
  const artifacts = emptyArtifacts()
  const traces: OntologyRuleTrace[] = []
  const issues: CompileIssue[] = []
  let compiledCount = 0
  let guardCount = 0
  let explainedCount = 0
  let rejectedCount = 0

  for (const rule of rules) {
    const outcome = decideRule(rule, entities, options)
    if (outcome.decision === 'compiled') compiledCount += 1
    else if (outcome.decision === 'guard') guardCount += 1
    else if (outcome.decision === 'explained') explainedCount += 1
    else rejectedCount += 1

    if (outcome.bound) {
      const bucket = outcome.bound.bucket === 'mv' ? artifacts.problemIr.mvBounds : artifacts.problemIr.cvBounds
      const merged = bucket[outcome.bound.key] ?? {}
      if (outcome.bound.entry.min !== undefined) merged.min = Math.max(merged.min ?? Number.NEGATIVE_INFINITY, outcome.bound.entry.min)
      if (outcome.bound.entry.max !== undefined) merged.max = Math.min(merged.max ?? Number.POSITIVE_INFINITY, outcome.bound.entry.max)
      bucket[outcome.bound.key] = merged
      outcome.decidingRef = `problem-ir:${outcome.bound.key}`
    }
    if (outcome.rate) {
      const merged = artifacts.problemIr.mvBounds[outcome.rate.key] ?? {}
      merged.maxStep = Math.min(merged.maxStep ?? Number.POSITIVE_INFINITY, outcome.rate.maxStep)
      artifacts.problemIr.mvBounds[outcome.rate.key] = merged
      outcome.decidingRef = `problem-ir:${outcome.rate.key}`
    }
    if (outcome.soft) artifacts.problemIr.softRegularization.push({ ruleId: rule.id, note: outcome.soft })
    if (outcome.guard) artifacts.controlGuard.guards.push(outcome.guard)
    if (outcome.decision === 'rejected' || outcome.decision === 'explained') {
      issues.push({
        code: outcome.code || RULE_ERROR_CODES.INVALID,
        path: `rules[${rule.id}]`,
        message: outcome.message,
        severity: outcome.decision === 'rejected' ? 'error' : 'warning',
        ruleId: rule.id,
        hint: outcome.hint,
      })
    }
    const trace = buildTrace(options.ontologyId, options.version, rulePackHash, rule, outcome, createdAt)
    if (outcome.guard) trace.artifacts.push({ kind: 'control_guard', ref: outcome.guard.id, artifactHash: sha256(canonicalJson(outcome.guard)) })
    if (outcome.decidingRef) trace.artifacts.push({ kind: 'problem_ir', ref: outcome.decidingRef })
    traces.push(trace)
  }

  const derived = deriveProcessModel(doc, entities)
  artifacts.processModel = derived

  artifacts.sceneContract.inferredRelations = doc.relations.map(rel => ({
    srcKey: rel.srcKey, dstKey: rel.dstKey, predicate: rel.kind, evidenceTier: rel.properties.evidenceTier,
  }))
  artifacts.sceneContract.variables = doc.entities
    .filter(e => !!e.role && (e.kind === 'process_variable' || e.kind === 'quality_variable'))
    .map((e) => {
      const bound = artifacts.problemIr.mvBounds[e.key] ?? artifacts.problemIr.cvBounds[e.key]
      return { id: e.key, role: e.role as string, unit: e.unit, min: bound?.min, max: bound?.max, maxStep: bound?.maxStep }
    })
  artifacts.sceneContract.constraints = [
    ...Object.entries(artifacts.problemIr.mvBounds)
      .map(([key, entry]) => ({ id: `mv:${key}`, kind: 'hard_range' as const, min: entry.min, max: entry.max })),
    ...Object.entries(artifacts.problemIr.mvBounds).filter(([, entry]) => entry.maxStep !== undefined)
      .map(([key, entry]) => ({ id: `rate:${key}`, kind: 'rate' as const, max: entry.maxStep })),
  ]

  const status: OntologyCompileResult['status'] = (compiledCount + guardCount) === 0 && rejectedCount > 0
    ? 'rejected'
    : (rejectedCount > 0 || explainedCount > 0 ? 'warning' : 'success')

  return {
    status,
    ontologyId: options.ontologyId,
    ontologyVersion: options.version,
    contentHash: sha256(canonicalJson(doc)),
    rulePackHash,
    artifacts,
    traces,
    issues,
    compiledCount,
    guardCount,
    explainedCount,
    rejectedCount,
  }
}

/** 规则集 hash(用于 Profile 侧漂移比对) */
export function ontologyPackHash(input: { rulePackHash: string, contentHash: string }): string {
  return sha256(canonicalJson({ v: ONTOLOGY_SCHEMA_VERSION, rulePackHash: input.rulePackHash, contentHash: input.contentHash }))
}
