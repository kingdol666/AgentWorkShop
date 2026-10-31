/**
 * wwtp-model —— A2O 污水生化处理物理引擎。
 *
 * 设备链:进水泵房(进水流量/COD/氨氮扰动物) → 曝气风机站(风机频率→溶解氧)
 *   → 加药单元(NaOH 中和 pH / PAC 化学除磷) → 回流与排泥单元(内回流脱氮/污泥回流/排泥→MLSS)
 *   → 出水水质检测站(COD/氨氮/总磷/pH/浊度/沿程 DO 轮廓)。
 *
 * 核心机理(与真实活性污泥法一致的因果方向):
 *   溶解氧 DO = f(kLa(风机频率)^1.8) 与氧利用率 OUR(进水负荷×MLSS)的平衡:
 *     DO = Csat − OUR/kLa —— 风机低了 DO 塌、硝化停;风机高了电耗平方级上涨
 *   COD 去除 η = ηmax·(1−e^(−kC·DO))·(MLSS)^0.35 —— DO/泥浓双驱动
 *   硝化(氨氮) nh3_out = nh3_in·e^(−kN·(DO−0.8)+)·内回流修正 —— DO<0.8 即崩溃
 *   化学除磷 ηP = 1−(1−生物除磷)·(1−PAC 朗缪尔饱和吸附) —— 药量收益递减
 *   pH = 6.1 + 0.041·NaOH − 0.75·(硝化碱耗) —— 中和与碱耗的平衡
 *   浊度 ∝ MLSS 过高(污泥膨胀) + 低 DO(丝状菌)
 *
 * 控制问题形态(与薄膜「质量窗」不同的多目标形态):
 *   排放达标(COD<50, NH3-N<5, TP<0.5, pH 6~9, 浊度<10)是硬约束;
 *   在达标前提下最小化运行成本 = 曝风电耗(频率^2.6) + 药耗(NaOH+PAC)。
 */
import type { PlantOptimum, WwtpParams } from '../../shared/types'

export interface WwtpControls {
  blowerHz: number
  naohDose: number
  pacDose: number
  recycleInt: number
  recycleSludge: number
  wasteSludge: number
  influentFlow: number
}

export interface WwtpStepResult {
  truth: Record<string, number>
  exposed: Record<string, number>
  /** 沿程 DO 轮廓(7 池段,mg/L) */
  profile: number[]
}

export const DEFAULT_WWTP_PARAMS: WwtpParams = {
  volume: 8000,
  klaBase: 3.3,
  klaExp: 1.8,
  cSat: 8.9,
  ourBase: 19.5,
  etaCodMax: 0.985,
  kCod: 0.75,
  kNh3: 0.95,
  pacK: 13,
  pacMax: 0.92,
  pBioBase: 0.62,
  mlssWasteK: 7.5,
  noiseDo: 0.05,
  noiseQuality: 0.35,
}

/**
 * 预设缺省工况(次优起点:不达标运行,待闭环优化「达标 + 降耗」):
 * 风机 26Hz → DO≈1.2(硝化受抑,氨氮超标);NaOH 12 L/h → pH≈5.9(低于排放下限 6);
 * PAC 30 L/h → 总磷 0.62(超标);进水 1000 m³/h。
 */
export const WWTP_NOMINAL: WwtpControls = {
  blowerHz: 26,
  naohDose: 12,
  pacDose: 30,
  recycleInt: 90,
  recycleSludge: 70,
  wasteSludge: 150,
  influentFlow: 1000,
}

/** 进水扰动物(扰动脉冲由 disturbances.feedDriftPerMin 驱动,基准窗口内清零) */
export const WWTP_INFLUENT = { cod: 420, nh3: 35, tp: 4.5 }

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

export interface WwtpSteady {
  mlss: number
  kLa: number
  our: number
  do: number
  etaCod: number
  codOut: number
  nh3Out: number
  tpOut: number
  ph: number
  turbidity: number
  energy: number
  cost: number
  compliant: boolean
}

/** 排放限值(GB 18918 一级 A 口径的模拟简化) */
export const WWTP_LIMITS = { cod: 50, nh3: 5, tp: 0.5, phMin: 6.0, phMax: 9.0, turbidity: 10 } as const

/** 稳态代数解 */
export function wwtpSteady(c: WwtpControls, p: WwtpParams, codIn = WWTP_INFLUENT.cod, nh3In = WWTP_INFLUENT.nh3, tpIn = WWTP_INFLUENT.tp): WwtpSteady {
  const mlss = clamp(
    4900 - p.mlssWasteK * (c.wasteSludge - 120) + 0.4 * ((codIn - 420) / 10),
    2200, 6800)
  const kLa = p.klaBase * Math.pow(c.blowerHz / 30, p.klaExp)
  const our = p.ourBase * (c.influentFlow / 1000) * (codIn / 420) * (0.85 + 0.3 * mlss / 4900)
  const doS = Math.max(0.15, p.cSat - our / Math.max(kLa, 0.05))
  const hrt = (p.volume / Math.max(c.influentFlow, 50)) / 8
  const etaCod = Math.min(0.985,
    p.etaCodMax * (1 - Math.exp(-p.kCod * doS)) * Math.pow(mlss / 4900, 0.35) * Math.min(1, hrt / 0.8))
  const codOut = codIn * (1 - etaCod)
  const nh3Out = nh3In
    * Math.exp(-p.kNh3 * Math.max(0, doS - 0.8))
    * (1 - 0.0015 * Math.max(0, c.recycleInt - 80))
  const etaP = 1 - (1 - p.pBioBase) * (1 - p.pacMax * c.pacDose / (c.pacDose + p.pacK))
  const tpOut = Math.max(0.05, tpIn * (1 - etaP) + 0.05)
  const ph = 6.10 + 0.041 * c.naohDose - 0.75 * (1 - nh3Out / nh3In)
  const turbidity = Math.max(0.35,
    0.00030 * Math.max(0, mlss - 2600) + 3.2 * Math.max(0, 1.4 - doS))
  const energy = Math.pow(c.blowerHz / 30, 2.6) * 100
  const cost = energy + 0.30 * c.naohDose + 0.45 * c.pacDose
  const compliant = codOut < WWTP_LIMITS.cod && nh3Out < WWTP_LIMITS.nh3
    && tpOut < WWTP_LIMITS.tp && ph > WWTP_LIMITS.phMin && ph < WWTP_LIMITS.phMax
    && turbidity < WWTP_LIMITS.turbidity
  return { mlss, kLa, our, do: doS, etaCod, codOut, nh3Out, tpOut, ph, turbidity, energy, cost, compliant }
}

/** 目标函数 J ∈ [0,100]:达标为硬约束(违反 → 重罚不 null,便于网格仍有解),成本越低越好。 */
export function scoreWwtp(c: WwtpControls, p: WwtpParams, s: WwtpSteady): number {
  if (!s.compliant) return null as unknown as number
  const costNorm = clamp((s.cost - 60) / 200, 0, 1)
  return Number(((1 - costNorm) * 100).toFixed(2))
}

/** W* 离线网格搜索(ground truth):风机×NaOH×PAC 三自由度,达标前提下成本最小。 */
export function wwtpGridSearchOptimum(params?: Partial<WwtpParams>): PlantOptimum {
  const p: WwtpParams = { ...DEFAULT_WWTP_PARAMS, ...params }
  let best: { score: number, c: WwtpControls, s: WwtpSteady } | null = null
  for (let blower = 24; blower <= 46; blower += 2) {
    for (let naoh = 12; naoh <= 60; naoh += 4) {
      for (let pac = 20; pac <= 90; pac += 5) {
        const c: WwtpControls = { ...WWTP_NOMINAL, blowerHz: blower, naohDose: naoh, pacDose: pac }
        const s = wwtpSteady(c, p)
        if (!s.compliant) continue
        const j = scoreWwtp(c, p, s)
        if (j == null || Number.isNaN(j)) continue
        if (!best || j > best.score) best = { score: j, c, s }
      }
    }
  }
  if (!best) return { score: 0, computedAt: new Date().toISOString() }
  return {
    score: best.score,
    computedAt: new Date().toISOString(),
    settings: { blowerHz: best.c.blowerHz, naohDose: best.c.naohDose, pacDose: best.c.pacDose },
    thickness: undefined,
    defect: Number((best.s.nh3Out).toFixed(3)),
  }
}

// ---------- 动态模型 ----------

export class WwtpModel {
  readonly params: WwtpParams
  private rand: () => number
  private gauss: () => number
  elapsedS = 0

  private mlss = 2500
  private doS = 0.5
  private influentCod = WWTP_INFLUENT.cod
  private loadDrift = 0

  constructor(params?: Partial<WwtpParams>, seed = 42) {
    this.params = { ...DEFAULT_WWTP_PARAMS, ...params }
    const r = mulberry32(seed)
    this.rand = r
    this.gauss = gaussOf(r)
  }

  reset(seed: number, cold: boolean): void {
    const r = mulberry32(seed)
    this.rand = r
    this.gauss = gaussOf(r)
    this.elapsedS = 0
    this.loadDrift = 0
    if (cold) {
      this.mlss = 2500
      this.doS = 0.5
      this.influentCod = WWTP_INFLUENT.cod
      return
    }
    const s = wwtpSteady(WWTP_NOMINAL, this.params)
    this.mlss = s.mlss
    this.doS = s.do
    this.influentCod = WWTP_INFLUENT.cod
  }

  private lag(cur: number, target: number, tau: number, dt: number): number {
    const alpha = 1 - Math.exp(-dt / Math.max(tau, 0.1))
    return cur + (target - cur) * alpha
  }

  sampleRand(): number {
    return this.rand()
  }

  step(c: WwtpControls, dtSec: number, opt: { heaterDecay?: number, feedDriftPerMin?: number } = {}): WwtpStepResult {
    const p = this.params
    this.elapsedS += dtSec
    if (opt.feedDriftPerMin) this.loadDrift += (opt.feedDriftPerMin / 60) * dtSec * this.gauss() * 8
    this.influentCod = WWTP_INFLUENT.cod + this.loadDrift

    // MLSS 与 DO 是慢状态(生化学反应时标)
    const s = wwtpSteady(c, p, this.influentCod)
    this.mlss = this.lag(this.mlss, s.mlss, 90, dtSec)
    // DO 用当前 MLSS 重新平衡(氧帐快速,分钟级)
    const kLa = p.klaBase * Math.pow(c.blowerHz / 30, p.klaExp)
    const our = p.ourBase * (c.influentFlow / 1000) * (this.influentCod / 420) * (0.85 + 0.3 * this.mlss / 4900)
    const doTarget = Math.max(0.15, p.cSat - our / Math.max(kLa, 0.05))
    this.doS = this.lag(this.doS, doTarget, 25, dtSec)

    // 出水水质对 (DO, MLSS) 准稳态
    const hrt = (p.volume / Math.max(c.influentFlow, 50)) / 8
    const etaCod = Math.min(0.985,
      p.etaCodMax * (1 - Math.exp(-p.kCod * this.doS)) * Math.pow(this.mlss / 4900, 0.35) * Math.min(1, hrt / 0.8))
    const codOut = this.influentCod * (1 - etaCod)
    const nh3Out = WWTP_INFLUENT.nh3
      * Math.exp(-p.kNh3 * Math.max(0, this.doS - 0.8))
      * (1 - 0.0015 * Math.max(0, c.recycleInt - 80))
    const etaP = 1 - (1 - p.pBioBase) * (1 - p.pacMax * c.pacDose / (c.pacDose + p.pacK))
    const tpOut = Math.max(0.05, WWTP_INFLUENT.tp * (1 - etaP) + 0.05)
    const ph = 6.10 + 0.041 * c.naohDose - 0.75 * (1 - nh3Out / WWTP_INFLUENT.nh3)
    const turbidity = Math.max(0.35,
      0.00030 * Math.max(0, this.mlss - 2600) + 3.2 * Math.max(0, 1.4 - this.doS))
    const energy = Math.pow(c.blowerHz / 30, 2.6) * 100
    const cost = energy + 0.30 * c.naohDose + 0.45 * c.pacDose
    const compliant = codOut < WWTP_LIMITS.cod && nh3Out < WWTP_LIMITS.nh3
      && tpOut < WWTP_LIMITS.tp && ph > WWTP_LIMITS.phMin && ph < WWTP_LIMITS.phMax
      && turbidity < WWTP_LIMITS.turbidity

    // 沿程 DO 轮廓(7 池段:进水端低、好氧末端高)
    const profile: number[] = []
    for (let i = 0; i < 7; i++) {
      const frac = Math.pow((i + 1) / 7, 0.7)
      profile.push(Number((0.55 + this.doS * frac + this.gauss() * 0.03).toFixed(3)))
    }

    const truth: Record<string, number> = {
      airPressure: 38 + 0.55 * c.blowerHz,
      do: this.doS,
      mlss: this.mlss,
      codIn: this.influentCod,
      nh3In: WWTP_INFLUENT.nh3,
      codOut, nh3Out, tpOut, ph, turbidity, energy, cost,
      compliant: compliant ? 1 : 0,
    }
    const exposed: Record<string, number> = {
      airPressure: 38 + 0.55 * c.blowerHz + this.gauss() * 0.8,
      do: Math.max(0, this.doS + this.gauss() * p.noiseDo),
      mlss: this.mlss + this.gauss() * 30,
      codIn: this.influentCod + this.gauss() * 8,
      nh3In: WWTP_INFLUENT.nh3 + this.gauss() * 0.8,
      codOut: Math.max(0, codOut + this.gauss() * p.noiseQuality),
      nh3Out: Math.max(0, nh3Out + this.gauss() * p.noiseQuality * 0.2),
      tpOut: Math.max(0, tpOut + this.gauss() * p.noiseQuality * 0.05),
      ph: ph + this.gauss() * 0.04,
      turbidity: Math.max(0, turbidity + this.gauss() * 0.08),
    }
    return { truth, exposed, profile }
  }
}
