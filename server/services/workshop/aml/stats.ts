/**
 * AML 统计引擎(Node 侧):逐节点概要 / 相关矩阵 / 控制→目标滞后互相关(时滞估计)/
 * 逐 run 轮廓(均值漂移)。纯函数,输出直接进 dataset report 并经 aml_dataset_stats 暴露。
 */
import { median } from './clean'

export interface SeriesSummary {
  nodeId: string
  role: string
  count: number
  mean: number
  std: number
  min: number
  max: number
  p05: number
  p50: number
  p95: number
  missingRatio: number
  cleanedRatio: number
}

export interface LagEstimate {
  controlId: string
  targetId: string
  /** 互相关峰值滞后(格数;正 = 控制领先目标) */
  lagSteps: number
  /** 峰值归一化互相关(-1..1) */
  corr: number
}

export interface RunProfile {
  runId: string
  steps: number
  /** 目标节点逐 run 均值(漂移检测) */
  targetMeans: Record<string, number>
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const loV = sorted[lo] ?? 0
  const hiV = sorted[hi] ?? loV
  return loV + (hiV - loV) * (pos - lo)
}

export function summarize(nodeId: string, role: string, values: number[], missingRatio: number, cleanedRatio: number): SeriesSummary {
  const n = values.length
  if (n === 0) {
    return { nodeId, role, count: 0, mean: 0, std: 0, min: 0, max: 0, p05: 0, p50: 0, p95: 0, missingRatio, cleanedRatio }
  }
  const mean = values.reduce((a, b) => a + b, 0) / n
  const varr = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, n - 1)
  const sorted = [...values].sort((a, b) => a - b)
  return {
    nodeId,
    role,
    count: n,
    mean,
    std: Math.sqrt(varr),
    min: sorted[0] ?? 0,
    max: sorted[n - 1] ?? 0,
    p05: quantile(sorted, 0.05),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    missingRatio,
    cleanedRatio,
  }
}

/** Pearson 相关(等长序列;含 NaN 防御) */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 4) return 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    sa += a[i] ?? 0
    sb += b[i] ?? 0
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = (a[i] ?? 0) - ma
    const xb = (b[i] ?? 0) - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  const den = Math.sqrt(da * db)
  return den < 1e-12 ? 0 : num / den
}

/**
 * 控制→目标滞后互相关:对 lead ∈ [-maxLag, maxLag] 计算 corr(control[t-lead], target[t]),
 * 取 |corr| 峰值。lagSteps > 0 = 控制领先目标(物理时滞格数,×beatMs 即滞后时长),
 * 供 historySteps/horizon 设计参考。
 */
export function lagCrossCorr(control: number[], target: number[], maxLag = 20): LagEstimate {
  const n = Math.min(control.length, target.length)
  const best: LagEstimate = { controlId: '', targetId: '', lagSteps: 0, corr: 0 }
  for (let lead = -maxLag; lead <= maxLag; lead++) {
    const a: number[] = []
    const b: number[] = []
    for (let i = 0; i < n; i++) {
      const j = i - lead
      const cv = control[j]
      const tv = target[i]
      if (j >= 0 && j < n && cv !== undefined && tv !== undefined) {
        a.push(cv)
        b.push(tv)
      }
    }
    const c = pearson(a, b)
    if (Math.abs(c) > Math.abs(best.corr)) {
      best.corr = c
      best.lagSteps = lead
    }
  }
  return best
}

/** 滑动窗口均值(趋势/漂移可视化辅助) */
export function movingMean(xs: number[], win: number): number[] {
  if (xs.length === 0 || win <= 1) return [...xs]
  const out: number[] = []
  let sum = 0
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i] ?? 0
    if (i >= win) sum -= xs[i - win] ?? 0
    out.push(i >= win - 1 ? sum / win : sum / (i + 1))
  }
  return out
}

export { median }
