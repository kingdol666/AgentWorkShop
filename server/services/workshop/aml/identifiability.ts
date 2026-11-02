/**
 * 干预可辨识性引擎(科学探索计划 P1,docs/plans/2026-11-02-scientific-exploration-plan.md):
 * 回答"这次干预的效应在统计上能不能被分辨"。预测精度 ≠ 因果可辨识 —— 本引擎在
 * 下发判读与探索前置时给出机器可读判定:
 *   IDENTIFIABLE          窗口/覆盖充分,CI 不含 0(有效应)或分辨率足够支撑"无可分辨效应"负结论
 *   UNDERPOWERED          响应窗未覆盖 ≥3 个主导扰动周期(或 MDE 大于效应量级),结论不可信
 *   CONFOUNDED            控制量与时间序号高度共线(干预与自然漂移不可分,如"SP 降档==作业后半段")
 *   INSUFFICIENT_DATA     数据拍数不足,连预检都做不了
 * 纯函数、零依赖(复用 stats.ts 的 pearson);统计口径:主导周期=预窗自相关峰、
 * CI=分组自助法(种子确定,可复现)、MDE=(z_{α/2}+z_{power})·SE(经 AR(1) 有效样本量修正)。
 */
import { pearson } from './stats'

export type IdentifiabilityVerdictCode = 'IDENTIFIABLE' | 'UNDERPOWERED' | 'CONFOUNDED' | 'INSUFFICIENT_DATA'

export interface IdentifiabilityInput {
  /** 干预前目标序列(等间隔 beatMs;应为未受干预的自然工况段) */
  pre: number[]
  /** 干预后目标序列(等间隔 beatMs) */
  post: number[]
  /** 序列节拍(ms;两段同拍) */
  beatMs: number
  /** 显著性水平,缺省 0.05 */
  alpha?: number
  /** 可选:控制量全序列(与 pre+post 对齐);提供时做水平数与共线诊断 */
  control?: number[]
  /** 自助法种子(缺省 42,保证判定可复现) */
  seed?: number
  /** 关心的效应量(判据 MDE):提供时,分辨率罩不住它 → UNDERPOWERED;缺省只按周期覆盖判功效 */
  targetMde?: number
  /**
   * 已知主导周期(ms;来自更长历史窗的估计,如 DoE 执行前一次性估计)。
   * 提供时跳过窗口内自相关检测 —— 短窗常只能看到局部纹波,局部估计不可靠。
   */
  expectedPeriodMs?: number
}

export interface IdentifiabilityVerdict {
  verdict: IdentifiabilityVerdictCode
  /** 效应量估计 = post 均值 − pre 均值 */
  effect: number | null
  ciLow: number | null
  ciHigh: number | null
  /** 95%(或 alpha)CI 是否不含 0 */
  significant: boolean
  /** 最小可检测效应(当前窗宽/噪声/显著水平/80% 功效下的分辨率下限) */
  mde: number | null
  /** 主导扰动周期(ms;预窗自相关峰;无可检周期为 null) */
  dominantPeriodMs: number | null
  /** 预窗/响应窗覆盖的主导周期个数(无周期时为 null) */
  preCoveragePeriods: number | null
  postCoveragePeriods: number | null
  /** 建议试验响应窗 = 3 × 主导周期(无周期为 null) */
  suggestedWindowMs: number | null
  /** 建议控制水平数(覆盖 <3 个水平时 = 3,否则 null) */
  suggestedLevels: number | null
  /** 预/响窗在主导周期相位轴上的重叠系数 0..1(无周期为 null) */
  phaseOverlap: number | null
  /** 控制量与时间序号 |pearson|(未提供 control 为 null) */
  collinearity: number | null
  /** 控制量历史水平数(容差聚类;未提供 control 为 null) */
  controlLevels: number | null
  /** AR(1) 有效样本量修正后的 pre/post 拍数 */
  nEffPre: number | null
  nEffPost: number | null
  reasons: string[]
}

/** 自相关系数(滞后 lag;两端对齐截断后走 pearson) */
function autocorr(xs: number[], lag: number): number {
  if (lag <= 0 || xs.length <= lag + 4) return 0
  return pearson(xs.slice(0, xs.length - lag), xs.slice(lag))
}

/**
 * 主导扰动周期:自相关**第一个**显著局部极大(基波周期)。
 * 峰判据三条件:上行进入(> 前一 lag)且下行离开(≥ 后一 lag)、幅值 ≥ max(0.25, 全局峰/2)、
 * 突出度 ≥ 0.1(与前谷差,排除随机游走的噪声上抖)。取首峰不取全局峰 ——
 * 纯正弦的自相关在各整周期处几乎等高,全局最大会随机抓到 k×周期(倍周期错判)。
 */
export function dominantPeriod(series: number[]): { lagBeats: number | null, peakCorr: number, lag1Corr: number } {
  const n = series.length
  const maxLag = Math.min(Math.floor(n / 2), 2000)
  if (maxLag < 4) return { lagBeats: null, peakCorr: 0, lag1Corr: 0 }
  const a: number[] = new Array<number>(maxLag + 1).fill(0) // a[lag]
  for (let lag = 1; lag <= maxLag; lag++) a[lag] = autocorr(series, lag)
  const lag1 = a[1]!
  let best = 2
  for (let lag = 2; lag <= maxLag; lag++) if (a[lag]! > a[best]!) best = lag
  const maxR = a[best]!
  if (maxR < 0.25) return { lagBeats: null, peakCorr: maxR, lag1Corr: lag1 }
  // 倍周期收敛:正弦在 T,2T,3T… 处几乎等高;取"与全局峰相差 ≤10% 的最早 lag"作为基波,
  // 避免随机抓到 k×T。
  let fundamental = best
  for (let lag = 2; lag < best; lag++) {
    if (a[lag]! >= 0.9 * maxR && a[lag]! >= a[lag - 1]! && a[lag]! >= a[lag + 1]!) {
      fundamental = lag
      break
    }
  }
  // 低频漂移守卫:lag1 强持续(≥0.9)却报出很短的"周期" ⇒ 小 lag 处只是慢漂移上的纹波,
  // 不是主导扰动周期(事故形态:60 拍窗 vs 282 拍周期,被 4 拍纹波带偏)。
  if (Math.abs(lag1) >= 0.9 && fundamental <= 8) {
    return { lagBeats: null, peakCorr: maxR, lag1Corr: lag1 }
  }
  return { lagBeats: fundamental, peakCorr: a[fundamental]!, lag1Corr: lag1 }
}

/** AR(1) 有效样本量:n·(1−ρ1)/(1+ρ1);下限 2(方差估计仍来自全样本) */
export function effectiveN(xs: number[], lag1Corr: number): number {
  const rho = Math.max(-0.95, Math.min(0.95, lag1Corr))
  return Math.max(2, xs.length * (1 - rho) / (1 + rho))
}

/** 标准正态分位数(反 CDF;Acklam 有理逼近,|相对误差|<1.15e-9) */
export function probit(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`probit 定义域 (0,1),收到 ${p}`)
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598876e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const pLow = 0.02425
  let q: number
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (p > 1 - pLow) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  q = p - 0.5
  const rr = q * q
  return (((((a[0]! * rr + a[1]!) * rr + a[2]!) * rr + a[3]!) * rr + a[4]!) * rr + a[5]!) * q / (((((b[0]! * rr + b[1]!) * rr + b[2]!) * rr + b[3]!) * rr + b[4]!) * rr + 1)
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function sampleStd(xs: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1))
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    // >>> 0 归一为 uint32:int32 直除会产出负数,用于索引时 floor 出负下标 → undefined → NaN
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296
  }
}

/** 分组自助法百分位置信区间(组内重采样;种子确定 → 同输入同输出) */
export function bootstrapEffectCi(pre: number[], post: number[], opts?: { seed?: number, alpha?: number, replicates?: number }): { low: number, high: number } {
  const alpha = opts?.alpha ?? 0.05
  const B = opts?.replicates ?? 1000
  const rnd = mulberry32(opts?.seed ?? 42)
  const diffs: number[] = []
  for (let i = 0; i < B; i++) {
    let sp = 0
    for (let j = 0; j < pre.length; j++) sp += pre[Math.floor(rnd() * pre.length)]!
    let sq = 0
    for (let j = 0; j < post.length; j++) sq += post[Math.floor(rnd() * post.length)]!
    diffs.push(sq / post.length - sp / pre.length)
  }
  diffs.sort((a, b) => a - b)
  const loIdx = Math.max(0, Math.floor((alpha / 2) * B))
  const hiIdx = Math.min(B - 1, Math.floor((1 - alpha / 2) * B))
  return { low: diffs[loIdx]!, high: diffs[hiIdx]! }
}

/** 最小可检测效应:MDE = (z_{α/2} + z_{power}) · SE(AR(1) 有效样本量修正) */
export function minimumDetectableEffect(pre: number[], post: number[], lag1: number, alpha = 0.05): number {
  const nEffP = effectiveN(pre, lag1)
  const nEffQ = effectiveN(post, lag1)
  const se = Math.sqrt(sampleStd(pre) ** 2 / nEffP + sampleStd(post) ** 2 / nEffQ)
  return (probit(1 - alpha / 2) + probit(0.8)) * se
}

/** 控制量历史水平数(容差聚类:跨度 1e-9 相对容差 + 绝对 1e-12) */
export function distinctLevels(values: number[]): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!finite.length) return 0
  let levels = 1
  for (let i = 1; i < finite.length; i++) {
    const tol = Math.max(1e-12, Math.abs(finite[i]!) * 1e-9)
    if (Math.abs(finite[i]! - finite[i - 1]!) > tol) levels++
  }
  return levels
}

/** 预/响窗在主导周期相位轴上的重叠系数(8 bin 直方图,Σmin/n;1=相位结构一致) */
export function phaseOverlap(pre: number[], post: number[], periodBeats: number): number {
  if (periodBeats <= 0) return 0
  const bins = 8
  const hist = (xs: number[]): number[] => {
    const h = new Array<number>(bins).fill(0)
    for (let i = 0; i < xs.length; i++) {
      const phase = ((i % periodBeats) / periodBeats) * bins
      h[Math.min(bins - 1, Math.floor(phase))]!++
    }
    const total = xs.length || 1
    return h.map(v => v / total)
  }
  const hp = hist(pre)
  const hq = hist(post)
  return hp.reduce((a, v, i) => a + Math.min(v, hq[i]!), 0)
}

/**
 * 可辨识性判定主入口。判定顺序:数据量 → 混杂(共线)→ 功效(周期覆盖/MDE)→ 结论。
 * 关键语义:**窗口充分但 CI 含 0 = 可辨识的无效应(负结果,同等科学价值)**;
 * 只有窗口/覆盖不充分才判 UNDERPOWERED。
 */
export function assessIdentifiability(input: IdentifiabilityInput): IdentifiabilityVerdict {
  const { pre, post, beatMs } = input
  const alpha = input.alpha ?? 0.05
  const seed = input.seed ?? 42
  const reasons: string[] = []

  const empty = (verdict: IdentifiabilityVerdictCode, extra: Partial<IdentifiabilityVerdict> = {}): IdentifiabilityVerdict => ({
    verdict,
    effect: null,
    ciLow: null,
    ciHigh: null,
    significant: false,
    mde: null,
    dominantPeriodMs: null,
    preCoveragePeriods: null,
    postCoveragePeriods: null,
    suggestedWindowMs: null,
    suggestedLevels: null,
    phaseOverlap: null,
    collinearity: null,
    controlLevels: null,
    nEffPre: null,
    nEffPost: null,
    reasons,
    ...extra,
  })

  if (pre.length < 8 || post.length < 8) {
    reasons.push(`拍数不足:前窗 ${pre.length} 拍 / 响应窗 ${post.length} 拍,判定至少各需 8 拍(beatMs=${beatMs})`)
    return empty('INSUFFICIENT_DATA')
  }

  // 1) 主导周期:优先用调用方给出的长历史估计(短窗局部估计会被纹波带偏);
  //    否则以未受干预的预窗为准(预窗过短时退化为拼接序列估计)。
  const expectedLag = input.expectedPeriodMs != null && input.expectedPeriodMs > 0
    ? Math.max(2, Math.round(input.expectedPeriodMs / Math.max(1, beatMs)))
    : null
  const periodSrc = pre.length >= 16 ? pre : [...pre, ...post]
  const periodOf = expectedLag != null
    ? { lagBeats: expectedLag as number | null, peakCorr: autocorr(periodSrc, Math.min(expectedLag, Math.floor(periodSrc.length / 2))), lag1Corr: autocorr(periodSrc, 1) }
    : dominantPeriod(periodSrc)
  const periodMs = periodOf.lagBeats != null ? periodOf.lagBeats * beatMs : null
  if (periodMs != null) {
    reasons.push(`检出主导扰动周期 ${(periodMs / 60000).toFixed(2)} min(自相关峰 r=${periodOf.peakCorr.toFixed(2)},lag=${periodOf.lagBeats} 拍)`)
  }
  else {
    reasons.push('未检出显著周期性(自相关峰 < 0.25),功效仅按噪声分辨率评估')
  }
  const prePeriods = periodOf.lagBeats != null ? pre.length / periodOf.lagBeats : null
  const postPeriods = periodOf.lagBeats != null ? post.length / periodOf.lagBeats : null

  // 2) 混杂诊断:控制量与时间序号共线(干预档位与自然漂移在数据里是同一件事)
  let collinearity: number | null = null
  let controlLevels: number | null = null
  if (input.control && input.control.length >= 8) {
    const idx = input.control.map((_, i) => i)
    collinearity = Math.abs(pearson(input.control, idx))
    controlLevels = distinctLevels(input.control)
    if (collinearity > 0.9) {
      reasons.push(`控制量与时间序号高度共线(|r|=${collinearity.toFixed(3)}):干预档位与自然漂移/工段推进不可分,判读被混杂`)
      return empty('CONFOUNDED', { dominantPeriodMs: periodMs, preCoveragePeriods: prePeriods, postCoveragePeriods: postPeriods, suggestedWindowMs: periodMs != null ? 3 * periodMs : null, collinearity, controlLevels })
    }
    if (controlLevels < 2) {
      reasons.push(`控制量仅 ${controlLevels} 个水平:本次数据不含对照差分,无法归因`)
      return empty('CONFOUNDED', { dominantPeriodMs: periodMs, preCoveragePeriods: prePeriods, postCoveragePeriods: postPeriods, suggestedWindowMs: periodMs != null ? 3 * periodMs : null, collinearity, controlLevels })
    }
  }

  // 3) 效应与分辨率
  const effect = mean(post) - mean(pre)
  const ci = bootstrapEffectCi(pre, post, { seed, alpha })
  // 数值零下限:恒定/近恒定序列的浮点残差(1e-15 级)不得被当成"显著效应"
  const effectFloor = 1e-9 * Math.max(1, Math.abs(mean(pre)))
  const significant = (ci.low > 0 || ci.high < 0) && Math.abs(effect) > effectFloor
  const mde = minimumDetectableEffect(pre, post, periodOf.lag1Corr, alpha)
  const overlap = periodOf.lagBeats != null ? phaseOverlap(pre, post, periodOf.lagBeats) : null

  // 4) 功效判定:响应窗须覆盖 ≥3 个主导周期(3×周期=建议窗);带判据时分辨率须罩得住关心效应量。
  //    注意:MDE 只对照"关心的效应量"(判据),不对照样本观测差分 —— 否则一切零结果都被误判欠功效,
  //    负结果语义失效(零结果 + 充分窗口 = 可辨识的无效应)。
  const periodShort = postPeriods != null && postPeriods < 3
  const mdeSwallowsCriterion = input.targetMde != null && mde > input.targetMde
  // 窗内未覆盖一个完整周期(周期检测为 null)但自相关 lag1 高 = 低频漂移/振荡:
  // 相邻窗的均值差可能只是相位/漂移,不是干预效应(事故形态:47s 窗 vs 4.71min 周期)。
  // 此时不得判"有效应",必须判欠功效并提示在更长历史上估周期。
  const unresolvableDrift = periodOf.lagBeats == null && Math.abs(periodOf.lag1Corr) >= 0.5
  if (periodShort || mdeSwallowsCriterion || unresolvableDrift) {
    if (periodShort) reasons.push(`响应窗仅覆盖 ${postPeriods!.toFixed(2)} 个主导扰动周期(<3):均值差受相位混杂,不能归因于干预`)
    if (unresolvableDrift) reasons.push(`窗内未覆盖一个完整扰动周期(自相关 lag1=${periodOf.lag1Corr.toFixed(2)} 显示强持续性):前/后窗均值差可能只是相位或漂移,不能归因于干预;请先用更长历史窗(daq_identifiability)估主导周期,再按 ≥3×周期设响应窗`)
    if (mdeSwallowsCriterion) reasons.push(`分辨率不足:MDE=${mde.toPrecision(3)} > 判据效应量 ${input.targetMde!.toPrecision(3)},当前步幅/窗长不足以分辨该效应`)
    return empty('UNDERPOWERED', {
      // 相位/漂移混杂时不得对外声称"显著":CI 算出来不含 0 也只作参考
      effect, ciLow: ci.low, ciHigh: ci.high, significant: significant && !(periodShort || unresolvableDrift), mde,
      dominantPeriodMs: periodMs, preCoveragePeriods: prePeriods, postCoveragePeriods: postPeriods,
      suggestedWindowMs: periodMs != null ? 3 * periodMs : null,
      suggestedLevels: controlLevels != null && controlLevels < 3 ? 3 : null,
      phaseOverlap: overlap, collinearity, controlLevels,
      nEffPre: effectiveN(pre, periodOf.lag1Corr), nEffPost: effectiveN(post, periodOf.lag1Corr),
    })
  }

  // 5) 结论:有效应(方向性外推合法)或可辨识的无效应(负结果)
  if (significant) reasons.push(`效应可分辨:Δ=${effect.toPrecision(4)},${Math.round((1 - alpha) * 100)}% CI [${ci.low.toPrecision(4)}, ${ci.high.toPrecision(4)}] 不含 0`)
  else reasons.push(`无可分辨效应:Δ=${effect.toPrecision(4)},CI [${ci.low.toPrecision(4)}, ${ci.high.toPrecision(4)}] 含 0,分辨率 MDE=${mde.toPrecision(3)} —— 窗口充分的负结论,可入库`)
  if (periodMs != null) reasons.push(`建议正交试验:响应窗 ≥ ${(3 * periodMs / 60000).toFixed(1)} min(3×周期)${controlLevels != null && controlLevels < 3 ? ',水平数 ≥3 阶梯往返' : ''}`)
  return empty('IDENTIFIABLE', {
    effect, ciLow: ci.low, ciHigh: ci.high, significant, mde,
    dominantPeriodMs: periodMs, preCoveragePeriods: prePeriods, postCoveragePeriods: postPeriods,
    suggestedWindowMs: periodMs != null ? 3 * periodMs : null,
    suggestedLevels: controlLevels != null && controlLevels < 3 ? 3 : null,
    phaseOverlap: overlap, collinearity, controlLevels,
    nEffPre: effectiveN(pre, periodOf.lag1Corr), nEffPost: effectiveN(post, periodOf.lag1Corr),
  })
}
