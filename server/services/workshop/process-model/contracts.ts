/**
 * Process Model Service —— 类型化契约(单一事实来源)。
 *
 * 设计约束(见 docs/plans/2026-10-22-optimizer-process-model-plan.md §3.1.1 / G1.2):
 *  - 模型家族用**判别联合**(artifactKind + modelInterface),未知类型一律抛
 *    UNSUPPORTED_ARTIFACT / UNSUPPORTED_MODEL_INTERFACE,绝不静默回落到 ONNX;
 *  - 配置只描述"用哪个内置训练器 / 什么输入输出语义",不接受用户 Python 代码;
 *  - 单位换算必须显式(scale/offset),不猜测补齐;
 *  - 工况 exactly-one 匹配,重叠/无匹配在发布与运行时都要报错。
 */
import { AppError } from '../../../utils/errors'

/** 训练/求解共用契约版本(manifest v2 起) */
export const PROCESS_MODEL_SCHEMA_VERSION = 2 as const
export const PROCESS_MODEL_MANIFEST_VERSION = 2 as const
export const PROCESS_MODEL_GATE_POLICY = 'process-model.gates@1' as const
export const FEATURE_PIPELINE_VERSION = 1 as const

// ===== 工件类型判别联合 =====

export const ARTIFACT_KINDS = [
  /** 旧 ONNX 一步预测(历史兼容;不能直接绑定 OSQP) */
  'onnx_one_step@1',
  /** Hybrid Twin 工件(旧链;不隐式转换模型含义) */
  'hybrid_manifest@1',
  /** 线性 ARX 辨识出的状态空间包(A/B/C/D/缩放/偏置/延迟/残差校准) */
  'linear_state_space@1',
  /** 静态响应面(系数/特征展开/缩放/偏置/留出残差) */
  'static_response@1',
] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** 模型接口 = 平台如何把输入喂给模型。与工件类型分开,允许同工件多接口版本演进。 */
export const MODEL_INTERFACE_IDS = [
  'one_step',
  'linear_state_space',
  'static_response',
] as const

export type ModelInterfaceId = (typeof MODEL_INTERFACE_IDS)[number]

export interface ArtifactDescriptor {
  kind: ArtifactKind
  schemaVersion: number
  /** 工件主文件相对路径(在模型实体目录内) */
  entryFile: string
  /** 必需伴随文件(完整性检查清单) */
  requiredFiles: string[]
  artifactHash: string
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value)
}

export function isModelInterfaceId(value: unknown): value is ModelInterfaceId {
  return typeof value === 'string' && (MODEL_INTERFACE_IDS as readonly string[]).includes(value)
}

export function assertArtifactKind(value: unknown): ArtifactKind {
  if (!isArtifactKind(value)) {
    throw new AppError(422, 'UNSUPPORTED_ARTIFACT', `不支持的工件类型 artifactKind=${String(value)};允许值:${ARTIFACT_KINDS.join(', ')}`)
  }
  return value
}

export function assertModelInterfaceId(value: unknown): ModelInterfaceId {
  if (!isModelInterfaceId(value)) {
    throw new AppError(422, 'UNSUPPORTED_MODEL_INTERFACE', `不支持的模型接口 modelInterface=${String(value)};允许值:${MODEL_INTERFACE_IDS.join(', ')}`)
  }
  return value
}

// ===== 变量与工况 =====

export const VARIABLE_ROLES = ['mv', 'cv', 'md', 'feature'] as const
export type VariableRole = (typeof VARIABLE_ROLES)[number]

/**
 * 输入语义:
 *  - setpoint      —— 设定值作为模型输入,实际过程量作为状态/观测(执行器滞后进响应模型);
 *  - process_value —— 实际过程量作为模型输入;在线候选设定值必须先经执行器模型转换。
 * 缺映射时拒绝发布(不允许"猜")。
 */
export const INPUT_SEMANTICS = ['setpoint', 'process_value'] as const
export type InputSemantics = (typeof INPUT_SEMANTICS)[number]

export interface VariableMap {
  /** 用户语义变量 id(Profile/目标/约束引用它) */
  id: string
  /** DAQ 节点 id */
  nodeId: string
  role: VariableRole
  /** 源字段(未来可扩 readback/setpoint;首版 value) */
  field: 'value' | 'setpoint' | 'readback'
  /** 源单位(必须与 DAQ 元数据一致或显式换算) */
  unit: string
  /** 模型单位(缺省 = 源单位) */
  modelUnit?: string
  /** 显式仿射换算:model = source * scale + offset */
  scale: number
  offset: number
  /** 作用延迟(ms);对 MV 必填,0 也是显式值 */
  delayMs?: number
  min?: number
  max?: number
  maxStep?: number
  /** SW5:MV 的下发执行节点(DCW);parse 可选(旧 spec),publish/dispatch required */
  controlNodeId?: string
}

export interface ConditionClause {
  /** 上下文维度:productId / recipeId / recipeVersion / stage / lineId */
  field: 'productId' | 'recipeId' | 'recipeVersion' | 'stage' | 'lineId'
  /** eq 精确;range 闭区间 */
  op: 'eq' | 'range'
  value: string | number | [number, number]
}

export interface ConditionSpec {
  id: string
  label?: string
  /** 全部子句 AND;必须 exactly-one 命中 */
  match: ConditionClause[]
}

export interface RuntimeContextInput {
  lineId: string
  productId: string
  recipeId: string
  recipeVersion: number
  stage?: string
}

/** 返回命中的工况 id;零命中/多命中都抛错(不依赖隐式优先级)。 */
export function matchCondition(conditions: ConditionSpec[], context: RuntimeContextInput): string {
  const hits: string[] = []
  for (const condition of conditions) {
    const matched = condition.match.every((clause) => {
      const actual = (context as unknown as Record<string, unknown>)[clause.field]
      if (clause.op === 'eq') return String(actual ?? '') === String(clause.value)
      if (typeof actual !== 'number') return false
      const [lo, hi] = clause.value as [number, number]
      return actual >= lo && actual <= hi
    })
    if (matched) hits.push(condition.id)
  }
  if (hits.length === 0) throw new AppError(422, 'CONDITION_NO_MATCH', `当前工况无匹配条件(可用:${conditions.map(c => c.id).join(', ')})`)
  if (hits.length > 1) throw new AppError(422, 'CONDITION_OVERLAP', `当前工况命中多个条件(${hits.join(', ')});条件必须 exactly-one`)
  return hits[0]!
}

// ===== 训练器 =====

export const TRAINER_REFS = ['linear_arx@1', 'static_response@1'] as const
export type TrainerRef = (typeof TRAINER_REFS)[number]

export function isTrainerRef(value: unknown): value is TrainerRef {
  return typeof value === 'string' && (TRAINER_REFS as readonly string[]).includes(value)
}

export const SOLVER_REFS = ['scipy_slsqp@1', 'osqp_mpc@1'] as const
export type SolverRef = (typeof SOLVER_REFS)[number]

export function isSolverRef(value: unknown): value is SolverRef {
  return typeof value === 'string' && (SOLVER_REFS as readonly string[]).includes(value)
}

export const PROBLEM_TEMPLATE_REFS = ['linear_mpc_quadratic@1', 'steady_response@1'] as const
export type ProblemTemplateRef = (typeof PROBLEM_TEMPLATE_REFS)[number]

export function isProblemTemplateRef(value: unknown): value is ProblemTemplateRef {
  return typeof value === 'string' && (PROBLEM_TEMPLATE_REFS as readonly string[]).includes(value)
}

// ===== 规格 =====

export type ProcessModelStatus = 'draft' | 'published' | 'retired'

export interface DatasetPolicy {
  runIds?: string[]
  fromMs?: number
  toMs?: number
  split: { valRatio: number, testRatio: number, seed: number }
  cleaning?: { hampelK?: number, maxInterpMs?: number, maxDropRatio?: number }
}

export interface LinearArxTrainerConfig {
  /** 每个 MV 的 AR 阶数 + 输入阶数(按输入显式延迟在 spec.variables.delayMs) */
  arOrder: number
  inputOrder: number
  /** 岭回归正则(0 = 无正则) */
  ridgeLambda: number
  /** 输出归一化(以训练均值/标准差) */
  standardize: boolean
}

export interface StaticResponseTrainerConfig {
  /** 1 = 线性响应面;2 = 含二次项/交互项 */
  order: 1 | 2
  ridgeLambda: number
  standardize: boolean
}

export interface ProcessModelTiming {
  /** 采样节拍 */
  beatMs: number
  /** 历史窗口步数(ARX 阶数 >= arOrder 时用于状态初始化) */
  historySteps: number
  /** 预测时域步数 */
  horizonSteps: number
  /** 首版固定采样周期,不做通用变步长 */
  fixedDt: true
}

export interface ModelInterfaceSpec {
  id: ModelInterfaceId
  version: number
  inputSemantics: InputSemantics
  /** 首版恒为 history[H,F] → y_next[C](一步)或线性状态空间 rollout */
  mode: 'one_step' | 'state_space' | 'static'
}

export interface EffectiveDomain {
  /** 训练数据覆盖的输入区间(运行时越界 → OOD) */
  mv: Record<string, { min: number, max: number, maxStep?: number }>
  cv?: Record<string, { min: number, max: number }>
}

export interface ProcessModelSpec {
  schemaVersion: typeof PROCESS_MODEL_SCHEMA_VERSION
  /** 稳定 id;发布后版本不可原地修改 */
  id: string
  version: number
  lineId: string
  productId: string
  recipeId: string
  recipeVersion: number
  conditions: ConditionSpec[]
  variables: VariableMap[]
  timing: ProcessModelTiming
  trainer: { ref: TrainerRef, config: LinearArxTrainerConfig | StaticResponseTrainerConfig }
  datasetPolicy: DatasetPolicy
  gatePolicyRef: typeof PROCESS_MODEL_GATE_POLICY
  modelInterface: ModelInterfaceSpec
  effectiveDomain: EffectiveDomain
  /** 训练产物落到哪个 AML 数据集的 purpose(legacy 表沿用 mpc_surrogate 等) */
  purpose: 'mpc_surrogate' | 'quality_predict'
  note?: string
  status?: ProcessModelStatus
  createdAt?: string
}

export function artifactKindOfTrainer(ref: TrainerRef): ArtifactKind {
  if (ref === 'linear_arx@1') return 'linear_state_space@1'
  if (ref === 'static_response@1') return 'static_response@1'
  throw new AppError(422, 'UNSUPPORTED_ARTIFACT', `训练器 ${String(ref)} 没有对应工件类型`)
}

export function modelInterfaceOfTrainer(ref: TrainerRef): ModelInterfaceSpec {
  if (ref === 'linear_arx@1') return { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' }
  if (ref === 'static_response@1') return { id: 'static_response', version: 1, inputSemantics: 'setpoint', mode: 'static' }
  throw new AppError(422, 'UNSUPPORTED_MODEL_INTERFACE', `训练器 ${String(ref)} 没有对应模型接口`)
}

/** 该工件类型是否能被某求解器消费(ONNX 黑箱不能直接交给 OSQP)。 */
export function solverSupportsArtifact(solver: SolverRef, kind: ArtifactKind): boolean {
  if (solver === 'osqp_mpc@1') return kind === 'linear_state_space@1'
  if (solver === 'scipy_slsqp@1') return kind === 'static_response@1' || kind === 'linear_state_space@1'
  return false
}

export function assertSolverSupportsArtifact(solver: SolverRef, kind: ArtifactKind, detail?: string): void {
  if (!solverSupportsArtifact(solver, kind)) {
    throw new AppError(422, 'UNSUPPORTED_MODEL_SOLVER', `求解器 ${solver} 不能消费工件 ${kind}${detail ? `(${detail})` : ''}`)
  }
}

// ===== 资格 =====

export interface EligibilityGap {
  code: string
  message: string
  detail?: Record<string, unknown>
}

export interface EligibilityReport {
  predictionEligible: boolean
  optimizationEligible: boolean
  scope: 'simulation' | 'real'
  conditionId: string
  evidenceVersion: string
  gaps: EligibilityGap[]
  metrics: Record<string, number | string | boolean | null>
  createdAt: string
}

export type EvidenceSource = 'simulation' | 'real' | 'unassessed'

// ===== 数据集 manifest v2 =====

export interface ManifestV2 {
  version: 2
  dataKind: 'dynamic' | 'static'
  specHash: string
  contentHash: string
  conditionId: string
  variables: VariableMap[]
  timing: ProcessModelTiming
  shapes: {
    x: [number, number, number]
    u: [number, number, number]
    y: [number, number, number]
  }
  norm: Record<string, { mean: number[], std: number[] }>
  artifacts: {
    x: string
    u: string
    y: string
    timestamps: string
    mask: string
    sidecar: string
  }
  provenance: {
    lineId: string
    productId: string
    recipeId: string
    recipeVersion: number
    runIds: string[]
    recipeContentHash: string
    evidenceSource: EvidenceSource
    availabilityWatermark: number | null
    capturedAt: string
  }
  trainerRef: TrainerRef
  createdAt: string
}

/** 数据/模型工件内容摘要:排除生成时间/任务 id 等易变封套(同输入必须同摘要)。 */
export function contentPayloadForHash<T extends Record<string, unknown>>(value: T): Omit<T, 'createdAt' | 'jobId' | 'runId'> {
  const { createdAt: _createdAt, jobId: _jobId, runId: _runId, ...stable } = value
  return stable as Omit<T, 'createdAt' | 'jobId' | 'runId'>
}
