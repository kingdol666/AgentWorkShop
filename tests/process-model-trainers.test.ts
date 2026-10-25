/* eslint-disable @stylistic/max-statements-per-line, @stylistic/member-delimiter-style */
/**
 * G2 内置训练器(A3 前置):线性 ARX 辨识恢复真实系数;多步 rollout 相对持值基线改善 ≥20%;
 * 静态响应面恢复系数。数据为合成真值 plant,不依赖外部服务。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readDataset } from '../server/services/workshop/process-model/trainers/dataset-reader'
import { trainLinearArx } from '../server/services/workshop/process-model/trainers/linear-arx'
import { trainStaticResponse } from '../server/services/workshop/process-model/trainers/static-response'

function writeDataset(dir: string, opts: {
  H: number, P: number, nRuns: number, stepsPerRun: number,
  gen: (u: number[], x: number[]) => { y: number, u: number }
}): void {
  mkdirSync(join(dir, 'arrays'), { recursive: true })
  const { H, P } = opts
  const xRows: number[] = []
  const uRows: number[] = []
  const yRows: number[] = []
  let windows = 0
  const allX: number[][] = []
  const allY: number[][] = []
  const allU: number[][] = []
  for (let run = 0; run < opts.nRuns; run++) {
    // 每 run 独立初态 + 随机但确定的激励
    const x: number[] = [0, 50]
    const series: Array<{ y: number, u: number }> = []
    for (let t = 0; t < opts.stepsPerRun; t++) {
      const u = 50 + 25 * Math.sin((t + run * 13) / 4) + 8 * Math.sin((t + run * 7) / 11)
      const y = 0.7 * x[1]! + 0.5 * x[0]! + 10
      series.push({ y, u })
      x[0] = u
      x[1] = y
    }
    for (let t = H; t + P <= series.length; t++) {
      const xw: number[] = []
      for (let i = 0; i < H; i++) xw.push(series[t - H + i]!.y, series[t - H + i]!.u)
      const uw: number[] = []
      const yw: number[] = []
      for (let p = 0; p < P; p++) { uw.push(series[t + p]!.u); yw.push(series[t + p]!.y) }
      allX.push(xw); allU.push(uw); allY.push(yw)
      windows++
    }
  }
  for (const w of allX) xRows.push(...w)
  for (const w of allU) uRows.push(...w)
  for (const w of allY) yRows.push(...w)
  writeFileSync(join(dir, 'arrays', 'x.f32'), Buffer.from(new Float32Array(xRows).buffer))
  writeFileSync(join(dir, 'arrays', 'u.f32'), Buffer.from(new Float32Array(uRows).buffer))
  writeFileSync(join(dir, 'arrays', 'y.f32'), Buffer.from(new Float32Array(yRows).buffer))
  const nTest = Math.max(1, Math.floor(windows * 0.25))
  const nVal = Math.max(1, Math.floor(windows * 0.2))
  const nTrain = windows - nTest - nVal
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    version: 2,
    allNodes: ['n-cv', 'n-mv'],
    controlNodes: ['n-mv'],
    targetNodes: ['n-cv'],
    featureNodes: [],
    shapes: { x: [windows, H, 2], u: [windows, P, 1], y: [windows, P, 1] },
    split: { train: nTrain, val: nVal, test: nTest, trainRunIds: [], valRunIds: [], testRunIds: [] },
    norm: { x: { mean: [0, 0], std: [1, 1] }, u: { mean: [0], std: [1] }, y: { mean: [0], std: [1] } },
    beatMs: 1000,
  }, null, 2))
}

const specInfo = {
  variables: [
    { id: 'mv1', nodeId: 'n-mv', role: 'mv', delayMs: 1000 },
    { id: 'cv1', nodeId: 'n-cv', role: 'cv' },
  ],
  beatMs: 1000,
}

test('linear_arx 辨识恢复真实系数(0.7 / 0.5)且 rollout 优于持值基线 ≥20%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-trainer-arx-'))
  writeDataset(dir, { H: 12, P: 4, nRuns: 6, stepsPerRun: 140, gen: () => ({ y: 0, u: 0 }) })
  const ds = readDataset(dir)
  const artifact = trainLinearArx(ds, { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-8, standardize: true }, specInfo)
  // y(t) = a*y(t-1) + b*u(t-1) + c;延迟 1 步、inputOrder=1 → q = d+l-1 = 0 → A[0][uOffset+0]
  const a = artifact.A[0]![0]!
  const uOffset = artifact.layout.uOffset
  const bCoef = artifact.A[0]![uOffset] ?? artifact.D[0]![0] ?? 0
  const c = artifact.bias[0]!
  assert.ok(Math.abs(a - 0.7) < 0.02, `a=${a}`)
  assert.ok(Math.abs(bCoef - 0.5) < 0.02, `b=${bCoef}`)
  assert.ok(Math.abs(c - 10) < 0.5, `c=${c}`)
  assert.ok(artifact.metrics.rolloutImprovement >= 0.2, `improvement=${artifact.metrics.rolloutImprovement}`)
})

test('static_response 一阶/二阶响应面恢复系数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-trainer-static-'))
  // 两个 MV,稳态 y = 10 + 2*u1 - 0.5*u2 + 0.1*u1^2
  mkdirSync(join(dir, 'arrays'), { recursive: true })
  const H = 6
  const P = 2
  const windows: Array<{ x: number[], u: number[], y: number }> = []
  for (let n = 0; n < 60; n++) {
    const u1 = 20 + (n % 20) * 3
    const u2 = 10 + (n % 7) * 2
    const y = 10 + 2 * u1 - 0.5 * u2 + 0.1 * u1 * u1
    const x: number[] = []
    for (let i = 0; i < H; i++) x.push(y, u1, u2)
    windows.push({ x, u: [u1, u2], y })
  }
  const xRows = windows.flatMap(w => w.x)
  const uRows = windows.flatMap(w => [...w.u, ...w.u])
  const yRows = windows.flatMap(w => [w.y, w.y])
  writeFileSync(join(dir, 'arrays', 'x.f32'), Buffer.from(new Float32Array(xRows).buffer))
  writeFileSync(join(dir, 'arrays', 'u.f32'), Buffer.from(new Float32Array(uRows).buffer))
  writeFileSync(join(dir, 'arrays', 'y.f32'), Buffer.from(new Float32Array(yRows).buffer))
  const nTest = 12
  const nVal = 10
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    version: 2, allNodes: ['n-cv', 'n-mv1', 'n-mv2'], controlNodes: ['n-mv1', 'n-mv2'], targetNodes: ['n-cv'], featureNodes: [],
    shapes: { x: [windows.length, H, 3], u: [windows.length, P, 2], y: [windows.length, P, 1] },
    split: { train: windows.length - nTest - nVal, val: nVal, test: nTest, trainRunIds: [], valRunIds: [], testRunIds: [] },
    norm: { x: { mean: [0, 0, 0], std: [1, 1, 1] }, u: { mean: [0, 0], std: [1, 1] }, y: { mean: [0], std: [1] } },
    beatMs: 1000,
  }))
  const ds = readDataset(dir)
  const artifact = trainStaticResponse(ds, { order: 2, ridgeLambda: 1e-8, standardize: true }, {
    variables: [
      { id: 'mv1', nodeId: 'n-mv1', role: 'mv', delayMs: 0 },
      { id: 'mv2', nodeId: 'n-mv2', role: 'mv', delayMs: 0 },
      { id: 'cv1', nodeId: 'n-cv', role: 'cv' },
    ],
    beatMs: 1000,
  })
  const coef = artifact.coefficients.cv1!
  const index = (name: string) => artifact.featureOrder.indexOf(name)
  assert.ok(Math.abs(coef[index('bias')]! - 10) < 0.2, `bias=${coef[index('bias')]}`)
  assert.ok(Math.abs(coef[index('mv1')]! - 2) < 0.1, `w1=${coef[index('mv1')]}`)
  assert.ok(Math.abs(coef[index('mv2')]! + 0.5) < 0.1, `w2=${coef[index('mv2')]}`)
  assert.ok(Math.abs(coef[index('mv1^2')]! - 0.1) < 0.02, `q1=${coef[index('mv1^2')]}`)
  assert.ok(artifact.metrics.holdoutNrmse < 0.05)
})
