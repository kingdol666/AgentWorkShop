/**
 * 趋势图 option 构建器 —— /studio 画布与 /studio/board 看板卡的单一实现。
 *
 * 为什么抽出来(2026-10-22-eda-ui-fix-plan F2/F3):此前两处各写一份 option 组装,
 * 已经漂移 —— 看板 queryCard 丢 run_id 过滤、丢按单位双轴(保存的双轴图到看板变单轴),
 * 且小卡下图例压轴名、x 轴刻度互相重叠。同一图表必须两处渲染一致,所以收敛到一个函数;
 * 语义变更(如增加图型)只改这里。
 *
 * 取数永远在调用方按请求鉴权(图表只存查询参数快照 —— B4 铁律);本函数纯同步、零请求。
 */
import type { EChartsOption } from 'echarts'

export interface TrendSeriesPoint { at: number, v: number }
export interface TrendSeries { nodeId: string, name: string, unit: string, points: TrendSeriesPoint[] }
/** 字段井条目(/studio 的 encoding.y;轴实际按单位分配,L/R 徽标为展示语义) */
export interface TrendYEntry { nodeId: string, name: string, unit: string, axis: 'L' | 'R' }
export interface TrendRefLine { label: string, value: number }
export interface TrendGoldenBin { phase: number, mean: number | null, std: number | null }
export interface TrendGolden {
  /** nodeId → golden 相位画像(studio 的 goldenCache) */
  cache: Map<string, TrendGoldenBin[]>
  /** 当前叠加开启的 nodeId 集合(studio 的 goldenOn) */
  on: Set<string>
}

export interface TrendOptionInput {
  series: TrendSeries[]
  refLines?: TrendRefLine[]
  /** golden 相位叠加(仅 /studio 传入;看板不叠) */
  golden?: TrendGolden
  /** 看板小卡等紧凑场景:无 toolbox、无滑块缩放、收紧内边距 */
  compact?: boolean
}

/** Warm Editorial 色序与 AwChart 注入的同源;此处不显式上色,交给 AwChart 统一调色。 */
export function buildTrendOption(input: TrendOptionInput): EChartsOption {
  const { series, refLines = [], golden, compact = false } = input
  const units: string[] = []
  for (const s of series) if (s.unit && !units.includes(s.unit)) units.push(s.unit)
  const axisOf = (u: string) => Math.min(units.indexOf(u), 1)
  const yAxes = [0, 1].slice(0, Math.max(1, Math.min(units.length, 2))).map(i => ({
    type: 'value' as const,
    name: units[i] ?? '',
    scale: true,
    // F3:轴名与图例/曲线留出间距,窄容器下不再压字
    nameGap: compact ? 10 : 14,
  }))

  const seriesOut: Record<string, unknown>[] = series.map(s => ({
    name: s.name,
    type: 'line',
    yAxisIndex: axisOf(s.unit),
    showSymbol: false,
    data: s.points.map(p => [p.at, p.v]),
  }))

  // golden 相位叠加(0-100% 副轴):均值虚线 + ±std 隐形堆叠面积带(与 studio 既有语义一致)
  let hasGolden = false
  if (golden) {
    for (const s of series) {
      const bins = golden.cache.get(s.nodeId)
      if (!bins || !golden.on.has(s.nodeId)) continue
      hasGolden = true
      const mk = (pick: (b: TrendGoldenBin) => number | null) => bins.map(b => [Number((b.phase * 100).toFixed(2)), pick(b)])
      seriesOut.push({ name: `${s.name} G`, type: 'line', xAxisIndex: 1, yAxisIndex: axisOf(s.unit), showSymbol: false, lineStyle: { type: 'dashed', width: 2 }, data: mk(b => b.mean) })
      seriesOut.push({ name: `${s.name} G+`, type: 'line', xAxisIndex: 1, yAxisIndex: axisOf(s.unit), showSymbol: false, stack: `g-${s.nodeId}`, lineStyle: { opacity: 0 }, data: mk(b => (b.mean != null && b.std != null ? b.mean + b.std : null)) })
      seriesOut.push({ name: `${s.name} G-`, type: 'line', xAxisIndex: 1, yAxisIndex: axisOf(s.unit), showSymbol: false, stack: `g-${s.nodeId}`, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.12 }, data: mk(b => (b.mean != null && b.std != null ? b.mean - b.std : null)) })
    }
  }

  const xAxes: Record<string, unknown>[] = [{ type: 'time', axisLabel: { hideOverlap: true } }]
  if (hasGolden) xAxes.push({ type: 'value', min: 0, max: 100, name: '%' })

  // F3:参考线挂在第一个可用 series;hideOverlap 对轴刻度生效,markLine 标签靠 distance 收敛
  if (refLines.length && seriesOut.length) {
    ;(seriesOut[0] as Record<string, unknown>).markLine = {
      silent: true,
      symbol: 'none',
      data: refLines.map(r => ({ yAxis: r.value, label: { formatter: `${r.label} ${r.value}` }, lineStyle: { type: 'dashed', color: '#b3403a' } })),
    }
  }

  return {
    tooltip: { trigger: 'axis' },
    legend: { type: 'scroll', padding: compact ? [2, 4] : [4, 8] },
    grid: compact
      ? { left: 44, right: units.length > 1 ? 40 : 14, top: units.length > 1 ? 24 : 16, bottom: 18 }
      : { left: 56, right: units.length > 1 ? 56 : 24, top: 32, bottom: 64 },
    xAxis: xAxes,
    yAxis: yAxes,
    dataZoom: compact
      ? [{ type: 'inside' }]
      : [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 10 }],
    toolbox: compact ? undefined : { right: 8, top: 0, feature: { saveAsImage: { title: 'PNG' } } },
    series: seriesOut,
  } as EChartsOption
}
