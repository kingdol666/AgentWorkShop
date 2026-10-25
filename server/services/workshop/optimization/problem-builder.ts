/**
 * ProblemIR 编译(G3.4 / plan §4.1):
 *   ContextSnapshot + 模型工件 + OptimizationProfile → 同一问题定义(带稳定 hash)。
 *
 * 编译期检查(不可 eval 用户公式):
 *  - 工件类型与求解器兼容(ONNX 黑箱不能交给 OSQP);
 *  - 维度/变量序/权重非负/边界一致;
 *  - MV 有效域与 maxStep 必须来自 spec(不允许"看起来合理"的缺省)。
 */
import { AppError } from '../../../utils/errors'
import type { ContextSnapshot } from '../process-model/context'
import type { ProcessModelSpec } from '../process-model/contracts'
import { assertSolverSupportsArtifact } from '../process-model/contracts'
import type { OptimizationProfile, ProblemBounds, ProblemIR, ProblemScaling, SolveCandidate } from './contracts'
import { computeProblemIrHash } from './contracts'

export interface LinearStateSpaceLike {
  kind: 'linear_state_space@1'
  stateDim: number
  arOrder: number
  inputOrder: number
  mvOrder: string[]
  cvOrder: string[]
  delaysSteps: Record<string, number>
  K: number
  A: number[][]
  B: number[][]
  C: number[][]
  D: number[][]
  bias: number[]
  layout: { yOffset: number, uOffset: number, stateDim: number, K: number }
}

export interface StaticResponseLike {
  kind: 'static_response@1'
  mvOrder: string[]
  cvOrder: string[]
  featureOrder: string[]
  coefficients: Record<string, number[]>
  order: 1 | 2
}

export type ModelArtifact = LinearStateSpaceLike | StaticResponseLike

function boundsFor(spec: ProcessModelSpec, variableId: string): ProblemBounds {
  const domain = spec.effectiveDomain.mv[variableId]
  if (!domain) throw new AppError(422, 'PROBLEM_DOMAIN_MISSING', `MV ${variableId} 缺少有效域;拒绝编译问题`)
  return { min: domain.min, max: domain.max, maxStep: domain.maxStep }
}

function scalingOf(spec: ProcessModelSpec): ProblemScaling {
  const mv: ProblemScaling['mv'] = {}
  const cv: ProblemScaling['cv'] = {}
  for (const variable of spec.variables) {
    const entry = { scale: variable.scale, offset: variable.offset }
    if (variable.role === 'mv') mv[variable.id] = entry
    if (variable.role === 'cv') cv[variable.id] = entry
  }
  return { mv, cv }
}

export function buildProblemIR(input: {
  profile: OptimizationProfile
  spec: ProcessModelSpec
  artifact: ModelArtifact
  context: ContextSnapshot
  runId: string
}): ProblemIR {
  const { profile, spec, artifact, context } = input
  assertSolverSupportsArtifact(profile.solverRef, profile.modelRef.artifactKind)
  const conditionId = context.conditionId || spec.conditions[0]?.id || ''
  const base = {
    irVersion: 1 as const,
    profileRef: `${profile.id}@${profile.version}`,
    modelRef: profile.modelRef,
    solverRef: profile.solverRef,
    conditions: {
      conditionId, lineId: spec.lineId, productId: spec.productId, recipeId: spec.recipeId,
      recipeVersion: spec.recipeVersion,
    },
    horizon: spec.timing.horizonSteps,
    beatMs: spec.timing.beatMs,
    scaling: scalingOf(spec),
    context: {
      capturedAt: context.capturedAt,
      eventAsOf: context.eventAsOf,
      availabilityWatermark: context.availabilityWatermark,
      evidenceSource: context.evidenceSource,
    },
  }

  if (profile.problemTemplateRef === 'linear_mpc_quadratic@1') {
    if (artifact.kind !== 'linear_state_space@1') {
      throw new AppError(422, 'PROBLEM_MODEL_MISMATCH', `linear_mpc_quadratic 需要 linear_state_space 工件,收到 ${artifact.kind}`)
    }
    const cfg = profile.problemConfig.linear_mpc_quadratic
    if (!cfg) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', '缺少 linear_mpc_quadratic 配置')
    const mvOrder = artifact.mvOrder
    const cvOrder = artifact.cvOrder
    for (const id of mvOrder) if (!(id in cfg.duWeights)) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', `duWeights 缺少 ${id}`)
    for (const id of cvOrder) if (!(id in cfg.cvWeights)) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', `cvWeights 缺少 ${id}`)
    if (artifact.stateDim !== artifact.A.length || artifact.A.some(row => row.length !== artifact.stateDim)) {
      throw new AppError(422, 'PROBLEM_DIMENSION_MISMATCH', '状态矩阵维度不一致')
    }
    if (artifact.B.length !== artifact.stateDim || artifact.B.some(row => row.length !== mvOrder.length)) {
      throw new AppError(422, 'PROBLEM_DIMENSION_MISMATCH', '输入矩阵维度不一致')
    }
    if (artifact.C.length !== cvOrder.length || artifact.C.some(row => row.length !== artifact.stateDim)) {
      throw new AppError(422, 'PROBLEM_DIMENSION_MISMATCH', '观测矩阵维度不一致')
    }
    const x0 = new Array<number>(artifact.stateDim).fill(0)
    const { yOffset, uOffset, K } = artifact.layout
    for (let j = 0; j < cvOrder.length; j++) {
      const value = context.currentOutputs[cvOrder[j]!]
      if (value === undefined) throw new AppError(422, 'PROBLEM_CONTEXT_MISSING', `上下文缺少 CV ${cvOrder[j]} 的当前观测`)
      for (let i = 0; i < artifact.arOrder; i++) {
        // 历史寄存器:history[H-1-i][cv]
        const variableIndex = spec.variables.findIndex(v => v.id === cvOrder[j])
        x0[yOffset + j * artifact.arOrder + i] = context.history.at(-1 - i)?.[variableIndex] ?? value
      }
    }
    for (let m = 0; m < mvOrder.length; m++) {
      const variableIndex = spec.variables.findIndex(v => v.id === mvOrder[m])
      for (let q = 0; q < K; q++) x0[uOffset + m * K + q] = context.history.at(-1 - q)?.[variableIndex] ?? 0
    }
    const cvSetpoints = cvOrder.map((id) => {
      const target = cfg.targets[id]
      if (target == null || !Number.isFinite(target)) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', `targets 缺少 ${id}(CV 设定值必填)`)
      return target
    })
    const cvBounds = cvOrder.map((id) => {
      const domain = spec.effectiveDomain.cv?.[id]
      return domain ? { min: domain.min, max: domain.max } : {}
    })
    const uPrev = mvOrder.map((id) => {
      const value = context.currentInputs[id]
      if (value === undefined) throw new AppError(422, 'PROBLEM_CONTEXT_MISSING', `上下文缺少 MV ${id} 的当前值`)
      return value
    })
    const cvWeights = Object.fromEntries(cvOrder.map(id => [id, cfg.cvWeights[id]!]))
    const duWeights = Object.fromEntries(mvOrder.map(id => [id, cfg.duWeights[id]!]))
    const ir: Omit<ProblemIR, 'hash'> = {
      ...base,
      weights: {
        cv: cvWeights, du: duWeights, terminal: cfg.terminalWeight, economic: undefined, slack: cfg.slackPenalty,
      },
      problem: {
        template: 'linear_mpc_quadratic@1',
        dynamics: {
          stateDim: artifact.stateDim,
          A: artifact.A.flat(),
          B: artifact.B.flat(),
          C: artifact.C.flat(),
          D: artifact.D.flat(),
          bias: artifact.bias,
          delays: artifact.delaysSteps,
          x0,
        },
        cvSetpoints,
        cvBounds,
        mvOrder,
        cvOrder,
        mvBounds: mvOrder.map(id => boundsFor(spec, id)),
        uPrev,
      },
    }
    return { ...ir, hash: computeProblemIrHash(ir) }
  }

  if (profile.problemTemplateRef === 'steady_response@1') {
    if (artifact.kind !== 'static_response@1') {
      throw new AppError(422, 'PROBLEM_MODEL_MISMATCH', `steady_response 需要 static_response 工件,收到 ${artifact.kind}`)
    }
    const cfg = profile.problemConfig.steady_response
    if (!cfg) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', '缺少 steady_response 配置')
    const mvOrder = artifact.mvOrder
    const cvOrder = artifact.cvOrder
    for (const id of cvOrder) {
      if (!artifact.coefficients[id]) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', `工件缺少 CV ${id} 的响应面系数`)
      if (cfg.cvWeights[id] == null && cfg.economicWeights[id] == null) {
        // 经济权重按 MV 给;CV 至少要有目标或权重
        if (cfg.targets[id] == null) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', `CV ${id} 缺少 targets/cvWeights`)
      }
    }
    const cvTargets = cvOrder.map(id => Number(cfg.targets[id] ?? 0))
    const uPrev = mvOrder.map((id) => {
      const value = context.currentInputs[id]
      if (value === undefined) throw new AppError(422, 'PROBLEM_CONTEXT_MISSING', `上下文缺少 MV ${id} 的当前值`)
      return value
    })
    const ir: Omit<ProblemIR, 'hash'> = {
      ...base,
      weights: { cv: { ...cfg.cvWeights }, du: {}, terminal: 0, economic: { ...cfg.economicWeights } },
      problem: {
        template: 'steady_response@1',
        mvOrder,
        cvOrder,
        coefficients: artifact.coefficients,
        featureOrder: artifact.featureOrder,
        cvTargets,
        mvBounds: mvOrder.map(id => boundsFor(spec, id)),
        cvBounds: cvOrder.map((id) => {
          const domain = spec.effectiveDomain.cv?.[id]
          return domain ? { min: domain.min, max: domain.max } : {}
        }),
        uPrev,
      },
    }
    return { ...ir, hash: computeProblemIrHash(ir) }
  }

  throw new AppError(422, 'UNSUPPORTED_PROBLEM_TEMPLATE', `不支持的问题模板 ${profile.problemTemplateRef}`)
}

/**
 * 独立代价重算(Solver/Twin/baseline 同口径):A4 要求三者相对差 ≤1e-6。
 * 线性 MPC:全时域跟踪误差 + Δu + 终端 + 软约束;静态:经济代价 + CV 跟踪。
 */
export function evaluateCandidateCost(ir: ProblemIR, candidate: SolveCandidate): number {
  const controls = candidate.controls
  if (ir.problem.template === 'linear_mpc_quadratic@1') {
    const p = ir.problem
    const cvWeights = p.cvOrder.map(id => ir.weights.cv[id] ?? 1)
    const duWeights = p.mvOrder.map(id => ir.weights.du[id] ?? 0)
    let cost = 0
    const predicted = simulateLinear(p.dynamics, p.mvOrder.length, p.cvOrder.length, p.uPrev, controls)
    for (let t = 0; t < predicted.length; t++) {
      for (let j = 0; j < p.cvOrder.length; j++) cost += cvWeights[j]! * (predicted[t]![j]! - p.cvSetpoints[j]!) ** 2
    }
    // 终端代价
    const last = predicted[predicted.length - 1]
    if (last) for (let j = 0; j < p.cvOrder.length; j++) cost += ir.weights.terminal * cvWeights[j]! * (last[j]! - p.cvSetpoints[j]!) ** 2
    for (let t = 0; t < controls.length; t++) {
      const prev = t === 0 ? p.uPrev : controls[t - 1]!
      for (let m = 0; m < p.mvOrder.length; m++) cost += duWeights[m]! * (controls[t]![m]! - prev[m]!) ** 2
    }
    return cost
  }
  const p = ir.problem
  const u = controls[0] ?? []
  let cost = 0
  for (const [id, weight] of Object.entries(ir.weights.economic ?? {})) {
    const m = p.mvOrder.indexOf(id)
    if (m >= 0 && u[m] != null) cost += weight * u[m]!
  }
  for (let j = 0; j < p.cvOrder.length; j++) {
    const y = evaluateStatic(p.coefficients[p.cvOrder[j]!]!, p.featureOrder, p.mvOrder, u)
    cost += (ir.weights.cv[p.cvOrder[j]!] ?? 0) * (y - (p.cvTargets[j] ?? 0)) ** 2
  }
  return cost
}

export function evaluateStatic(coefficients: number[], featureOrder: string[], mvOrder: string[], u: number[]): number {
  let sum = 0
  const byName = new Map<string, number>()
  mvOrder.forEach((id, i) => byName.set(id, u[i] ?? 0))
  for (let k = 0; k < featureOrder.length; k++) {
    const name = featureOrder[k]!
    let value: number
    if (name === 'bias') value = 1
    else if (name.endsWith('^2')) {
      const id = name.slice(0, -2)
      value = (byName.get(id) ?? 0) ** 2
    }
    else if (name.includes('*')) {
      const [a, b] = name.split('*')
      value = (byName.get(a!) ?? 0) * (byName.get(b!) ?? 0)
    }
    else value = byName.get(name) ?? 0
    sum += (coefficients[k] ?? 0) * value
  }
  return sum
}

/** 线性状态空间 rollout(与 Solver/Python 相同的离散语义)。 */
export function constraintReport(ir: ProblemIR, candidate: SolveCandidate): import('./contracts').ConstraintReport[] {
  const reports: import('./contracts').ConstraintReport[] = []
  if (ir.problem.template !== 'linear_mpc_quadratic@1') {
    const p = ir.problem
    for (let m = 0; m < p.mvOrder.length; m++) {
      const value = candidate.controls[0]?.[m] ?? 0
      const b = p.mvBounds[m] ?? {}
      reports.push({ id: `mv.${p.mvOrder[m]}.bound`, kind: 'bound', satisfied: (b.min == null || value >= b.min - 1e-9) && (b.max == null || value <= b.max + 1e-9), residual: Math.max(0, (b.min ?? value) - value, value - (b.max ?? value)), tolerance: 1e-6 })
      if (b.maxStep != null) {
        const delta = Math.abs(value - p.uPrev[m]!)
        reports.push({ id: `mv.${p.mvOrder[m]}.rate`, kind: 'rate', satisfied: delta <= b.maxStep + 1e-9, residual: Math.max(0, delta - b.maxStep), tolerance: 1e-6 })
      }
    }
    // 静态路径:独立复核 CV 有效域(此前只查 MV)
    for (let j = 0; j < p.cvOrder.length; j++) {
      const y = candidate.predicted[0]?.[j] ?? Number.NaN
      const b = p.cvBounds[j] ?? {}
      const lo = b.min ?? Number.NEGATIVE_INFINITY
      const hi = b.max ?? Number.POSITIVE_INFINITY
      reports.push({ id: `cv.${p.cvOrder[j]}.bound`, kind: 'domain', satisfied: Number.isFinite(y) && y >= lo - 1e-9 && y <= hi + 1e-9, residual: Math.max(0, lo - y, y - hi), tolerance: 1e-6 })
    }
    return reports
  }
  const p = ir.problem
  const mvCount = p.mvOrder.length
  for (let t = 0; t < candidate.controls.length; t++) {
    for (let m = 0; m < mvCount; m++) {
      const value = candidate.controls[t]?.[m] ?? 0
      const b = p.mvBounds[m] ?? {}
      const lo = b.min ?? Number.NEGATIVE_INFINITY
      const hi = b.max ?? Number.POSITIVE_INFINITY
      reports.push({
        id: `mv.${p.mvOrder[m]}.t${t}.bound`, kind: 'bound',
        satisfied: value >= lo - 1e-9 && value <= hi + 1e-9,
        residual: Math.max(0, lo - value, value - hi), tolerance: 1e-6,
      })
      if (b.maxStep != null) {
        const prev = t === 0 ? p.uPrev[m] ?? value : candidate.controls[t - 1]?.[m] ?? value
        const delta = Math.abs(value - prev)
        reports.push({ id: `mv.${p.mvOrder[m]}.t${t}.rate`, kind: 'rate', satisfied: delta <= b.maxStep + 1e-9, residual: Math.max(0, delta - b.maxStep), tolerance: 1e-6 })
      }
    }
  }
  // 动态一致性:重算预测轨迹与 Solver 返回预测逐点对齐
  const simulated = simulateLinear(p.dynamics, mvCount, p.cvOrder.length, p.uPrev, candidate.controls)
  let maxDiff = 0
  for (let t = 0; t < simulated.length; t++) {
    for (let j = 0; j < p.cvOrder.length; j++) {
      maxDiff = Math.max(maxDiff, Math.abs((simulated[t]?.[j] ?? 0) - (candidate.predicted[t]?.[j] ?? 0)))
    }
  }
  reports.push({ id: 'dynamics.rollout', kind: 'dynamic', satisfied: maxDiff <= 1e-6, residual: maxDiff, tolerance: 1e-6 })
  return reports
}

export function simulateLinear(
  dynamics: { A: number[], B: number[], C: number[], D: number[], stateDim: number, x0: number[], bias?: number[] },
  mvCount: number,
  cvCount: number,
  uPrev: number[],
  controls: number[][],
): number[][] {
  const n = dynamics.stateDim
  let x = [...dynamics.x0]
  const out: number[][] = []
  for (let t = 0; t < controls.length; t++) {
    const u = controls[t] ?? uPrev
    const next = new Array<number>(n).fill(0)
    for (let r = 0; r < n; r++) {
      let v = dynamics.bias?.[r] ?? 0
      for (let c = 0; c < n; c++) v += (dynamics.A[r * n + c] ?? 0) * (x[c] ?? 0)
      for (let m = 0; m < mvCount; m++) v += (dynamics.B[r * mvCount + m] ?? 0) * (u[m] ?? 0)
      next[r] = v
    }
    x = next
    const y = new Array<number>(cvCount).fill(0)
    for (let j = 0; j < cvCount; j++) {
      for (let c = 0; c < n; c++) y[j] = (y[j] ?? 0) + (dynamics.C[j * n + c] ?? 0) * (x[c] ?? 0)
      for (let m = 0; m < mvCount; m++) y[j] = (y[j] ?? 0) + (dynamics.D[j * mvCount + m] ?? 0) * (u[m] ?? 0)
    }
    out.push(y)
  }
  return out
}
