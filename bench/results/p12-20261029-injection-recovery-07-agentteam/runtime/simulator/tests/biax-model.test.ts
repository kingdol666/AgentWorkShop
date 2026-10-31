/**
 * biax-model(双拉产线)物理一致性自测 —— 纯函数,无 IO:
 *   ① 标称工况稳态:厚度 ≈27.5μm(次优起点,偏厚待寻优)、熔温/泵压/张力在工艺窗内
 *   ② 铸片速度 +10% → 成品厚度按 ~1/1.1 下降(动态收敛到解析解 ±2%)
 *   ③ 出口轨宽 +10% → 厚度按 ~1/1.1 下降(横向拉伸比机理)
 *   ④ 快辊 +10% → 厚度按 ~1/1.1 下降(纵向拉伸比机理)
 *   ⑤ 拉伸温度跌破窗口 → σ/缺陷急剧恶化(冷拉颈缩)
 *   ⑥ 收卷张力出窗(过高) → 缺陷上升(勒痕)
 *   ⑦ 同 seed 热态复位轨迹逐位一致
 *   ⑧ W* 网格:厚度入 25.0±0.8 规格、分数为正、约束可行
 */
import { BiaxModel, BIAX_NOMINAL, biaxSteady, biaxGridSearchOptimum, scoreBiax, type BiaxControls } from '../src/server/engine/biax-model'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const DT = 0.5 // 物理步长(s)

const c0 = (): BiaxControls => ({ ...BIAX_NOMINAL })

/** 热态复位 + 充分推进到当前控制的稳态 */
function settle(m: BiaxModel, c: BiaxControls, seconds = 240): { thickness: number, sigma: number, defect: number, tension: number, meltTemp: number } {
  m.reset(42, false)
  for (let t = 0; t < seconds; t += DT) m.step(c, DT)
  return m.lastTruth as never
}

// ── ① 标称工况稳态 ──
{
  const s = biaxSteady(c0(), new BiaxModel().params)
  check('① 标称厚度 ≈27.5μm(次优起点)', Math.abs(s.h2 - 27.5) <= 1.5, `h2=${s.h2.toFixed(2)}μm`)
  check('① 熔温在工艺窗 268~300℃', s.meltTemp > 268 && s.meltTemp < 300, `Tm=${s.meltTemp.toFixed(1)}℃`)
  check('① 泵出口压力 ≤32MPa', s.pumpOutlet <= 32, `P=${s.pumpOutlet.toFixed(2)}MPa`)
  check('① 残水 <30ppm(干燥正常)', s.moisture < 30, `m=${s.moisture.toFixed(1)}ppm`)
  check('① 缺陷 <1.0%(标称工况合格)', s.defect < 1.0, `d=${s.defect.toFixed(3)}%`)
}

// ── ②③④ 厚度机理:动态模型收敛到解析解 ──
{
  const p = new BiaxModel().params
  // ② 铸片速度 +10%
  {
    const m = new BiaxModel(undefined, 42)
    const base = settle(m, c0())
    const c = c0(); c.castSpd = c.castSpd * 1.1
    const r = settle(m, c)
    const expect = biaxSteady(c, p).h2
    const err = Math.abs(r.thickness - expect) / expect
    check('② 铸速+10% → 厚度收敛解析解±2%', err <= 0.02, `h=${r.thickness.toFixed(2)} expect=${expect.toFixed(2)}`)
    check('② 厚度随铸速下降(≈1/1.1)', r.thickness < base.thickness * 0.965, `${base.thickness.toFixed(2)}→${r.thickness.toFixed(2)}μm`)
  }
  // ③ 出口轨宽 +10%
  {
    const m = new BiaxModel(undefined, 42)
    settle(m, c0())
    const c = c0(); c.railOut = Math.round(c.railOut * 1.1)
    const r = settle(m, c)
    const expect = biaxSteady(c, p).h2
    const err = Math.abs(r.thickness - expect) / expect
    check('③ 轨宽+10% → 厚度收敛解析解±2%', err <= 0.02, `h=${r.thickness.toFixed(2)} expect=${expect.toFixed(2)}`)
    check('③ 厚度随轨宽下降', r.thickness < biaxSteady(c0(), p).h2 * 0.965, `→${r.thickness.toFixed(2)}μm`)
  }
  // ④ 快辊 +10%(纵向拉伸比)
  {
    const m = new BiaxModel(undefined, 42)
    settle(m, c0())
    const c = c0(); c.fastRoll = c.fastRoll * 1.1
    const r = settle(m, c)
    const expect = biaxSteady(c, p).h2
    const err = Math.abs(r.thickness - expect) / expect
    check('④ 快辊+10% → 厚度收敛解析解±2%', err <= 0.02, `h=${r.thickness.toFixed(2)} expect=${expect.toFixed(2)}`)
  }
}

// ── ⑤ 冷拉惩罚:MDO 预热拉到 70℃(窗口 86~110)→ σ 与缺陷爆炸 ──
{
  const p = new BiaxModel().params
  const good = biaxSteady(c0(), p)
  const c = c0(); c.mdoPreheat1 = 72; c.mdoPreheat2 = 74; c.mdoPreheat3 = 76; c.mdoAnneal = 95
  const bad = biaxSteady(c, p)
  check('⑤ 冷拉:σ 显著恶化(>2×)', bad.sigma > good.sigma * 2, `σ ${good.sigma.toFixed(3)}→${bad.sigma.toFixed(3)}μm`)
  check('⑤ 冷拉:缺陷显著恶化(>3×)', bad.defect > good.defect * 3, `d ${good.defect.toFixed(3)}→${bad.defect.toFixed(3)}%`)
  const m = new BiaxModel(undefined, 42)
  const r = settle(m, c)
  check('⑤ 动态模型复现冷拉缺陷', r.defect > good.defect * 2.5, `d_dyn=${r.defect.toFixed(3)}%`)
}

// ── ⑥ 张力出窗 → 勒痕缺陷 ──
{
  const p = new BiaxModel().params
  const good = biaxSteady(c0(), p)
  const c = c0(); c.windTension = 150 // 超出 55~120 工作窗
  const bad = biaxSteady(c, p)
  check('⑥ 张力 150N → 缺陷上升', bad.defect > good.defect * 1.3, `d ${good.defect.toFixed(3)}→${bad.defect.toFixed(3)}%`)
}

// ── ⑦ 同 seed 热态复位 → 轨迹逐位一致 ──
{
  const run = () => {
    const m = new BiaxModel(undefined, 42)
    m.reset(42, false)
    const out: number[] = []
    for (let t = 0; t < 120; t += DT) out.push(m.step(c0(), DT).truth.thickness)
    return out
  }
  const a = run()
  const b = run()
  const same = a.every((v, i) => v === b[i])
  check('⑦ 同 seed 轨迹逐位一致(可复现)', same, `${a.length} steps ${same ? 'identical' : 'DIVERGED'}`)
}

// ── ⑧ W* 网格搜索 ──
{
  const w = biaxGridSearchOptimum()
  check('⑧ W* 厚度入规格 25.0±0.8μm', Math.abs((w.thickness ?? 0) - 25.0) <= 0.8, `h*=${w.thickness?.toFixed(2)}μm`)
  check('⑧ W* 分数为正且 > 标称工况', (w.score ?? 0) > 0 && w.score! > (scoreBiax(c0(), new BiaxModel().params, biaxSteady(c0(), new BiaxModel().params)) ?? 0), `J*=${w.score} J_nom=${scoreBiax(c0(), new BiaxModel().params, biaxSteady(c0(), new BiaxModel().params))?.toFixed(1)}`)
  check('⑧ W* 约束可行(熔温/泵压)', (w.meltTemp ?? 0) >= 268 && (w.meltTemp ?? 0) <= 300 && (w.pressure ?? 0) <= 32, `Tm*=${w.meltTemp} P*=${w.pressure}`)
}

console.log(`\nbiax-model: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
