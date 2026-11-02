/**
 * P1 可辨识性引擎单测(纯函数)+ P0 事故回放验收(docs/plans/2026-11-02-scientific-exploration-plan.md):
 *  - A1-1 合成信号:窗长 < 3×主导周期 → UNDERPOWERED 且建议窗 = 3×周期;充分窗 + 真实阶跃 → IDENTIFIABLE
 *  - A1-2 控制量与时间共线(|r|>0.9)→ CONFOUNDED
 *  - A1-3 事故夹具(吹压SP 2.6→2.4 / 4.71min 振荡 / 47s 探索窗)→ UNDERPOWERED + 建议窗 ≈ 14.1 min
 *  - 负结果语义:窗口充分但 CI 含 0 → IDENTIFIABLE(!significant),不是 UNDERPOWERED
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assessIdentifiability, probit, distinctLevels, effectiveN, dominantPeriod, bootstrapEffectCi } from '../server/services/workshop/aml/identifiability'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296
  }
}

/** 周期振荡 + 噪声合成序列(确定性) */
function oscillation(periodBeats: number, n: number, opts: { amplitude?: number, noise?: number, shift?: number, seed?: number, phase?: number } = {}): number[] {
  const amp = opts.amplitude ?? 1
  const noise = opts.noise ?? 0.05
  const shift = opts.shift ?? 0
  const phase = opts.phase ?? 0
  const uni = mulberry32(opts.seed ?? 7)
  const out: number[] = []
  let spare: number | null = null
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(1e-12, uni())
    const u2 = uni()
    const mag = Math.sqrt(-2 * Math.log(u1))
    const g = spare ?? mag * Math.cos(2 * Math.PI * u2)
    spare = spare != null ? null : mag * Math.sin(2 * Math.PI * u2)
    out.push(shift + amp * Math.sin((2 * Math.PI * i) / periodBeats + phase) + noise * g)
  }
  return out
}

describe('identifiability 统计基元', () => {
  it('probit 反 CDF 与标准值一致(1.96/0.84 口径)', () => {
    assert.ok(Math.abs(probit(0.975) - 1.959964) < 1e-5)
    assert.ok(Math.abs(probit(0.8) - 0.8416212) < 1e-6)
  })

  it('distinctLevels 容差聚类(SP 2.6/2.4 两水平)', () => {
    assert.equal(distinctLevels([2.6, 2.6, 2.4, 2.4, 2.6000000001]), 2)
    assert.equal(distinctLevels([2.6, 2.6, 2.6]), 1)
    assert.equal(distinctLevels([]), 0)
  })

  it('effectiveN:AR(1) 高自相关显著收缩有效样本量', () => {
    const n = 1000
    assert.ok(Math.abs(effectiveN(new Array(n).fill(0), 0) - n) < 1e-9)
    assert.ok(effectiveN(new Array(n).fill(0), 0.9) < n * 0.06)
    assert.equal(effectiveN(new Array(47).fill(0), 0.999), 2)
  })

  it('dominantPeriod:60 拍周期正弦检出 lag≈60', () => {
    const r = dominantPeriod(oscillation(60, 600, { amplitude: 1, noise: 0.05 }))
    assert.ok(r.lagBeats != null && Math.abs(r.lagBeats - 60) <= 2, `lagBeats=${r.lagBeats}`)
    assert.ok(r.peakCorr > 0.8)
  })

  it('bootstrapEffectCi 同种子逐位可复现', () => {
    const pre = oscillation(60, 300, { noise: 0.05, seed: 11 })
    const post = oscillation(60, 300, { noise: 0.05, seed: 12, shift: 0.2 })
    const a = bootstrapEffectCi(pre, post, { seed: 42 })
    const b = bootstrapEffectCi(pre, post, { seed: 42 })
    assert.deepEqual(a, b)
  })
})

describe('assessIdentifiability 判定语义', () => {
  it('A1-1a 响应窗 < 3×周期 → UNDERPOWERED,建议窗 = 3×周期', () => {
    const pre = oscillation(60, 600, { seed: 1 })
    const post = oscillation(60, 30, { seed: 2, phase: 0.7, shift: 0.3 })
    const v = assessIdentifiability({ pre, post, beatMs: 1000 })
    assert.equal(v.verdict, 'UNDERPOWERED')
    assert.equal(v.suggestedWindowMs, 180_000)
    assert.ok(v.postCoveragePeriods != null && v.postCoveragePeriods < 3)
    assert.match(v.reasons.join(';'), /主导扰动周期|分辨率不足/)
  })

  it('A1-1b 充分窗 + 真实阶跃 → IDENTIFIABLE,CI 覆盖真值', () => {
    const pre = oscillation(60, 600, { seed: 3 })
    const post = oscillation(60, 300, { seed: 4, phase: 0.7, shift: 0.3 })
    const v = assessIdentifiability({ pre, post, beatMs: 1000 })
    assert.equal(v.verdict, 'IDENTIFIABLE')
    assert.equal(v.significant, true)
    assert.ok(v.ciLow != null && v.ciLow < 0.3 && v.ciHigh != null && v.ciHigh > 0.3, `ci=[${v.ciLow}, ${v.ciHigh}]`)
  })

  it('负结果语义:窗口充分但无效应 → IDENTIFIABLE 且 significant=false(不是 UNDERPOWERED)', () => {
    const pre = oscillation(60, 600, { seed: 5 })
    const post = oscillation(60, 300, { seed: 6, phase: 0.7 })
    const v = assessIdentifiability({ pre, post, beatMs: 1000 })
    assert.equal(v.verdict, 'IDENTIFIABLE')
    assert.equal(v.significant, false)
    assert.match(v.reasons.join(';'), /负结论/)
  })

  it('A1-2 控制量与时间序号共线(|r|>0.9)→ CONFOUNDED', () => {
    const pre = oscillation(60, 600, { seed: 7 })
    const post = oscillation(60, 300, { seed: 8, shift: 0.3 })
    const control = [...Array(900).keys()].map(i => 2.6 - 0.2 * (i / 899))
    const v = assessIdentifiability({ pre, post, beatMs: 1000, control })
    assert.equal(v.verdict, 'CONFOUNDED')
    assert.ok(v.collinearity != null && v.collinearity > 0.9)
    assert.match(v.reasons.join(';'), /共线/)
  })

  it('控制量单水平(无对照差分)→ CONFOUNDED', () => {
    const pre = oscillation(60, 300, { seed: 9 })
    const post = oscillation(60, 300, { seed: 10 })
    const v = assessIdentifiability({ pre, post, beatMs: 1000, control: new Array(600).fill(2.6) })
    assert.equal(v.verdict, 'CONFOUNDED')
    assert.match(v.reasons.join(';'), /水平/)
  })

  it('判据 MDE:关心效应量超出分辨率 → UNDERPOWERED;罩得住 → 不因判据降级', () => {
    const pre = oscillation(60, 600, { seed: 13 })
    const post = oscillation(60, 300, { seed: 14, phase: 0.7, shift: 0.3 })
    const base = assessIdentifiability({ pre, post, beatMs: 1000 })
    assert.ok(base.mde != null && base.mde > 0)
    const over = assessIdentifiability({ pre, post, beatMs: 1000, targetMde: base.mde * 0.5 })
    assert.equal(over.verdict, 'UNDERPOWERED')
    assert.match(over.reasons.join(';'), /判据效应量/)
    const under = assessIdentifiability({ pre, post, beatMs: 1000, targetMde: base.mde * 1.5 })
    assert.equal(under.verdict, 'IDENTIFIABLE')
    assert.equal(under.significant, true)
  })

  it('窗内未覆盖一个完整周期(慢振荡+短窗)→ UNDERPOWERED,不得判有效应(事故形态)', () => {
    // 周期 282 拍,窗只取 60 拍:相邻窗相位不同 → 均值差看似显著,实为相位伪影
    const slow = (n: number, phase: number) => Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / 282 + phase))
    const v = assessIdentifiability({ pre: slow(60, 0), post: slow(60, 1.2), beatMs: 1000 })
    assert.equal(v.verdict, 'UNDERPOWERED')
    assert.match(v.reasons.join(';'), /未覆盖一个完整扰动周期|相位/)
    assert.equal(v.significant, false, '守卫生效时不得声称显著')
  })

  it('恒定序列的浮点残差不算效应(负结论,不是假阳性)', () => {
    const flat = new Array<number>(900).fill(0.28)
    const v = assessIdentifiability({ pre: flat, post: flat, beatMs: 1000 })
    assert.equal(v.verdict, 'IDENTIFIABLE')
    assert.equal(v.significant, false)
    const jitter = flat.map((x, i) => x + (i % 2 === 0 ? 1e-15 : -1e-15))
    const v2 = assessIdentifiability({ pre: flat, post: jitter, beatMs: 1000 })
    assert.equal(v2.significant, false, 'epsilon 级差分必须视为无效应')
  })

  it('拍数不足 → INSUFFICIENT_DATA(不装判)', () => {
    const v = assessIdentifiability({ pre: [1, 2, 3, 4, 5], post: [1, 2, 3, 4, 5], beatMs: 1000 })
    assert.equal(v.verdict, 'INSUFFICIENT_DATA')
  })
})

describe('A1-3 事故回放(吹压SP 2.6→2.4 / 4.71min 振荡 / 47s 探索窗)', () => {
  const fixturePath = join(import.meta.dirname, 'fixtures', 'identifiability-incident-replay.json')
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
    meta: { periodMin: number, beatMs: number, settleSeconds: number, spFrom: number, spTo: number, preMinutes: number }
    target: { pre: number[], post: number[] }
    control: { pre: number[], post: number[] }
  }

  it('夹具形状与事故参数一致', () => {
    assert.equal(fixture.meta.periodMin, 4.71)
    assert.equal(fixture.meta.settleSeconds, 47)
    assert.equal(fixture.meta.spFrom, 2.6)
    assert.equal(fixture.meta.spTo, 2.4)
    assert.equal(fixture.target.pre.length, fixture.meta.preMinutes * 60)
    assert.equal(fixture.target.post.length, 47)
  })

  it('引擎判定:UNDERPOWERED + 建议窗 ≈ 3×4.71min ≈ 14.1min(事故会被门禁挡住)', () => {
    const v = assessIdentifiability({
      pre: fixture.target.pre,
      post: fixture.target.post,
      beatMs: fixture.meta.beatMs,
      control: [...fixture.control.pre, ...fixture.control.post],
    })
    assert.equal(v.verdict, 'UNDERPOWERED')
    const periodMs = fixture.meta.periodMin * 60_000
    assert.ok(v.dominantPeriodMs != null && Math.abs(v.dominantPeriodMs - periodMs) <= 4000, `dominantPeriodMs=${v.dominantPeriodMs}`)
    assert.ok(v.suggestedWindowMs != null && Math.abs(v.suggestedWindowMs - 3 * periodMs) <= 12_000, `suggestedWindowMs=${v.suggestedWindowMs}`)
    assert.ok(v.postCoveragePeriods != null && v.postCoveragePeriods < 0.25)
    assert.ok(v.mde != null && v.mde > 0, `mde=${v.mde}`)
    // 单步干预(边界阶跃)不构成平滑共线 —— 混杂语义不误伤
    assert.ok(v.collinearity != null && v.collinearity < 0.9)
    assert.match(v.reasons.join(';'), /主导扰动周期/)
    assert.match(v.reasons.join(';'), /分辨率不足|响应窗仅覆盖/)
  })

  it('门槛值对齐事故叙述:14.1 min = 3 × 4.71 min', () => {
    const periodMs = fixture.meta.periodMin * 60_000
    assert.equal(Math.round((3 * periodMs) / 60000 * 10) / 10, 14.1)
  })
})
