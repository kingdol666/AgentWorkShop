/**
 * UQ 证据(D2/D3/D4/D5)——工件级、块级 conformal,唯一证据源。
 *
 * 统计量 = h 步 rollout 残差在块内最大值(逐 CV,模型单位);h = 训练时 ds.P(static 固定 1)。
 * 校准段(val)定 qhat,检验段(test)实测 coverage —— 两段不相交。
 * 两种模式:
 *   - split_conformal:nValBlocks≥9 ∧ nValRuns≥2,分位数 ⌈(n+1)(1−α)⌉/n(α=0.1)
 *   - empirical_max:2≤nValBlocks≤8,qhat = max(val)×1.25(预注册安全系数),coverage 必须 =1
 * emit 条件:nUniqueTestSteps≥120 ∧ nTestRuns≥2;不足不发证(fail-closed)。
 * verified 门限(D3):coverage ≥ max(0.8, 0.9−3√(0.09/nTestRuns));empirical_max → 1.0。
 */
import { amlUqFreshDays } from '../settings'

export interface ArtifactUq {
  method: 'split_conformal' | 'empirical_max'
  qhatPerCv: number[]
  coverageTest: number
  alpha: number
  horizon: number
  nValBlocks: number
  nValRuns: number
  nValUniqueSteps: number
  nTestBlocks: number
  nTestRuns: number
  nUniqueTestSteps: number
  safetyFactor?: number
  calibratedAt: string
}

export interface BlockUqInput {
  /** val 段逐块逐 CV 的 max|h 步残差|(模型单位) */
  valScoresPerCv: Array<number[]>
  testScoresPerCv: Array<number[]>
  nValRuns: number
  nTestRuns: number
  nUniqueTestSteps: number
  horizon: number
  alpha?: number
  calibratedAt?: string
}

/** ⌈(n+1)(1−α)⌉ 阶统计量(split conformal;rank 超界时取 max) */
function conformalQuantile(scores: number[], alpha: number): number {
  const n = scores.length
  if (!n) return Number.POSITIVE_INFINITY
  const rank = Math.min(n, Math.ceil((n + 1) * (1 - alpha)))
  const sorted = [...scores].sort((a, b) => a - b)
  return sorted[rank - 1] ?? sorted[n - 1] ?? Number.POSITIVE_INFINITY
}

export function computeBlockUq(input: BlockUqInput): { uq: ArtifactUq | null, reason: string } {
  const alpha = input.alpha ?? 0.1
  const nValBlocks = input.valScoresPerCv.length
  const nTestBlocks = input.testScoresPerCv.length
  // emit 条件(D2):样本量不足不发 uq → 维持 unverified(fail-closed)
  if (input.nUniqueTestSteps < 120 || input.nTestRuns < 2 || nTestBlocks < 1) {
    return { uq: null, reason: `样本量不足(nUniqueTestSteps=${input.nUniqueTestSteps}<120 或 nTestRuns=${input.nTestRuns}<2);不发 UQ 证据` }
  }
  if (nValBlocks < 2 || input.nValRuns < 1) {
    return { uq: null, reason: `校准块不足(nValBlocks=${nValBlocks}<2);不发 UQ 证据` }
  }
  const cvCount = input.valScoresPerCv[0]?.length ?? 0
  if (!cvCount) return { uq: null, reason: '无 CV 校准分数' }

  const useConformal = nValBlocks >= 9 && input.nValRuns >= 2
  const qhatPerCv: number[] = []
  for (let j = 0; j < cvCount; j++) {
    const valScores = input.valScoresPerCv.map(r => r[j] ?? Number.POSITIVE_INFINITY).filter(Number.isFinite)
    if (valScores.length !== nValBlocks) return { uq: null, reason: `CV ${j} 校准分数含非有限值;不发 UQ 证据` }
    qhatPerCv.push(useConformal ? conformalQuantile(valScores, alpha) : Math.max(...valScores) * 1.25)
  }
  // test 段实测 coverage(逐 CV 命中块数/测试块数;门取 min_j)
  let minCoverage = 1
  for (let j = 0; j < cvCount; j++) {
    const testScores = input.testScoresPerCv.map(r => r[j] ?? Number.POSITIVE_INFINITY)
    const hits = testScores.filter(s => Number.isFinite(s) && s <= (qhatPerCv[j] ?? Number.POSITIVE_INFINITY)).length
    minCoverage = Math.min(minCoverage, nTestBlocks ? hits / nTestBlocks : 0)
  }
  return {
    uq: {
      method: useConformal ? 'split_conformal' : 'empirical_max',
      qhatPerCv: qhatPerCv.map(q => Number(q.toFixed(9))),
      coverageTest: Number(minCoverage.toFixed(6)),
      alpha,
      horizon: input.horizon,
      nValBlocks,
      nValRuns: input.nValRuns,
      nValUniqueSteps: 0,
      nTestBlocks,
      nTestRuns: input.nTestRuns,
      nUniqueTestSteps: input.nUniqueTestSteps,
      ...(useConformal ? {} : { safetyFactor: 1.25 }),
      calibratedAt: input.calibratedAt ?? new Date().toISOString(),
    },
    reason: useConformal ? 'split_conformal' : 'empirical_max(经验界,非 conformal)',
  }
}

/** D3 verified 门限:0.8 硬底(裸公式在小样本塌缩到 0.264);empirical_max 必须 1.0 */
export function coverageThreshold(uq: Pick<ArtifactUq, 'method' | 'nTestRuns'>): number {
  if (uq.method === 'empirical_max') return 1.0
  const n = Math.max(1, uq.nTestRuns)
  return Math.max(0.8, 0.9 - 3 * Math.sqrt(0.09 / n))
}

/** D4 inputDistance = MV+CV 双偏移(σ 取工件 norm;σ≈0 → ∞;列数不符 → null,不伪造) */
export function inputDistance(input: {
  currentU: Array<number | undefined>
  currentY: Array<number | undefined>
  normU: { mean: number[], std: number[] }
  normY: { mean: number[], std: number[] }
}): number | null {
  const dev = (values: Array<number | undefined>, norm: { mean: number[], std: number[] }): number | null => {
    if (values.length !== norm.std.length || values.length !== norm.mean.length) return null
    let max = 0
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (v === undefined || !Number.isFinite(v)) return null
      const sigma = Math.abs(norm.std[i] ?? 0)
      if (sigma < 1e-9) return Number.POSITIVE_INFINITY
      max = Math.max(max, Math.abs((v - (norm.mean[i] ?? 0)) / sigma))
    }
    return max
  }
  const du = dev(input.currentU, input.normU)
  if (du === null) return null
  const dy = dev(input.currentY, input.normY)
  if (dy === null) return null
  return Math.max(du, dy)
}

/** UQ 保鲜(D2):calibratedAt 超过 aml.uq.freshDays → 过期 */
export function isUqFresh(uq: Pick<ArtifactUq, 'calibratedAt'>, now = Date.now()): boolean {
  const t = Date.parse(uq.calibratedAt)
  if (!Number.isFinite(t)) return false
  return now - t <= amlUqFreshDays() * 86_400_000
}

/** 建议 UQ 证据快照(进 recommendation 行;含 artifactHash 锚,杜绝双证据路径) */
export interface RecommendationUqEvidence extends ArtifactUq {
  artifactHash: string
  calibrationFresh: boolean
  inputDistance: number | null
}
