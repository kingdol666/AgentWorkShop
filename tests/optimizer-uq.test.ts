/** SW3/D2/D3/D4 UQ 证据单测:双模式/门限硬底/emit 条件/inputDistance/分类门。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-sw3-uq-'))

const { computeBlockUq, coverageThreshold, inputDistance, isUqFresh } = await import('../server/services/workshop/optimization/uq-evidence')
const { classifyRecommendation } = await import('../server/services/workshop/optimization/recommendation.service')

after(() => {
  try {
    rmSync(process.env.AW_HOME!, { recursive: true, force: true })
  }
  catch { /* 并行会话可能已清理 */ }
})

function scores(blocks: number, cvs: number, hit: (b: number, j: number) => number): number[][] {
  return Array.from({ length: blocks }, (_, b) => Array.from({ length: cvs }, (_, j) => hit(b, j)))
}

test('D2 双模式:≥9 块+≥2 run → split_conformal;2-8 块 → empirical_max(coverage 必须=1)', () => {
  // 10 val 块(10 run×1块)校准分数 1..10;test 全部 ≤ 分位 → conformal
  const conformal = computeBlockUq({
    valScoresPerCv: scores(10, 1, b => b + 1),
    testScoresPerCv: scores(4, 1, () => 9),
    nValRuns: 10, nTestRuns: 4, nUniqueTestSteps: 480, horizon: 1,
  })
  assert.equal(conformal.uq?.method, 'split_conformal')
  assert.equal(conformal.uq?.nValBlocks, 10)
  assert.ok((conformal.uq?.coverageTest ?? 0) >= 0.8)
  // 2 块 → empirical_max,安全系数 1.25;若 test 有超出 → coverage<1
  const empirical = computeBlockUq({
    valScoresPerCv: scores(2, 1, () => 4),
    testScoresPerCv: scores(4, 1, () => 4),
    nValRuns: 2, nTestRuns: 4, nUniqueTestSteps: 480, horizon: 1,
  })
  assert.equal(empirical.uq?.method, 'empirical_max')
  assert.equal(empirical.uq?.safetyFactor, 1.25)
  assert.equal(empirical.uq?.coverageTest, 1)
  const empiricalMiss = computeBlockUq({
    valScoresPerCv: scores(2, 1, () => 4),
    testScoresPerCv: scores(4, 1, b => (b === 0 ? 100 : 4)),
    nValRuns: 2, nTestRuns: 4, nUniqueTestSteps: 480, horizon: 1,
  })
  assert.ok((empiricalMiss.uq?.coverageTest ?? 1) < 1, 'empirical_max 命中失败必须反映在 coverage')
})

test('D2 emit 条件:nTestRuns<2 或 nUniqueTestSteps<120 → 不发证;单 val 块 → 不发证', () => {
  const few = computeBlockUq({
    valScoresPerCv: scores(3, 1, () => 1),
    testScoresPerCv: scores(1, 1, () => 1),
    nValRuns: 3, nTestRuns: 1, nUniqueTestSteps: 480, horizon: 1,
  })
  assert.equal(few.uq, null)
  const short = computeBlockUq({
    valScoresPerCv: scores(3, 1, () => 1),
    testScoresPerCv: scores(2, 1, () => 1),
    nValRuns: 3, nTestRuns: 2, nUniqueTestSteps: 100, horizon: 1,
  })
  assert.equal(short.uq, null)
  const oneVal = computeBlockUq({
    valScoresPerCv: scores(1, 1, () => 1),
    testScoresPerCv: scores(2, 1, () => 1),
    nValRuns: 1, nTestRuns: 2, nUniqueTestSteps: 480, horizon: 1,
  })
  assert.equal(oneVal.uq, null)
})

test('D3 门限:0.8 硬底(nTestRuns=2 时不得塌缩);empirical_max 必须 1.0', () => {
  assert.equal(coverageThreshold({ method: 'split_conformal', nTestRuns: 2 }), 0.8)
  assert.equal(coverageThreshold({ method: 'split_conformal', nTestRuns: 4 }), 0.8)
  assert.ok(coverageThreshold({ method: 'split_conformal', nTestRuns: 100 }) > 0.8)
  assert.equal(coverageThreshold({ method: 'empirical_max', nTestRuns: 4 }), 1.0)
})

test('D4 inputDistance:MV+CV 双偏移;σ≈0 → ∞;列数不符 → null', () => {
  const normU = { mean: [50], std: [10] }
  const normY = { mean: [50], std: [8] }
  assert.ok(Math.abs(inputDistance({ currentU: [60], currentY: [50], normU, normY })! - 1) < 1e-12)
  assert.ok(Math.abs(inputDistance({ currentU: [50], currentY: [66], normU, normY })! - 2) < 1e-12)
  assert.equal(inputDistance({ currentU: [50], currentY: [50], normU: { mean: [50], std: [0] }, normY }).toString(), 'Infinity')
  assert.equal(inputDistance({ currentU: [50, 1], currentY: [50], normU, normY }), null)
  assert.equal(inputDistance({ currentU: [Number.NaN], currentY: [50], normU, normY }), null)
})

test('分类门:coverage 低于阈值/OOD>3/距离 null → unverified;完整证据 → verified;旧 ONNX(无 uq)→ unverified', () => {
  const base = { method: 'split_conformal' as const, nTestRuns: 4, calibratedAt: new Date().toISOString() }
  const ok = { ...base, coverageTest: 0.95, calibrationFresh: true, inputDistance: 0.5 }
  assert.equal(classifyRecommendation({ evidenceSource: 'simulation', uqEvidence: ok, candidateFeasible: true }).status, 'verified')
  // coverage 低于 0.8 硬底
  assert.equal(classifyRecommendation({ evidenceSource: 'simulation', uqEvidence: { ...ok, coverageTest: 0.7 }, candidateFeasible: true }).status, 'unverified')
  // empirical_max coverage 0.95 < 1.0 → 拒
  assert.equal(classifyRecommendation({ evidenceSource: 'simulation', uqEvidence: { ...ok, method: 'empirical_max' as const }, candidateFeasible: true }).status, 'unverified')
  // OOD
  assert.equal(classifyRecommendation({ evidenceSource: 'simulation', uqEvidence: { ...ok, inputDistance: 3.1 }, candidateFeasible: true }).status, 'unverified')
  // 距离未评估
  assert.equal(classifyRecommendation({ evidenceSource: 'simulation', uqEvidence: { ...ok, inputDistance: null }, candidateFeasible: true }).status, 'unverified')
  // 校准过期
  assert.equal(classifyRecommendation({ evidenceSource: 'simulation', uqEvidence: { ...ok, calibrationFresh: false }, candidateFeasible: true }).status, 'unverified')
  // 旧 ONNX/无 uq
  assert.equal(classifyRecommendation({ evidenceSource: 'simulation', uqEvidence: null, candidateFeasible: true }).status, 'unverified')
  // 证据来源未评估
  assert.equal(classifyRecommendation({ evidenceSource: 'unassessed', uqEvidence: ok, candidateFeasible: true }).status, 'unverified')
})

test('isUqFresh:超过 aml.uq.freshDays(默认 7 天)→ 过期', () => {
  assert.equal(isUqFresh({ calibratedAt: new Date().toISOString() }), true)
  assert.equal(isUqFresh({ calibratedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }), false)
  assert.equal(isUqFresh({ calibratedAt: 'not-a-date' }), false)
})
