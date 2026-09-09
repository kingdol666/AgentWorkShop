/**
 * AML 时序清洗管线(顺序固定,全部动作计数进清洗报告):
 *   state 过滤 → 量程截断 → Hampel 去尖峰 → 桶对齐重采样 → 缺口策略
 * 纯函数(Node 侧,无 IO);输入为单节点单 run 的对齐前点列。
 */

export interface RawPoint { at: number, value: number, state?: string }

export interface CleanCounts {
  total: number
  droppedState: number
  droppedRange: number
  droppedHampel: number
  interpolated: number
}

export interface CleanOptions {
  /** 模板量程 [min, max];undefined = 不截断 */
  range?: { min: number, max: number }
  /** Hampel 窗口半径(点数),0/undefined = 关闭;阈值 = median ± 3·MAD */
  hampelK?: number
  beatMs: number
  /** 短缺口线性插值上限 ms(缺省 3×beatMs;0 = 不插值) */
  maxInterpMs?: number
}

export interface CleanResult {
  /** 对齐到 beatMs 网格后的值序列(时间戳 = 网格点) */
  grid: { at: number, value: number }[]
  counts: CleanCounts
}

/** 1+2+3:逐点清洗(原值域),返回干净点列 */
export function cleanPoints(points: RawPoint[], opts: { range?: { min: number, max: number }, hampelK?: number }): { values: { at: number, value: number }[], counts: CleanCounts } {
  const counts: CleanCounts = { total: points.length, droppedState: 0, droppedRange: 0, droppedHampel: 0, interpolated: 0 }
  const kept: { at: number, value: number }[] = []
  for (const p of points) {
    if (p.state && p.state !== 'ok') {
      counts.droppedState++
      continue
    }
    if (opts.range && (p.value < opts.range.min || p.value > opts.range.max)) {
      counts.droppedRange++
      continue
    }
    kept.push({ at: p.at, value: p.value })
  }
  if (opts.hampelK && opts.hampelK > 0 && kept.length > opts.hampelK * 2 + 2) {
    const out: { at: number, value: number }[] = []
    const k = opts.hampelK
    for (let i = 0; i < kept.length; i++) {
      const cur = kept[i]
      if (!cur) continue
      const win: number[] = []
      for (let j = Math.max(0, i - k); j <= Math.min(kept.length - 1, i + k); j++) {
        const wv = kept[j]
        if (wv) win.push(wv.value)
      }
      const med = median(win)
      const mad = median(win.map(v => Math.abs(v - med))) || 1e-12
      if (Math.abs(cur.value - med) > 3 * 1.4826 * mad) {
        counts.droppedHampel++
        continue
      }
      out.push(cur)
    }
    return { values: out, counts }
  }
  return { values: kept, counts }
}

/** 4+5:对齐 beatMs 网格(桶均值)+ 缺口策略(短缺口线性插值) */
export function alignToGrid(values: { at: number, value: number }[], opts: { beatMs: number, maxInterpMs?: number }): CleanResult {
  const counts: CleanCounts = { total: values.length, droppedState: 0, droppedRange: 0, droppedHampel: 0, interpolated: 0 }
  if (values.length === 0) return { grid: [], counts }
  const beat = opts.beatMs
  // 桶均值(与 TsdbPort bucket 语义一致:floor(at/beat)*beat)
  const buckets = new Map<number, { sum: number, n: number }>()
  let t0 = Infinity
  let t1 = -Infinity
  for (const v of values) {
    const b = Math.floor(v.at / beat) * beat
    const cur = buckets.get(b)
    if (cur) {
      cur.sum += v.value
      cur.n++
    }
    else buckets.set(b, { sum: v.value, n: 1 })
    if (b < t0) t0 = b
    if (b > t1) t1 = b
  }
  const grid: { at: number, value: number }[] = []
  const maxInterp = opts.maxInterpMs ?? beat * 3
  let prev: { at: number, value: number } | null = null
  for (let t = t0; t <= t1; t += beat) {
    const b = buckets.get(t)
    if (b) {
      const point = { at: t, value: b.sum / b.n }
      // 从上一已知点到当前点之间的缺口,若 ≤ maxInterp 则线性插值补齐
      if (prev && point.at - prev.at > beat && point.at - prev.at <= maxInterp + beat) {
        const gapSteps = Math.round((point.at - prev.at) / beat) - 1
        for (let s = 1; s <= gapSteps; s++) {
          const ratio = s / (gapSteps + 1)
          grid.push({ at: prev.at + s * beat, value: prev.value + (point.value - prev.value) * ratio })
          counts.interpolated++
        }
      }
      grid.push(point)
      prev = point
    }
  }
  return { grid, counts }
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}
