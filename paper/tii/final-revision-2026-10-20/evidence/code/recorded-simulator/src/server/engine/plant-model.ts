/**
 * plant-model:挤出流延薄膜产线物理模型(cast-film extrusion digital twin)。
 *
 * 纯物理状态方程组(欧拉积分),所有 DAQ 信号值从状态积分产出 —— 不再独立随机:
 *   (1) 加热区一阶惯性 + 区间热传导   dTz_i/dt = (SP_i·η − Tz_i)/τT + k·(Tz_{i−1} − Tz_i)/τT
 *   (2) 熔体温度纯滞后(螺杆输送)     Tm = Tz_3(t − τm)
 *   (3) Arrhenius 粘度                μ = μ0·exp(B·(1/Tm − 1/T0))   温度↑粘度↓
 *   (4) 熔体流量                      Q = kN·N·(μ0/μ)^0.4           转速正比 + 粘度部分补偿
 *   (5) 泵送腔一阶                    dP/dt = (Q/Kp − P)/τP
 *   (6) 质量守恒定厚 + 纯滞后         h = Q/(w·v·ρ),τh = L/v(v 变则滞后变)
 *   (7) 厚度横向轮廓                  profile(x̂) = h·(1−κ·x̂²)·(1+ε)
 *   (8) 缺陷率                        defect = α·((Tm−T*)/10)² + β·σ_P + γ·max(0,Tm−255)²
 *   (9) 晶点                          gels = δ·max(0,Tm−240)²
 * 扰动:加热器效率衰减 η、进料温度阶跃/慢漂移(随机游走)。
 * 噪声全部走可播种 PRNG(mulberry32 + Box-Muller)→ 同 seed 完全可复现。
 *
 * 稳态代数解(steadyState)供离线网格搜索最优窗口 W*(/api/plant/optimum)。
 */
import type {
  PlantOptimum, PlantParams, PlantPhase, PlantTruthSample,
} from '../../shared/types'

export const DEFAULT_PLANT_PARAMS: PlantParams = {
  tauZone: 90,          // 加热区热惯性(s),挤出教材典型 60~120
  kHeat: 0.25,          // 相邻加热区热传导份额
  tauMelt: 20,          // 螺杆输送混合滞后(s)
  arrheniusB: 2200,     // Arrhenius 指数(K),聚烯烃典型 2000~2600
  mu0: 480,             // 参考粘度(Pa·s)
  tRef: 483.15,         // 参考温度(K) = 210℃
  flowK: 0.0326,        // 流量系数(kg/min 每 rpm)→ 名义 N=120 → Q≈3.91 kg/min
  pumpK: 0.26,          // 泵送增益(kg/min 每 MPa)→ 名义 P≈15 MPa
  tauP: 8,              // 泵送腔时间常数(s)
  dieWidth: 1.0,        // 模口宽度(m)
  gaugeDistance: 12,    // 模口→测厚仪输送距离(m)
  filmDensity: 920,     // 固化膜密度(kg/m³)
  defectT: 212,         // 缺陷率最低参考温度(℃)
  dieGapRef: 1.0,       // 名义模口间隙(mm)
  noiseTemp: 0.4,       // 熔体温度传感器 σ(℃)
  noisePressure: 0.08,  // 压力传感器 σ(MPa)
  noiseThickness: 0.5,  // 测厚仪 σ(μm)
  noiseDefect: 0.15,    // CCD 缺陷率 σ(%)
  noiseGels: 1.5,       // 晶点计数 σ(个/m²)
}

/** 名义工况(预热完成后的稳产工作点)——用于测试与最优窗口的基准 */
export const NOMINAL = { zone: 210, screw: 120, lineSpeed: 85, dieGap: 1.0, thickness: 50 }

// ---------- 可播种 PRNG ----------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller 高斯(基于给定 uniform 源,保证可复现) */
export function gaussOf(rand: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

export interface PlantControls {
  zone1: number
  zone2: number
  zone3: number
  screw: number
  lineSpeed: number
  dieGap: number
}

/** castfilm 单步物理真值(具体形状;PlantTruthSample.truth 是跨模型的宽松记录) */
export interface CastFilmTruth {
  zoneTemps: [number, number, number]
  meltTemp: number
  pressure: number
  flow: number
  thickness: number
  defect: number
  gels: number
  viscosity: number
  transportDelayS: number
}

export interface PlantStepResult {
  truth: CastFilmTruth
  exposed: PlantTruthSample['exposed']
  /** 厚度横向轮廓(64 点,μm;含轮廓成形噪声,不含传感器噪声) */
  profile: number[]
  /** 平均轮廓偏差(ppm 级指标,供 image 生成) */
  profileDev: number
}

/** 厚度输送段:模口出口的膜片单元,按线速向测厚仪移动 */
interface HSegment { dist: number, h: number }

export class CastFilmModel {
  readonly params: PlantParams
  private rand: () => number
  private t = 0 // 物理时间(s)
  private tz: [number, number, number] = [25, 25, 25] // 冷态启动
  private p = 0.5
  private meltDelay: number[] = []
  private hSegments: HSegment[] = []
  private pWindow: number[] = []
  private feedTemp = 0
  private defectCache = 0

  constructor(params?: Partial<PlantParams>, seed = 42) {
    this.params = { ...DEFAULT_PLANT_PARAMS, ...params }
    this.rand = mulberry32(seed)
  }

  /** 复位到指定初始状态(实验复现用) */
  reset(seed = 42, cold = true): void {
    this.rand = mulberry32(seed)
    this.t = 0
    this.tz = cold ? [25, 25, 25] : [NOMINAL.zone, NOMINAL.zone, NOMINAL.zone]
    this.p = cold ? 0.5 : NOMINAL.screw * this.params.flowK / this.params.pumpK
    this.meltDelay = []
    this.hSegments = []
    this.pWindow = []
    this.feedTemp = 0
    this.defectCache = 0
  }

  get elapsedS(): number {
    return this.t
  }

  /**
   * 推进一拍。dtSec = 物理秒(真实 dt × timeScale,由调用方折算)。
   * disturbances 通过 opt 注入(加热衰减/进料阶跃/漂移),不需要时可省略。
   */
  step(c: PlantControls, dtSec: number, opt?: {
    heaterDecay?: number
    feedDriftPerMin?: number
  }): PlantStepResult {
    const P = this.params
    const dt = Math.max(dtSec, 0.001)
    this.t += dt
    const eta = clamp(opt?.heaterDecay ?? 1, 0.2, 1)

    // 进料温度慢漂移(随机游走,界内)
    if (opt?.feedDriftPerMin) {
      this.feedTemp = clamp(this.feedTemp + gaussOf(this.rand) * (opt.feedDriftPerMin / 60) * dt, -6, 6)
    }

    // (1) 加热区:一阶惯性 + 区间热传导;进料温度叠加在 zone1 有效设定上
    const sp1 = c.zone1 * eta + this.feedTemp
    const d1 = (sp1 - this.tz[0]) / P.tauZone
    const d2 = (c.zone2 * eta - this.tz[1]) / P.tauZone + P.kHeat * (this.tz[0]! - this.tz[1]!) / P.tauZone
    const d3 = (c.zone3 * eta - this.tz[2]) / P.tauZone + P.kHeat * (this.tz[1]! - this.tz[2]!) / P.tauZone
    this.tz[0] += d1 * dt
    this.tz[1] += d2 * dt
    this.tz[2] += d3 * dt

    // (2) 熔体温度:纯滞后线(每步推入当前第三区温度,延时 τmelt)
    const delaySteps = Math.max(1, Math.round(P.tauMelt / dt))
    this.meltDelay.push(this.tz[2]!)
    while (this.meltDelay.length > delaySteps) this.meltDelay.shift()
    const Tm = this.meltDelay[0] ?? this.tz[2]!

    // (3) 粘度 (4) 流量
    const TmK = Tm + 273.15
    const ratio = Math.exp(-P.arrheniusB * (1 / TmK - 1 / P.tRef)) // μ0/μ
    const Q = P.flowK * Math.max(c.screw, 0) * Math.pow(Math.max(ratio, 1e-6), 0.4)

    // (5) 泵送腔一阶
    this.p += dt * (Q / P.pumpK - this.p) / P.tauP

    // (6) 质量守恒定厚(模口间隙修正)+ 纯滞后输送
    const gFac = clamp(c.dieGap / P.dieGapRef, 0.55, 1.6)
    const hExit = ((Q / (P.dieWidth * Math.max(c.lineSpeed, 1) * P.filmDensity)) * 1e6) * gFac
    const vmps = Math.max(c.lineSpeed, 1) / 60
    for (const seg of this.hSegments) seg.dist -= vmps * dt
    this.hSegments.push({ dist: P.gaugeDistance, h: hExit })
    let h = hExit
    while (this.hSegments.length > 0 && this.hSegments[0]!.dist <= 0) {
      h = this.hSegments.shift()!.h // FIFO:先投放的先到达
    }

    // 压力波动窗口(≈10s)
    this.pWindow.push(this.p)
    const winCap = Math.max(4, Math.round(10 / dt))
    while (this.pWindow.length > winCap) this.pWindow.shift()
    const pAvg = this.pWindow.reduce((a, b) => a + b, 0) / this.pWindow.length
    const sigmaP = Math.sqrt(this.pWindow.reduce((a, b) => a + (b - pAvg) ** 2, 0) / this.pWindow.length)

    // (8) 缺陷率 (9) 晶点
    const over = Math.max(0, Tm - 255)
    const defect = clamp(0.55 * ((Tm - P.defectT) / 10) ** 2 + 0.9 * sigmaP + 0.02 * over * over, 0, 100)
    this.defectCache = defect
    const gels = clamp(4 + 0.05 * Math.max(0, Tm - 240) ** 2, 0, 500)

    // (7) 厚度横向轮廓:边缘减薄 + 成形偏差(确定性 seeded)
    const pts: number[] = []
    let devSum = 0
    const N_PROFILE = 64
    for (let i = 0; i < N_PROFILE; i++) {
      const x = (i / (N_PROFILE - 1)) * 2 - 1
      const shape = 1 - 0.06 * x * x
      const e = gaussOf(this.rand) * 0.008
      devSum += e
      pts.push(Number((h * shape * (1 + e)).toFixed(3)))
    }

    // 传感器暴露值(加噪)
    const exposed = {
      meltTemp: Number(clamp(Tm + gaussOf(this.rand) * P.noiseTemp, 0, 400).toFixed(2)),
      pressure: Number(clamp(this.p + gaussOf(this.rand) * P.noisePressure, 0, 45).toFixed(3)),
      thickness: Number(clamp(h + gaussOf(this.rand) * P.noiseThickness, 0, 400).toFixed(2)),
      defect: Number(clamp(defect + gaussOf(this.rand) * P.noiseDefect, 0, 100).toFixed(3)),
      gels: Number(clamp(Math.round(gels + gaussOf(this.rand) * P.noiseGels), 0, 500).toFixed(0)),
    }

    const truth = {
      zoneTemps: [this.tz[0]!, this.tz[1]!, this.tz[2]!] as [number, number, number],
      meltTemp: Number(Tm.toFixed(3)),
      pressure: Number(this.p.toFixed(4)),
      flow: Number(Q.toFixed(4)),
      thickness: Number(h.toFixed(3)),
      defect: Number(defect.toFixed(4)),
      gels: Number(gels.toFixed(1)),
      viscosity: Number((this.params.mu0 / Math.max(ratio, 1e-6)).toFixed(2)),
      transportDelayS: Number((P.gaugeDistance / vmps).toFixed(2)),
    }

    return { truth, exposed, profile: pts, profileDev: devSum / N_PROFILE }
  }

  /** 当前缺陷率缓存(图像帧生成用) */
  get defect(): number {
    return this.defectCache
  }

  /** 下一个 seeded 均匀样本(派生渲染[如图像撒点]复用同一随机流,保证可复现) */
  sampleRand(): number {
    return this.rand()
  }

  /** 稳态代数解(令全部导数=0,含区间热传导稳态梯度):离线网格搜索 W* 用 */
  static steadyState(c: PlantControls, params?: Partial<PlantParams>): {
    meltTemp: number, viscosity: number, flow: number, pressure: number, thickness: number, defect: number, gels: number
  } {
    const P = { ...DEFAULT_PLANT_PARAMS, ...params }
    // 稳态:dTz_i=0 → tz2=(sp2+k·tz1)/(1+k),tz3=(sp3+k·tz2)/(1+k);熔体=第三区
    const tz1 = c.zone1
    const tz2 = (c.zone2 + P.kHeat * tz1) / (1 + P.kHeat)
    const tz3 = (c.zone3 + P.kHeat * tz2) / (1 + P.kHeat)
    const Tm = tz3
    const TmK = Tm + 273.15
    const ratio = Math.exp(-P.arrheniusB * (1 / TmK - 1 / P.tRef))
    const Q = P.flowK * c.screw * Math.pow(Math.max(ratio, 1e-6), 0.4)
    const pressure = Q / P.pumpK
    const gFac = clamp(c.dieGap / P.dieGapRef, 0.55, 1.6)
    const thickness = ((Q / (P.dieWidth * Math.max(c.lineSpeed, 1) * P.filmDensity)) * 1e6) * gFac
    const sigmaP0 = 0.06 // 稳态残余波动
    const over = Math.max(0, Tm - 255)
    const defect = clamp(0.55 * ((Tm - P.defectT) / 10) ** 2 + 0.9 * sigmaP0 + 0.02 * over * over, 0, 100)
    const gels = clamp(4 + 0.05 * Math.max(0, Tm - 240) ** 2, 0, 500)
    return {
      meltTemp: Tm,
      viscosity: P.mu0 / Math.max(ratio, 1e-6),
      flow: Q,
      pressure,
      thickness,
      defect,
      gels,
    }
  }
}

// ============================================================
// 离线最优窗口 W*(网格搜索,孪生独有 ground truth)
// ============================================================

/**
 * 目标函数(与 bench T6 窗口寻优任务一致):
 *   J = 55·厚度达标(硬窗 50±2μm,软退化) + 25·品质(缺陷率) + 8·能耗(转速) + 7·产能(线速)
 *   约束:Tm∈[195,225]℃,P≤22MPa(安全),N∈[50,200],v∈[20,120]
 */
export function scoreWindow(s: { thickness: number, defect: number, meltTemp: number, pressure: number, screw: number, lineSpeed: number }): number {
  if (s.meltTemp < 195 || s.meltTemp > 225 || s.pressure > 22) return -Infinity
  const thErr = Math.abs(s.thickness - NOMINAL.thickness)
  const jTh = thErr <= 2 ? 1 : Math.max(0, 1 - (thErr - 2) / 10)
  const jQuality = 1 - Math.min(s.defect, 8) / 8
  const jEnergy = 1 - (s.screw - 50) / 150
  const jThrough = s.lineSpeed / 120
  return 55 * jTh + 25 * jQuality + 8 * jEnergy + 7 * jThrough
}

export function gridSearchOptimum(params?: Partial<PlantParams>): PlantOptimum {
  let best: PlantOptimum | null = null
  for (let zone = 195; zone <= 225.01; zone += 2.5) {
    for (let screw = 50; screw <= 200.01; screw += 5) {
      for (let v = 20; v <= 120.01; v += 2.5) {
        const s = CastFilmModel.steadyState({ zone1: zone, zone2: zone, zone3: zone, screw, lineSpeed: v, dieGap: 1.0 }, params)
        const score = scoreWindow({ thickness: s.thickness, defect: s.defect, meltTemp: s.meltTemp, pressure: s.pressure, screw, lineSpeed: v })
        if (!Number.isFinite(score)) continue
        if (!best || score > best.score) {
          best = {
            zoneTemp: zone, screw, lineSpeed: v,
            meltTemp: Number(s.meltTemp.toFixed(2)),
            pressure: Number(s.pressure.toFixed(3)),
            thickness: Number(s.thickness.toFixed(2)),
            defect: Number(s.defect.toFixed(3)),
            score: Number(score.toFixed(3)),
            computedAt: new Date().toISOString(),
          }
        }
      }
    }
  }
  if (!best) throw new Error('网格搜索无可行解:检查约束与参数')
  return best
}

export type { PlantPhase, PlantTruthSample }
