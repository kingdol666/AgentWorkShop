/**
 * 仪表盘(/)图表 option 装配 —— 五张 ECharts 图 + 主题感知的公共色。
 *
 * 入参是本页唯一那份数据(useDashboardData 的返回值):图表只是同一份
 * server 权威数据的另一种呈现,所以本 composable 不取数、不订阅、不持有状态,
 * 只在页面 setup 里展开成 computed option 交给 dashboard/* 面板渲染。
 */
import { computed } from 'vue'
import type { EChartsOption } from 'echarts'
import type { DashboardData } from './useDashboardData'

export function useDashboardCharts(data: DashboardData) {
  const { t } = useI18n()
  const { pal, isDark, trendNodes, trendBuf, linesActive, writeRate, daq, dcw } = data

  // ---------- 主题感知的图表公共色 ----------
  const inkC = computed(() => (isDark.value ? '#e8eef8' : '#1f2a3a'))
  const dimC = computed(() => (isDark.value ? 'rgba(143,160,181,0.85)' : 'rgba(80,95,120,0.85)'))
  const splitC = computed(() => (isDark.value ? 'rgba(143,160,181,0.13)' : 'rgba(80,95,120,0.14)'))
  const tipBg = computed(() => (isDark.value ? 'rgba(10,16,28,0.94)' : 'rgba(255,255,255,0.97)'))

  const baseTooltip = computed(() => ({
    backgroundColor: tipBg.value,
    borderColor: splitC.value,
    textStyle: { color: inkC.value, fontSize: 11 },
  }))

  // ---------- 图 1:实时工况趋势(多通道量程归一化) ----------
  const trendOpt = computed<EChartsOption>(() => ({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', ...baseTooltip.value },
    legend: {
      top: 0, right: 4, icon: 'roundRect', itemWidth: 10, itemHeight: 4,
      textStyle: { color: dimC.value, fontSize: 10.5 },
    },
    grid: { left: 42, right: 14, top: 30, bottom: 24 },
    xAxis: {
      type: 'time',
      axisLabel: { color: dimC.value, fontSize: 10, formatter: '{HH}:{mm}:{ss}' },
      axisLine: { lineStyle: { color: splitC.value } },
      splitLine: { show: false },
    },
    yAxis: {
      // 轴名移到面板头 meta:贴在轴端会和刻度数字挤在一起(见 aw-bench-meta)
      type: 'value', min: 0, max: 100,
      axisLabel: { color: dimC.value, fontSize: 10 },
      splitLine: { lineStyle: { color: splitC.value } },
    },
    series: trendNodes.value.map((n, i) => {
      const color = [pal.value.accent, pal.value.cyan, pal.value.amber, pal.value.violet][i % 4]
      return {
        name: n.name,
        type: 'line',
        smooth: true,
        showSymbol: false,
        connectNulls: true,
        lineStyle: { width: 1.6, color },
        itemStyle: { color },
        data: trendBuf.value.map(p => [p.t, p.m[n.id] ?? null]),
      }
    }),
  }))

  // ---------- 图 2:产线运行状态(donut) ----------
  const lineStateOpt = computed<EChartsOption>(() => ({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', ...baseTooltip.value },
    legend: {
      bottom: 0, left: 'center', icon: 'roundRect', itemWidth: 10, itemHeight: 4,
      textStyle: { color: dimC.value, fontSize: 10.5 },
    },
    series: [{
      type: 'pie',
      radius: ['62%', '82%'],
      center: ['50%', '44%'],
      label: { show: false },
      silent: false,
      data: [
        { value: linesActive.value.length, name: t('home.runNow'), itemStyle: { color: pal.value.accent } },
        { value: Math.max(dcw.lines.length - linesActive.value.length, 0), name: t('home.standBy'), itemStyle: { color: splitC.value } },
      ],
    }],
  }))

  // ---------- 图 3:数采管线吞吐(累计) ----------
  const pipelineOpt = computed<EChartsOption>(() => ({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...baseTooltip.value },
    grid: { left: 70, right: 34, top: 10, bottom: 24 },
    xAxis: {
      type: 'value',
      axisLabel: { color: dimC.value, fontSize: 10, formatter: (v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v) },
      splitLine: { lineStyle: { color: splitC.value } },
    },
    yAxis: {
      type: 'category',
      data: [t('home.pipelineSeries.stored'), t('home.pipelineSeries.consumed'), t('home.pipelineSeries.produced')],
      axisLabel: { color: dimC.value, fontSize: 10.5 },
      axisLine: { lineStyle: { color: splitC.value } },
    },
    series: [{
      type: 'bar',
      barWidth: 10,
      data: [
        { value: daq.meta.samplesStored ?? 0, itemStyle: { color: pal.value.amber } },
        { value: daq.meta.consumed ?? 0, itemStyle: { color: pal.value.cyan } },
        { value: daq.meta.produced ?? 0, itemStyle: { color: pal.value.accent } },
      ],
      itemStyle: { borderRadius: [0, 5, 5, 0] },
    }],
  }))

  // ---------- 图 4:写控制成功率(gauge) ----------
  const writeOpt = computed<EChartsOption>(() => ({
    backgroundColor: 'transparent',
    series: [{
      type: 'gauge',
      startAngle: 210,
      endAngle: -30,
      min: 0,
      max: 100,
      radius: '92%',
      center: ['50%', '58%'],
      progress: { show: true, width: 12, itemStyle: { color: pal.value.accent } },
      axisLine: { lineStyle: { width: 12, color: [[1, splitC.value]] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      anchor: { show: false },
      title: { show: false },
      detail: {
        valueAnimation: true,
        formatter: '{value}%',
        color: inkC.value,
        fontSize: 26,
        fontFamily: 'monospace',
        offsetCenter: [0, '4%'],
      },
      data: [{ value: writeRate.value }],
    }],
  }))

  // ---------- 图 5:节点状态分布(数采/控制 堆叠) ----------
  const nodeStates = computed(() => [
    { key: 'ok', color: pal.value.accent },
    { key: 'warn', color: pal.value.amber },
    { key: 'alarm', color: pal.value.danger },
    { key: 'writing', color: pal.value.cyan },
    { key: 'idle', color: isDark.value ? '#5f6e84' : '#8fa0b5' },
    { key: 'error', color: '#ff8a5c' },
    { key: 'offline', color: isDark.value ? 'rgba(95,110,132,0.38)' : 'rgba(143,160,181,0.35)' },
  ])

  const nodeStateOpt = computed<EChartsOption>(() => {
    const daqCount = new Map<string, number>()
    for (const n of daq.nodes) daqCount.set(n.state, (daqCount.get(n.state) ?? 0) + 1)
    const dcwCount = new Map<string, number>()
    for (const n of dcw.nodes) dcwCount.set(n.state, (dcwCount.get(n.state) ?? 0) + 1)
    const states = nodeStates.value.filter(s => daqCount.get(s.key) || dcwCount.get(s.key))
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...baseTooltip.value },
      legend: {
        top: 0, left: 'center', icon: 'roundRect', itemWidth: 10, itemHeight: 4,
        textStyle: { color: dimC.value, fontSize: 10 },
      },
      grid: { left: 56, right: 14, top: 30, bottom: 24 },
      xAxis: {
        type: 'value',
        axisLabel: { color: dimC.value, fontSize: 10 },
        splitLine: { lineStyle: { color: splitC.value } },
      },
      yAxis: {
        type: 'category',
        data: [t('home.stateDcw'), t('home.stateDaq')],
        axisLabel: { color: dimC.value, fontSize: 10.5 },
        axisLine: { lineStyle: { color: splitC.value } },
      },
      series: states.map(s => ({
        name: t(`home.states.${s.key}`),
        type: 'bar' as const,
        stack: 'nodes',
        barWidth: 12,
        itemStyle: { color: s.color },
        data: [dcwCount.get(s.key) ?? 0, daqCount.get(s.key) ?? 0],
      })),
    }
  })

  return { trendOpt, lineStateOpt, pipelineOpt, writeOpt, nodeStateOpt }
}
