/* eslint-disable @stylistic/max-statements-per-line */
/**
 * static_response@1 —— 稳态响应面训练器(不伪造 ONNX/hybrid_manifest)。
 *
 * 输入:每条窗口的历史末拍 MV(物理单位)+ 未来时域内 CV 均值;
 * 输出:一阶/二阶(含二次项与交互项)多项式系数 + 特征展开顺序 + 留出残差。
 * 供 `steady_response@1` 问题模板与 SciPy 有界优化使用。
 */
import type { DatasetView } from './dataset-reader'
import { pvX, pvY, splitRange } from './dataset-reader'
import type { TrainerSpecInfo } from './linear-arx'
import { computeBlockUq, type ArtifactUq } from '../../optimization/uq-evidence'

export interface StaticResponseArtifact {
  kind: 'static_response@1'
  schemaVersion: 1
  mvOrder: string[]
  cvOrder: string[]
  featureOrder: string[]
  order: 1 | 2
  /** cv → 系数(与 featureOrder 等长) */
  coefficients: Record<string, number[]>
  /** 训练覆盖的 MV 区间(有效域) */
  mvRanges: Record<string, { min: number, max: number }>
  metrics: { holdoutNrmse: number, persistenceNrmse: number, improvement: number, samples: number }
  residual: { mean: number, std: number }
  norm: DatasetView['norm']
  /** 块级 UQ 证据(D2;h=1,块=窗口;val 段校准/test 段实证;不足=undefined 维持 unverified) */
  uq?: ArtifactUq
}

export interface StaticResponseConfig { order: 1 | 2, ridgeLambda: number, standardize: boolean }

function features(u: number[], order: 1 | 2): number[] {
  const out = [1, ...u]
  if (order === 2) {
    for (let i = 0; i < u.length; i++) for (let j = i; j < u.length; j++) out.push(u[i]! * u[j]!)
  }
  return out
}

function featureNames(mvOrder: string[], order: 1 | 2): string[] {
  const names = ['bias', ...mvOrder]
  if (order === 2) {
    for (let i = 0; i < mvOrder.length; i++) for (let j = i; j < mvOrder.length; j++) names.push(i === j ? `${mvOrder[i]}^2` : `${mvOrder[i]}*${mvOrder[j]}`)
  }
  return names
}

function solveLinearSystem(matrix: number[][], rhs: number[]): number[] {
  const n = matrix.length
  const a = matrix.map((row, i) => [...row, rhs[i] ?? 0])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row
    if (pivot !== col) { const tmp = a[col]!; a[col] = a[pivot]!; a[pivot] = tmp }
    const div = a[col]![col]!
    if (Math.abs(div) < 1e-12) continue
    for (let j = col; j <= n; j++) a[col]![j] = a[col]![j]! / div
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = a[row]![col]!
      if (factor === 0) continue
      for (let j = col; j <= n; j++) a[row]![j] = a[row]![j]! - factor * a[col]![j]!
    }
  }
  return a.map(row => row[n] ?? 0)
}

function fitRidge(rows: number[][], y: number[], lambda: number): number[] {
  const p = rows[0]?.length ?? 0
  const xtx: number[][] = Array.from({ length: p }, () => Array.from({ length: p }, () => 0))
  const xty: number[] = Array.from({ length: p }, () => 0)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    for (let a = 0; a < p; a++) {
      xty[a] = xty[a]! + row[a]! * y[i]!
      for (let bb = 0; bb < p; bb++) xtx[a]![bb] = xtx[a]![bb]! + row[a]! * row[bb]!
    }
  }
  for (let a = 1; a < p; a++) xtx[a]![a] = xtx[a]![a]! + lambda // 截距不正则
  return solveLinearSystem(xtx, xty)
}

function rmse(pred: number[], actual: number[]): number {
  if (!pred.length) return 0
  let s = 0
  for (let i = 0; i < pred.length; i++) s += (pred[i]! - actual[i]!) ** 2
  return Math.sqrt(s / pred.length)
}

export function trainStaticResponse(ds: DatasetView, config: StaticResponseConfig, spec: TrainerSpecInfo): StaticResponseArtifact {
  const mv = spec.variables.filter(v => v.role === 'mv')
  const cv = spec.variables.filter(v => v.role === 'cv')
  const mvIdx = mv.map(v => ds.allNodes.indexOf(v.nodeId))
  const cvIdx = cv.map(v => ds.allNodes.indexOf(v.nodeId))
  if (mvIdx.some(i => i < 0) || cvIdx.some(i => i < 0)) throw new Error('MV/CV 变量未包含在数据集节点中')
  const train = splitRange(ds, 'train')
  const valRange = splitRange(ds, 'val')
  const test = splitRange(ds, 'test')
  if (test.end <= test.start) throw new Error('静态模型需要非空的独立测试集')

  const rowsFor = (n: number): number[] => features(mvIdx.map(idx => pvX(ds, n, ds.H - 1, idx)), config.order)
  const targetFor = (n: number, j: number): number => {
    let sum = 0
    for (let p = 0; p < ds.P; p++) sum += pvY(ds, n, p, j)
    return sum / Math.max(1, ds.P)
  }

  const coefficients: Record<string, number[]> = {}
  const allResiduals: number[] = []
  const holdPred: number[] = []
  const holdActual: number[] = []
  /** 块级 UQ 分数(SW3/D2):h=1,块=窗口,逐 CV |残差|(模型单位) */
  const valBlockScores: number[][] = []
  const testBlockScores: number[][] = []
  let samples = 0

  for (let j = 0; j < cv.length; j++) {
    const trainRows: number[][] = []
    const trainY: number[] = []
    for (let n = train.start; n < train.end; n++) { trainRows.push(rowsFor(n)); trainY.push(targetFor(n, j)) }
    if (trainRows.length < 3) throw new Error(`目标 ${cv[j]!.id} 训练样本不足(${trainRows.length})`)
    const coef = fitRidge(trainRows, trainY, config.ridgeLambda)
    coefficients[cv[j]!.id] = coef
    for (let i = 0; i < trainRows.length; i++) allResiduals.push(trainY[i]! - trainRows[i]!.reduce((s, v, k) => s + v * coef[k]!, 0))
    // 留出:test 段(与预测同口径)
    for (let n = test.start; n < test.end; n++) {
      const pred = rowsFor(n).reduce((s, v, k) => s + v * coef[k]!, 0)
      holdPred.push(pred)
      holdActual.push(targetFor(n, j))
      samples++
    }
  }
  // UQ 块分数:val 校准(启用此前闲置的 val 段)/ test 实证
  for (let j = 0; j < cv.length; j++) {
    const coef = coefficients[cv[j]!.id]!
    const valScores: number[] = []
    for (let n = valRange.start; n < valRange.end; n++) {
      const pred = rowsFor(n).reduce((s, v, k) => s + v * coef[k]!, 0)
      valScores.push(Math.abs(targetFor(n, j) - pred))
    }
    if (j === 0) for (let n = valRange.start; n < valRange.end; n++) valBlockScores.push([])
    for (let i = 0; i < valScores.length; i++) valBlockScores[i]!.push(valScores[i]!)
    const testScores: number[] = []
    for (let n = test.start; n < test.end; n++) {
      const pred = rowsFor(n).reduce((s, v, k) => s + v * coef[k]!, 0)
      testScores.push(Math.abs(targetFor(n, j) - pred))
    }
    if (j === 0) for (let n = test.start; n < test.end; n++) testBlockScores.push([])
    for (let i = 0; i < testScores.length; i++) testBlockScores[i]!.push(testScores[i]!)
  }

  // 持值基线(每个目标用其训练均值):与预测同口径重算
  const persistPred: number[] = []
  const persistActual: number[] = []
  for (let j = 0; j < cv.length; j++) {
    const trainY: number[] = []
    for (let n = train.start; n < train.end; n++) trainY.push(targetFor(n, j))
    const mean = trainY.reduce((a, b) => a + b, 0) / Math.max(1, trainY.length)
    for (let n = test.start; n < test.end; n++) { persistPred.push(mean); persistActual.push(targetFor(n, j)) }
  }

  const scale = Math.max(1e-9, ds.norm.y.std.reduce((a, b) => a + b, 0) / Math.max(1, ds.norm.y.std.length))
  const holdoutNrmse = holdActual.length ? rmse(holdPred, holdActual) / scale : 0
  const persistenceNrmse = persistActual.length ? rmse(persistPred, persistActual) / scale : 0
  const residualMean = allResiduals.reduce((a, b) => a + b, 0) / Math.max(1, allResiduals.length)
  const residualStd = Math.sqrt(allResiduals.reduce((a, b) => a + (b - residualMean) ** 2, 0) / Math.max(1, allResiduals.length))

  const mvRanges: Record<string, { min: number, max: number }> = {}
  for (const [m, idx] of mvIdx.entries()) {
    let lo = Infinity
    let hi = -Infinity
    for (let n = 0; n < ds.N; n++) {
      const v = pvX(ds, n, ds.H - 1, idx)
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    mvRanges[mv[m]!.id] = { min: lo, max: hi }
  }

  // 块级 UQ(D2):h=1(static),nUniqueTestSteps = test 窗口数;不足不发证
  const { uq } = computeBlockUq({
    valScoresPerCv: valBlockScores,
    testScoresPerCv: testBlockScores,
    nValRuns: ds.split.valRunIds.length,
    nTestRuns: ds.split.testRunIds.length,
    nUniqueTestSteps: test.end - test.start,
    horizon: 1,
  })

  return {
    kind: 'static_response@1',
    schemaVersion: 1,
    mvOrder: mv.map(v => v.id),
    cvOrder: cv.map(v => v.id),
    featureOrder: featureNames(mv.map(v => v.id), config.order),
    order: config.order,
    coefficients,
    mvRanges,
    metrics: {
      holdoutNrmse: Number(holdoutNrmse.toFixed(6)),
      persistenceNrmse: Number(persistenceNrmse.toFixed(6)),
      improvement: Number((1 - holdoutNrmse / Math.max(1e-9, persistenceNrmse)).toFixed(6)),
      samples,
    },
    residual: { mean: Number(residualMean.toFixed(9)), std: Number(residualStd.toFixed(9)) },
    norm: ds.norm,
    uq: uq ?? undefined,
  }
}
