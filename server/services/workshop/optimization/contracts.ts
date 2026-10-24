/**
 * Optimizer Manager —— 类型化契约(单一事实来源)。
 *
 * 边界(plan §4 / G1.2):
 *  - Profile 冻结"模型精确版本 + 问题模板 + 求解器版本",发布后不可原地修改;
 *  - ProblemIR 是 Solver / Twin / baseline 共用的**同一问题定义**,三者必须在其上重算代价;
 *  - 候选/建议是运行时产物,不进入配置;建议永不等于设备执行授权。
 */
import { canonicalJson, sha256 } from '../aml/twin/contracts'
import type { ArtifactKind, ModelInterfaceId, ProblemTemplateRef, SolverRef } from '../process-model/contracts'
import { assertSolverSupportsArtifact } from '../process-model/contracts'
import { AppError } from '../../../utils/errors'

export const OPTIMIZATION_SCHEMA_VERSION = 1 as const
export const PROBLEM_IR_VERSION = 1 as const

// ===== Profile =====

export type ProfileStatus = 'draft' | 'validated' | 'published' | 'retired'

export interface ModelRef {
  modelId: string
  artifactKind: ArtifactKind
  artifactHash: string
  modelInterface: ModelInterfaceId
  /** 模型发布阶段(candidate 可求解但建议不可信;production 才作为推荐依据) */
  stage: 'candidate' | 'shadow' | 'production' | 'retired'
}

export interface LinearMpcConfig {
  /** 相对设定值的跟踪权重(CV) */
  cvWeights: Record<string, number>
  /** 输入移动惩罚 Δu */
  duWeights: Record<string, number>
  /** 终端代价权重(相对 cvWeights 的倍数) */
  terminalWeight: number
  /** CV 设定值(工程/模型单位,按 spec.variables 的 modelUnit) */
  targets: Record<string, number>
  /** 软约束惩罚(硬约束之外的越界惩罚) */
  slackPenalty?: number
}

export interface SteadyResponseConfig {
  /** 经济代价目标:对 MV 的线性权重(可为负 = 越大越好) */
  economicWeights: Record<string, number>
  /** CV 目标跟踪权重 */
  cvWeights: Record<string, number>
  /** CV 目标值 */
  targets: Record<string, number>
}

export interface ProblemConfig {
  linear_mpc_quadratic?: LinearMpcConfig
  steady_response?: SteadyResponseConfig
}

export interface OptimizationProfile {
  schemaVersion: typeof OPTIMIZATION_SCHEMA_VERSION
  id: string
  version: number
  name?: string
  modelRef: ModelRef
  problemTemplateRef: ProblemTemplateRef
  problemConfig: ProblemConfig
  solverRef: SolverRef
  solverVersion: string
  /** ProcessModelSpec 精确版本("id@version");运行期据此装配变量/延迟/有效域 */
  processSpecRef: string
  /** 允许的工况 id(空 = 该模型所有工况) */
  conditionIds: string[]
  status: ProfileStatus
  ownerUserId?: string
  /** 发布时冻结的问题结构 hash */
  problemIrHash?: string
  createdAt?: string
}

export function assertProfileSolverCompatible(profile: Pick<OptimizationProfile, 'solverRef' | 'modelRef' | 'problemTemplateRef'>): void {
  assertSolverSupportsArtifact(profile.solverRef, profile.modelRef.artifactKind, `profile model=${profile.modelRef.modelId}`)
  if (profile.solverRef === 'osqp_mpc@1' && profile.problemTemplateRef !== 'linear_mpc_quadratic@1') {
    throw new AppError(422, 'PROFILE_INCOMPATIBLE', 'osqp_mpc@1 只能使用 linear_mpc_quadratic@1 模板')
  }
  if (profile.solverRef === 'scipy_slsqp@1' && profile.problemTemplateRef !== 'steady_response@1') {
    // D21 solverRef×template 分派矩阵:worker 按模板分派,线性模板固定走 OSQP;
    // scipy+linear 会在运行时静默误派 → 发布期显式拒绝(SW6/MP-A8)
    throw new AppError(422, 'SOLVER_TEMPLATE_UNSUPPORTED', 'scipy_slsqp@1 只能使用 steady_response@1 模板(线性模板由 osqp_mpc@1 求解)')
  }
}

// ===== Binding =====

export type BindingMode = 'shadow' | 'recommendation'

export interface OptimizerBinding {
  id: string
  workspaceId: string
  channelId: string
  /** channel_agents.id(实例身份;绝不接受 agents.id 模板 id) */
  channelAgentId: string
  profileVersion: string
  capabilities: string[]
  mode: BindingMode
  validFrom: string
  validTo?: string | null
  revision: number
  createdAt: string
}

export const OPTIMIZER_CAPABILITIES = ['solve', 'status', 'cancel', 'plan_get', 'capabilities'] as const
export type OptimizerCapability = (typeof OPTIMIZER_CAPABILITIES)[number]

// ===== ProblemIR =====

export interface ProblemScaling {
  /** 变量名 → 缩放(模型单位 → 规划单位) */
  mv: Record<string, { scale: number, offset: number }>
  cv: Record<string, { scale: number, offset: number }>
}

export interface LinearDynamics {
  /** 状态数 */
  stateDim: number
  /** A 行主序 [stateDim x stateDim] */
  A: number[]
  /** B 行主序 [stateDim x (mvCount)] —— 已含延迟扩充状态时的输入矩阵 */
  B: number[]
  /** C 行主序 [cvCount x stateDim] */
  C: number[]
  /** D 行主序 [cvCount x mvCount] */
  D: number[]
  /** 每 MV 的输入延迟(步);调度器/模型已按此索引,ProblemIR 只记录不重复施加 */
  delays: Record<string, number>
  /** 初始状态(历史寄存器展开) */
  x0: number[]
  /** 状态偏置(x' = A x + B u + bias);缺省全 0 */
  bias?: number[]
}

export interface ProblemBounds {
  min?: number
  max?: number
  /** 相对上一时刻的最大变化率(≤) */
  maxStep?: number
}

export interface LinearMpcProblem {
  template: 'linear_mpc_quadratic@1'
  dynamics: LinearDynamics
  /** CV 设定值(模型单位) */
  cvSetpoints: number[]
  /** CV 的软约束/有效域 */
  cvBounds: ProblemBounds[]
  /** MV 变量名顺序(= dynamics 输入顺序) */
  mvOrder: string[]
  cvOrder: string[]
  mvBounds: ProblemBounds[]
  /** 上一时刻已生效输入(Δu 基准,模型单位) */
  uPrev: number[]
}

export interface StaticResponseProblem {
  template: 'steady_response@1'
  mvOrder: string[]
  cvOrder: string[]
  /** 响应面系数:cv → [1, mv..., mv_i*mv_j...](与特征展开顺序一致) */
  coefficients: Record<string, number[]>
  featureOrder: string[]
  cvTargets: number[]
  mvBounds: ProblemBounds[]
  cvBounds: ProblemBounds[]
  uPrev: number[]
}

export interface ProblemIRBase {
  irVersion: typeof PROBLEM_IR_VERSION
  profileRef: string
  modelRef: ModelRef
  solverRef: SolverRef
  conditions: { conditionId: string, lineId: string, productId: string, recipeId: string, recipeVersion: number }
  horizon: number
  beatMs: number
  scaling: ProblemScaling
  weights: {
    cv: Record<string, number>
    du: Record<string, number>
    terminal: number
    economic?: Record<string, number>
    slack?: number
  }
  context: {
    capturedAt: string
    /** 事件时间上界(本次求解允许使用的历史末点) */
    eventAsOf: number
    /** 平台入库水位(= max(ingested_at));null = unknown,不能作严格在线回放 */
    availabilityWatermark: number | null
    evidenceSource: 'simulation' | 'real' | 'unassessed'
  }
  /** 稳定 hash(不含 context.capturedAt,避免同问题每次求解变更身份) */
  hash: string
}

export type ProblemIR = (ProblemIRBase & { problem: LinearMpcProblem | StaticResponseProblem })

/**
 * 计算 ProblemIR **结构** hash:固定变量序/时间索引/缩放/目标与约束语义。
 * 排除运行期实例量(capturedAt/eventAsOf/watermark/x0/uPrev)——否则同一 Profile
 * 每次求解都会得到不同 hash,发布时冻结的 hash 永远失配。
 */
export function computeProblemIrHash(ir: Omit<ProblemIR, 'hash'> | ProblemIR): string {
  const { hash: _hash, context: _context, ...rest } = ir as ProblemIR
  const problem = rest.problem
  const structuralProblem = problem.template === 'linear_mpc_quadratic@1'
    ? { ...problem, dynamics: { ...problem.dynamics, x0: [] }, uPrev: [] }
    : { ...problem, uPrev: [] }
  return sha256(canonicalJson({ ...rest, problem: structuralProblem }))
}

// ===== 求解结果 =====

export const SOLVE_STATUSES = [
  'optimal',
  'feasible',
  'infeasible',
  'unbounded',
  'timeout',
  'cancelled',
  'numerical_error',
  'unsupported',
] as const

export type SolveStatus = (typeof SOLVE_STATUSES)[number]

export interface ConstraintReport {
  id: string
  kind: 'bound' | 'rate' | 'dynamic' | 'domain'
  satisfied: boolean
  residual: number
  tolerance: number
}

export interface SolveCandidate {
  seq: number
  /** MV 轨迹 [[t][mv]] (模型单位 → 已按 scaling 还原为工程单位) */
  controls: number[][]
  /** CV 预测轨迹 [[t][cv]] */
  predicted: number[][]
  /** 全时域代价(ProblemIR 定义) */
  cost: number
  constraints: ConstraintReport[]
  feasible: boolean
}

export interface SolveResult {
  runId: string
  status: SolveStatus
  candidates: SolveCandidate[]
  /** 首步建议(MPC 只应用首步) */
  firstMove: Record<string, number> | null
  /** 独立复算的代价(Solver 自报之外) */
  independentCost: number | null
  diagnostics: {
    backend: string
    solverVersion: string
    iterations?: number
    elapsedMs: number
    problemIrHash: string
    message?: string
    workerPid?: number
  }
  createdAt: string
}

export type RecommendationStatus = 'verified' | 'unverified' | 'expired'

export interface Recommendation {
  id: string
  runId: string
  candidateId: string
  problemIrHash: string
  modelArtifactHash: string
  evidenceSource: 'simulation' | 'real' | 'unassessed'
  uqEvidence: Record<string, unknown> | null
  status: RecommendationStatus
  /** 人读状态;未验证时后端/前端都必须原样展示 */
  statusLabel: string
  validUntil: string
  createdAt: string
}

export function recommendationLabel(status: RecommendationStatus): string {
  if (status === 'verified') return '已验证推荐'
  if (status === 'unverified') return '未验证(缺 UQ/OOD 证据)'
  return '已失效'
}

// ===== Solve options / worker protocol =====

export interface SolveOptions {
  /** 固定问题步长的兼容字段;Manager 只接受与发布配置一致的值,Worker 使用 ProblemIR.horizon。 */
  horizon?: number
  /** 应用的 binding revision(逐次重校验) */
  bindingRevision?: number
  timeoutMs?: number
  requestId?: string
}

export interface SolverRequestFrame {
  /** SW6/D21:1|2(v2 增 payload.solverRef 按 ref 分派;worker 兼容 v1,feature flag 关闭时 Manager 发 v1) */
  protocolVersion: 1 | 2
  reqId: string
  op: 'solve' | 'cancel' | 'ping'
  payload?: unknown
  deadlineMs?: number
}

export interface SolverResponseFrame {
  protocolVersion: 1 | 2
  reqId: string
  ok: boolean
  result?: unknown
  error?: { code: string, message: string, detail?: Record<string, unknown> }
  diag?: Record<string, unknown>
}

export interface SolverEventFrame {
  protocolVersion: 1 | 2
  type: 'ready' | 'heartbeat' | 'log'
  detail?: Record<string, unknown>
  /** worker ready 帧携带的进程诊断(pid/python 版本);与 detail 并存以兼容两代帧形状 */
  diag?: Record<string, unknown>
  message?: string
}

/**
 * 绑定解析错误码。工具面/dispatch/verify 三处共用同一套码,
 * 保证"未绑定/绑定歧义/越权/过期"在回执里可区分(不是笼统 403)。
 */
export const BINDING_ERRORS = {
  NOT_FOUND: 'BINDING_NOT_FOUND',
  AMBIGUOUS: 'BINDING_AMBIGUOUS',
  NOT_OWNED: 'BINDING_NOT_OWNED',
  STALE: 'BINDING_STALE',
  TEMPLATE_ID: 'AGENT_TEMPLATE_ID_NOT_ALLOWED',
  CHANNEL_MISMATCH: 'BINDING_CHANNEL_MISMATCH',
  WORKSPACE_MISMATCH: 'BINDING_WORKSPACE_MISMATCH',
} as const
