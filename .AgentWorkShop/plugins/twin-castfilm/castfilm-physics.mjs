/**
 * castfilm-physics —— 挤出流延薄膜(cast-film)灰箱物理内核(纯函数,零 IO 依赖)。
 *
 * 来源与同步责任(重要):
 *   - 本文件中的动力学方程、参数与稳态解**复制自**
 *     plc-node-simulator/src/server/engine/plant-model.ts
 *     (plc-node-simulator 子模块 @ 0db5f40,plant-model.ts 最后改动 f86653d 2026-09-18),
 *     复制日期 2026-10-05。
 *   - 不做跨目录 import(插件加载时相对路径不可靠),因此选择**复制**;
 *     当模拟器引擎(时间常数/增益/滞后/稳态解)变更时,责任方需**手动同步**本文件,
 *     并更新下方 SYNC 注记。两侧不一致时,以模拟器 plant-model.ts 为准。
 *   - SYNC: 2026-10-05 vs plant-model.ts(f86653d)逐式核对一致(式 1~6、稳态解、scoreWindow)。
 *
 * 与模拟器的差异(有意为之的灰箱简化):
 *   - 不含 seeded 传感器噪声/横向轮廓(式 7)与进料温度随机游走(扰动改为显式入参);
 *   - 压力波动 σP 用稳态残余 sigmaP0=0.06 近似(同 CastFilmModel.steadyState 口径);
 *   - 纯滞后(式 2 熔体温度、式 6 厚度输送)以**状态内嵌延迟缓冲**实现,
 *     缓冲内容随 PhysicsState 记录携带,保证 rollout 可从任意 state Record 复现。
 */

/** 挤出流延产线物理参数(逐字段复制自 DEFAULT_PLANT_PARAMS,单位见注释) */
export const PLANT_PARAMS = {
  tauZoneSec: 90,        // 加热区热惯性(s),挤出教材典型 60~120
  kHeat: 0.25,           // 相邻加热区热传导份额(ratio)
  tauMeltSec: 20,        // 螺杆输送混合纯滞后(s)
  arrheniusB: 2200,      // Arrhenius 指数(K),聚烯烃典型 2000~2600
  mu0: 480,              // 参考粘度(Pa·s)
  tRefK: 483.15,         // 参考温度(K) = 210℃
  flowK: 0.0326,         // 流量系数(kg/min 每 rpm)→ 名义 N=120 → Q≈3.91 kg/min
  pumpK: 0.26,           // 泵送增益(kg/min 每 MPa)→ 名义 P≈15 MPa
  tauPumpSec: 8,         // 泵送腔时间常数(s)
  dieWidthM: 1.0,        // 模口宽度(m)
  gaugeDistanceM: 12,    // 模口→测厚仪输送距离(m)
  filmDensity: 920,      // 固化膜密度(kg/m³)
  defectT: 212,          // 缺陷率最低参考温度(℃)
  dieGapRefMm: 1.0,      // 名义模口间隙(mm)
}

/** 名义工况(预热完成后的稳产工作点;复制自 NOMINAL) */
export const CASTFILM_NOMINAL = { zone: 210, screw: 120, lineSpeed: 85, dieGap: 1.0, thickness: 50 }

/** 传感器硬量程(复制自 plant-model.step 的 exposed clamp;区间热区温度同 [0,400]) */
export const SENSOR_RANGE = {
  melt_temp: [0, 400],        // ℃
  pump_pressure: [0, 45],     // MPa
  thickness_um: [0, 400],     // μm
  defect_pct: [0, 100],       // %
  gels_per_m2: [0, 500],      // 个/m²
  zone_temp: [0, 400],        // ℃(各区)
}

export function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi)
}

// ============================================================
// 稳态代数解(复制自 CastFilmModel.steadyState,令全部导数=0)
// ============================================================

/**
 * 稳态解:tz2=(sp2+k·tz1)/(1+k),tz3=(sp3+k·tz2)/(1+k);熔体温度=第三区。
 * 离线最优窗口 W*(网格搜索)与 /api/plant/optimum 同源,可作孪生侧 ground truth。
 */
export function castFilmSteadyState(c, paramsOverride) {
  const P = { ...PLANT_PARAMS, ...paramsOverride }
  const tz1 = c.zone1
  const tz2 = (c.zone2 + P.kHeat * tz1) / (1 + P.kHeat)
  const tz3 = (c.zone3 + P.kHeat * tz2) / (1 + P.kHeat)
  const meltTemp = tz3
  const tmK = meltTemp + 273.15
  const ratio = Math.exp(-P.arrheniusB * (1 / tmK - 1 / P.tRefK))
  const flow = P.flowK * c.screw * Math.pow(Math.max(ratio, 1e-6), 0.4)
  const pressure = flow / P.pumpK
  const gFac = clamp(c.dieGap / P.dieGapRefMm, 0.55, 1.6)
  const thickness = ((flow / (P.dieWidthM * Math.max(c.lineSpeed, 1) * P.filmDensity)) * 1e6) * gFac
  const sigmaP0 = 0.06 // 稳态残余波动(MPa)
  const over = Math.max(0, meltTemp - 255)
  const defect = clamp(0.55 * ((meltTemp - P.defectT) / 10) ** 2 + 0.9 * sigmaP0 + 0.02 * over * over, 0, 100)
  const gels = clamp(4 + 0.05 * Math.max(0, meltTemp - 240) ** 2, 0, 500)
  return {
    melt_temp: meltTemp,
    viscosity_pas: P.mu0 / Math.max(ratio, 1e-6),
    melt_flow_kpm: flow,
    pump_pressure: pressure,
    thickness_um: thickness,
    defect_pct: defect,
    gels_per_m2: gels,
  }
}

// ============================================================
// 目标函数与网格搜索(复制自 scoreWindow / gridSearchOptimum)
//   J = 55·厚度达标(硬窗 50±2μm,软退化) + 25·品质(缺陷率) + 8·能耗(转速) + 7·产能(线速)
//   约束:Tm∈[195,225]℃,P≤22MPa(安全),N∈[50,200],v∈[20,120]
// ============================================================

export function scoreWindow(s) {
  if (s.melt_temp < 195 || s.melt_temp > 225 || s.pump_pressure > 22) return -Infinity
  const thErr = Math.abs(s.thickness_um - CASTFILM_NOMINAL.thickness)
  const jTh = thErr <= 2 ? 1 : Math.max(0, 1 - (thErr - 2) / 10)
  const jQuality = 1 - Math.min(s.defect_pct, 8) / 8
  const jEnergy = 1 - (s.screw - 50) / 150
  const jThrough = s.lineSpeed / 120
  return 55 * jTh + 25 * jQuality + 8 * jEnergy + 7 * jThrough
}

/** 离线最优窗口 W*(与模拟器 /api/plant/optimum 同一网格;孪生独有 ground truth) */
export function gridSearchOptimum(paramsOverride) {
  let best = null
  for (let zone = 195; zone <= 225.01; zone += 2.5) {
    for (let screw = 50; screw <= 200.01; screw += 5) {
      for (let v = 20; v <= 120.01; v += 2.5) {
        const controls = { zone1: zone, zone2: zone, zone3: zone, screw, lineSpeed: v, dieGap: 1.0 }
        const s = castFilmSteadyState(controls, paramsOverride)
        const score = scoreWindow({ ...s, screw, lineSpeed: v })
        if (!Number.isFinite(score)) continue
        if (!best || score > best.score) {
          best = {
            zoneTemp: zone,
            screw,
            lineSpeed: v,
            meltTemp: Number(s.melt_temp.toFixed(2)),
            pressure: Number(s.pump_pressure.toFixed(3)),
            thickness: Number(s.thickness_um.toFixed(2)),
            defect: Number(s.defect_pct.toFixed(3)),
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

// ============================================================
// 一阶惯性 + 纯滞后(FOPDT)单步灰箱动力学
//   状态(全数值 Record,可序列化):
//     zone1_temp/zone2_temp/zone3_temp  加热区温度(℃)
//     pump_pressure                     泵送腔压力(MPa)
//     thickness_um                      测厚仪处厚度(μm)
//     die_gap_mm                        上一步模口间隙(缺省时保持)
//     meltBufK + meltBuf0..meltBufK-1   熔体温度纯滞后缓冲(旧→新,存第三区温度)
//     hBufK + hBuf0..hBufK-1            厚度输送纯滞后缓冲(旧→新,存模口出口厚度)
// ============================================================

function readDelayBuf(state, prefix, k, seed) {
  const storedK = Math.max(0, Math.trunc(Number(state[`${prefix}K`]) || 0))
  const buf = []
  for (let i = 0; i < storedK; i++) {
    const v = Number(state[`${prefix}${i}`])
    buf.push(Number.isFinite(v) ? v : seed)
  }
  if (buf.length === 0) buf.push(seed)
  if (k > buf.length) buf.unshift(...new Array(k - buf.length).fill(buf[0]))
  else if (k < buf.length) buf.splice(0, buf.length - k)
  return buf
}

function writeDelayBuf(state, prefix, buf) {
  const prevK = Math.max(0, Math.trunc(Number(state[`${prefix}K`]) || 0))
  for (let i = buf.length; i < prevK; i++) delete state[`${prefix}${i}`]
  state[`${prefix}K`] = buf.length
  for (let i = 0; i < buf.length; i++) state[`${prefix}${i}`] = buf[i]
}

/**
 * 单步推进(欧拉积分,口径同 plant-model.step:先算全部导数再统一更新)。
 * disturbances: heater_efficiency(0.2~1,加热器效率衰减)、feed_temp_offset(℃,进料温度偏移)。
 */
export function castFilmStep(state, controls, opt = {}) {
  const P = { ...PLANT_PARAMS, ...(opt.params ?? {}) }
  const dt = Math.max(Number(opt.dtSec ?? 1), 0.001)
  const dist = opt.disturbances ?? {}
  const eta = clamp(Number(dist.heater_efficiency ?? 1), 0.2, 1)
  const feedTemp = Number(dist.feed_temp_offset ?? 0)

  const tz1 = Number(state.zone1_temp ?? CASTFILM_NOMINAL.zone)
  const tz2 = Number(state.zone2_temp ?? CASTFILM_NOMINAL.zone)
  const tz3 = Number(state.zone3_temp ?? CASTFILM_NOMINAL.zone)
  const p = Number(state.pump_pressure ?? 0.5)
  const dieGap = Number.isFinite(Number(state.die_gap_mm)) ? Number(state.die_gap_mm) : CASTFILM_NOMINAL.dieGap

  const u = controls ?? {}
  const cZone1 = Number.isFinite(Number(u.zone1_sp)) ? Number(u.zone1_sp) : tz1
  const cZone2 = Number.isFinite(Number(u.zone2_sp)) ? Number(u.zone2_sp) : tz2
  const cZone3 = Number.isFinite(Number(u.zone3_sp)) ? Number(u.zone3_sp) : tz3
  const screw = Number.isFinite(Number(u.screw_rpm)) ? Number(u.screw_rpm) : CASTFILM_NOMINAL.screw
  const lineSpeed = Number.isFinite(Number(u.line_speed_mpm)) ? Number(u.line_speed_mpm) : CASTFILM_NOMINAL.lineSpeed
  const gap = Number.isFinite(Number(u.die_gap_mm)) ? Number(u.die_gap_mm) : dieGap

  // (1) 加热区:一阶惯性 + 区间热传导(导数全部用旧值;进料偏移叠加在 zone1 有效设定)
  const sp1 = cZone1 * eta + feedTemp
  const d1 = (sp1 - tz1) / P.tauZoneSec
  const d2 = (cZone2 * eta - tz2) / P.tauZoneSec + P.kHeat * (tz1 - tz2) / P.tauZoneSec
  const d3 = (cZone3 * eta - tz3) / P.tauZoneSec + P.kHeat * (tz2 - tz3) / P.tauZoneSec
  const n1 = tz1 + d1 * dt
  const n2 = tz2 + d2 * dt
  const n3 = tz3 + d3 * dt

  // (2) 熔体温度:纯滞后线(每步推入当前第三区温度,延时 tauMeltSec)
  const meltK = Math.max(1, Math.round(P.tauMeltSec / dt))
  const meltBuf = readDelayBuf(state, 'meltBuf', meltK, n3)
  meltBuf.push(n3)
  while (meltBuf.length > meltK) meltBuf.shift()
  const meltTemp = meltBuf[0]

  // (3) Arrhenius 粘度 → (4) 熔体流量(转速正比 + 粘度部分补偿)
  const tmK = meltTemp + 273.15
  const ratio = Math.exp(-P.arrheniusB * (1 / tmK - 1 / P.tRefK))
  const flow = P.flowK * Math.max(screw, 0) * Math.pow(Math.max(ratio, 1e-6), 0.4)

  // (5) 泵送腔一阶
  const np = p + dt * (flow / P.pumpK - p) / P.tauPumpSec

  // (6) 质量守恒定厚(模口间隙修正)+ 纯滞后输送(τh = L/v,随线速变)
  const gFac = clamp(gap / P.dieGapRefMm, 0.55, 1.6)
  const hExit = ((flow / (P.dieWidthM * Math.max(lineSpeed, 1) * P.filmDensity)) * 1e6) * gFac
  const vmps = Math.max(lineSpeed, 1) / 60
  const hK = Math.max(1, Math.round(P.gaugeDistanceM / vmps / dt))
  const hBuf = readDelayBuf(state, 'hBuf', hK, hExit)
  hBuf.push(hExit)
  while (hBuf.length > hK) hBuf.shift()
  const h = hBuf[0]

  // (8) 缺陷率 (9) 晶点(σP 取稳态残余,口径同 steadyState)
  const sigmaP0 = 0.06
  const over = Math.max(0, meltTemp - 255)
  const defect = clamp(0.55 * ((meltTemp - P.defectT) / 10) ** 2 + 0.9 * sigmaP0 + 0.02 * over * over, 0, 100)
  const gels = clamp(4 + 0.05 * Math.max(0, meltTemp - 240) ** 2, 0, 500)

  const nextState = {
    ...state,
    zone1_temp: n1,
    zone2_temp: n2,
    zone3_temp: n3,
    pump_pressure: np,
    thickness_um: h,
    die_gap_mm: gap,
  }
  writeDelayBuf(nextState, 'meltBuf', meltBuf)
  writeDelayBuf(nextState, 'hBuf', hBuf)

  return {
    state: nextState,
    observations: {
      melt_temp: meltTemp,
      pump_pressure: np,
      thickness_um: h,
      defect_pct: defect,
      gels_per_m2: gels,
      melt_flow_kpm: flow,
      viscosity_pas: P.mu0 / Math.max(ratio, 1e-6),
      transport_delay_s: P.gaugeDistanceM / vmps,
    },
    guards: {
      zone1_temp: n1,
      zone2_temp: n2,
      zone3_temp: n3,
      melt_temp: meltTemp,
      pump_pressure: np,
      thickness_um: h,
    },
  }
}

/** rollout:给定控制序列连续推进 N 步(与 simulate 同口径,供 ensemble 复用) */
export function castFilmRollout(initialState, controlsList, disturbances = {}, dtSec = 1, params) {
  let state = { ...initialState }
  const steps = []
  const failures = []
  for (const controls of controlsList) {
    const result = castFilmStep(state, controls, { disturbances, dtSec, params })
    const nonFinite = [...Object.values(result.observations), ...Object.values(result.guards)].some(v => !Number.isFinite(v))
    if (nonFinite) failures.push('PHYSICS_NON_FINITE')
    state = result.state
    steps.push(result)
  }
  return { steps, failures }
}

/** 3 样本参数扰动 ensemble(名义 + 高/低参数分支;确定性,无随机) */
export function ensembleParamVariants() {
  return [
    {},
    { tauZoneSec: PLANT_PARAMS.tauZoneSec * 0.9, flowK: PLANT_PARAMS.flowK * 1.1, pumpK: PLANT_PARAMS.pumpK * 1.1, tauPumpSec: PLANT_PARAMS.tauPumpSec * 0.8 },
    { tauZoneSec: PLANT_PARAMS.tauZoneSec * 1.1, flowK: PLANT_PARAMS.flowK * 0.9, pumpK: PLANT_PARAMS.pumpK * 0.9, tauPumpSec: PLANT_PARAMS.tauPumpSec * 1.2 },
  ]
}

function stdOf3(a, b, c) {
  const mean = (a + b + c) / 3
  return Math.sqrt(((a - mean) ** 2 + (b - mean) ** 2 + (c - mean) ** 2) / 3)
}

/**
 * rollout + 参数扰动 ensemble 不确定度(uq)。
 * 返回 { steps, failures, uq }:uq.meanStd/maxStd/finalStd 基于 3 样本总体标准差。
 */
export function castFilmRolloutWithUq(initialState, controlsList, disturbances = {}, dtSec = 1) {
  const runs = ensembleParamVariants().map(params => castFilmRollout(initialState, controlsList, disturbances, dtSec, params))
  const base = runs[0]
  const uqKeys = ['melt_temp', 'pump_pressure', 'thickness_um']
  const meanStd = {}
  const finalStd = {}
  let maxStd = 0
  for (const key of uqKeys) {
    let sum = 0
    for (let i = 0; i < base.steps.length; i++) {
      const s = stdOf3(
        runs[0].steps[i]?.observations[key] ?? NaN,
        runs[1].steps[i]?.observations[key] ?? NaN,
        runs[2].steps[i]?.observations[key] ?? NaN,
      )
      if (!Number.isFinite(s)) continue
      sum += s
      if (s > maxStd) maxStd = s
    }
    meanStd[key] = base.steps.length ? sum / base.steps.length : 0
    const last = base.steps.length - 1
    finalStd[key] = stdOf3(
      runs[0].steps[last]?.observations[key] ?? NaN,
      runs[1].steps[last]?.observations[key] ?? NaN,
      runs[2].steps[last]?.observations[key] ?? NaN,
    )
  }
  return {
    steps: base.steps,
    failures: base.failures,
    uq: {
      method: 'parameter-perturbation-ensemble',
      ensembleSize: runs.length,
      meanStd,
      finalStd: Object.fromEntries(Object.entries(finalStd).map(([k, v]) => [k, Number.isFinite(v) ? v : 0])),
      maxStd: Number.isFinite(maxStd) ? maxStd : 0,
      perturbation: 'tauZoneSec±10%, flowK±10%, pumpK±10%, tauPumpSec∓20%',
    },
  }
}

/** 稳态 ensemble 不确定度(参数扰动 3 样本 std) */
export function steadyStateWithUq(controls) {
  const samples = ensembleParamVariants().map(params => castFilmSteadyState(controls, params))
  const uq = {}
  for (const key of Object.keys(samples[0])) {
    uq[key] = stdOf3(samples[0][key], samples[1][key], samples[2][key])
  }
  return { outputs: samples[0], uq: { method: 'parameter-perturbation-ensemble', ensembleSize: samples.length, std: uq } }
}
