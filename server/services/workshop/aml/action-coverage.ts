/**
 * 动作覆盖度(action coverage;科学探索计划 P3,docs/plans/2026-11-02-scientific-exploration-plan.md):
 * 回答"这份数据在动作维度上到底有没有信息量"——预测精度高不代表动作维度被学到。
 *
 * 交给 G6 门的四个量:
 *  - distinctLevels:控制量历史水平数(容差聚类)。<3 时无法区分线性/二次,也做不了正交阶梯;
 *  - collinearityWithTime:|pearson(control, 时间序号)|。≈1 表示"档位"与"时间推进"是同一件事,
 *    任何在该数据上学到的"效应"都可能只是漂移(事故形态:SP 降档 == 作业后半段);
 *  - stepCount:水平切换次数。1 次单步(AB)只有 2 水平且极易与相位混淆,正交需要阶梯往返;
 *  - saturationRatio:控制量落在观测极值(上/下沿)的样本占比。高值 = 长期贴边运行,
 *    有效激励幅度远小于名义步长。
 * 另附 levelPhaseMatrix(各水平的样本数与归一化时间位置),供人/Agent 直接看出"哪个水平只出现在后半段"。
 *
 * 另有 arxStepResponseGain:从 ARX 状态空间工件做阶跃仿真求稳态增益 ——
 * 让"模型对某个 SP 到底有没有响应"变成一个可核对的数(P5 互审的模型侧通道)。
 */
import { pearson } from './stats'

export interface ActionLevelInfo {
  level: number
  count: number
  /** 该水平样本的平均归一化时间位置(0=最早,1=最晚) */
  meanPhase: number
}

export interface ActionCoverage {
  controlId: string
  distinctLevels: number
  stepCount: number
  /** |pearson(control, 时间序号)|。注意 2 水平的理论上限是 0.866(不是 1),单靠它抓不住"纯阶梯" */
  collinearityWithTime: number
  /** 最长驻留水平的样本占比(≥0.9 → 激励不足提示;不是硬门) */
  saturationRatio: number
  levelPhaseMatrix: ActionLevelInfo[]
  /** 每个水平的连续段数(1 = 该水平只出现在一个连续区间) */
  levelBlocks: number[]
  /** 所有水平都只出现一段 = 纯阶梯/单调斜坡:档位与时间推进不可分(正交需 ≥2 个来回) */
  monolithicSequence: boolean
  samples: number
}

export interface ActionCoverageThresholds {
  minControlLevels: number
  maxCollinearity: number
}

export interface ActionCoverageAssessment {
  pass: boolean
  reasons: string[]
}

/** 容差聚类水平(相对 1e-9 + 绝对 1e-12;与可辨识性引擎同口径) */
function levelsOf(values: number[]): number[] {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b)
  const out: number[] = []
  for (const v of finite) {
    const last = out[out.length - 1]
    const tol = last == null ? Infinity : Math.max(1e-12, Math.abs(v) * 1e-9)
    if (last == null || Math.abs(v - last) > tol) out.push(v)
  }
  return out
}

/**
 * 计算单控制列的覆盖度。values 为该控制量按时间顺序的实测/回显序列
 * (跨 run 拼接时请按 run 分段调用再合并,避免把批次间的复位计成阶跃)。
 */
export function computeActionCoverage(controlId: string, values: number[]): ActionCoverage {
  const finite = values.filter(Number.isFinite)
  const n = finite.length
  if (n === 0) {
    return { controlId, distinctLevels: 0, stepCount: 0, collinearityWithTime: 0, saturationRatio: 0, levelPhaseMatrix: [], levelBlocks: [], monolithicSequence: false, samples: 0 }
  }
  const levels = levelsOf(finite)
  // 水平切换次数(相邻样本跨水平)
  const tolOf = (v: number): number => Math.max(1e-12, Math.abs(v) * 1e-9)
  let stepCount = 0
  for (let i = 1; i < n; i++) {
    if (Math.abs(finite[i]! - finite[i - 1]!) > Math.max(tolOf(finite[i]!), tolOf(finite[i - 1]!))) stepCount++
  }
  // 时间共线(线性趋势)
  const idx = finite.map((_, i) => i)
  const collinearityWithTime = Math.abs(pearson(finite, idx))
  // 最长驻留水平占比(激励不足的代理指标:控制量绝大部分时间停在同一档 = 有效激励样本很少)
  const levelCounts = new Map<number, number>()
  for (const v of finite) {
    const level = levels.reduce((best, cand) => (Math.abs(v - cand) < Math.abs(v - best) ? cand : best), levels[0]!)
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1)
  }
  const saturationRatio = Math.max(...levelCounts.values()) / n
  // 水平 × 相位
  const levelPhaseMatrix: ActionLevelInfo[] = levels.map((level) => {
    let count = 0
    let phaseSum = 0
    for (let i = 0; i < n; i++) {
      if (Math.abs(finite[i]! - level) <= Math.max(tolOf(level), tolOf(finite[i]!))) {
        count++
        phaseSum += n > 1 ? i / (n - 1) : 0
      }
    }
    return { level, count, meanPhase: count ? phaseSum / count : 0 }
  })
  // 水平 → 连续段数(段数=该水平出现后被别的水平打断的次数+1)。纯阶梯每档只有 1 段。
  const levelIndex = finite.map(v => levels.findIndex(level => Math.abs(v - level) <= Math.max(tolOf(level), tolOf(v))))
  const levelBlocks = levels.map((_, li) => {
    let blocks = 0
    let prevWasLevel = false
    for (const cur of levelIndex) {
      const isLevel = cur === li
      if (isLevel && !prevWasLevel) blocks++
      prevWasLevel = isLevel
    }
    return blocks
  })
  const monolithicSequence = levels.length >= 2 && levelBlocks.every(b => b === 1)
  return { controlId, distinctLevels: levels.length, stepCount, collinearityWithTime, saturationRatio, levelPhaseMatrix, levelBlocks, monolithicSequence, samples: n }
}

/** G6 判定(阈值来自 amlSettings().gates) */
export function assessActionCoverage(coverage: ActionCoverage, thresholds: ActionCoverageThresholds): ActionCoverageAssessment {
  const reasons: string[] = []
  if (coverage.samples === 0) {
    reasons.push(`${coverage.controlId}: 无有效样本`)
    return { pass: false, reasons }
  }
  let pass = true
  if (coverage.distinctLevels < thresholds.minControlLevels) {
    pass = false
    reasons.push(`${coverage.controlId}: 仅 ${coverage.distinctLevels} 个水平(<${thresholds.minControlLevels});动作维度不足以识别,建议 ≥3 水平阶梯往返`)
  }
  if (coverage.collinearityWithTime > thresholds.maxCollinearity) {
    pass = false
    reasons.push(`${coverage.controlId}: 与时间序号 |r|=${coverage.collinearityWithTime.toFixed(3)}(>${thresholds.maxCollinearity});档位与时间推进共线,效应不可归因`)
  }
  if (coverage.stepCount === 0 && coverage.distinctLevels > 1) {
    // 水平数>1 但无切换 = 拼接边界伪水平;不是正交激励
    pass = false
    reasons.push(`${coverage.controlId}: 无水平切换(疑似跨批次拼接);不构成阶梯激励`)
  }
  if (coverage.monolithicSequence) {
    // 纯阶梯(每档只出现一段)无论档数多少都与时间推进不可分:
    // 2 水平的 |r| 理论上限仅 0.866,直线阈值抓不住,必须用连续段判据
    pass = false
    reasons.push(`${coverage.controlId}: ${coverage.distinctLevels} 个水平各仅单一连续段(纯阶梯),档位与时间推进不可分;正交设计需 ≥2 个来回阶梯(ABAB/A→B→A)`)
  }
  if (coverage.saturationRatio >= 0.9) {
    reasons.push(`${coverage.controlId}: ${(coverage.saturationRatio * 100).toFixed(0)}% 样本停在单一档位(激励不足),有效激励幅度可能远小于名义步长`)
  }
  return { pass, reasons }
}

/** 数据集级汇总(任一控制列不过 → 整体不过;无控制列 → 不适用,pass=true 且 detail 说明) */
export function assessDatasetActionCoverage(
  coverage: ActionCoverage[],
  thresholds: ActionCoverageThresholds,
): { pass: boolean, applicable: boolean, reasons: string[], per: Array<{ coverage: ActionCoverage, assessment: ActionCoverageAssessment }> } {
  if (coverage.length === 0) {
    return { pass: true, applicable: false, reasons: ['数据集未声明 role=control 节点,动作覆盖门不适用'], per: [] }
  }
  const per = coverage.map(c => ({ coverage: c, assessment: assessActionCoverage(c, thresholds) }))
  return {
    pass: per.every(p => p.assessment.pass),
    applicable: true,
    reasons: per.flatMap(p => p.assessment.reasons),
    per,
  }
}

// ---------- ARX 动作敏感度(阶跃仿真稳态增益) ----------

export interface ArxArtifactLike {
  A: number[][]
  B: number[][]
  C: number[][]
  D: number[][]
  mvOrder: string[]
  cvOrder: string[]
  /** 可选:归一化统计(把归一化增益折回物理单位) */
  norm?: { u: { mean: number[], std: number[] }, y: { mean: number[], std: number[] } }
}

export interface ActionSensitivity {
  controlId: string
  /** 控制量 +1 单位(物理单位,若提供 norm)在目标上的稳态变化;按目标节点给出 */
  gains: Record<string, number>
  /** 仿真是否收敛(未收敛的增益不可用) */
  converged: boolean
  steps: number
}

/**
 * 用工件自身的状态方程做单位阶跃仿真,求稳态增益:y_ss(j) = (C(I−A)⁻¹B + D) 的列。
 * 数值上直接迭代 x_{k+1} = A x_k + B u, y_k = C x_k + D u,直到 |Δy| < 1e-10 或 5000 拍。
 * 若提供 norm,再做物理单位换算:Δy_phys = Δy_norm · std_y / std_u。
 */
export function arxStepResponseGain(artifact: ArxArtifactLike, controlId: string): ActionSensitivity | null {
  const m = artifact.mvOrder.indexOf(controlId)
  if (m < 0) return null
  const A = artifact.A
  const B = artifact.B
  const C = artifact.C
  const D = artifact.D
  const nState = A.length
  const nY = C.length
  if (!nState || !nY) return null
  const u = new Array<number>(artifact.mvOrder.length).fill(0)
  u[m] = 1
  let x = new Array<number>(nState).fill(0)
  const yOf = (xx: number[]): number[] => C.map((row, j) => row.reduce((s, c, i) => s + c * (xx[i] ?? 0), 0) + (D[j] ?? []).reduce((s, d, i) => s + d * (u[i] ?? 0), 0))
  const y0 = yOf(x)
  const maxSteps = 5000
  let converged = false
  let prev = y0
  let steps = 0
  for (let k = 0; k < maxSteps; k++) {
    const next = new Array<number>(nState).fill(0)
    for (let i = 0; i < nState; i++) {
      let acc = 0
      for (let j = 0; j < nState; j++) acc += (A[i]?.[j] ?? 0) * (x[j] ?? 0)
      for (let q = 0; q < u.length; q++) acc += (B[i]?.[q] ?? 0) * (u[q] ?? 0)
      next[i] = acc
    }
    x = next
    const y = yOf(x)
    steps = k + 1
    const dy = y.reduce((a, v, j) => a + Math.abs(v - (prev[j] ?? 0)), 0)
    prev = y
    if (!Number.isFinite(dy)) return { controlId, gains: {}, converged: false, steps }
    // 首拍 y 可能恰好不动(输入还没传到输出),必须跑过若干拍再判收敛,否则增益恒为 0
    if (steps >= 10 && dy < 1e-10) {
      converged = true
      break
    }
  }
  const gains: Record<string, number> = {}
  const stdU = artifact.norm?.u.std[m]
  prev.forEach((v, j) => {
    const target = artifact.cvOrder[j] ?? `y${j}`
    const stdY = artifact.norm?.y.std[j]
    const physical = artifact.norm && stdU && Number.isFinite(stdU) && stdU !== 0 && stdY != null
      ? (v / stdU) * stdY
      : v
    gains[target] = physical
  })
  return { controlId, gains, converged, steps }
}

/** 敏感度是否为"可分辨的耦合"(|gain| 超过给定下限,缺省 1e-9) */
export function hasResolvableCoupling(sensitivity: ActionSensitivity | null, targetNodeId: string, minGain = 1e-9): boolean {
  if (!sensitivity || !sensitivity.converged) return false
  const g = sensitivity.gains[targetNodeId]
  return typeof g === 'number' && Number.isFinite(g) && Math.abs(g) > minGain
}
