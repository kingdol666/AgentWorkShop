/**
 * P3 动作覆盖度 + G6 门单测(科学探索计划,docs/plans/2026-11-02-scientific-exploration-plan.md):
 *  - A3-1 事故同款数据(2 水平且与时间共线)→ G6 FAIL 且 reasons 指出水平数与共线;
 *         4 水平阶梯 → PASS;v1 数据集(无字段)→ unknown 不追溯误杀
 *  - A3-2 ARX 阶跃仿真增益与解析真值一致(相对误差 < 1e-6,远优于 20% 验收线)
 *  - 覆盖度分项:水平聚类容差/切换计数/贴边比例/水平×相位
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-g6-'))

const { computeActionCoverage, assessActionCoverage, assessDatasetActionCoverage, arxStepResponseGain, hasResolvableCoupling } = await import('../server/services/workshop/aml/action-coverage')
const { evaluateGates } = await import('../server/services/workshop/aml/gates')

const thresholds = { minControlLevels: 3, maxCollinearity: 0.9 }

const split = { train: 10, val: 2, test: 2, trainRunIds: ['r1'], valRunIds: ['r2'], testRunIds: ['r3'] }
const okMetrics = {
  oneStepTest: { windows: 10, nrmse: 0.01 },
  oneStepVal: { windows: 10, nrmse: 0.01 },
  rolloutTest: { windows: 5, nrmse: 0.05, horizon: 3 },
  rolloutImprovement: 0.5,
  persistenceNrmse: 0.4,
}
const dataset = { rowCount: 5000, runIds: ['r1', 'r2', 'r3'] }

/** 写一个最小工件目录,满足 G5 工件存在(linear_state_space@1 → model.json) */
function artifactDirWith(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aw-g6-art-${tag}-`))
  writeFileSync(join(dir, 'model.json'), JSON.stringify({ kind: 'linear_state_space@1', stateDim: 1, A: [[0.5]] }))
  return dir
}

function g6Of(checks: Array<{ id: string, pass: boolean, detail: string }>): { id: string, pass: boolean, detail: string } {
  const c = checks.find(x => x.id === 'G6')
  assert.ok(c, '必须产出 G6 检查项')
  return c!
}

describe('A3-1 G6 动作覆盖门', () => {
  it('事故同款(2 水平纯阶梯:前半段 2.6 → 后半段 2.4)→ FAIL', () => {
    const values = Array.from({ length: 600 }, (_, i) => (i < 300 ? 2.6 : 2.4))
    const coverage = computeActionCoverage('dw-blow-sp', values)
    assert.equal(coverage.distinctLevels, 2)
    // 2 水平的 |r| 理论上限 0.866 —— 这正是必须用"连续段"判据的原因
    assert.ok(coverage.collinearityWithTime > 0.86, `|r|=${coverage.collinearityWithTime}`)
    assert.equal(coverage.monolithicSequence, true)
    const a = assessActionCoverage(coverage, thresholds)
    assert.equal(a.pass, false)
    assert.ok(a.reasons.some(r => /仅 2 个水平/.test(r)), a.reasons.join(';'))
    assert.ok(a.reasons.some(r => /单一连续段|纯阶梯/.test(r)), a.reasons.join(';'))

    const report = evaluateGates('mpc_surrogate', dataset, { split, actionCoverage: [coverage] }, okMetrics, artifactDirWith('fail'))
    const g6 = g6Of(report.checks)
    assert.equal(g6.pass, false)
    assert.match(g6.detail, /仅 2 个水平/)
    assert.match(g6.detail, /纯阶梯/)
    assert.equal(report.passed, false, 'G6 不过 → 整体门禁不过')
  })

  it('ABAB 阶梯往返(3 档 × 2 个来回)→ PASS', () => {
    const levels = [2.6, 2.5, 2.4, 2.5, 2.6, 2.5, 2.4, 2.5]
    const values = levels.flatMap(v => new Array<number>(60).fill(v))
    const coverage = computeActionCoverage('dw-blow-sp', values)
    assert.equal(coverage.distinctLevels, 3)
    assert.equal(coverage.monolithicSequence, false)
    assert.ok(coverage.stepCount >= 7)
    const a = assessActionCoverage(coverage, thresholds)
    assert.equal(a.pass, true, a.reasons.join(';'))
    const report = evaluateGates('mpc_surrogate', dataset, { split, actionCoverage: [coverage] }, okMetrics, artifactDirWith('pass'))
    assert.equal(g6Of(report.checks).pass, true, g6Of(report.checks).detail)
    assert.equal(report.passed, true)
  })

  it('3 档单调斜坡(纯阶梯)→ FAIL(与时间不可分,即使档数达标)', () => {
    const values = [2.6, 2.5, 2.4].flatMap(v => new Array<number>(200).fill(v))
    const coverage = computeActionCoverage('dw-ramp', values)
    assert.equal(coverage.distinctLevels, 3)
    assert.equal(coverage.monolithicSequence, true)
    const a = assessActionCoverage(coverage, thresholds)
    assert.equal(a.pass, false)
    assert.match(a.reasons.join(';'), /纯阶梯/)
  })

  it('v1 数据集(无 actionCoverage 字段)→ unknown 放行且 detail 如实说明', () => {
    const report = evaluateGates('mpc_surrogate', dataset, { split }, okMetrics, artifactDirWith('unknown'))
    const g6 = g6Of(report.checks)
    assert.equal(g6.pass, true)
    assert.match(g6.detail, /unknown|未携带/)
  })

  it('无控制列(纯预测器)→ 门不适用但放行', () => {
    const report = evaluateGates('quality_predict', dataset, { split, actionCoverage: [] }, okMetrics, artifactDirWith('none'))
    const g6 = g6Of(report.checks)
    assert.equal(g6.pass, true)
    assert.match(g6.detail, /不适用|未声明/)
  })

  it('长期驻留单一档位 → 给"激励不足"非阻断提示;均匀 ABAB 不触发', () => {
    // 95% 时间停在 2.6,短暂到 2.5/2.4 再回:水平数达标但有效激励少
    const stuck = [...new Array<number>(380).fill(2.6), ...new Array<number>(20).fill(2.4), ...new Array<number>(380).fill(2.6), ...new Array<number>(20).fill(2.5)]
    const coverage = computeActionCoverage('dw-stuck', stuck)
    assert.ok(coverage.saturationRatio > 0.9, `saturation=${coverage.saturationRatio}`)
    const a = assessActionCoverage(coverage, thresholds)
    assert.ok(a.reasons.some(r => /激励不足/.test(r)), a.reasons.join(';'))
    // 均匀 ABAB:每档占比约 1/3,不触发
    const balanced = computeActionCoverage('dw-ok', [2.6, 2.5, 2.4, 2.5, 2.6].flatMap(v => new Array<number>(100).fill(v)))
    assert.ok(balanced.saturationRatio < 0.5)
    assert.equal(assessActionCoverage(balanced, thresholds).pass, true)
  })
})

describe('A3-2 ARX 动作敏感度(阶跃仿真稳态增益)', () => {
  // 一阶系统 y(k) = a·y(k-1) + b·u(k-1) → 稳态增益 b/(1−a)
  const a = 0.5
  const b = 0.3
  // 布局:state = [y_prev, u_prev],x' = A x + B u,y = C x + D u
  const artifact = {
    A: [[a, b], [0, 0]],
    B: [[0], [1]],
    C: [[1, 0]],
    D: [[0]],
    mvOrder: ['dw-blow-sp'],
    cvOrder: ['daq-wall-thickness'],
  }

  it('增益与解析真值一致(0.3/(1−0.5)=0.6)', () => {
    const s = arxStepResponseGain(artifact, 'dw-blow-sp')
    assert.ok(s)
    assert.equal(s!.converged, true)
    const gain = s!.gains['daq-wall-thickness']!
    assert.ok(Math.abs(gain - 0.6) < 1e-6, `gain=${gain}`)
    assert.equal(hasResolvableCoupling(s, 'daq-wall-thickness'), true)
  })

  it('无耦合通道(增益 0)→ hasResolvableCoupling=false(负结论可断言)', () => {
    const s = arxStepResponseGain({ ...artifact, A: [[a, 0], [0, 0]] }, 'dw-blow-sp')
    assert.ok(s)
    assert.ok(Math.abs(s!.gains['daq-wall-thickness']!) < 1e-6)
    assert.equal(hasResolvableCoupling(s, 'daq-wall-thickness'), false)
  })

  it('归一化统计存在时折回物理单位(×std_y/std_u)', () => {
    const s = arxStepResponseGain({
      ...artifact,
      norm: { u: { mean: [0], std: [2] }, y: { mean: [0], std: [0.5] } },
    }, 'dw-blow-sp')
    assert.ok(s)
    // 归一化增益 0.6 → 物理增益 0.6 × 0.5 / 2 = 0.15
    assert.ok(Math.abs(s!.gains['daq-wall-thickness']! - 0.15) < 1e-9)
  })

  it('未收敛(积分型 A)如实标记 converged=false', () => {
    const s = arxStepResponseGain({ ...artifact, A: [[1, b], [0, 0]] }, 'dw-blow-sp')
    assert.ok(s)
    assert.equal(s!.converged, false)
    assert.equal(hasResolvableCoupling(s, 'daq-wall-thickness'), false)
  })

  it('未知控制量 → null(不编造)', () => {
    assert.equal(arxStepResponseGain(artifact, 'dw-not-in-model'), null)
  })
})

describe('assessDatasetActionCoverage 汇总语义', () => {
  it('任一控制列不过 → 数据集整体不过;全过 → 过', () => {
    const good = computeActionCoverage('dw-a', [2.6, 2.5, 2.4, 2.5, 2.6].flatMap(v => new Array<number>(50).fill(v)))
    const bad = computeActionCoverage('dw-b', [2.6, 2.6, 2.6])
    assert.equal(assessDatasetActionCoverage([good], thresholds).pass, true)
    assert.equal(assessDatasetActionCoverage([good, bad], thresholds).pass, false)
    assert.equal(assessDatasetActionCoverage([], thresholds).applicable, false)
  })
})
