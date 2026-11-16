/**
 * injection-model —— 注塑成型产线物理引擎。
 *
 * 设备链:注塑主机(机筒四区+螺杆塑化) → 注射/保压单元 → 模具(模温机+锁模)
 *   → 冷却水单元 → 制品质量检测站(克重/飞边/缩痕/尺寸/壁厚轮廓/外观)。
 *
 * 核心机理(与真机一致的因果方向):
 *   熔体温度 = 机筒四区加权 + 螺杆剪切热(约 +0.11℃/rpm),一阶滞后
 *   注射压力 ∝ 注射速度 × 粘度(Arrhenius)——速度快/料温低 → 压力升高
 *   制品克重 W = f(保压压力 +, 保压时间 +, 熔温 −):保压把熔体补缩进模腔,
 *     熔温越高比容越大、同一模腔出件越轻
 *   飞边 = 保压/注射压力超过锁模余量后急剧上升;模温越高越易飞边
 *   缩痕 = 保压不足(补缩不够)或模温过低(表面过早冻结);与克重同源于「补缩量」
 *   尺寸偏差 = 保压(负相关,收缩回退)与模温(正相关,热膨胀)共同决定
 *   生产节拍 = 基础循环 + 保压时间 + 模温(冷却 dominates):质量与产能此消彼长
 *
 * 控制问题形态:把克重调回规格窗(32.5±0.35 g)的同时飞边/缩痕/尺寸都在
 *   约束内——保压低了缩痕超、高了飞边超,是典型的「窗口寻优」问题。
 */
import type { InjectionParams, PlantOptimum } from '../../shared/types'

export interface InjectionControls {
  barrelTemp1: number
  barrelTemp2: number
  barrelTemp3: number
  barrelTemp4: number
  screw: number
  injectSpeed: number
  holdPressure: number
  holdTime: number
  moldTemp: number
  clampForce: number
  coolWater: number
}

export interface InjectionStepResult {
  truth: Record<string, number>
  exposed: Record<string, number>
  /** 壁厚轮廓(48 点,mm) */
  profile: number[]
}

export const DEFAULT_INJECTION_PARAMS: InjectionParams = {
  tauZone: 16,
  tauMelt: 7,
  tauMold: 10,
  coolCouple: 0.5,
  zoneW: [0.28, 0.26, 0.24, 0.22],
  kW: 0.052,
  kWt: 0.05,
  kWT: 0.011,
  flashStart: 68,
  flashK: 0.042,
  sinkBase: 2.6,
  sinkK: 0.046,
  weightTarget: 32.5,
  weightTol: 0.35,
  noiseTemp: 0.35,
  noiseWeight: 0.04,
  noiseQuality: 0.03,
}

/**
 * 预设缺省工况(次优起点,待闭环寻优):
 * 保压 45 bar 偏低 → 克重 ≈31.3 g(规格 32.5±0.35 下偏轻)+ 缩痕 ≈3%;
 * 模温 40℃ 偏低;注射速度 85 mm/s 中性。飞边 ≈0(保压远低于起始阈值)。
 */
export const INJECTION_NOMINAL: InjectionControls = {
  barrelTemp1: 240,
  barrelTemp2: 246,
  barrelTemp3: 252,
  barrelTemp4: 258,
  screw: 120,
  injectSpeed: 85,
  holdPressure: 45,
  holdTime: 6,
  moldTemp: 40,
  clampForce: 1600,
  coolWater: 24,
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gaussOf(rand: () => number): () => number {
  let spare: number | null = null
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s }
    let u = 0, v = 0
    while (u === 0) u = rand()
    while (v === 0) v = rand()
    const mag = Math.sqrt(-2 * Math.log(u))
    spare = mag * Math.sin(2 * Math.PI * v)
    return mag * Math.cos(2 * Math.PI * v)
  }
}

// ---------- 稳态代数解(离线评分 / W* 网格 / 测试锚点) ----------

export interface InjectionSteady {
  meltTemp: number
  viscosityRatio: number
  injPressure: number
  moldTempEff: number
  partWeight: number
  flash: number
  sink: number
  dimDev: number
  cycleTime: number
  waterTemp: number
  coolFlow: number
}

/** 稳态代数解:全部状态到达平衡后的解(动态模型收敛于此,±0.5% 内) */
export function injectionSteady(c: InjectionControls, p: InjectionParams, heaterDecay = 1): InjectionSteady {
  const tz = [c.barrelTemp1, c.barrelTemp2, c.barrelTemp3, c.barrelTemp4]
  const zoneAvg = tz.reduce((s, z, i) => s + z * heaterDecay * p.zoneW[i]!, 0)
  const meltTemp = 0.94 * zoneAvg + 0.11 * c.screw
  const vr = Math.exp(2600 * (1 / (meltTemp + 273.15) - 1 / (245 + 273.15)))
  const injPressure = 42 * Math.pow(c.injectSpeed / 80, 0.85) * Math.pow(vr, 0.5) + 8
  // 模温机:冷却水温偏高会顶高模具实际温度(冷却能力不足)
  const moldTempEff = c.moldTemp + Math.max(0, c.coolWater - 25) * p.coolCouple
  const partWeight = 31.0
    + p.kW * (c.holdPressure - 40)
    + p.kWt * (c.holdTime - 4)
    - p.kWT * (meltTemp - 235)
    + 0.004 * (c.injectSpeed - 80)
  const flash = Math.max(0,
    0.05
    + p.flashK * (c.holdPressure - p.flashStart)
    + 0.006 * (injPressure - 95)
    + 0.004 * (moldTempEff - 55)
    + Math.max(0, 1500 - c.clampForce) * 0.0002)
  const sink = Math.max(0,
    p.sinkBase
    - p.sinkK * (c.holdPressure - 40)
    - 0.11 * (c.holdTime - 4)
    + 0.010 * (moldTempEff - 40))
  const dimDev = -0.00055 * (c.holdPressure - 70) + 0.0013 * (moldTempEff - 45) + 0.0008 * (meltTemp - 245)
  const cycleTime = 6.5 + 0.30 * (moldTempEff - 20) + 0.42 * c.holdTime + 0.020 * (meltTemp - 235)
  const waterTemp = c.coolWater
  const coolFlow = 25 + 0.55 * (60 - waterTemp)
  return { meltTemp, viscosityRatio: vr, injPressure, moldTempEff, partWeight, flash, sink, dimDev, cycleTime, waterTemp, coolFlow }
}

/**
 * 目标函数 J ∈ [0,100]:克重窗 + 飞边/缩痕/尺寸约束 + 节拍(产能)。
 * 硬约束(违反 → null):飞边 > 0.8%(模具损伤级)、缩痕 > 2.5%(批量废品级)。
 */
export function scoreInjection(c: InjectionControls, p: InjectionParams, s: InjectionSteady): number | null {
  if (s.flash > 0.8) return null
  if (s.sink > 2.5) return null
  const soft = (x: number, tol: number, span: number) =>
    Math.abs(x) <= tol ? 1 : clamp(1 - Math.pow((Math.abs(x) - tol) / span, 2), 0, 1)
  const jW = soft(s.partWeight - p.weightTarget, p.weightTol, 3 * p.weightTol)
  const jF = s.flash <= 0.4 ? 1 : clamp(1 - Math.pow((s.flash - 0.4) / 0.4, 2), 0, 1)
  const jS = s.sink <= 1.5 ? 1 : clamp(1 - Math.pow((s.sink - 1.5) / 1.0, 2), 0, 1)
  const jD = soft(s.dimDev, 0.05, 0.15)
  const jCycle = clamp((26 - s.cycleTime) / 10, 0, 1)
  return 55 * jW + 15 * jF + 15 * jS + 10 * jD + 5 * jCycle
}

/** W* 离线网格搜索(ground truth):保压×保压时间×模温×注射速度,其余取标称。 */
export function injectionGridSearchOptimum(params?: Partial<InjectionParams>): PlantOptimum {
  const p: InjectionParams = { ...DEFAULT_INJECTION_PARAMS, ...params }
  let best: { score: number, c: InjectionControls, s: InjectionSteady } | null = null
  for (let hold = 60; hold <= 90; hold += 2) {
    for (let holdTime = 5; holdTime <= 11; holdTime += 1) {
      for (let mold = 30; mold <= 70; mold += 5) {
        for (let inject = 60; inject <= 110; inject += 10) {
          const c: InjectionControls = { ...INJECTION_NOMINAL, holdPressure: hold, holdTime, moldTemp: mold, injectSpeed: inject }
          const s = injectionSteady(c, p)
          const j = scoreInjection(c, p, s)
          if (j == null) continue
          if (!best || j > best.score) best = { score: j, c, s }
        }
      }
    }
  }
  if (!best) return { score: 0, computedAt: new Date().toISOString() }
  return {
    score: Number(best.score.toFixed(2)),
    computedAt: new Date().toISOString(),
    settings: {
      holdPressure: best.c.holdPressure,
      holdTime: best.c.holdTime,
      moldTemp: best.c.moldTemp,
      injectSpeed: best.c.injectSpeed,
    },
    defect: Number(Math.max(best.s.flash, best.s.sink).toFixed(3)),
  }
}

// ---------- 动态模型(一阶滞后;质量量对滞后态准稳态) ----------

export class InjectionModel {
  readonly params: InjectionParams
  private rand: () => number
  private gauss: () => number
  private seed = 42
  elapsedS = 0

  private Tz: number[] = [25, 25, 25, 25]
  private melt = 25
  private mold = 25
  private clampKnn = 0
  private waterT = 24

  constructor(params?: Partial<InjectionParams>, seed = 42) {
    this.params = { ...DEFAULT_INJECTION_PARAMS, ...params }
    this.seed = seed
    const r = mulberry32(seed)
    this.rand = r
    this.gauss = gaussOf(r)
  }

  reset(seed: number, cold: boolean): void {
    this.seed = seed
    const r = mulberry32(seed)
    this.rand = r
    this.gauss = gaussOf(r)
    this.elapsedS = 0
    if (cold) {
      this.Tz = [25, 25, 25, 25]
      this.melt = 25
      this.mold = 25
      this.clampKnn = 0
      this.waterT = 24
      return
    }
    const c = INJECTION_NOMINAL
    this.Tz = [c.barrelTemp1, c.barrelTemp2, c.barrelTemp3, c.barrelTemp4]
    const s = injectionSteady(c, this.params)
    this.melt = s.meltTemp
    this.mold = s.moldTempEff
    this.clampKnn = c.clampForce
    this.waterT = c.coolWater
  }

  private lag(cur: number, target: number, tau: number, dt: number): number {
    const alpha = 1 - Math.exp(-dt / Math.max(tau, 0.1))
    return cur + (target - cur) * alpha
  }

  sampleRand(): number {
    return this.rand()
  }

  step(c: InjectionControls, dtSec: number, opt: { heaterDecay?: number } = {}): InjectionStepResult {
    const p = this.params
    const hd = opt.heaterDecay ?? 1
    this.elapsedS += dtSec

    // 机筒四区一阶 + 熔体跟随
    const spZ = [c.barrelTemp1, c.barrelTemp2, c.barrelTemp3, c.barrelTemp4]
    for (let i = 0; i < 4; i++) this.Tz[i] = this.lag(this.Tz[i]!, spZ[i]! * hd, p.tauZone, dtSec)
    const zoneAvg = this.Tz.reduce((s, z, i) => s + z * p.zoneW[i]!, 0)
    this.melt = this.lag(this.melt, 0.94 * zoneAvg + 0.11 * c.screw, p.tauMelt, dtSec)

    // 模温机/冷却水/锁模
    this.waterT = this.lag(this.waterT, c.coolWater, 8, dtSec)
    const moldTarget = c.moldTemp + Math.max(0, this.waterT - 25) * p.coolCouple
    this.mold = this.lag(this.mold, moldTarget, p.tauMold, dtSec)
    this.clampKnn = this.lag(this.clampKnn, c.clampForce, 6, dtSec)

    // 稳态质量量(作用于当前滞后态)
    const vr = Math.exp(2600 * (1 / (this.melt + 273.15) - 1 / (245 + 273.15)))
    const injPressure = 42 * Math.pow(c.injectSpeed / 80, 0.85) * Math.pow(vr, 0.5) + 8
    const partWeight = 31.0
      + p.kW * (c.holdPressure - 40)
      + p.kWt * (c.holdTime - 4)
      - p.kWT * (this.melt - 235)
      + 0.004 * (c.injectSpeed - 80)
    const flash = Math.max(0,
      0.05
      + p.flashK * (c.holdPressure - p.flashStart)
      + 0.006 * (injPressure - 95)
      + 0.004 * (this.mold - 55)
      + Math.max(0, 1500 - this.clampKnn) * 0.0002)
    const sink = Math.max(0,
      p.sinkBase
      - p.sinkK * (c.holdPressure - 40)
      - 0.11 * (c.holdTime - 4)
      + 0.010 * (this.mold - 40))
    const dimDev = -0.00055 * (c.holdPressure - 70) + 0.0013 * (this.mold - 45) + 0.0008 * (this.melt - 245)
    const cycleTime = 6.5 + 0.30 * (this.mold - 20) + 0.42 * c.holdTime + 0.020 * (this.melt - 235)

    // 壁厚轮廓(48 点:克重驱动基准 + 抛物 + 噪声)
    const baseW = 2.50 + (partWeight - 32.5) * 0.012
    const profile: number[] = []
    for (let i = 0; i < 48; i++) {
      const xh = (i / 47) * 2 - 1
      profile.push(Number((baseW * (1 - 0.006 * xh * xh) * (1 + this.gauss() * 0.002)).toFixed(4)))
    }

    const truth: Record<string, number> = {
      meltTemp: this.melt, meltPressure: injPressure, moldTemp: this.mold,
      clampForce: this.clampKnn, injPressure, waterTemp: this.waterT,
      coolFlow: 25 + 0.55 * (60 - this.waterT),
      partWeight, flash, sink, dimDev, cycleTime,
    }
    const exposed: Record<string, number> = {
      meltTemp: this.melt + this.gauss() * p.noiseTemp,
      meltPressure: injPressure + this.gauss() * 0.8,
      moldTemp: this.mold + this.gauss() * p.noiseTemp,
      clampForce: this.clampKnn + this.gauss() * 4,
      injPressure: injPressure + this.gauss() * 0.8,
      waterTemp: this.waterT + this.gauss() * 0.2,
      coolFlow: 25 + 0.55 * (60 - this.waterT) + this.gauss() * 0.5,
      partWeight: partWeight + this.gauss() * p.noiseWeight,
      flash: Math.max(0, flash + this.gauss() * p.noiseQuality),
      sink: Math.max(0, sink + this.gauss() * p.noiseQuality * 3),
      dimDev: dimDev + this.gauss() * 0.004,
      cycleTime,
      image: flash,
    }
    return { truth, exposed, profile }
  }
}
