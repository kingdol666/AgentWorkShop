/**
 * biax-model —— 双向拉伸薄膜产线(BOPET 类)物理引擎。
 *
 * 全线物料链:干燥上料 → 挤出(机筒五区+螺杆) → 熔体计量泵 → T 模头铸片(急冷辊)
 *   → 纵向拉伸 MDO(预热辊×3 + 慢/快辊拉伸 + 退火辊)
 *   → 横向拉伸 TDO(预热/拉伸/定型烘箱 + 链夹 + 轨道展幅)
 *   → 在线测厚 → 电晕处理/表面检测 → 收卷(张力锥度/接触辊/卷径)。
 *
 * 核心机理(与真机一致的因果方向):
 *   铸片厚度 h0 = Q/(w·v_cast·ρ)            —— 流量与铸片速度决定
 *   纵拉后 h1 = h0/R_md, R_md = v_fast/v_slow —— 拉伸比 = 快慢辊速比
 *   横拉后 h2 = h1/R_td·(1−relax), R_td = 轨出口宽/入口宽
 *   拉伸温度必须在 [Tg+8, Tg+30] 高弹态窗口内:过冷→颈缩/破膜(σ 与缺陷爆炸),
 *   过热→不均匀减薄;定型段温度决定结晶/雾度;收卷张力窗外→皱折/勒痕缺陷。
 *
 * 与 cast-film 的关系:同一套 PlantModelConfig 绑定/真值流/W* 网格搜索契约,
 * kind='biax' 时由 plant-runtime 选择本模型。
 */
import type { BiaxParams, PlantOptimum } from '../../shared/types'

export interface BiaxControls {
  dryTemp: number
  dewPoint: number
  feedRate: number
  zone1: number
  zone2: number
  zone3: number
  zone4: number
  zone5: number
  screw: number
  pump: number
  dieLip: number
  chillTemp: number
  castSpd: number
  pinning: number
  mdoPreheat1: number
  mdoPreheat2: number
  mdoPreheat3: number
  slowRoll: number
  fastRoll: number
  mdoAnneal: number
  tdoPreheat: number
  tdoStretch: number
  tdoAnneal: number
  chain: number
  railOut: number
  corona: number
  windTension: number
  windTaper: number
  windContact: number
  windSpeed: number
}

export interface BiaxStepResult {
  /** 物理真值(未加噪;含评分所需的窗口温度代理) */
  truth: Record<string, number>
  /** 协议暴露值(加噪,Agent 看到的世界) */
  exposed: Record<string, number>
  /** 横向厚度轮廓(64 点) */
  profile: number[]
}

export const DEFAULT_BIAX_PARAMS: BiaxParams = {
  tauDry: 110,
  tauZone: 65,
  kHeat: 0.05,
  tauMelt: 16,
  arrheniusB: 2600,
  mu0: 480,
  tRef: 285,
  flowK: 20.5,
  pumpGain: 17.5,
  tauPump: 5,
  dieWidth: 1.0,
  neckIn: 0.965,
  railInFactor: 0.955,
  trimFraction: 0.06,
  filmDensity: 1390,
  mdoLength: 18,
  tdoLength: 62,
  gaugeDistance: 12,
  tauTension: 4,
  rollCoreDiameter: 0.15,
  tg: 78,
  mdoWindow: [86, 110],
  tdoStretchWindow: [98, 128],
  thicknessTarget: 25.0,
  noiseTemp: 0.35,
  noisePressure: 0.06,
  noiseThickness: 0.09,
  noiseDefect: 0.035,
  noiseMoisture: 0.5,
}

/** 预设缺省工况(次优起点:厚度 ≈27.5 μm 偏厚,留待闭环寻优收敛到 25.0) */
export const BIAX_NOMINAL: BiaxControls = {
  dryTemp: 172,
  dewPoint: -40,
  feedRate: 650,
  zone1: 272,
  zone2: 278,
  zone3: 284,
  zone4: 288,
  zone5: 292,
  screw: 58,
  pump: 32,
  dieLip: 285,
  chillTemp: 28,
  castSpd: 32,
  pinning: 7,
  mdoPreheat1: 95,
  mdoPreheat2: 100,
  mdoPreheat3: 105,
  slowRoll: 42,
  fastRoll: 118,
  mdoAnneal: 135,
  tdoPreheat: 110,
  tdoStretch: 118,
  tdoAnneal: 215,
  chain: 130,
  railOut: 3000,
  corona: 3.5,
  windTension: 88,
  windTaper: 28,
  windContact: 1.6,
  windSpeed: 160,
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const ZONE_W = [0.06, 0.10, 0.22, 0.26, 0.36] as const

/** mulberry32 + Box-Muller:与 cast-film 同族确定性随机源 */
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

export interface BiaxSteady {
  moisture: number
  zoneAvg: number
  meltTemp: number
  viscosityRatio: number
  flow: number
  pumpOutlet: number
  meltPressure: number
  castWidth: number
  h0: number
  rMd: number
  tMdo: number
  h1: number
  railIn: number
  rTd: number
  relax: number
  h2: number
  sigmaRel: number
  sigma: number
  defect: number
  haze: number
  dyne: number
  tension: number
  throughput: number
}

/** 稳态代数解:全部状态变量到达平衡后的解(动态模型收敛于此,±0.5% 内) */
export function biaxSteady(c: BiaxControls, p: BiaxParams, heaterDecay = 1): BiaxSteady {
  const dryT = c.dryTemp * heaterDecay
  const moisture = 52 * Math.exp(-(dryT - 120) / 20) + Math.max(0, c.dewPoint + 40) * 0.9
  const tz = [c.zone1, c.zone2, c.zone3, c.zone4, c.zone5].map(z => z * heaterDecay)
  const zoneAvg = tz.reduce((s, z, i) => s + z * ZONE_W[i]!, 0)
  const meltTemp = 0.82 * zoneAvg + 0.18 * c.dieLip + 0.09 * c.screw - 0.04 * Math.max(0, moisture - 30)
  const viscosityRatio = Math.exp(p.arrheniusB * (1 / (meltTemp + 273.15) - 1 / (p.tRef + 273.15)))
  let flow = p.flowK * c.pump * Math.pow(1 / viscosityRatio, 0.32)
  flow = Math.min(flow, c.feedRate * 1.06)
  const pumpOutlet = p.pumpGain * (flow / 650) * Math.pow(viscosityRatio, 0.8)
  const meltPressure = pumpOutlet * 0.62 + 2.1 * Math.pow(viscosityRatio, 0.9)
  const castWidth = p.dieWidth * p.neckIn
  const h0 = (flow * 1e6) / (60 * p.filmDensity * castWidth * c.castSpd)
  const rMd = clamp(c.fastRoll / c.slowRoll, 1.0, 4.2)
  const tMdo = 0.85 * ((c.mdoPreheat1 + c.mdoPreheat2 + c.mdoPreheat3) / 3) + 0.15 * c.mdoAnneal
  const h1 = h0 / rMd
  const railIn = castWidth * 1000 * p.railInFactor
  const rTd = clamp(c.railOut / railIn, 1.0, 6.0)
  const relax = 0.012 + 0.0004 * Math.max(0, c.tdoAnneal - 225)
  const h2 = (h1 / rTd) * (1 - relax)
  const sigmaRel = 0.008
    + Math.max(0, 5 - c.pinning) * 0.0025
    + Math.max(0, p.mdoWindow[0] - tMdo) * 0.004
    + Math.max(0, tMdo - p.mdoWindow[1]) * 0.003
    + Math.max(0, p.tdoStretchWindow[0] - c.tdoStretch) * 0.0035
    + Math.max(0, Math.abs(c.dieLip - 285) - 8) * 0.0004
  const sigma = h2 * sigmaRel
  const defect = 0.18
    + Math.max(0, moisture - 30) * 0.02
    + Math.pow(Math.max(0, p.mdoWindow[0] - 2 - tMdo), 2) * 0.010
    + Math.pow(Math.max(0, p.tdoStretchWindow[0] - 4 - c.tdoStretch), 2) * 0.006
    + Math.max(0, 205 - c.tdoAnneal) * 0.004
    + Math.max(0, 55 - c.windTension) * 0.010
    + Math.max(0, c.windTension - 125) * 0.012
    + Math.max(0, c.chillTemp - 45) * 0.010
    + Math.max(0, 0.9 - c.windContact) * 0.8
  const haze = 0.55
    + Math.max(0, 205 - c.tdoAnneal) * 0.02
    + Math.max(0, moisture - 30) * 0.015
    + Math.max(0, sigmaRel - 0.012) * 40
  const dyne = Math.min(58, 34 + 6.2 * Math.log(1 + c.corona / 1.2))
  const tension = c.windTension // 稳态(卷径=芯径)锥度修正为 0
  const throughput = p.filmDensity * (c.railOut / 1000) * (1 - p.trimFraction) * (c.chain / 60) * (h2 / 1e6) * 3600
  return {
    moisture, zoneAvg, meltTemp, viscosityRatio, flow, pumpOutlet, meltPressure, castWidth,
    h0, rMd, tMdo, h1, railIn, rTd, relax, h2, sigmaRel, sigma, defect, haze, dyne, tension, throughput,
  }
}

/** 目标函数 J ∈ [0,100]:厚度窗 + 均匀性 + 质量(缺陷/雾度) + 表面处理 + 能耗 + 产能。
 *  硬约束(违反 → null):熔温、泵压、拉伸温度可行域、收卷张力。 */
export function scoreBiax(c: BiaxControls, p: BiaxParams, s: BiaxSteady): number | null {
  if (s.meltTemp < 268 || s.meltTemp > 300) return null
  if (s.pumpOutlet > 32) return null
  if (s.tension < 40 || s.tension > 150) return null
  if (s.tMdo < p.mdoWindow[0] - 2) return null
  if (c.tdoStretch < p.tdoStretchWindow[0] - 4) return null
  const soft = (x: number, tol: number, span: number) =>
    Math.abs(x) <= tol ? 1 : clamp(1 - Math.pow((Math.abs(x) - tol) / span, 2), 0, 1)
  const jTh = soft(s.h2 - p.thicknessTarget, 0.8, 2.4)
  const jUni = s.sigmaRel <= 0.010 ? 1 : clamp(1 - Math.pow((s.sigmaRel - 0.010) / 0.020, 2), 0, 1)
  const jDef = s.defect <= 0.5 ? 1 : clamp(1 - Math.pow((s.defect - 0.5) / 2.5, 2), 0, 1)
  const jHaze = s.haze <= 1.2 ? 1 : clamp(1 - Math.pow((s.haze - 1.2) / 2.8, 2), 0, 1)
  const jQ = 0.6 * jDef + 0.4 * jHaze
  const jSurf = clamp((s.dyne - 36) / 4, 0, 1)
  const eEnergy = 0.5 * clamp((s.zoneAvg - 270) / 30, 0, 1)
    + 0.5 * clamp(((c.tdoPreheat + c.tdoStretch + c.tdoAnneal) - 380) / 120, 0, 1)
  const jE = 1 - 0.4 * eEnergy
  const jT = clamp((c.chain - 40) / 220, 0, 1)
  return 45 * jTh + 15 * jUni + 15 * jQ + 5 * jSurf + 8 * jE + 12 * jT
}

/** W* 离线网格搜索(ground truth):厚度相关的四个自由度 + 链速,温度/张力取可行缺省。
 *  网格 ~12 万个稳态闭式解,一次性计算 <1s,结果缓存在 cfg.optimum。 */
export function biaxGridSearchOptimum(params?: Partial<BiaxParams>): PlantOptimum {
  const p: BiaxParams = { ...DEFAULT_BIAX_PARAMS, ...params }
  const base = { ...BIAX_NOMINAL }
  let best: { score: number, c: BiaxControls, s: BiaxSteady } | null = null
  for (let castSpd = 24; castSpd <= 48; castSpd += 3) {
    for (let slowRoll = 34; slowRoll <= 52; slowRoll += 3) {
      for (let fastRoll = 84; fastRoll <= 180; fastRoll += 8) {
        for (let railOut = 2400; railOut <= 3600; railOut += 100) {
          for (let chain = 70; chain <= 220; chain += 15) {
            const c = { ...base, castSpd, slowRoll, fastRoll, railOut, chain }
            const s = biaxSteady(c, p)
            const j = scoreBiax(c, p, s)
            if (j == null) continue
            if (!best || j > best.score) best = { score: j, c, s }
          }
        }
      }
    }
  }
  if (!best) return { score: 0, computedAt: new Date().toISOString() }
  return {
    score: Number(best.score.toFixed(2)),
    castSpd: best.c.castSpd,
    slowRoll: best.c.slowRoll,
    fastRoll: best.c.fastRoll,
    railOut: best.c.railOut,
    chain: best.c.chain,
    meltTemp: Number(best.s.meltTemp.toFixed(1)),
    pressure: Number(best.s.pumpOutlet.toFixed(2)),
    thickness: Number(best.s.h2.toFixed(2)),
    sigma: Number(best.s.sigma.toFixed(3)),
    defect: Number(best.s.defect.toFixed(3)),
    haze: Number(best.s.haze.toFixed(2)),
    computedAt: new Date().toISOString(),
  }
}

// ---------- 动态模型(一阶滞后 + 纯滞后运输管线) ----------

interface TimedVal { t: number, v: number }

export class BiaxModel {
  readonly params: BiaxParams
  private rand: () => number
  private gauss: () => number
  private seed = 42
  elapsedS = 0

  private Td = 25
  private Tz: number[] = [25, 25, 25, 25, 25]
  private meltLine: TimedVal[] = []
  private mdoLine: TimedVal[] = [] // h0(铸片) → MDO 出口
  private tdoLine: TimedVal[] = [] // h1(纵拉后) → 测厚仪
  private Tcast = 25
  private Tmdo = 25
  private Ttdo = 25
  private pOut = 0.5
  private tension = 0
  private D: number
  private lenAcc = 0
  private feedDrift = 0
  /** 最近一拍真值(plantSnapshot 直读,不落盘) */
  lastTruth: Record<string, number> | null = null

  constructor(params?: Partial<BiaxParams>, seed = 42) {
    this.params = { ...DEFAULT_BIAX_PARAMS, ...params }
    this.seed = seed
    const r = mulberry32(seed)
    this.rand = r
    this.gauss = gaussOf(r)
    this.D = this.params.rollCoreDiameter
  }

  /** 复位:冷态(25℃ 全线)或热态(各温=SP、管线填满稳态厚度) */
  reset(seed: number, cold: boolean): void {
    this.seed = seed
    const r = mulberry32(seed)
    this.rand = r
    this.gauss = gaussOf(r)
    this.elapsedS = 0
    this.feedDrift = 0
    this.lenAcc = 0
    this.D = this.params.rollCoreDiameter
    this.meltLine = []
    this.mdoLine = []
    this.tdoLine = []
    if (cold) {
      this.Td = 25
      this.Tz = [25, 25, 25, 25, 25]
      this.Tcast = 25
      this.Tmdo = 25
      this.Ttdo = 25
      this.pOut = 0.5
      this.tension = 0
      return
    }
    const c = BIAX_NOMINAL
    const s = biaxSteady(c, this.params)
    this.Td = c.dryTemp
    this.Tz = [c.zone1, c.zone2, c.zone3, c.zone4, c.zone5]
    this.Tcast = c.chillTemp + 4
    this.Tmdo = s.tMdo
    this.Ttdo = 0.25 * c.tdoPreheat + 0.35 * c.tdoStretch + 0.40 * c.tdoAnneal
    this.pOut = s.pumpOutlet
    this.tension = c.windTension
    // 运输管线预填稳态厚度,避免热启动后测厚仪出现「空窗」
    const horizon = this.transportHorizon(c)
    const dtFill = Math.max((this.params.tauMelt + horizon) / 400, 0.5)
    for (let t = -horizon; t <= 0; t += dtFill) {
      this.meltLine.push({ t, v: s.zoneAvg })
      this.mdoLine.push({ t, v: s.h0 })
      this.tdoLine.push({ t, v: s.h1 })
    }
  }

  /** (相对 elapsedS 的)运输时距:screw→die 熔体滞后 + MDO/TDO/测厚 物料行程 */
  private transportHorizon(c: BiaxControls): number {
    const vMdo = ((c.slowRoll + c.fastRoll) / 2) / 60
    const vChain = c.chain / 60
    return this.params.tauMelt + (this.params.mdoLength / Math.max(vMdo, 0.1)) + ((this.params.tdoLength + this.params.gaugeDistance) / Math.max(vChain, 0.1))
  }

  private lag(cur: number, target: number, tau: number, dt: number): number {
    const alpha = 1 - Math.exp(-dt / Math.max(tau, 0.1))
    return cur + (target - cur) * alpha
  }

  private prune(line: TimedVal[], ageS: number): number {
    while (line.length > 1 && this.elapsedS - line[0]!.t > ageS) line.shift()
    return line[0]!.v
  }

  /** 供缺陷图像等复用的确定性随机源 */
  sampleRand(): number {
    return this.rand()
  }

  step(c: BiaxControls, dtSec: number, opt: { heaterDecay?: number, feedDriftPerMin?: number } = {}): BiaxStepResult {
    const p = this.params
    const hd = opt.heaterDecay ?? 1
    this.elapsedS += dtSec
    if (opt.feedDriftPerMin) this.feedDrift += (opt.feedDriftPerMin / 60) * dtSec * this.gauss()

    // ── 干燥塔 ──
    this.Td = this.lag(this.Td, c.dryTemp * hd, p.tauDry, dtSec)
    const moisture = 52 * Math.exp(-(this.Td - 120) / 20) + Math.max(0, c.dewPoint + 40) * 0.9

    // ── 机筒五区(滞后 + 邻区传导 + 进料扰动) ──
    const spZ = [c.zone1, c.zone2, c.zone3, c.zone4, c.zone5]
    for (let i = 0; i < 5; i++) {
      const eff = spZ[i]! * hd + (i === 0 ? this.feedDrift : 0)
      const nb = (i > 0 ? this.Tz[i - 1]! : this.Tz[i]!) + (i < 4 ? this.Tz[i + 1]! : this.Tz[i]!)
      const target = eff + p.kHeat * (nb / 2 - this.Tz[i]!)
      this.Tz[i] = this.lag(this.Tz[i]!, target, p.tauZone, dtSec)
    }
    const zoneAvg = this.Tz.reduce((s, z, i) => s + z * ZONE_W[i]!, 0)

    // ── 熔体输送(纯滞后线)→ 熔温/粘度/泵送 ──
    this.meltLine.push({ t: this.elapsedS, v: zoneAvg })
    const zoneAvgDelayed = this.prune(this.meltLine, p.tauMelt)
    const meltTemp = 0.82 * zoneAvgDelayed + 0.18 * c.dieLip + 0.09 * c.screw - 0.04 * Math.max(0, moisture - 30)
    const viscosityRatio = Math.exp(p.arrheniusB * (1 / (meltTemp + 273.15) - 1 / (p.tRef + 273.15)))
    let flow = p.flowK * c.pump * Math.pow(1 / viscosityRatio, 0.32)
    flow = Math.min(flow, c.feedRate * 1.06)
    const pOutTarget = p.pumpGain * (flow / 650) * Math.pow(viscosityRatio, 0.8)
    this.pOut = this.lag(this.pOut, pOutTarget, p.tauPump, dtSec)
    const meltPressure = this.pOut * 0.62 + 2.1 * Math.pow(viscosityRatio, 0.9)

    // ── 铸片:厚度 h0 进入 MDO 运输线 ──
    const castWidth = p.dieWidth * p.neckIn
    const h0 = (flow * 1e6) / (60 * p.filmDensity * castWidth * c.castSpd)
    this.mdoLine.push({ t: this.elapsedS, v: h0 })
    const vMdo = ((c.slowRoll + c.fastRoll) / 2) / 60
    const mdoAge = p.mdoLength / Math.max(vMdo, 0.1)
    const h0Delayed = this.prune(this.mdoLine, mdoAge)

    // ── MDO:拉伸比即时作用于到达的铸片 ──
    const rMd = clamp(c.fastRoll / c.slowRoll, 1.0, 4.2)
    const h1 = h0Delayed / rMd
    this.tdoLine.push({ t: this.elapsedS, v: h1 })
    const vChain = c.chain / 60
    const tdoAge = (p.tdoLength + p.gaugeDistance) / Math.max(vChain, 0.1)
    const h1Delayed = this.prune(this.tdoLine, tdoAge)

    // ── TDO:轨道展幅 + 热松弛 ──
    const railIn = castWidth * 1000 * p.railInFactor
    const rTd = clamp(c.railOut / railIn, 1.0, 6.0)
    const relax = 0.012 + 0.0004 * Math.max(0, c.tdoAnneal - 225)
    // 破膜/颈缩严重度:拉伸温度越低于窗口,测厚噪声越剧烈(真机上表现为厚度抖动与废品)
    const coldMdo = Math.max(0, p.mdoWindow[0] - 2 - this.Tmdo)
    const coldTdo = Math.max(0, p.tdoStretchWindow[0] - 4 - c.tdoStretch)
    const severity = 1 + coldMdo * 0.35 + coldTdo * 0.5
    const h2 = (h1Delayed / rTd) * (1 - relax) + this.gauss() * p.noiseThickness * severity

    // ── 膜温滞后(缺陷/均匀性的输入) ──
    const tMdoTarget = 0.85 * ((c.mdoPreheat1 + c.mdoPreheat2 + c.mdoPreheat3) / 3) + 0.15 * c.mdoAnneal
    this.Tmdo = this.lag(this.Tmdo, tMdoTarget * hd, 12, dtSec)
    const tdoBlend = 0.25 * c.tdoPreheat + 0.35 * c.tdoStretch + 0.40 * c.tdoAnneal
    this.Ttdo = this.lag(this.Ttdo, tdoBlend * hd, 20, dtSec)
    this.Tcast = this.lag(this.Tcast, c.chillTemp + 4, 15, dtSec)

    // ── 均匀性 / 缺陷 / 雾度 / 电晕(温度取滞后态,其余取控制) ──
    const tMdo = this.Tmdo
    const sigmaRel = 0.008
      + Math.max(0, 5 - c.pinning) * 0.0025
      + Math.max(0, p.mdoWindow[0] - tMdo) * 0.004
      + Math.max(0, tMdo - p.mdoWindow[1]) * 0.003
      + Math.max(0, p.tdoStretchWindow[0] - c.tdoStretch) * 0.0035
      + Math.max(0, Math.abs(c.dieLip - 285) - 8) * 0.0004
    const sigma = Math.max(0, h2 * sigmaRel + this.gauss() * 0.015)
    const defect = Math.max(0.01,
      0.18
      + Math.max(0, moisture - 30) * 0.02
      + Math.pow(Math.max(0, p.mdoWindow[0] - 2 - tMdo), 2) * 0.010
      + Math.pow(coldTdo, 2) * 0.006
      + Math.max(0, 205 - c.tdoAnneal) * 0.004
      + Math.max(0, 55 - this.tension) * 0.010
      + Math.max(0, this.tension - 125) * 0.012
      + Math.max(0, c.chillTemp - 45) * 0.010
      + Math.max(0, 0.9 - c.windContact) * 0.8
      + this.gauss() * p.noiseDefect)
    const haze = Math.max(0.05,
      0.55
      + Math.max(0, 205 - c.tdoAnneal) * 0.02
      + Math.max(0, moisture - 30) * 0.015
      + Math.max(0, sigmaRel - 0.012) * 40
      + this.gauss() * 0.02)
    const dyne = Math.min(58, 34 + 6.2 * Math.log(1 + c.corona / 1.2))

    // ── 收卷:锥度张力 + 卷径生长 ──
    const taperFrac = clamp((this.D - p.rollCoreDiameter) / 0.9, 0, 1)
    const tensionTarget = c.windTension * (1 - (c.windTaper / 100) * taperFrac)
    this.tension = this.lag(this.tension, tensionTarget, p.tauTension, dtSec)
    this.lenAcc += vChain * dtSec
    this.D = Math.sqrt(p.rollCoreDiameter ** 2 + (4 * Math.max(h2, 5) * 1e-6 * this.lenAcc) / Math.PI)

    // ── 横向轮廓(64 点:抛物 + 噪声) ──
    const aLip = 0.055 + Math.max(0, Math.abs(c.dieLip - 285) - 8) * 0.0012
    const profile: number[] = []
    for (let i = 0; i < 64; i++) {
      const xh = (i / 63) * 2 - 1
      profile.push(Number((h2 * (1 - aLip * xh * xh) * (1 + this.gauss() * sigmaRel * 0.6)).toFixed(3)))
    }

    const truth: Record<string, number> = {
      dryTemp: this.Td,
      moisture,
      meltTemp,
      meltPressure,
      pumpOutlet: this.pOut,
      castTemp: this.Tcast,
      mdoTemp: this.Tmdo,
      mdRatio: rMd,
      tdoTemp: this.Ttdo,
      tdRatio: rTd,
      railWidth: rTd * railIn,
      thickness: h2,
      sigma,
      defect,
      haze,
      dyne,
      tension: this.tension,
      rollDia: this.D,
      flow,
      throughput: p.filmDensity * (c.railOut / 1000) * (1 - p.trimFraction) * vChain * (h2 / 1e6) * 3600,
    }
    const exposed: Record<string, number> = {
      dryTemp: this.Td + this.gauss() * p.noiseTemp,
      moisture: moisture + this.gauss() * p.noiseMoisture,
      meltTemp: meltTemp + this.gauss() * p.noiseTemp,
      meltPressure: meltPressure + this.gauss() * p.noisePressure,
      pumpOutlet: this.pOut + this.gauss() * p.noisePressure,
      castTemp: this.Tcast + this.gauss() * p.noiseTemp,
      mdoTemp: this.Tmdo + this.gauss() * p.noiseTemp,
      mdRatio: rMd + this.gauss() * 0.004,
      tdoTemp: this.Ttdo + this.gauss() * p.noiseTemp,
      tdRatio: rTd + this.gauss() * 0.004,
      railWidth: rTd * railIn,
      thickness: h2,
      sigma,
      defect: Math.max(0.01, defect),
      haze: Math.max(0.05, haze),
      dyne,
      tension: this.tension + this.gauss() * 0.9,
      rollDia: this.D,
    }
    this.lastTruth = truth
    return { truth, exposed, profile }
  }
}
