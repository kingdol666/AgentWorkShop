/**
 * anneal-model —— 连续退火产线(冷轧低碳钢带)物理引擎。
 *
 * 设备链:加热段炉(均热三区) → 炉内传动与张力(线速度=产能) → 冷却与过时效段
 *   → 保护气单元(H2/Nx 混合 + 露点) → 成品质量检测站(硬度/抗拉/屈服/晶粒/表面/板形)。
 *
 * 核心机理(与真机一致的因果方向):
 *   带钢温度 = 0.95×炉温加权 − 线速敏感(快了加热不足) + H2 传热增益
 *   退热指数 SMP = (带温−Ac1 参考温)×驻留时间(驻留 = 加热段长/线速) —— 再结晶驱动量
 *   硬度 HV = 基值 + 欠退火幅度×e^(−SMP/τ) —— 欠退火(硬/脆)随 SMP 指数软化
 *   抗拉 = f(硬度, 冷却速率);晶粒 = √SMP(Hall-Petch 方向:晶粒大→软)
 *   表面缺陷 ← 露点高(氧化) / H2 低(还原不足) / 带温超窗(过热)
 *   产能 ∝ 线速度 —— 质量窗内的最高线速 = 最优解(多目标:质量约束 + 产能最大)
 *
 * 控制问题形态:起始欠退火(硬度 ≈135-163 HV,目标 95±6)→ 先把炉温/线速
 *   调回再结晶窗,再在质量窗内逐级推高线速(产能)直到硬度触边回退。
 */
import type { AnnealParams, PlantOptimum } from '../../shared/types'

export interface AnnealControls {
  zone1: number
  zone2: number
  zone3: number
  lineSpeed: number
  oaTemp: number
  coolRate: number
  h2: number
}

export interface AnnealStepResult {
  truth: Record<string, number>
  exposed: Record<string, number>
  /** 板形轮廓(48 点,I-Unit) */
  profile: number[]
}

export const DEFAULT_ANNEAL_PARAMS: AnnealParams = {
  heatLength: 90,
  zoneW: [0.25, 0.35, 0.4],
  stripGain: 0.95,
  stripSpeedK: 0.16,
  h2HeatK: 0.25,
  smpT0: 680,
  smpTau: 700,
  hvBase: 96,
  hvAmp: 28,
  tsK: 0.42,
  tsBase: 295,
  noiseTemp: 0.8,
  noiseQuality: 0.7,
}

/**
 * 预设缺省工况(次优起点:欠退火,硬度远超目标 95±6 HV,待闭环寻优):
 * 均热三区 (690,710,730)℃ 偏低 + 线速 140 m/min 偏快 → SMP<0(再结晶未完成)。
 * H2 10%,过时效 400℃,冷却 50%。
 */
export const ANNEAL_NOMINAL: AnnealControls = {
  zone1: 690,
  zone2: 710,
  zone3: 730,
  lineSpeed: 140,
  oaTemp: 400,
  coolRate: 50,
  h2: 10,
}

/** 质量规格:硬度窗 + 抗拉窗 + 表面等级(DC04 类冲压板的模拟简化) */
export const ANNEAL_SPEC = { hvTarget: 95, hvTol: 6, tsTarget: 300, tsTol: 25, surfaceMax: 0.5 } as const

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

export interface AnnealSteady {
  zoneAvg: number
  stripTemp: number
  soakS: number
  smp: number
  grainSize: number
  hardness: number
  tensile: number
  yieldStr: number
  surfaceDef: number
  throughput: number
}

/** 稳态代数解 */
export function annealSteady(c: AnnealControls, p: AnnealParams, heaterDecay = 1): AnnealSteady {
  const tz = [c.zone1, c.zone2, c.zone3]
  const zoneAvg = tz.reduce((s, z, i) => s + z * heaterDecay * p.zoneW[i]!, 0)
  const stripTemp = p.stripGain * zoneAvg - p.stripSpeedK * (c.lineSpeed - 120) + p.h2HeatK * (c.h2 - 10)
  const soakS = (p.heatLength / Math.max(c.lineSpeed, 20)) * 60
  const smp = (stripTemp - p.smpT0) * soakS
  const grainSize = 5.0 + 0.0035 * Math.sqrt(Math.max(0, smp))
  const hardness = Math.min(185,
    p.hvBase + p.hvAmp * Math.exp(-smp / p.smpTau) + 0.010 * (c.oaTemp - 400) + 0.035 * (c.coolRate - 50))
  const tensile = p.tsBase + p.tsK * (hardness - p.hvBase) + 0.10 * (c.coolRate - 50)
  const yieldStr = 150 + 0.55 * (hardness - p.hvBase)
  const surfaceDef = Math.max(0.05,
    0.15
    + Math.max(0, 8 - c.h2) * 0.06
    + Math.max(0, stripTemp - 790) * 0.03)
  const throughput = c.lineSpeed * 60 * 1.05 / 1000 // t/h 量纲近似(带宽×厚度归一)
  return { zoneAvg, stripTemp, soakS, smp, grainSize, hardness, tensile, yieldStr, surfaceDef, throughput }
}

/** 目标函数 J ∈ [0,100]:硬度/抗拉窗 + 表面约束 + 产能(线速)。
 *  硬约束(违反 → null):表面缺陷 > 1.0%、硬度 > 130(欠退火废品级)。 */
export function scoreAnneal(c: AnnealControls, p: AnnealParams, s: AnnealSteady): number | null {
  if (s.surfaceDef > 1.0) return null
  if (s.hardness > 130) return null
  const soft = (x: number, tol: number, span: number) =>
    Math.abs(x) <= tol ? 1 : clamp(1 - Math.pow((Math.abs(x) - tol) / span, 2), 0, 1)
  const jHv = soft(s.hardness - ANNEAL_SPEC.hvTarget, ANNEAL_SPEC.hvTol, 2 * ANNEAL_SPEC.hvTol)
  const jTs = soft(s.tensile - ANNEAL_SPEC.tsTarget, ANNEAL_SPEC.tsTol, 3 * ANNEAL_SPEC.tsTol)
  const jSurf = s.surfaceDef <= ANNEAL_SPEC.surfaceMax ? 1 : clamp(1 - (s.surfaceDef - ANNEAL_SPEC.surfaceMax) / 0.5, 0, 1)
  const jThru = clamp((c.lineSpeed - 60) / 160, 0, 1)
  return 40 * jHv + 25 * jTs + 10 * jSurf + 25 * jThru
}

/** W* 离线网格搜索(ground truth):z2/z3 炉温 × 线速 × H2,质量窗内产能最大。 */
export function annealGridSearchOptimum(params?: Partial<AnnealParams>): PlantOptimum {
  const p: AnnealParams = { ...DEFAULT_ANNEAL_PARAMS, ...params }
  let best: { score: number, c: AnnealControls, s: AnnealSteady } | null = null
  for (let zone2 = 700; zone2 <= 800; zone2 += 10) {
    for (let zone3 = 720; zone3 <= 850; zone3 += 10) {
      for (let speed = 80; speed <= 220; speed += 10) {
        for (const h2 of [6, 8, 10, 12, 14]) {
          const c: AnnealControls = { ...ANNEAL_NOMINAL, zone2, zone3, lineSpeed: speed, h2 }
          const s = annealSteady(c, p)
          const j = scoreAnneal(c, p, s)
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
      zone2: best.c.zone2, zone3: best.c.zone3,
      lineSpeed: best.c.lineSpeed, h2: best.c.h2,
    },
    thickness: undefined,
    sigma: Number(best.s.hardness.toFixed(2)),
    defect: Number(best.s.surfaceDef.toFixed(3)),
  }
}

// ---------- 动态模型 ----------

export class AnnealModel {
  readonly params: AnnealParams
  private rand: () => number
  private gauss: () => number
  elapsedS = 0

  private Tz: number[] = [25, 25, 25]
  private strip = 25
  private oa = 25
  private dew = -40
  private speed = 0

  constructor(params?: Partial<AnnealParams>, seed = 42) {
    this.params = { ...DEFAULT_ANNEAL_PARAMS, ...params }
    const r = mulberry32(seed)
    this.rand = r
    this.gauss = gaussOf(r)
  }

  reset(seed: number, cold: boolean): void {
    const r = mulberry32(seed)
    this.rand = r
    this.gauss = gaussOf(r)
    this.elapsedS = 0
    if (cold) {
      this.Tz = [25, 25, 25]
      this.strip = 25
      this.oa = 25
      this.dew = -40
      this.speed = 0
      return
    }
    const c = ANNEAL_NOMINAL
    this.Tz = [c.zone1, c.zone2, c.zone3]
    const s = annealSteady(c, this.params)
    this.strip = s.stripTemp
    this.oa = c.oaTemp
    this.dew = -40
    this.speed = c.lineSpeed
  }

  private lag(cur: number, target: number, tau: number, dt: number): number {
    const alpha = 1 - Math.exp(-dt / Math.max(tau, 0.1))
    return cur + (target - cur) * alpha
  }

  sampleRand(): number {
    return this.rand()
  }

  step(c: AnnealControls, dtSec: number, opt: { heaterDecay?: number } = {}): AnnealStepResult {
    const p = this.params
    const hd = opt.heaterDecay ?? 1
    this.elapsedS += dtSec

    const spZ = [c.zone1, c.zone2, c.zone3]
    for (let i = 0; i < 3; i++) this.Tz[i] = this.lag(this.Tz[i]!, spZ[i]! * hd, 20, dtSec)
    const zoneAvg = this.Tz.reduce((s, z, i) => s + z * p.zoneW[i]!, 0)
    this.speed = this.lag(this.speed, c.lineSpeed, 8, dtSec)
    const stripTarget = p.stripGain * zoneAvg - p.stripSpeedK * (this.speed - 120) + p.h2HeatK * (c.h2 - 10)
    this.strip = this.lag(this.strip, stripTarget, 14, dtSec)
    this.oa = this.lag(this.oa, c.oaTemp, 16, dtSec)

    const soakS = (p.heatLength / Math.max(this.speed, 20)) * 60
    const smp = (this.strip - p.smpT0) * soakS
    const grainSize = 5.0 + 0.0035 * Math.sqrt(Math.max(0, smp))
    const hardness = Math.min(185,
      p.hvBase + p.hvAmp * Math.exp(-smp / p.smpTau) + 0.010 * (this.oa - 400) + 0.035 * (c.coolRate - 50))
    const tensile = p.tsBase + p.tsK * (hardness - p.hvBase) + 0.10 * (c.coolRate - 50)
    const yieldStr = 150 + 0.55 * (hardness - p.hvBase)
    const surfaceDef = Math.max(0.05,
      0.15
      + Math.max(0, 8 - c.h2) * 0.06
      + Math.max(0, this.strip - 790) * 0.03)

    // 板形轮廓(48 点,I-Unit):区温不均 → 边浪/中浪
    const spread = Math.max(...this.Tz) - Math.min(...this.Tz)
    const aEdge = 0.010 + spread * 0.0004
    const profile: number[] = []
    for (let i = 0; i < 48; i++) {
      const xh = (i / 47) * 2 - 1
      profile.push(Number((10 * aEdge * xh * xh * 100 + this.gauss() * 0.8).toFixed(2)))
    }

    const truth: Record<string, number> = {
      furnaceTemp: zoneAvg,
      stripTemp: this.strip,
      actSpeed: this.speed,
      oaTemp: this.oa,
      dewPoint: this.dew,
      h2Act: c.h2,
      hardness, tensile, yieldStr, grainSize, surfaceDef,
      soakS, smp, throughput: this.speed * 60 * 1.05 / 1000,
    }
    const exposed: Record<string, number> = {
      furnaceTemp: zoneAvg + this.gauss() * p.noiseTemp,
      stripTemp: this.strip + this.gauss() * p.noiseTemp,
      actSpeed: this.speed + this.gauss() * 0.5,
      oaTemp: this.oa + this.gauss() * p.noiseTemp,
      dewPoint: this.dew + this.gauss() * 1.5,
      h2Act: c.h2 + this.gauss() * 0.15,
      hardness: hardness + this.gauss() * p.noiseQuality,
      tensile: tensile + this.gauss() * p.noiseQuality * 2,
      yieldStr: yieldStr + this.gauss() * p.noiseQuality,
      grainSize: grainSize + this.gauss() * 0.08,
      surfaceDef: Math.max(0.02, surfaceDef + this.gauss() * 0.03),
    }
    return { truth, exposed, profile }
  }
}
