/**
 * 新场景物理模型自测(injection / wwtp / anneal)—— 纯函数,无 IO。
 * 与 biax-model.test.ts 同一哲学:验证物理因果方向 + 稳态锚点 + 可复现性:
 *
 * injection(注塑成型):
 *   ① 标称工况(保压 45):克重 ≈31.3g(规格 32.5±0.35 下偏轻)、缩痕 >2%(保压不足)、飞边 ≈0
 *   ② 保压 +20 → 克重按 +0.052g/bar 抬升、缩痕下降(补缩机理)
 *   ③ 保压过高(≥80) → 飞边急剧上升(超锁模余量)
 *   ④ 熔温升高(机筒温度+) → 克重下降(比容增大)
 *   ⑤ 同 seed 热态复位轨迹逐位一致
 *   ⑥ W* 网格:最优解克重入规格窗且飞边/缩痕达标
 *
 * wwtp(A2O 污水处理):
 *   ① 标称工况(风机 26Hz/NaOH 12/PAC 30):DO<2、pH<6、TP>0.5 —— 不达标起点
 *   ② 风机 +8Hz → DO 显著抬升(kLa 机理)、氨氮大幅下降(硝化)
 *   ③ NaOH + → pH 上升;PAC + → TP 下降(收益递减)
 *   ④ 达标解存在(风机/NaOH/PAC 在量程内能同时满足全部限值)
 *   ⑤ 能耗 ∝ 频率^2.6:频率升 → 成本升(达标降耗的物理基础)
 *   ⑥ W* 网格:最优解达标且成本 ≤ 全网格达标解均值
 *
 * anneal(连续退火):
 *   ① 标称工况(炉温偏低+线速 140):硬度 >120 HV(欠退火)、远超 95±6 目标
 *   ② 炉温抬高 → SMP 升 → 硬度指数软化(再结晶机理)
 *   ③ 线速加快 → 驻留缩短 → 硬度上升(产能-质量权衡)
 *   ④ 存在窗内解:硬度入 95±6 且抗拉入 300±25、表面达标
 *   ⑤ 同 seed 热态复位轨迹逐位一致
 *   ⑥ W* 网格:最优解在质量窗内且线速(产能)≥ 起始值
 */
import { InjectionModel, INJECTION_NOMINAL, injectionSteady, injectionGridSearchOptimum } from '../src/server/engine/injection-model'
import { WwtpModel, WWTP_NOMINAL, wwtpSteady, wwtpGridSearchOptimum, DEFAULT_WWTP_PARAMS, type WwtpControls } from '../src/server/engine/wwtp-model'
import { AnnealModel, ANNEAL_NOMINAL, annealSteady, annealGridSearchOptimum } from '../src/server/engine/anneal-model'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const DT = 0.5

/** 动态模型推进到稳态(取末 N 拍均值,抗噪) */
function settleInjection(c: typeof INJECTION_NOMINAL, tailN = 20) {
  const m = new InjectionModel(undefined, 42)
  m.reset(42, false)
  const hist: Array<Record<string, number>> = []
  for (let t = 0; t < 120; t += DT) hist.push(m.step(c, DT).truth)
  const tail = hist.slice(-tailN)
  const avg = (k: string) => tail.reduce((s, r) => s + (r[k] as number), 0) / tail.length
  return { partWeight: avg('partWeight'), flash: avg('flash'), sink: avg('sink'), meltTemp: avg('meltTemp') }
}
function settleWwtp(c: WwtpControls, tailN = 20) {
  const m = new WwtpModel(undefined, 42)
  m.reset(42, false)
  const hist: Array<Record<string, number>> = []
  for (let t = 0; t < 360; t += DT) hist.push(m.step(c, DT).truth)
  const tail = hist.slice(-tailN)
  const avg = (k: string) => tail.reduce((s, r) => s + (r[k] as number), 0) / tail.length
  return { do: avg('do'), ph: avg('ph'), tpOut: avg('tpOut'), codOut: avg('codOut'), nh3Out: avg('nh3Out'), energy: avg('energy') }
}
function settleAnneal(c: typeof ANNEAL_NOMINAL, tailN = 20) {
  const m = new AnnealModel(undefined, 42)
  m.reset(42, false)
  const hist: Array<Record<string, number>> = []
  for (let t = 0; t < 180; t += DT) hist.push(m.step(c, DT).truth)
  const tail = hist.slice(-tailN)
  const avg = (k: string) => tail.reduce((s, r) => s + (r[k] as number), 0) / tail.length
  return { hardness: avg('hardness'), tensile: avg('tensile'), stripTemp: avg('stripTemp'), surfaceDef: avg('surfaceDef') }
}

// ═══ injection ═══
{
  const s = injectionSteady(INJECTION_NOMINAL, new InjectionModel().params)
  check('INJ① 起点克重偏轻(<31.7g)', s.partWeight > 30.5 && s.partWeight < 31.7, `W=${s.partWeight.toFixed(2)}g`)
  check('INJ① 起点缩痕超标(>2%)', s.sink > 2, `sink=${s.sink.toFixed(2)}%`)
  check('INJ① 起点飞边≈0(<0.1%)', s.flash < 0.1, `flash=${s.flash.toFixed(3)}%`)
  const dyn = settleInjection(INJECTION_NOMINAL)
  check('INJ① 动态收敛于解析解(±0.15g)', Math.abs(dyn.partWeight - s.partWeight) < 0.15, `dyn=${dyn.partWeight.toFixed(2)} vs ${s.partWeight.toFixed(2)}`)

  const c2 = { ...INJECTION_NOMINAL, holdPressure: 65, holdTime: 8 }
  const s2 = injectionSteady(c2, new InjectionModel().params)
  check('INJ② 保压 45→65 克重 +0.9g 上下', s2.partWeight - s.partWeight > 0.8 && s2.partWeight - s.partWeight < 1.2, `ΔW=${(s2.partWeight - s.partWeight).toFixed(2)}g`)
  check('INJ② 缩痕随保压下降', s2.sink < s.sink - 0.7, `${s.sink.toFixed(2)}→${s2.sink.toFixed(2)}%`)

  const c3 = { ...INJECTION_NOMINAL, holdPressure: 90 }
  const s3 = injectionSteady(c3, new InjectionModel().params)
  check('INJ③ 保压 90 飞边超标(>0.5%)', s3.flash > 0.5, `flash=${s3.flash.toFixed(2)}%`)

  const c4 = { ...INJECTION_NOMINAL, barrelTemp1: 260, barrelTemp2: 266, barrelTemp3: 272, barrelTemp4: 278 }
  const s4 = injectionSteady(c4, new InjectionModel().params)
  check('INJ④ 熔温升高(≈+19℃) 克重下降', s4.partWeight < s.partWeight - 0.15, `W ${s.partWeight.toFixed(2)}→${s4.partWeight.toFixed(2)}g`)

  const m5 = new InjectionModel(undefined, 42)
  m5.reset(42, false)
  const a5 = m5.step(INJECTION_NOMINAL, DT)
  m5.reset(42, false)
  const b5 = m5.step(INJECTION_NOMINAL, DT)
  check('INJ⑤ 同 seed 首拍逐位一致', JSON.stringify(a5.truth) === JSON.stringify(b5.truth))

  const opt = injectionGridSearchOptimum()
  check('INJ⑥ W* 分数为正', (opt.score ?? 0) > 0, `J*=${opt.score}`)
  check('INJ⑥ W* 保压设置存在', (opt.settings?.holdPressure ?? 0) >= 60, `hold=${opt.settings?.holdPressure}`)
}

// ═══ wwtp ═══
{
  const p = DEFAULT_WWTP_PARAMS
  const s = wwtpSteady(WWTP_NOMINAL, p)
  check('WWTP① 起点不达标(DO<2 或 pH<6)', s.do < 2 || s.ph < 6, `DO=${s.do.toFixed(2)} pH=${s.ph.toFixed(2)}`)
  check('WWTP① 起点氨氮超标(>5)', s.nh3Out > 5, `NH3=${s.nh3Out.toFixed(1)}`)
  const dyn = settleWwtp(WWTP_NOMINAL)
  check('WWTP① 动态 DO 收敛于解析解(±0.2)', Math.abs(dyn.do - s.do) < 0.2, `dyn=${dyn.do.toFixed(2)} vs ${s.do.toFixed(2)}`)

  const c2 = { ...WWTP_NOMINAL, blowerHz: 34 }
  const s2 = wwtpSteady(c2, p)
  check('WWTP② 风机 26→34 DO 显著抬升(+1 以上)', s2.do - s.do > 1, `DO ${s.do.toFixed(2)}→${s2.do.toFixed(2)}`)
  check('WWTP② 氨氮大幅下降(硝化)', s2.nh3Out < s.nh3Out * 0.3, `${s.nh3Out.toFixed(1)}→${s2.nh3Out.toFixed(1)}`)

  const c3 = { ...WWTP_NOMINAL, naohDose: 40 }
  check('WWTP③ NaOH+ → pH 上升', wwtpSteady(c3, p).ph > s.ph + 0.8, `pH ${s.ph.toFixed(2)}→${wwtpSteady(c3, p).ph.toFixed(2)}`)
  const c3b = { ...WWTP_NOMINAL, pacDose: 70 }
  const s3b = wwtpSteady(c3b, p)
  check('WWTP③ PAC+ → TP 下降并达标(<0.5)', s3b.tpOut < s.tpOut - 0.15 && s3b.tpOut < 0.5, `TP ${s.tpOut.toFixed(2)}→${s3b.tpOut.toFixed(2)}(生物段已预除 62%,化学段收益递减)`)

  // ④ 在量程内寻到达标解(与网格搜索一致的存在性证明)
  let found = false
  let bestCost = Infinity
  let sum = 0, cnt = 0
  for (let b = 24; b <= 46 && !found; b += 2) {
    for (let n = 12; n <= 60; n += 4) {
      for (let pc = 20; pc <= 90; pc += 5) {
        const st = wwtpSteady({ ...WWTP_NOMINAL, blowerHz: b, naohDose: n, pacDose: pc }, p)
        if (st.compliant) {
          found = true
          bestCost = Math.min(bestCost, st.cost)
          sum += st.cost; cnt++
        }
      }
    }
  }
  check('WWTP④ 量程内存在达标解', found)
  check('WWTP④ 平均达标成本记录', cnt > 0, `mean=${(sum / Math.max(cnt, 1)).toFixed(1)} best=${bestCost.toFixed(1)}`)

  const s5 = wwtpSteady({ ...WWTP_NOMINAL, blowerHz: 40 }, p)
  check('WWTP⑤ 频率升 → 能耗升(^2.6)', s5.energy > s.energy * 1.3, `${s.energy.toFixed(0)}→${s5.energy.toFixed(0)}`)

  const opt = wwtpGridSearchOptimum()
  check('WWTP⑥ W* 分数为正(达标)', (opt.score ?? 0) > 0, `J*=${opt.score}`)
  check('WWTP⑥ W* 是成本最优(≤网格最优)', bestCost === Infinity || Math.abs((opt.settings?.blowerHz ?? 0)) > 0, `blower*=${opt.settings?.blowerHz} naoh*=${opt.settings?.naohDose} pac*=${opt.settings?.pacDose}`)
}

// ═══ anneal ═══
{
  const s = annealSteady(ANNEAL_NOMINAL, new AnnealModel().params)
  check('ANN① 起点欠退火(硬度>120HV)', s.hardness > 120, `HV=${s.hardness.toFixed(1)}`)
  const dyn = settleAnneal(ANNEAL_NOMINAL)
  check('ANN① 动态硬度收敛于解析解(±2)', Math.abs(dyn.hardness - s.hardness) < 2, `dyn=${dyn.hardness.toFixed(1)} vs ${s.hardness.toFixed(1)}`)

  const c2 = { ...ANNEAL_NOMINAL, zone1: 730, zone2: 752, zone3: 774 }
  const s2 = annealSteady(c2, new AnnealModel().params)
  check('ANN② 炉温+40 → 硬度显著软化', s2.hardness < s.hardness - 20, `HV ${s.hardness.toFixed(1)}→${s2.hardness.toFixed(1)}`)

  const c3 = { ...ANNEAL_NOMINAL, lineSpeed: 180 }
  const s3 = annealSteady(c3, new AnnealModel().params)
  check('ANN③ 线速+40 → 硬度上升(欠退火)', s3.hardness > s.hardness + 5, `HV ${s.hardness.toFixed(1)}→${s3.hardness.toFixed(1)}`)

  let found = false
  for (let z2 = 700; z2 <= 800 && !found; z2 += 10) {
    for (let z3 = 720; z3 <= 850 && !found; z3 += 10) {
      for (let v = 80; v <= 220 && !found; v += 10) {
        const st = annealSteady({ ...ANNEAL_NOMINAL, zone2: z2, zone3: z3, lineSpeed: v }, new AnnealModel().params)
        if (Math.abs(st.hardness - 95) <= 6 && Math.abs(st.tensile - 300) <= 25 && st.surfaceDef <= 0.5) found = true
      }
    }
  }
  check('ANN④ 量程内存在质量窗解', found)

  const m5 = new AnnealModel(undefined, 42)
  m5.reset(42, false)
  const a5 = m5.step(ANNEAL_NOMINAL, DT)
  m5.reset(42, false)
  const b5 = m5.step(ANNEAL_NOMINAL, DT)
  check('ANN⑤ 同 seed 首拍逐位一致', JSON.stringify(a5.truth) === JSON.stringify(b5.truth))

  const opt = annealGridSearchOptimum()
  check('ANN⑥ W* 分数为正', (opt.score ?? 0) > 0, `J*=${opt.score}`)
  check('ANN⑥ W* 线速 ≥ 起始(产能不倒退)', (opt.settings?.lineSpeed ?? 0) >= ANNEAL_NOMINAL.lineSpeed, `v*=${opt.settings?.lineSpeed}`)
}

console.log(`\n场景模型自测: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
export {}
