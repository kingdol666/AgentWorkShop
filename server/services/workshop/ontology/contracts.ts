/**
 * 本体契约(单一类型真相)。
 *
 * 三层模型:
 *  1) Core/Scenario 本体 = 一份「草稿文档」→ 发布时快照为不可变版本;
 *  2) 语义绑定把本体实体锚到现有平台对象(daq_node/dcw_node/recipe_param),不建影子表;
 *  3) Runtime Semantic Context 按请求组装,不落库。
 *
 * 证据三级(candidate_influence < observed_correlation < validated_control)与生命周期
 * 五态(proposed→reviewed→validated→approved_for_control→deprecated)分离「可读 / 可参考 /
 * 可编译为控制侧产物」三种能力。硬约束只接受 validated_control。
 */
import { z } from 'zod'
import { dimensionOf, dimensionsCompatible, unitsCompatible } from '@/shared/dimensions'
import { canonicalJson, sha256 } from '../aml/twin/contracts'

export const ONTOLOGY_SCHEMA_VERSION = 1 as const

export const ONTOLOGY_ENTITY_KINDS = [
  'production_line', 'process_unit', 'equipment', 'sensor', 'actuator',
  'process_variable', 'quality_variable', 'process_model', 'optimization_task', 'operating_condition',
] as const
export type OntologyEntityKind = typeof ONTOLOGY_ENTITY_KINDS[number]

/** 关系封闭枚举(禁止宽泛 relatedTo) */
export const ONTOLOGY_RELATION_KINDS = [
  'influences', 'measures', 'actuates', 'hasPart', 'precedes', 'observedBy', 'constrainedBy', 'basedOn',
] as const
export type OntologyRelationKind = typeof ONTOLOGY_RELATION_KINDS[number]

/** 实体在控制问题中的角色(与 ProcessModelSpec/SceneContract 词表显式对齐) */
export const ONTOLOGY_ROLES = ['control', 'target', 'disturbance', 'feature', 'state', 'guard', 'observation'] as const
export type OntologyRole = typeof ONTOLOGY_ROLES[number]

export const ONTOLOGY_STATES = ['proposed', 'reviewed', 'validated', 'approved_for_control', 'deprecated'] as const
export type OntologyState = typeof ONTOLOGY_STATES[number]

export const EVIDENCE_LEVELS = ['candidate_influence', 'observed_correlation', 'validated_control'] as const
export type EvidenceLevel = typeof EVIDENCE_LEVELS[number]

export const RULE_KINDS = ['bound', 'rate', 'linear_coupling', 'nonlinear', 'state_condition', 'interlock', 'informal'] as const
export type RuleKind = typeof RULE_KINDS[number]

export const PLATFORM_KINDS = ['daq_node', 'dcw_node', 'recipe_param', 'device', 'spec_variable', 'scene_variable', 'condition'] as const
export type PlatformKind = typeof PLATFORM_KINDS[number]

export const BINDING_DIRECTIONS = ['read', 'write', 'read_write'] as const

export type OntologyTarget = 'process_model' | 'problem_ir' | 'scene_contract' | 'control_guard'
export type CompileStatus = 'success' | 'warning' | 'rejected'
export type RuleDecision = 'compiled' | 'guard' | 'explained' | 'rejected'

/** 生命周期合法迁移(唯一真相;服务层与前端按钮共用) */
export const RULE_TRANSITIONS: Readonly<Record<OntologyState, readonly OntologyState[]>> = {
  proposed: ['reviewed', 'deprecated'],
  reviewed: ['validated', 'deprecated'],
  validated: ['approved_for_control', 'deprecated'],
  approved_for_control: ['deprecated'],
  deprecated: [],
}

export function evidenceLevelRank(level: EvidenceLevel | '' | undefined): number {
  const idx = EVIDENCE_LEVELS.indexOf((level ?? '') as EvidenceLevel)
  return idx < 0 ? -1 : idx
}

export function maxEvidenceLevel(levels: Array<EvidenceLevel | '' | undefined>): EvidenceLevel | '' {
  let best: EvidenceLevel | '' = ''
  for (const level of levels) if (evidenceLevelRank(level) > evidenceLevelRank(best)) best = level as EvidenceLevel
  return best
}

export const RULE_ERROR_CODES = {
  EVIDENCE_INSUFFICIENT: 'ONTOLOGY_EVIDENCE_INSUFFICIENT',
  UNKNOWN_ENTITY: 'ONTOLOGY_UNKNOWN_ENTITY',
  UNIT_MISMATCH: 'ONTOLOGY_UNIT_MISMATCH',
  RULE_CONFLICT: 'ONTOLOGY_RULE_CONFLICT',
  EVIDENCE_STALE: 'ONTOLOGY_EVIDENCE_STALE',
  SCOPE_MISMATCH: 'ONTOLOGY_SCOPE_MISMATCH',
  TIGHTEN_ONLY: 'TIGHTEN_ONLY_VIOLATED',
  UNSUPPORTED_FORM: 'REJECTED_UNSUPPORTED_FORM',
  PLC_LAYER: 'PLC_LAYER_REQUIRED',
  INVALID: 'ONTOLOGY_INVALID',
  ROLE_UNRESOLVED: 'ONTOLOGY_ROLE_UNRESOLVED',
  OBSERVABLE_UNRESOLVED: 'ONTOLOGY_OBSERVABLE_UNRESOLVED',
  NOT_APPROVED: 'ONTOLOGY_NOT_APPROVED',
} as const

// ===== 证据 =====

export const evidenceSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('expert_note'), author: z.string().min(1), noteId: z.string().min(1) }),
  z.object({ type: z.literal('template_semantics'), templateKey: z.string().min(1) }),
  z.object({ type: z.literal('physics_spec_monotonicity'), modelId: z.string().min(1) }),
  z.object({ type: z.literal('dataset_stats'), datasetId: z.string().min(1), sha256: z.string().min(1) }),
  z.object({ type: z.literal('optimizer_run'), runId: z.string().min(1), problemIrHash: z.string().min(1), modelArtifactHash: z.string().min(1) }),
  z.object({ type: z.literal('manual'), author: z.string().default('') }),
])
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>

export const evidenceRecordSchema = z.object({
  id: z.string().min(1),
  level: z.enum(EVIDENCE_LEVELS),
  source: evidenceSourceSchema,
  /** 只存引用与引用快照 hash,不复制证据内容(D5/D11 证据单源) */
  sourceRefHash: z.string().default(''),
  createdAt: z.string().min(1),
  note: z.string().max(500).optional(),
})
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>

// ===== 实体 / 关系 =====

const ENTITY_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/

export const ontologyEntitySchema = z.object({
  key: z.string().min(1).max(120).regex(ENTITY_KEY, '实体 key 必须形如 pv.melt_pressure(小写、点分)'),
  kind: z.enum(ONTOLOGY_ENTITY_KINDS),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  unit: z.string().max(32).default(''),
  dimension: z.string().max(64).default(''),
  role: z.enum(ONTOLOGY_ROLES).optional(),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
})
export type OntologyEntity = z.infer<typeof ontologyEntitySchema>

export const relationPropertiesSchema = z.object({
  sign: z.enum(['positive', 'negative']).optional(),
  /** 增益只接受模型单位(展示层经 shared/units 换算);仅 validated_control 允许填 */
  gainPerUnit: z.number().finite().optional(),
  lagMs: z.number().int().min(0).optional(),
  /** 关系证据档:不得超过其所附 evidence 的最高级别 */
  evidenceTier: z.enum(EVIDENCE_LEVELS).default('candidate_influence'),
  /** 变速工况下 τ=D/v 是否已校验;未校验时时滞只能作软先验 */
  variabilityChecked: z.boolean().default(false),
  /** 物料输运距离与标称线速(用于 τ=D/v 时滞先验;两者都给才计算) */
  transportDistanceM: z.number().finite().positive().optional(),
  nominalSpeedMps: z.number().finite().positive().optional(),
  controlApplicability: z.object({
    lineId: z.string().default(''),
    recipeIds: z.array(z.string()).default([]),
    conditionIds: z.array(z.string()).default([]),
  }).optional(),
})
export type RelationProperties = z.infer<typeof relationPropertiesSchema>

export const ontologyRelationSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(ONTOLOGY_RELATION_KINDS),
  srcKey: z.string().min(1),
  dstKey: z.string().min(1),
  status: z.enum(ONTOLOGY_STATES).default('proposed'),
  evidence: z.array(evidenceRecordSchema).default([]),
  properties: relationPropertiesSchema.default({ evidenceTier: 'candidate_influence', variabilityChecked: false }),
})
export type OntologyRelation = z.infer<typeof ontologyRelationSchema>

// ===== 规则 DSL =====

const comparisonSchema = z.object({
  variableKey: z.string().min(1),
  op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']),
  value: z.union([z.number(), z.string(), z.boolean()]),
})

export const ruleDslSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('bound'),
    variableKey: z.string().min(1),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    unit: z.string().max(32).optional(),
  }),
  z.object({
    type: z.literal('rate'),
    variableKey: z.string().min(1),
    maxStep: z.number().finite().positive(),
    unit: z.string().max(32).optional(),
  }),
  z.object({
    type: z.literal('linear_coupling'),
    variableKey: z.string().min(1),
    ofKey: z.string().min(1),
    factor: z.number().finite(),
    note: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('nonlinear'),
    variableKey: z.string().min(1),
    /** 简单阈值形态可由运行时守卫执行(如 'cv.thickness <= 52');复杂表达式需后端支持 */
    expression: z.string().min(1).max(300),
  }),
  z.object({
    type: z.literal('state_condition'),
    when: comparisonSchema,
    forbid: z.object({
      kind: z.enum(['positive_increment', 'nonzero_increment']),
      variableKey: z.string().min(1),
    }),
    message: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('interlock'),
    variableKey: z.string().min(1).optional(),
    text: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal('informal'),
    text: z.string().min(1).max(500),
  }),
])
export type RuleDsl = z.infer<typeof ruleDslSchema>

export const ontologyRuleSchema = z.object({
  id: z.string().min(1).max(120),
  key: z.string().min(1).max(120),
  kind: z.enum(RULE_KINDS),
  dsl: ruleDslSchema,
  constraintLevel: z.enum(['hard', 'soft']).default('soft'),
  severity: z.enum(['error', 'warn']).default('error'),
  status: z.enum(ONTOLOGY_STATES).default('proposed'),
  evidence: z.array(evidenceRecordSchema).default([]),
  description: z.string().max(500).default(''),
  scope: z.object({
    lineId: z.string().default(''),
    recipeId: z.string().default(''),
    conditionId: z.string().default(''),
  }).default({ lineId: '', recipeId: '', conditionId: '' }),
})
export type OntologyRule = z.infer<typeof ontologyRuleSchema>

// ===== 语义绑定(草稿期) =====

export const bindingDraftSchema = z.object({
  id: z.string().min(1).max(120),
  entityKey: z.string().min(1),
  platformKind: z.enum(PLATFORM_KINDS),
  platformId: z.string().min(1).max(200),
  targetSub: z.string().max(200).default(''),
  scope: z.string().max(200).default('global'),
  direction: z.enum(BINDING_DIRECTIONS).default('read'),
  unitDeclared: z.string().max(32).default(''),
  unitTarget: z.string().max(32).default(''),
  scale: z.number().finite().default(1),
  offset: z.number().finite().default(0),
})
export type BindingDraft = z.infer<typeof bindingDraftSchema>

// ===== 草稿文档 =====

export const ontologyDraftDocSchema = z.object({
  schemaVersion: z.literal(ONTOLOGY_SCHEMA_VERSION),
  name: z.string().min(1).max(200),
  /** 授权锚;空 = 全局本体(仅 admin 可发布) */
  lineId: z.string().max(120).default(''),
  entities: z.array(ontologyEntitySchema).default([]),
  relations: z.array(ontologyRelationSchema).default([]),
  rules: z.array(ontologyRuleSchema).default([]),
  bindings: z.array(bindingDraftSchema).default([]),
  note: z.string().max(2000).default(''),
})
export type OntologyDraftDoc = z.infer<typeof ontologyDraftDocSchema>

export function emptyDraftDoc(ontologyId: string, lineId = ''): OntologyDraftDoc {
  return { schemaVersion: ONTOLOGY_SCHEMA_VERSION, name: ontologyId, lineId, entities: [], relations: [], rules: [], bindings: [], note: '' }
}

export function parseDraftDoc(value: unknown): OntologyDraftDoc {
  return ontologyDraftDocSchema.parse(value) as OntologyDraftDoc
}

/** 草稿内容 hash(与版本 content_hash 同口径:整份规范化文档) */
export function draftContentHash(doc: OntologyDraftDoc): string {
  return sha256(canonicalJson(doc))
}

// ===== 编译产物 =====

export interface BoundsEntry { min?: number, max?: number, maxStep?: number }

export interface ProblemIrDelta {
  templateRef: 'linear_mpc_quadratic@1' | 'steady_response@1'
  mvBounds: Record<string, BoundsEntry>
  cvBounds: Record<string, BoundsEntry>
  softRegularization: Array<{ ruleId: string, note: string }>
}

export interface FeatureCandidate {
  entityKey: string
  role: 'feature' | 'disturbance'
  relation: string
  evidenceLevel: EvidenceLevel
  priorDelayMs?: number
  variabilityChecked: boolean
}

export interface DelayPrior {
  entityKey: string
  delayMs: number
  basis: 'relation_lag' | 'tau_eq_D_over_v'
  variabilityChecked: boolean
}

export interface ProcessModelDelta {
  featureCandidates: FeatureCandidate[]
  delayPriors: DelayPrior[]
  monotonicity: Array<{ output: string, input: string, direction: 'increasing' | 'decreasing' }>
}

export interface SceneContractPatch {
  variables: Array<{ id: string, role: string, unit: string, min?: number, max?: number, maxStep?: number }>
  constraints: Array<{ id: string, kind: 'hard_range' | 'rate' | 'max_delta' | 'custom', min?: number, max?: number, unit?: string }>
  inferredRelations: Array<{ srcKey: string, dstKey: string, predicate: string, evidenceTier: EvidenceLevel }>
}

/** 运行时守卫:白名单算子 + 单条件阈值;可被 evaluateGuards 真正执行 */
export interface ControlGuard {
  id: string
  ruleId: string
  when: { variableKey: string, op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte', value: number | string | boolean }
  forbid: { kind: 'positive_increment' | 'nonzero_increment', variableKey: string }
  scope: { lineId: string, recipeId: string, conditionId: string }
  onViolate: 'block_recommendation' | 'annotate'
  message: string
}

export interface ControlGuardSet {
  guards: ControlGuard[]
}

export interface CompiledArtifacts {
  processModel: ProcessModelDelta
  problemIr: ProblemIrDelta
  sceneContract: SceneContractPatch
  controlGuard: ControlGuardSet
}

export function emptyArtifacts(): CompiledArtifacts {
  return {
    processModel: { featureCandidates: [], delayPriors: [], monotonicity: [] },
    problemIr: { templateRef: 'linear_mpc_quadratic@1', mvBounds: {}, cvBounds: {}, softRegularization: [] },
    sceneContract: { variables: [], constraints: [], inferredRelations: [] },
    controlGuard: { guards: [] },
  }
}

export interface OntologyRuleTrace {
  id: string
  ontologyId: string
  version: number
  rulePackHash: string
  ruleId: string
  ruleKey: string
  ruleRevision: string
  ruleKind: RuleKind
  evidenceLevel: EvidenceLevel | ''
  constraintLevel: 'hard' | 'soft'
  decision: RuleDecision
  decisionCode: string
  message: string
  bindings: Array<{ entityKey: string, platformKind?: string, platformId?: string }>
  artifacts: Array<{ kind: OntologyTarget, ref?: string, artifactHash?: string }>
  scope: { lineId: string, recipeId: string, conditionId: string }
  rowHash: string
  createdAt: string
}

export interface CompileIssue {
  code: string
  path: string
  message: string
  severity: 'error' | 'warning'
  ruleId?: string
  hint?: string
}

export interface OntologyCompileResult {
  status: CompileStatus
  ontologyId: string
  ontologyVersion: number
  contentHash: string
  rulePackHash: string
  artifacts: CompiledArtifacts
  traces: OntologyRuleTrace[]
  issues: CompileIssue[]
  compiledCount: number
  guardCount: number
  explainedCount: number
  rejectedCount: number
}

export interface CompileOptions {
  ontologyId: string
  version: number
  /** 现行权威界(来自 ProblemConfig/effectiveDomain);提供时强制「只收紧」 */
  currentBounds?: { mv?: Record<string, BoundsEntry>, cv?: Record<string, BoundsEntry> }
  scope?: { lineId?: string, recipeId?: string, conditionId?: string }
  createdAt?: string
  /**
   * 只接受 approved_for_control 的规则产出控制侧产物(发布路径必开;预览可关)。
   * 未获批的硬约束/阻断级守卫 → rejected ONTOLOGY_NOT_APPROVED。
   */
  approvedOnly?: boolean
}

/** 供 Profile 冻结的引用摘要(进 profileContentHash,绝不进 problemIrHash) */
export interface OntologyRef {
  ontologyId: string
  ontologyVersion: number
  contentHash: string
  rulePackHash: string
  guardCount: number
}

export function ontologyRefOf(result: { ontologyId: string, ontologyVersion: number, contentHash: string, rulePackHash: string, artifacts: CompiledArtifacts }): OntologyRef {
  return {
    ontologyId: result.ontologyId,
    ontologyVersion: result.ontologyVersion,
    contentHash: result.contentHash,
    rulePackHash: result.rulePackHash,
    guardCount: result.artifacts.controlGuard.guards.length,
  }
}

/** 单位一致性:实体声明单位与其量纲注记;绑定期再比对目标单位 */
export function entityUnitIssue(entity: OntologyEntity): CompileIssue | null {
  if (!entity.unit) return null
  if (!entity.dimension) return null
  const actual = dimensionOf(entity.unit)
  if (dimensionsCompatible(actual, entity.dimension)) return null
  return {
    code: RULE_ERROR_CODES.UNIT_MISMATCH,
    path: `entities[${entity.key}]`,
    message: `实体 ${entity.key} 声明量纲「${entity.dimension}」与单位「${entity.unit}」归一出「${actual}」不相容`,
    severity: 'error',
    hint: '改正 dimension 或 unit;换算请走 shared/units.ts,本体不做数值换算',
  }
}

export { unitsCompatible }
