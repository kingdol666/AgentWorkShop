/**
 * bench/lib/metrics.mjs —— 量化层：样本聚合、分位、CSV 落盘。
 * 口径与 paper/bench 一致：nearest-rank 分位（无插值），与 bench/e1-lite.mjs 同源。
 */

/** nearest-rank（与 e1-lite.mjs 同口径，避免"两套统计"） */
export function pct(sortedAsc, q) {
  const n = sortedAsc.length
  if (!n) return null
  if (q === 0.5) return sortedAsc[n >> 1]
  return sortedAsc[Math.min(n - 1, Math.ceil(n * q) - 1)]
}
export const p50 = (a) => pct([...a].sort((x, y) => x - y), 0.5)
export const p95 = (a) => pct([...a].sort((x, y) => x - y), 0.95)
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)
export const rate = (num, den) => (den ? Number((num / den).toFixed(4)) : null)
export const r3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(3)) : x)

/** 宽表 → CSV（首行表头；值内逗号/换行安全转义） */
export function toCsv(rows) {
  if (!rows?.length) return ''
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))]
  const esc = (v) => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object') v = JSON.stringify(v)
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')
}

/** 指标登记表：phase 内 key→value，用于 summary.json 与 dashboard 的"关键数字"区 */
export function makeMetricBag() {
  const bag = []
  return {
    add(section, key, value, unit = '', note = '') { bag.push({ section, key, value, unit, note }) },
    all: () => bag,
  }
}
