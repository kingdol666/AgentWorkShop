/**
 * SPC 数学库(E4,纯函数零依赖 —— 教科书公式,单测锁定)。
 *
 * 控制图:I-MR / Xbar-R / EWMA / CUSUM;判异:Nelson 1-8(含 Western Electric 基本四则)。
 * 全部输入输出为标量数组/结构体,不触库 —— 判定序列建议为 per-run 等间隔特征
 * (eda_run_features.mean 按 run 开始时间 ASC),不均匀采样上的链长类规则(5/6)无意义。
 */

/** Nelson 规则(逐点命中;返回每点触发的规则 id 列表,1-8) */
export function nelsonHits(values: number[], cl: number, sigma: number): string[][] {
  const n = values.length
  const hits: string[][] = Array.from({ length: n }, () => [])
  const side = (v: number): number => (v > cl ? 1 : v < cl ? -1 : 0)
  const beyond = (v: number, k: number): number => (v > cl + k * sigma ? 1 : v < cl - k * sigma ? -1 : 0)
  for (let i = 0; i < n; i++) {
    const v = values[i]!
    if (sigma > 0 && Math.abs(v - cl) > 3 * sigma) hits[i]!.push('1')
    // 规则 2:连续 9 点同侧
    if (i >= 8) {
      const win = values.slice(i - 8, i + 1)
      const s0 = side(win[0]!)
      if (s0 !== 0 && win.every(w => side(w) === s0)) hits[i]!.push('2')
    }
    // 规则 3:连续 6 点单调(升或降)
    if (i >= 5) {
      const win = values.slice(i - 5, i + 1)
      let inc = true
      let dec = true
      for (let j = 1; j < win.length; j++) {
        if (win[j]! <= win[j - 1]!) inc = false
        if (win[j]! >= win[j - 1]!) dec = false
      }
      if (inc || dec) hits[i]!.push('3')
    }
    // 规则 4:连续 14 点交替上下
    if (i >= 13) {
      const win = values.slice(i - 13, i + 1)
      let alt = true
      for (let j = 2; j < win.length; j++) {
        if ((win[j]! - win[j - 1]!) * (win[j - 1]! - win[j - 2]!) >= 0) alt = false
      }
      if (alt) hits[i]!.push('4')
    }
    // 规则 5:3 点中 2 点落在同侧 2σ 外
    if (i >= 2 && sigma > 0) {
      const win = values.slice(i - 2, i + 1)
      const up = win.filter(w => beyond(w, 2) === 1).length
      const down = win.filter(w => beyond(w, 2) === -1).length
      if (up >= 2 || down >= 2) hits[i]!.push('5')
    }
    // 规则 6:5 点中 4 点落在同侧 1σ 外
    if (i >= 4 && sigma > 0) {
      const win = values.slice(i - 4, i + 1)
      const up = win.filter(w => beyond(w, 1) === 1).length
      const down = win.filter(w => beyond(w, 1) === -1).length
      if (up >= 4 || down >= 4) hits[i]!.push('6')
    }
    // 规则 7:连续 15 点在 1σ 内(分层)
    if (i >= 14 && sigma > 0) {
      const win = values.slice(i - 14, i + 1)
      if (win.every(w => Math.abs(w - cl) < sigma)) hits[i]!.push('7')
    }
    // 规则 8:连续 8 点都落在 1σ 外(两侧不限)
    if (i >= 7 && sigma > 0) {
      const win = values.slice(i - 7, i + 1)
      if (win.every(w => Math.abs(w - cl) > sigma)) hits[i]!.push('8')
    }
  }
  return hits
}

/** I-MR:单值-移动极差;σ̂ = MR̄ / 1.128(n=2 无偏常数) */
export function iMr(values: number[]): { cl: number, sigma: number, ucl: number, lcl: number, mrBar: number, mrUcl: number } | null {
  if (values.length < 2) return null
  const cl = values.reduce((a, b) => a + b, 0) / values.length
  const mrs: number[] = []
  for (let i = 1; i < values.length; i++) mrs.push(Math.abs(values[i]! - values[i - 1]!))
  const mrBar = mrs.reduce((a, b) => a + b, 0) / mrs.length
  const sigma = mrBar / 1.128
  return {
    cl,
    sigma,
    ucl: cl + 3 * sigma,
    lcl: cl - 3 * sigma,
    mrBar,
    mrUcl: 3.267 * mrBar,
  }
}

/** Xbar-R:子组均值-极差;σ̂ = R̄ / d2(n)(d2 查表 2..6,缺省按 1.128 退化) */
const D2: Record<number, number> = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534 }
export function xbarR(groups: number[][]): { cl: number, sigma: number, ucl: number, lcl: number, rBar: number } | null {
  const usable = groups.filter(g => g.length >= 2)
  if (usable.length < 2) return null
  const xbars = usable.map(g => g.reduce((a, b) => a + b, 0) / g.length)
  const rs = usable.map(g => Math.max(...g) - Math.min(...g))
  const cl = xbars.reduce((a, b) => a + b, 0) / xbars.length
  const rBar = rs.reduce((a, b) => a + b, 0) / rs.length
  const n = usable[0]!.length
  const d2 = D2[n] ?? 1.128
  const sigma = rBar / d2
  const a2 = 3 / (d2 * Math.sqrt(n))
  return { cl, sigma, ucl: cl + a2 * rBar, lcl: cl - a2 * rBar, rBar }
}

/** EWMA:z_t = λ·x_t + (1-λ)·z_{t-1};控制限 cl ± 3σ·sqrt(λ/(2-λ)·(1-(1-λ)^{2t})) */
export function ewma(values: number[], cl: number, sigma: number, lambda = 0.2): { stats: number[], limits: Array<{ ucl: number, lcl: number }> } {
  let z = cl
  const stats: number[] = []
  const limits: Array<{ ucl: number, lcl: number }> = []
  for (let i = 0; i < values.length; i++) {
    z = lambda * values[i]! + (1 - lambda) * z
    const f = sigma * Math.sqrt((lambda / (2 - lambda)) * (1 - (1 - lambda) ** (2 * (i + 1))))
    stats.push(z)
    limits.push({ ucl: cl + 3 * f, lcl: cl - 3 * f })
  }
  return { stats, limits }
}

/** CUSUM(标准化):k(h 均以 σ 为单位,缺省 k=0.5,h=4);返回 C+/C- 与越限点 */
export function cusum(values: number[], cl: number, sigma: number, k = 0.5, h = 4): { cPlus: number[], cMinus: number[], violated: boolean[] } {
  let cp = 0
  let cm = 0
  const cPlus: number[] = []
  const cMinus: number[] = []
  const violated: boolean[] = []
  const kk = k * sigma
  const hh = h * sigma
  for (const v of values) {
    cp = Math.max(0, cp + (v - cl) - kk)
    cm = Math.max(0, cm + (cl - v) - kk)
    cPlus.push(cp)
    cMinus.push(cm)
    violated.push(sigma > 0 && (cp > hh || cm > hh))
  }
  return { cPlus, cMinus, violated }
}

/** 从特征值序列建限:I-MR 为主(等间隔 per-run 序列的缺省图型) */
export function buildLimits(values: number[]): { cl: number, sigma: number, ucl: number, lcl: number } | null {
  const m = iMr(values)
  if (!m) return null
  return { cl: m.cl, sigma: m.sigma, ucl: m.ucl, lcl: m.lcl }
}
