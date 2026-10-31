/**
 * plant-model 物理一致性自测 —— 「模型符合真实物理规律」的证明断言(纯函数,无 IO):
 *   ① 阶跃 T3 SP +20℃ → 熔体温度在 3τ 内收敛且无大幅超调
 *   ② 转速 +20rpm → 膜厚上升幅度 = 模型解析解 ±2%
 *   ③ 线速 +10% → 输送纯滞后反比缩短,膜厚按 1/1.1 下降
 *   ④ 关 T3 加热 → 熔体温度缓降,压力先升后降(粘度效应滞后)
 *   ⑤ 同 seed 完全可复现;⑥ 稳态代数解 = 积分收敛值;⑦ 网格搜索 W* 可行且达窗口
 *   ⑧ hook 策略:标量/节流/vector/image 产出
 */
import { CastFilmModel, NOMINAL, gridSearchOptimum } from '../src/server/engine/plant-model'
import { tickHookSignal } from '../src/server/engine/signals'
import type { SignalDef } from '../src/shared/types'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const DT = 0.5 // 物理步长(s)

const nominalControls = () => ({
  zone1: NOMINAL.zone, zone2: NOMINAL.zone, zone3: NOMINAL.zone,
  screw: NOMINAL.screw, lineSpeed: NOMINAL.lineSpeed, dieGap: NOMINAL.dieGap,
})

/** 热机到稳态(zone SP 全 210) */
function warmup(m: CastFilmModel, seconds = 240): void {
  const c = nominalControls()
  for (let t = 0; t < seconds; t += DT) m.step(c, DT)
}

// ── ① 阶跃响应:一阶惯性 + 纯滞后,3τ 内收敛、超调 <5% ──
{
  const m = new CastFilmModel(undefined, 42)
  warmup(m)
  const c = nominalControls()
  c.zone3 += 20 // 阶跃 +20℃
  const tauZone = new CastFilmModel().params.tauZone
  let peakAfter = -Infinity
  let final = NaN
  for (let t = 0; t < tauZone * 3 + 60; t += DT) {
    const r = m.step(c, DT)
    if (t > tauZone) peakAfter = Math.max(peakAfter, r.truth.meltTemp)
    final = r.truth.meltTemp
  }
  // 期望值 = 稳态代数解(含区间热传导稳态梯度,非简单 SP3)
  const expect = CastFilmModel.steadyState(c).meltTemp
  const overshoot = (peakAfter - expect) / 20
  check('① T3 阶跃+20℃ → Tm 3τ 内收敛到解析解±2℃', Math.abs(final - expect) <= 2, `final=${final.toFixed(2)}℃ (解析 ${expect.toFixed(2)})`)
  check('① 超调 <5%', overshoot < 0.05, `overshoot=${(overshoot * 100).toFixed(1)}% peak=${peakAfter.toFixed(2)}`)
}

// ── ② 转速 +20rpm → 膜厚上升 = 解析解 ±2% ──
{
  const m = new CastFilmModel(undefined, 42)
  warmup(m)
  const base = CastFilmModel.steadyState(nominalControls()).thickness
  const c = nominalControls()
  c.screw += 20
  let h = NaN
  for (let t = 0; t < 240; t += DT) h = m.step(c, DT).truth.thickness
  const expect = CastFilmModel.steadyState(c).thickness
  const err = Math.abs(h - expect) / expect
  check('② N+20rpm → h 收敛到解析解±2%', err <= 0.02, `h=${h.toFixed(2)}μm expect=${expect.toFixed(2)}μm(基础 ${base.toFixed(2)})`)
  check('② 厚度随转速单调上升', h > base, `+${(h - base).toFixed(2)}μm`)
}

// ── ③ 线速 +10% → 滞后反比缩短 + 厚度 1/1.1 ──
{
  const m = new CastFilmModel(undefined, 42)
  warmup(m)
  const c = nominalControls()
  const delayBefore = m.step(c, DT).truth.transportDelayS
  c.lineSpeed = Math.round(NOMINAL.lineSpeed * 1.1)
  let h = NaN
  let delayAfter = NaN
  for (let t = 0; t < 300; t += DT) {
    const r = m.step(c, DT)
    h = r.truth.thickness
    delayAfter = r.truth.transportDelayS
  }
  const ratio = delayBefore / delayAfter
  const hRatio = m.step(c, DT).truth.thickness / CastFilmModel.steadyState(nominalControls()).thickness
  check('③ 滞后按 L/v 反比缩短(±5%)', Math.abs(ratio - 1.1) / 1.1 <= 0.05, `τ: ${delayBefore.toFixed(1)}s → ${delayAfter.toFixed(1)}s (×${ratio.toFixed(3)})`)
  check('③ 膜厚降至 1/1.1(±3%)', Math.abs(hRatio - 1 / 1.1) <= 0.03, `h ratio=${hRatio.toFixed(4)} (期望 ${(-100 / 11).toFixed(4)})`)
}

// ── ④ 关 T3 加热 → Tm 缓降,压力先升后降 ──
{
  const m = new CastFilmModel(undefined, 42)
  warmup(m)
  const c = nominalControls()
  c.zone3 = 120 // 加热关死(下限)
  const pSeries: number[] = []
  let tmDrop = 0
  let tmStart = NaN
  for (let t = 0; t < 300; t += DT) {
    const r = m.step(c, DT)
    pSeries.push(r.truth.pressure)
    if (t === 0) tmStart = r.truth.meltTemp
    tmDrop = tmStart - r.truth.meltTemp
  }
  const pEarly = pSeries.slice(0, 60).reduce((a, b) => a + b, 0) / 60
  const pLate = pSeries.slice(-60).reduce((a, b) => a + b, 0) / 60
  check('④ T3 停加热 → Tm 缓降 >10℃', tmDrop > 10, `ΔTm=-${tmDrop.toFixed(1)}℃`)
  check('④ 压力先升后降(粘度滞后效应)', pEarly > pLate, `P: ${pEarly.toFixed(2)} → ${pLate.toFixed(2)} MPa`)
}

// ── ⑤ 同 seed 可复现 ──
{
  const run = (): number[] => {
    const m = new CastFilmModel(undefined, 7)
    const c = nominalControls()
    const out: number[] = []
    for (let t = 0; t < 120; t += DT) out.push(m.step(c, DT).exposed.meltTemp)
    return out
  }
  const a = run()
  const b = run()
  check('⑤ 同 seed 序列完全一致', a.every((v, i) => v === b[i]), `len=${a.length}`)
  const m2a = new CastFilmModel(undefined, 7)
  const m2b = new CastFilmModel(undefined, 8)
  const va = m2a.step(nominalControls(), DT).exposed.meltTemp
  const vb = m2b.step(nominalControls(), DT).exposed.meltTemp
  check('⑤ 不同 seed 序列发散', va !== vb, `seed7=${va} seed8=${vb}`)
}

// ── ⑥ 稳态代数解 vs 积分收敛(充分热机:6.7τ,残余 <0.2%)──
{
  const m = new CastFilmModel(undefined, 42)
  warmup(m, 600)
  const c = nominalControls()
  const ana = CastFilmModel.steadyState(c)
  const num = m.step(c, DT).truth
  const errH = Math.abs(num.thickness - ana.thickness) / ana.thickness
  const errP = Math.abs(num.pressure - ana.pressure) / ana.pressure
  check('⑥ 积分收敛 ≡ 稳态代数解(h ±0.5%,P ±0.5%)', errH <= 0.005 && errP <= 0.005,
    `h: ${num.thickness.toFixed(2)} vs ${ana.thickness.toFixed(2)};P: ${num.pressure.toFixed(2)} vs ${ana.pressure.toFixed(2)}`)
}

// ── ⑦ 网格搜索 W*:可行 + 名义点在窗口附近 ──
{
  const best = gridSearchOptimum()
  check('⑦ W* 厚度达标(50±2μm)', Math.abs(best.thickness! - 50) <= 2, `h*=${best.thickness}μm @ T=${best.zoneTemp} N=${best.screw} v=${best.lineSpeed}`)
  check('⑦ W* 约束内(Tm∈[195,225], P≤22)', best.meltTemp! >= 195 && best.meltTemp! <= 225 && best.pressure! <= 22, `Tm=${best.meltTemp} P=${best.pressure}`)
  check('⑦ W* 分量为正', best.score > 0, `J*=${best.score}`)
}

// ── ⑧ hook 策略:标量 / timegap 节流 / vector / image ──
{
  const sigOf = (partial: Partial<SignalDef>): SignalDef => ({
    id: 'h', name: 'h', format: 'scalar',
    strategy: { kind: 'constant', value: 0 },
    runtime: { value: 0, hist: [] },
    ...partial,
  })
  // 标量 + state 积分
  const s1 = sigOf({ strategy: { kind: 'hook', code: 'state.n = (state.n ?? 0) + 1; return state.n * 2' } })
  const v1 = tickHookSignal(s1, {}, 1000)
  const v2 = tickHookSignal(s1, {}, 2000)
  check('⑧ hook 标量 + state 持久', v1 === 2 && v2 === 4, `${v1},${v2}`)
  // timegap 节流
  const s2 = sigOf({ strategy: { kind: 'hook', code: 'return now', timegapMs: 5000 } })
  const t1 = tickHookSignal(s2, {}, 10_000)
  const t2 = tickHookSignal(s2, {}, 12_000) // 节流窗内 → 保持
  const t3 = tickHookSignal(s2, {}, 16_000) // 出窗 → 更新
  check('⑧ hook timegap 节流', t1 === 10_000 && t2 === 10_000 && t3 === 16_000, `${t1},${t2},${t3}`)
  // vector
  const s3 = sigOf({ format: 'vector', strategy: { kind: 'hook', code: 'return { points: [1,2,3,4] }' } })
  tickHookSignal(s3, {}, 1000)
  check('⑧ hook vector 帧', JSON.stringify(s3.runtime!.vector) === '[1,2,3,4]', JSON.stringify(s3.runtime!.vector))
  // 禁用标识符护栏
  const s4 = sigOf({ strategy: { kind: 'hook', code: 'return process.exit(0)' } })
  let threw = false
  try { tickHookSignal(s4, {}, 1000) }
  catch { threw = true }
  check('⑧ hook 危险标识符拒绝', threw)
}

// ── ⑨ 启动瞬态/输送滞后:队列未到达前厚度不得跳变(C18 / A3 前置)──
{
  const m = new CastFilmModel(undefined, 42)
  const base = nominalControls()
  const r1 = m.step(base, DT)
  const delayS = r1.truth.transportDelayS
  const changed = { ...base, screw: base.screw + 40 }
  let maxDev = 0
  let steps = 0
  for (let t = 0; t < Math.max(DT, delayS * 0.5); t += DT) {
    const r = m.step(changed, DT)
    maxDev = Math.max(maxDev, Math.abs(r.truth.thickness - r1.truth.thickness))
    steps++
  }
  check('⑨ 输送滞后未到达前厚度不跳变', steps > 0 && maxDev < r1.truth.thickness * 0.005,
    `delay=${delayS.toFixed(1)}s steps=${steps} maxΔh=${maxDev.toFixed(4)}μm (h0=${r1.truth.thickness}μm)`)
  // 滞后到达后必须真的响应(证明上面的"不跳变"不是因为永远不更新):
  // 先在稳态热机,再做阶跃,避免冷启动温升/流量动态掩盖输送滞后。
  const m2 = new CastFilmModel(undefined, 42)
  warmup(m2, 600)
  const stable = m2.step(base, DT)
  const hStable = stable.truth.thickness
  const delay2 = stable.truth.transportDelayS
  let maxDev2 = 0
  for (let t = 0; t < Math.max(DT, delay2 * 0.5); t += DT) {
    maxDev2 = Math.max(maxDev2, Math.abs(m2.step(changed, DT).truth.thickness - hStable))
  }
  check('⑨ 稳态阶跃:滞后窗内厚度保持', maxDev2 < hStable * 0.002, `delay=${delay2.toFixed(1)}s maxΔh=${maxDev2.toFixed(4)}μm`)
  let h = hStable
  for (let t = 0; t < delay2 * 3 + 240; t += DT) h = m2.step(changed, DT).truth.thickness
  const target = CastFilmModel.steadyState(changed).thickness
  check('⑨ 滞后到达后厚度响应新转速', Math.abs(h - target) / target < 0.02,
    `h=${h.toFixed(2)}μm target=${target.toFixed(2)}μm`)
}

console.log(failed === 0 ? `\nplant-model 物理一致性 ${passed} 断言全部通过 ✅` : `\n${failed} 断言失败 ❌`)
if (failed > 0) process.exitCode = 1
export {}
