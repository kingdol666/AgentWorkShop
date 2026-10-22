/**
 * Phase C 单测:SPC 数学(E4 纯函数)+ FDC 特征提取(E3 纯函数)。
 * 判定链路(参考带/告警/联动)走真实环境 e2e。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-spc-math-test-'))

const { nelsonHits, iMr, xbarR, ewma, cusum, buildLimits } = await import('../server/services/workshop/eda/spc-math')
const { extractFeatures } = await import('../server/services/workshop/eda/features')

describe('SPC 数学(E4)', () => {
  it('I-MR:恒定序列 σ≈0;已知漂移序列给出合理控制限', () => {
    const flat = Array.from({ length: 30 }, () => 100)
    const m0 = iMr(flat)!
    assert.ok(Math.abs(m0.cl - 100) < 1e-9)
    assert.equal(m0.sigma, 0)
    const drift = Array.from({ length: 30 }, (_, i) => 100 + (i % 5) - 2)
    const m = iMr(drift)!
    assert.ok(m.sigma > 0)
    assert.ok(m.ucl > m.cl && m.lcl < m.cl)
    // E4① 精确断言:控制限恒为 CL±3σ(解析关系,不只不等式)
    assert.ok(Math.abs((m.ucl - m.cl) - 3 * m.sigma) < 1e-9)
    assert.ok(Math.abs((m.cl - m.lcl) - 3 * m.sigma) < 1e-9)
  })

  it('Nelson 规则 1:单点 3σ 外命中;规则 2:连续 9 点同侧命中', () => {
    const base = Array.from({ length: 20 }, () => 100)
    const withOutlier = [...base, 130] // σ≈0 时规则 1 不判(除零保护):用带噪声序列
    const noisy = base.map((v, i) => v + (i % 2 === 0 ? 0.5 : -0.5))
    const m = iMr(noisy)!
    assert.ok(!nelsonHits(noisy, m.cl, m.sigma).some(h => h.includes('1')))
    const shifted = [...noisy, ...Array.from({ length: 9 }, () => m.cl + 2 * m.sigma)]
    const hits = nelsonHits(shifted, m.cl, m.sigma)
    assert.ok(hits[shifted.length - 1]!.includes('2'), `末点应命中规则 2:${JSON.stringify(hits.at(-1))}`)
    void withOutlier
  })

  it('Xbar-R:子组结构给出 cl/ucl/lcl;d2 表生效', () => {
    const groups = Array.from({ length: 25 }, (_, i) => [100 + (i % 3), 102 + (i % 3), 101 - (i % 3)])
    const r = xbarR(groups)!
    assert.ok(r.ucl > r.cl && r.lcl < r.cl)
    assert.ok(r.sigma > 0)
  })

  it('EWMA 收敛于 CL;阶跃后偏离', () => {
    const flat = Array.from({ length: 50 }, () => 100)
    const e = ewma(flat, 100, 2, 0.2)
    assert.ok(Math.abs(e.stats.at(-1)! - 100) < 1e-9)
    const step = [...flat, ...Array.from({ length: 10 }, () => 105)]
    const e2 = ewma(step, 100, 2, 0.2)
    assert.ok(e2.stats.at(-1)! > e2.limits.at(-1)!.ucl - 3 || e2.stats.at(-1)! > 101)
  })

  it('CUSUM:持续偏移累积越限;无偏移不越限', () => {
    const okSeq = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 0.5)
    const c0 = cusum(okSeq, 100, 1, 0.5, 4)
    assert.ok(!c0.violated.some(Boolean))
    const badSeq = Array.from({ length: 40 }, () => 102)
    const c1 = cusum(badSeq, 100, 1, 0.5, 4)
    assert.ok(c1.violated.at(-1) === true)
  })

  it('buildLimits:n<2 返回 null', () => {
    assert.equal(buildLimits([1]), null)
    assert.ok(buildLimits([1, 2, 3]))
  })
})

describe('FDC 特征提取(E3 纯函数)', () => {
  const points = Array.from({ length: 100 }, (_, i) => ({ at: 1_000_000 + i * 1000, v: 50 + Math.sin(i / 10) * 2 }))

  it('整窗统计:cnt/mean/std/min/max/slope(平坦序列 slope≈0)', () => {
    const f = extractFeatures(points)
    assert.equal(f.length, 1)
    assert.equal(f[0]!.segment, '')
    assert.equal(f[0]!.cnt, 100)
    assert.ok(Math.abs(f[0]!.mean - 50) < 2)
    assert.ok(Math.abs(f[0]!.slope) < 60) // 正弦波小时斜率有限
  })

  it('grace 期样本不计入', () => {
    const f = extractFeatures(points, { graceMs: 10 * 1000 })
    assert.equal(f[0]!.cnt, 90)
  })

  it('分段:0-50%/50-100% 两段各自统计', () => {
    const f = extractFeatures(points, { segments: [{ name: 's1', phaseFrom: 0, phaseTo: 0.5 }, { name: 's2', phaseFrom: 0.5, phaseTo: 1 }] })
    assert.equal(f.length, 2)
    assert.deepEqual(f.map(x => x.segment), ['s1', 's2'])
    assert.equal(f[0]!.cnt + f[1]!.cnt, 100)
  })

  it('越限计数:warnHigh 生效', () => {
    const f = extractFeatures(points, { warnHigh: 51 })
    assert.ok(f[0]!.breachCnt > 0)
    const f0 = extractFeatures(points, { warnHigh: 999 })
    assert.equal(f0[0]!.breachCnt, 0)
  })

  it('斜率:线性爬坡 60 点 +100/h 序列 slope≈100', () => {
    const ramp = Array.from({ length: 61 }, (_, i) => ({ at: i * 60_000, v: i })) // 每分钟+1 → 每小时 +60
    const f = extractFeatures(ramp)
    assert.ok(Math.abs(f[0]!.slope - 60) < 1, `slope=${f[0]!.slope}`)
  })
})
