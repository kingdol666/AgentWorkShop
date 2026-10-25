/**
 * linear_arx@1 —— 线性 ARX 辨识 → linear_state_space@1 工件。
 *
 * 模型(物理单位):
 *   y_j(k+1) = Σ_{i=1..ar} a_ji·y_j(k+1-i) + Σ_m Σ_{l=0..io-1} b_{jm,l}·u_m(k+1-d_m-l) + c_j
 *
 * 状态(x = [y 历史寄存器; u 延迟线]):
 *   sy[j][i] = y_j(k-i)      i=0..ar-1
 *   su[m][q] = u_m(k-q)      q=0..K-1,K = max(d_m+io-1)
 *   x' = A x + B u(k+1) + bias ; y(k) = C x
 * 观测使用更新后的状态,因此 d_m=0,l=0 的当拍输入进 B,D 保持零。
 */
/* eslint-disable @stylistic/max-statements-per-line */
import type { DatasetView } from './dataset-reader'
import { pvU, pvX, pvY, splitRange } from './dataset-reader'
import { computeBlockUq, type ArtifactUq } from '../../optimization/uq-evidence'

export interface LinearStateSpaceArtifact {
  kind: 'linear_state_space@1'
  schemaVersion: 1
  stateDim: number
  arOrder: number
  inputOrder: number
  mvOrder: string[]
  cvOrder: string[]
  /** 每 MV 延迟步数(由 spec.variables.delayMs / beatMs 派生,只记录不重复施加) */
  delaysSteps: Record<string, number>
  K: number
  A: number[][]
  B: number[][]
  C: number[][]
  D: number[][]
  /** x' = A x + B u + bias */
  bias: number[]
  /** 状态布局(求解器/预测器据此从历史初始化) */
  layout: { yOffset: number, uOffset: number, stateDim: number, K: number }
  /** 来源归一化统计(导出口径,训练在物理单位上完成) */
  norm: DatasetView['norm']
  /** 块级 UQ 证据(D2;val 校准/test 实证;不足=undefined 维持 unverified) */
  uq?: ArtifactUq
  metrics: { oneStepVal: { windows: number, nrmse: number }, oneStepNrmse: number, rolloutNrmse: number, persistenceNrmse: number, rolloutImprovement: number, windows: number }
  residual: { mean: number, std: number }
}

export interface LinearArxConfig { arOrder: number, inputOrder: number, ridgeLambda: number, standardize: boolean }

export interface TrainerSpecInfo {
  variables: Array<{ id: string, nodeId: string, role: string, delayMs?: number }>
  beatMs: number
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

interface Regression { y: number[], rows: number[][] }

/** 历史段上的监督样本:目标 y_j(k+1) 与回归量(y 历史 + 延迟输入)。 */
function buildRegressions(ds: DatasetView, targetIdx: number, mvIdx: number[], config: LinearArxConfig, delays: number[], range: { start: number, end: number }): Regression {
  const y: number[] = []
  const rows: number[][] = []
  const startT = Math.max(config.arOrder, ...delays.map(d => d + config.inputOrder))
  for (let n = range.start; n < range.end; n++) {
    for (let t = startT; t < ds.H; t++) {
      // 目标取历史第 t 步(对应 y(k+1),k=t-1);回归量都在 ≤ t-1
      y.push(pvX(ds, n, t, targetIdx))
      const row: number[] = []
      for (let i = 1; i <= config.arOrder; i++) row.push(pvX(ds, n, t - i, targetIdx))
      for (let m = 0; m < mvIdx.length; m++) {
        const d = delays[m] ?? 0
        // u(k+1-d-l) = u(t-d-l)
        for (let l = 0; l < config.inputOrder; l++) row.push(pvX(ds, n, t - d - l, mvIdx[m]!))
      }
      row.push(1) // bias
      rows.push(row)
    }
  }
  return { y, rows }
}

function fitRidge(rows: number[][], y: number[], lambda: number): number[] {
  const p = rows[0]?.length ?? 0
  const xtx: number[][] = Array.from({ length: p }, () => Array.from({ length: p }, () => 0))
  const xty: number[] = Array.from({ length: p }, () => 0)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    for (let a = 0; a < p; a++) {
      xty[a] = xty[a]! + row[a]! * y[i]!
      for (let b = 0; b < p; b++) xtx[a]![b] = xtx[a]![b]! + row[a]! * row[b]!
    }
  }
  for (let a = 0; a < p; a++) xtx[a]![a] = xtx[a]![a]! + lambda
  return solveLinearSystem(xtx, xty)
}

function rmse(pred: number[], actual: number[]): number {
  if (!pred.length) return 0
  let s = 0
  for (let i = 0; i < pred.length; i++) s += (pred[i]! - actual[i]!) ** 2
  return Math.sqrt(s / pred.length)
}

export function trainLinearArx(ds: DatasetView, config: LinearArxConfig, spec: TrainerSpecInfo): LinearStateSpaceArtifact {
  const mv = spec.variables.filter(v => v.role === 'mv')
  const cv = spec.variables.filter(v => v.role === 'cv')
  const mvIdx = mv.map(v => ds.allNodes.indexOf(v.nodeId))
  const cvIdx = cv.map(v => ds.allNodes.indexOf(v.nodeId))
  if (mvIdx.some(i => i < 0) || cvIdx.some(i => i < 0)) throw new Error('MV/CV 变量未包含在数据集节点中')
  const delays = mv.map(v => Math.max(0, Math.round((v.delayMs ?? 0) / spec.beatMs)))
  const K = Math.max(1, ...delays.map(d => d + config.inputOrder))
  const ar = config.arOrder
  const io = config.inputOrder
  const M = mv.length
  const C = cv.length
  const stateDim = C * ar + M * K
  const train = splitRange(ds, 'train')
  const val = splitRange(ds, 'val')
  const test = splitRange(ds, 'test')
  if (val.end <= val.start || test.end <= test.start) throw new Error('线性模型需要非空的独立验证集和测试集')

  const A: number[][] = Array.from({ length: stateDim }, () => Array.from({ length: stateDim }, () => 0))
  const B: number[][] = Array.from({ length: stateDim }, () => Array.from({ length: M }, () => 0))
  const Cm: number[][] = Array.from({ length: C }, () => Array.from({ length: stateDim }, () => 0))
  const D: number[][] = Array.from({ length: C }, () => Array.from({ length: M }, () => 0))
  const bias: number[] = Array.from({ length: stateDim }, () => 0)
  const yOffset = 0
  const uOffset = C * ar

  const allResiduals: number[] = []
  const valPred: number[] = []
  const valActual: number[] = []
  for (let j = 0; j < C; j++) {
    const { y, rows } = buildRegressions(ds, cvIdx[j]!, mvIdx, config, delays, train)
    if (!y.length) throw new Error(`目标 ${cv[j]!.id} 没有可辨识样本;检查窗口/延迟配置`)
    const coef = fitRidge(rows, y, config.ridgeLambda)
    const a = coef.slice(0, ar)
    const b: number[][] = []
    for (let m = 0; m < M; m++) b.push(coef.slice(ar + m * io, ar + (m + 1) * io))
    const c = coef[coef.length - 1] ?? 0

    // 状态方程:A 行(y_j 的新值)
    for (let i = 1; i <= ar; i++) A[yOffset + j * ar]![yOffset + j * ar + (i - 1)] = a[i - 1] ?? 0
    for (let m = 0; m < M; m++) {
      for (let l = 0; l < io; l++) {
        const q = (delays[m] ?? 0) + l - 1
        if (q < 0) B[yOffset + j * ar]![m] = b[m]![l]!
        else if (q < K) A[yOffset + j * ar]![uOffset + m * K + q] = b[m]![l]!
      }
    }
    bias[yOffset + j * ar] = c
    // 观测:y_j(k) = sy[j][0]
    Cm[j]![yOffset + j * ar] = 1

    // 一步残差(训练段)
    for (let i = 0; i < rows.length; i++) {
      const pred = rows[i]!.reduce((s, v, k) => s + v * coef[k]!, 0)
      allResiduals.push(y[i]! - pred)
    }
    const validation = buildRegressions(ds, cvIdx[j]!, mvIdx, config, delays, val)
    for (let i = 0; i < validation.rows.length; i++) {
      valPred.push(validation.rows[i]!.reduce((s, v, k) => s + v * coef[k]!, 0))
      valActual.push(validation.y[i]!)
    }
  }

  // 状态转移的寄存器移位:sy[j][i] <- sy[j][i-1];su[m][q] <- su[m][q-1]
  for (let j = 0; j < C; j++) for (let i = 1; i < ar; i++) A[yOffset + j * ar + i]![yOffset + j * ar + i - 1] = 1
  for (let m = 0; m < M; m++) {
    for (let q = 1; q < K; q++) A[uOffset + m * K + q]![uOffset + m * K + q - 1] = 1
    // 新输入 u_m(k+1) 进入延迟线首位
    B[uOffset + m * K]![m] = 1
  }

  // ---- 指标:一步 / 多步 rollout / 持值基线(test 段)----
  const oneStepPred: number[] = []
  const oneStepActual: number[] = []
  const rolloutPred: number[] = []
  const rolloutActual: number[] = []
  const holdPred: number[] = []
  const valRolloutPred: number[] = []
  const valRolloutActual: number[] = []
  /** 块级 UQ 分数(SW3/D2):每窗口逐 CV 的 max|h 步残差|(模型单位) */
  const valBlockScores: number[][] = []
  const testBlockScores: number[][] = []
  let windows = 0

  const initState = (n: number): number[] => {
    const x: number[] = Array.from({ length: stateDim }, () => 0)
    for (let j = 0; j < C; j++) for (let i = 0; i < ar; i++) x[yOffset + j * ar + i] = pvX(ds, n, ds.H - 1 - i, cvIdx[j]!)
    for (let m = 0; m < M; m++) for (let q = 0; q < K; q++) x[uOffset + m * K + q] = pvX(ds, n, ds.H - 1 - q, mvIdx[m]!)
    return x
  }
  const applyState = (x: number[], uNow: number[]): number[] => {
    const next = Array.from({ length: stateDim }, () => 0)
    for (let r = 0; r < stateDim; r++) {
      let v = bias[r]!
      for (let c = 0; c < stateDim; c++) v += A[r]![c]! * x[c]!
      for (let m = 0; m < M; m++) v += B[r]![m]! * uNow[m]!
      next[r] = v
    }
    return next
  }
  /** 多步 rollout 单窗口:返回逐 CV 的 max|残差|(模型单位);record=true 时计入 test 指标数组 */
  const rolloutWindow = (n: number, record: boolean): number[] => {
    let x = initState(n)
    const maxRes = Array.from({ length: C }, () => 0)
    for (let p = 0; p < ds.P; p++) {
      // pvU 的最后一维是 **control 列序**(0..M-1),不是 allNodes 下标
      const uNow = mvIdx.map((_idx, m) => pvU(ds, n, p, m))
      x = applyState(x, uNow)
      for (let j = 0; j < C; j++) {
        let yhat = D[j]!.reduce((s, v, m) => s + v * uNow[m]!, 0)
        for (let c = 0; c < stateDim; c++) yhat += Cm[j]![c]! * x[c]!
        maxRes[j] = Math.max(maxRes[j]!, Math.abs(yhat - pvY(ds, n, p, j)))
        if (record) {
          rolloutPred.push(yhat)
          rolloutActual.push(pvY(ds, n, p, j))
          holdPred.push(cvIdx.map(idx => pvX(ds, n, ds.H - 1, idx))[j]!)
        }
      }
    }
    return maxRes
  }

  for (let n = test.start; n < test.end; n++) {
    windows++
    // 一步(用真实历史回归量,等价于状态推进一步)
    const startT = Math.max(ar, ...delays.map(d => d + io))
    for (let t = startT; t < ds.H; t++) {
      const x = Array.from({ length: stateDim }, () => 0)
      for (let j = 0; j < C; j++) for (let i = 0; i < ar; i++) x[yOffset + j * ar + i] = pvX(ds, n, t - 1 - i, cvIdx[j]!)
      for (let m = 0; m < M; m++) for (let q = 0; q < K; q++) x[uOffset + m * K + q] = pvX(ds, n, t - 1 - q, mvIdx[m]!)
      // 目标 y(t)=y(k+1),k=t-1;当拍输入 u(k+1-d)=u(t-d)
      const uNow = mvIdx.map(idx => pvX(ds, n, t, idx))
      const next = applyState(x, uNow)
      for (let j = 0; j < C; j++) {
        let yhat = D[j]!.reduce((s, v, m) => s + v * uNow[m]!, 0)
        for (let c = 0; c < stateDim; c++) yhat += Cm[j]![c]! * next[c]!
        oneStepPred.push(yhat)
        oneStepActual.push(pvX(ds, n, t, cvIdx[j]!))
      }
    }
    testBlockScores.push(rolloutWindow(n, true))
  }
  // val 段 rollout(SW3):校准块分数 —— 独立于 test 段,不复用 test 残差
  for (let n = val.start; n < val.end; n++) {
    valBlockScores.push(rolloutWindow(n, false))
    // val rollout 指标(供门禁/展示;不进 test 统计)
    let vx = initState(n)
    for (let p = 0; p < ds.P; p++) {
      const uNow = mvIdx.map((_idx, m) => pvU(ds, n, p, m))
      vx = applyState(vx, uNow)
      for (let j = 0; j < C; j++) {
        let yhat = D[j]!.reduce((s, v, m) => s + v * uNow[m]!, 0)
        for (let c = 0; c < stateDim; c++) yhat += Cm[j]![c]! * vx[c]!
        valRolloutPred.push(yhat)
        valRolloutActual.push(pvY(ds, n, p, j))
      }
    }
  }

  const oneStepNrmse = oneStepActual.length
    ? rmse(oneStepPred, oneStepActual) / Math.max(1e-9, avg(ds.norm.y.std))
    : 0
  const rolloutNrmse = rolloutActual.length ? rmse(rolloutPred, rolloutActual) / Math.max(1e-9, avg(ds.norm.y.std)) : 0
  const persistenceNrmse = rolloutActual.length ? rmse(holdPred, rolloutActual) / Math.max(1e-9, avg(ds.norm.y.std)) : 0
  const residualMean = allResiduals.reduce((a, b) => a + b, 0) / Math.max(1, allResiduals.length)
  const residualStd = Math.sqrt(allResiduals.reduce((a, b) => a + (b - residualMean) ** 2, 0) / Math.max(1, allResiduals.length))

  // 块级 UQ(D2):val 校准/test 实证,两段不相交;不足不发证
  const { uq, reason: uqReason } = computeBlockUq({
    valScoresPerCv: valBlockScores,
    testScoresPerCv: testBlockScores,
    nValRuns: ds.split.valRunIds.length,
    nTestRuns: ds.split.testRunIds.length,
    nUniqueTestSteps: windows * ds.P,
    horizon: ds.P,
  })
  void uqReason

  return {
    kind: 'linear_state_space@1',
    schemaVersion: 1,
    stateDim,
    arOrder: ar,
    inputOrder: io,
    mvOrder: mv.map(v => v.id),
    cvOrder: cv.map(v => v.id),
    delaysSteps: Object.fromEntries(mv.map((v, m) => [v.id, delays[m] ?? 0])),
    K,
    A, B, C: Cm, D, bias,
    layout: { yOffset, uOffset, stateDim, K },
    norm: ds.norm,
    uq: uq ?? undefined,
    metrics: {
      oneStepVal: { windows: val.end - val.start, nrmse: Number((rmse(valPred, valActual) / Math.max(1e-9, avg(ds.norm.y.std))).toFixed(6)) },
      oneStepNrmse: Number(oneStepNrmse.toFixed(6)),
      rolloutNrmse: Number(rolloutNrmse.toFixed(6)),
      persistenceNrmse: Number(persistenceNrmse.toFixed(6)),
      rolloutImprovement: Number((1 - rolloutNrmse / Math.max(1e-9, persistenceNrmse)).toFixed(6)),
      windows,
    },
    residual: { mean: Number(residualMean.toFixed(9)), std: Number(residualStd.toFixed(9)) },
  }
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 1
}
