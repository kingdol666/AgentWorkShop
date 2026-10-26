/**
 * EDA 管道前端工具 —— 数据后处理(用户代码,仅浏览器执行) + 通用图表 option 构建 + PNG 导出。
 *
 * 安全边界:transform 代码只在用户自己的浏览器里 new Function 执行(行业惯例,同
 * Observable/Jupyter 客户端单元格),永不发往服务端 eval;服务端只存代码文本。
 */
import type { EChartsOption } from 'echarts'

export interface PipelineRow {
  [key: string]: unknown
}

export interface QuerySeriesPoint {
  /** 新版 daq/query 点形状 */
  at?: number | string
  v?: number
  /** 兼容旧形状(部分调用方/历史数据) */
  x?: number | string
  y?: number
}

export interface QuerySeries {
  nodeId: string
  name?: string
  points?: QuerySeriesPoint[]
}

/**
 * daq/query 的 series 点阵 → 宽表行(at + 每测点一列,列名=测点名)。
 * 服务端当前返回 {at, v};历史/兼容调用可能返回 {x, y},两种都接受。
 */
export function seriesToRows(
  series: QuerySeries[],
  resolveName: (s: QuerySeries) => string = s => s.name ?? s.nodeId,
): PipelineRow[] {
  const byAt = new Map<string, PipelineRow>()
  for (const s of series) {
    const key = resolveName(s)
    for (const p of s.points ?? []) {
      const rawX = p.x ?? p.at
      const y = p.y ?? p.v
      if (rawX == null || y == null || !Number.isFinite(Number(y))) continue
      const date = new Date(rawX)
      if (Number.isNaN(date.getTime())) continue
      const at = date.toISOString()
      const row = byAt.get(at) ?? { at }
      row[key] = Number(y)
      byAt.set(at, row)
    }
  }
  return [...byAt.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

/** 行内数值判定(null/undefined/空串不算数) */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 推断数据列(保序;数值列/时间列/其他) */
export function deriveFields(rows: PipelineRow[]): { name: string, numeric: boolean }[] {
  const cols = new Map<string, { numeric: number, seen: number }>()
  for (const row of rows.slice(0, 200)) {
    for (const [k, v] of Object.entries(row)) {
      const c = cols.get(k) ?? { numeric: 0, seen: 0 }
      c.seen += 1
      if (isNum(v)) c.numeric += 1
      cols.set(k, c)
    }
  }
  return [...cols.entries()].map(([name, c]) => ({ name, numeric: c.numeric > 0 && c.numeric >= c.seen * 0.6 }))
}

/**
 * 执行用户后处理代码。约定:代码里定义 `function transform(rows) { return rows }`,
 * 返回新行数组;亦可就地 filter/map。任何异常都收敛为 { error },不抛出拖垮页面。
 */
export function runTransform(rows: PipelineRow[], code: string): { rows: PipelineRow[], error: string } {
  const trimmed = code.trim()
  if (!trimmed) return { rows, error: '' }
  try {
    const fn = new Function('rows', `"use strict";\n${trimmed}\n;return transform(rows);`) as (rows: PipelineRow[]) => PipelineRow[]
    const out = fn(rows)
    if (!Array.isArray(out)) return { rows, error: 'transform 必须返回数组。' }
    return { rows: out as PipelineRow[], error: '' }
  }
  catch (err) {
    return { rows, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
  }
}

export interface PipelineConfig {
  xField: string
  yFields: string[]
  groupField?: string
  agg: 'avg' | 'sum' | 'min' | 'max' | 'count'
  title?: string
  yMin?: number | null
  yMax?: number | null
  refLine?: number | null
}

const AGG_FN: Record<PipelineConfig['agg'], (vals: number[]) => number> = {
  avg: vs => vs.reduce((a, b) => a + b, 0) / Math.max(vs.length, 1),
  sum: vs => vs.reduce((a, b) => a + b, 0),
  min: vs => Math.min(...vs),
  max: vs => Math.max(...vs),
  count: vs => vs.length,
}

/** 按 x 分桶聚合(groupField 存在时再按组拆系列) */
export function aggregateRows(rows: PipelineRow[], cfg: PipelineConfig): { categories: string[], series: Map<string, Array<number | null>> } {
  const agg = AGG_FN[cfg.agg] ?? AGG_FN.avg
  const buckets = new Map<string, Map<string, Map<string, number[]>>>()
  for (const row of rows) {
    const rawX = row[cfg.xField]
    if (rawX === undefined || rawX === null) continue
    const x = String(rawX)
    const group = cfg.groupField ? String(row[cfg.groupField] ?? '—') : '__all__'
    const bucket = buckets.get(x) ?? new Map<string, Map<string, number[]>>()
    const cell = bucket.get(group) ?? new Map<string, number[]>()
    for (const yf of cfg.yFields) {
      const arr = cell.get(yf) ?? []
      const v = row[yf]
      if (isNum(v)) arr.push(v)
      cell.set(yf, arr)
    }
    bucket.set(group, cell)
    buckets.set(x, bucket)
  }
  const categories = [...buckets.keys()]
  const series = new Map<string, Array<number | null>>()
  const groups = new Set<string>()
  for (const b of buckets.values()) for (const g of b.keys()) groups.add(g)
  for (const g of groups) {
    for (const yf of cfg.yFields) {
      const key = groups.size > 1 || cfg.yFields.length > 1 ? `${g === '__all__' ? '' : `${g} · `}${yf}` : g === '__all__' ? yf : g
      series.set(key, categories.map((x) => {
        const vals = (buckets.get(x)?.get(g)?.get(yf) ?? []).filter(isNum)
        return vals.length ? Math.round(agg(vals) * 1e6) / 1e6 : null
      }))
    }
  }
  return { categories, series }
}

/** 数值列直方图(等宽分箱) */
export function histogramBins(rows: PipelineRow[], field: string, bins = 20): { edges: number[], counts: number[] } {
  const vals = rows.map(r => r[field]).filter(isNum)
  if (!vals.length) return { edges: [], counts: [] }
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const width = (max - min) / bins || 1
  const counts = new Array<number>(bins).fill(0)
  for (const v of vals) {
    const idx = Math.min(Math.floor((v - min) / width), bins - 1)
    counts[idx] = (counts[idx] ?? 0) + 1
  }
  const edges = counts.map((_, i) => Math.round((min + width * i) * 1e4) / 1e4)
  return { edges, counts }
}

const PALETTE = ['#35e0a0', '#41c8f4', '#f5c451', '#e57373', '#9f8fef', '#63d8c6']

/** 通用 option:line/bar/scatter/pie/histogram 全走这里 */
export function buildPipelineOption(type: string, cfg: PipelineConfig, rows: PipelineRow[]): EChartsOption {
  const title = cfg.title ? { title: { text: cfg.title, left: 'left', textStyle: { fontSize: 13 } } } : {}
  const base = {
    ...title,
    color: PALETTE,
    tooltip: { trigger: 'axis' as const },
    legend: { type: 'scroll' as const, bottom: 0, textStyle: { fontSize: 11 } },
    grid: { left: 56, right: 24, top: cfg.title ? 44 : 24, bottom: 56 },
    toolbox: { right: 8, top: 0, feature: { saveAsImage: { pixelRatio: 2 } } },
  }
  if (type === 'histogram') {
    const field = cfg.yFields[0] ?? cfg.xField
    const { edges, counts } = histogramBins(rows, field)
    return {
      ...base,
      tooltip: { trigger: 'axis' as const },
      xAxis: { type: 'category' as const, data: edges.map(e => String(e)), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value' as const, ...(cfg.yMin != null ? { min: cfg.yMin } : {}), ...(cfg.yMax != null ? { max: cfg.yMax } : {}) },
      series: [{ type: 'bar', name: field, data: counts, barCategoryGap: '8%' }],
    }
  }
  if (type === 'pie') {
    const field = cfg.yFields[0] ?? ''
    const data = rows.slice(0, 200).map(r => ({ name: String(r[cfg.xField] ?? '?'), value: isNum(r[field]) ? r[field] : 0 }))
    return {
      ...base,
      tooltip: { trigger: 'item' as const },
      legend: { type: 'scroll' as const, bottom: 0, textStyle: { fontSize: 11 } },
      series: [{ type: 'pie', radius: ['38%', '68%'], data, label: { fontSize: 10 } }],
    }
  }
  const { categories, series } = aggregateRows(rows, cfg)
  // 大样本(数百/数千个时间桶)按固定目标数抽稀刻度,只让约 16 个标签落笔;
  // hideOverlap 在旋转标签下不足以压住全量刻度,必须给数值 interval。
  const labelInterval = categories.length > 60 ? Math.max(1, Math.ceil(categories.length / 16)) : 'auto' as const
  const xAxis = {
    type: 'category' as const,
    data: categories,
    axisLabel: {
      fontSize: 10,
      rotate: categories.length > 24 ? 40 : 0,
      hideOverlap: true,
      interval: labelInterval,
    },
  }
  const yAxis = {
    type: 'value' as const,
    ...(cfg.yMin != null ? { min: cfg.yMin } : {}),
    ...(cfg.yMax != null ? { max: cfg.yMax } : {}),
  }
  const markLine = cfg.refLine != null
    ? { markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed' as const }, data: [{ yAxis: cfg.refLine }] } }
    : {}
  if (type === 'bar') {
    return {
      ...base,
      xAxis, yAxis,
      series: [...series.entries()].map(([name, data]) => ({ type: 'bar' as const, name, data, barMaxWidth: 32, ...markLine })),
    }
  }
  if (type === 'scatter') {
    return {
      ...base,
      tooltip: { trigger: 'item' as const },
      xAxis: { ...xAxis, type: 'category' as const },
      yAxis,
      series: [...series.entries()].map(([name, data]) => ({ type: 'scatter' as const, name, data, symbolSize: 7, ...markLine })),
    }
  }
  return {
    ...base,
    xAxis, yAxis,
    series: [...series.entries()].map(([name, data]) => ({
      type: 'line' as const, name, data, symbol: 'none', lineWidth: 1.6,
      ...markLine,
    })),
  }
}
