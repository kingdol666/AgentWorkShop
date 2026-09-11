<script setup lang="ts">
/**
 * 仪表盘(/)—— 产线运营数字大屏。
 * ECharts 可视化:实时工况趋势(量程归一化)/ 产线运行状态 / 数采管线吞吐 /
 * 写控制成功率 / 节点状态分布 + 产线清单卡。
 * 数据权威在 server:useDcwStream + useDaqStream(REST 基线 + WS 实时收敛
 * + 5s 低频兜底刷新);趋势缓冲为本页每 5s 一次的量程归一化快照。
 */
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useVisibleInterval } from '@/app/composables/workshop/useVisibleInterval'
import { useWorkshopApi, type HarnessMetaDto } from '@/app/composables/workshop/useWorkshopApi'
import AwChart from '@/app/components/AwChart.vue'
import type { EChartsOption } from 'echarts'

const { t } = useI18n()
// 注意:useHead 的函数 title 在 prod SSR 下立即求值,必须在 useI18n 之后注册
useHead({ title: () => t('titles.dashboard') })

const site = useSiteConfig()
const store = useAppStore()
const daq = useDaqStream()
const dcw = useDcwStream()

// 图表色序随主题切换(两套声部,同一语义序):
//   亮 = Warm Editorial 编辑色板(main.css --chart-* 同源,墨绿→苔绿→琥珀→陶赭)
//   暗 = 控制室 tone 系统(绿=运行/成功 · 青=数据 · 琥珀=需关注 · 紫=重试 · 红=告警)
// —— 亮阶把品牌绿当"墨"用,暗阶把同一抹绿当"信号"用,各自在自己的画布上才成立。
const PAL = computed(() => (store.isDark
  ? { accent: '#3fe4ab', cyan: '#41c8f4', amber: '#f6c453', violet: '#a795ff', danger: '#ff8080' }
  : { accent: '#4a6b57', cyan: '#6f8296', amber: '#c9a26a', violet: '#b3714f', danger: '#c25a4e' }))

// ---------- 数据装载(WS 实时 + 5s 兜底;可见性调度:后台降频 30s,回前台立即补拍) ----------
onMounted(() => {
  daq.ensureWsFeed()
  dcw.ensureWsFeed()
  void Promise.all([daq.load(), dcw.load()]).then(() => pushTrend())
  void loadHarnesses()
  useVisibleInterval(() => {
    void daq.load()
    void dcw.load()
    void loadHarnesses()
    pushTrend()
  }, 5000, { bgMs: 30000 })
})

// ---------- Harness 可用性(引擎 CLI 环境探测;服务端 30s 探测缓存,随兜底节拍刷新) ----------
const api = useWorkshopApi()
const harnesses = ref<HarnessMetaDto[]>([])
const loadHarnesses = async (): Promise<void> => {
  try {
    const res = await api.listHarnesses()
    harnesses.value = (res as unknown as { data?: { harnesses?: HarnessMetaDto[] } })?.data?.harnesses ?? []
  }
  catch { /* 探测不可得时面板留空,不阻塞大屏 */ }
}
const harnessOk = computed(() => harnesses.value.filter(h => h.available !== false).length)

// ---------- KPI ----------
const linesActive = computed(() => dcw.lines.filter(l => dcw.lineStateOf(l.id).active))
const daqOnline = computed(() => daq.nodes.filter(n => n.enabled && n.state !== 'offline').length)
const daqTotal = computed(() => daq.nodes.length)
const alarmCount = computed(() => daq.nodes.filter(n => n.state === 'alarm').length)
const writeRate = computed(() => {
  const total = dcw.controller.writesTotal
  if (total === 0) return 100
  return Math.round(((total - dcw.controller.writesFailed) / total) * 1000) / 10
})

// ---------- 趋势缓冲(近 3 分钟,5s 一拍,量程归一化) ----------
interface TrendPoint { t: number, m: Record<string, number | null> }
const trendBuf = ref<TrendPoint[]>([])
/** 趋势通道:有实时值的节点优先(在线优先),稳定取前 4 */
const trendNodes = computed(() => daq.nodes
  .filter(n => n.value != null && n.max > n.min)
  .sort((a, b) => (a.lineId ? 0 : 1) - (b.lineId ? 0 : 1) || a.id.localeCompare(b.id))
  .slice(0, 4))

function pushTrend(): void {
  const m: Record<string, number | null> = {}
  for (const n of trendNodes.value) {
    m[n.id] = n.value == null ? null : Math.round(((n.value - n.min) / (n.max - n.min)) * 100)
  }
  trendBuf.value.push({ t: Date.now(), m: m as Record<string, number | null> })
  if (trendBuf.value.length > 36) trendBuf.value.shift()
}

// ---------- 主题感知的图表公共色 ----------
const inkC = computed(() => (store.isDark ? '#e8eef8' : '#1f2a3a'))
const dimC = computed(() => (store.isDark ? 'rgba(143,160,181,0.85)' : 'rgba(80,95,120,0.85)'))
const splitC = computed(() => (store.isDark ? 'rgba(143,160,181,0.13)' : 'rgba(80,95,120,0.14)'))
const tipBg = computed(() => (store.isDark ? 'rgba(10,16,28,0.94)' : 'rgba(255,255,255,0.97)'))

const baseTooltip = computed(() => ({
  backgroundColor: tipBg.value,
  borderColor: splitC.value,
  textStyle: { color: inkC.value, fontSize: 11 },
}))

// ---------- 图 1:实时工况趋势(多通道量程归一化) ----------
/** 趋势是否真有数值可画(采样被活动批次门控:未开跑时缓冲里只有 null 占位) */
const trendHasData = computed(() =>
  trendNodes.value.length > 0
  && trendBuf.value.some(p => trendNodes.value.some(n => typeof p.m[n.id] === 'number')))

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
    const color = [PAL.value.accent, PAL.value.cyan, PAL.value.amber, PAL.value.violet][i % 4]
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
      { value: linesActive.value.length, name: t('home.runNow'), itemStyle: { color: PAL.value.accent } },
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
      { value: daq.meta.samplesStored ?? 0, itemStyle: { color: PAL.value.amber } },
      { value: daq.meta.consumed ?? 0, itemStyle: { color: PAL.value.cyan } },
      { value: daq.meta.produced ?? 0, itemStyle: { color: PAL.value.accent } },
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
    progress: { show: true, width: 12, itemStyle: { color: PAL.value.accent } },
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
  { key: 'ok', color: PAL.value.accent },
  { key: 'warn', color: PAL.value.amber },
  { key: 'alarm', color: PAL.value.danger },
  { key: 'writing', color: PAL.value.cyan },
  { key: 'idle', color: store.isDark ? '#5f6e84' : '#8fa0b5' },
  { key: 'error', color: '#ff8a5c' },
  { key: 'offline', color: store.isDark ? 'rgba(95,110,132,0.38)' : 'rgba(143,160,181,0.35)' },
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

// ---------- 产线清单(裁策:清单是导航不是数据库导出) ----------
const lineCards = computed(() => dcw.lines.map((l) => {
  const st = dcw.lineStateOf(l.id)
  return {
    id: l.id,
    name: l.name,
    color: l.color,
    active: st.active,
    product: st.productName,
    recipe: st.recipeName,
    runId: st.runId,
    tagged: st.taggedSamples,
    dcwCount: dcw.nodes.filter(n => n.lineId === l.id).length,
    daqCount: daq.nodes.filter(n => n.lineId === l.id).length,
  }
}))
/** 运行中优先,其次已打标样本多的(最近活跃),稳定排序 */
const fleetSorted = computed(() => [...lineCards.value].sort((a, b) =>
  Number(b.active) - Number(a.active) || b.tagged - a.tagged || a.name.localeCompare(b.name)))
const FLEET_CAP = 8
const fleetShown = computed(() => fleetSorted.value.slice(0, FLEET_CAP))
const fleetOverflow = computed(() => Math.max(lineCards.value.length - FLEET_CAP, 0))
</script>

<template>
  <div class="home">
    <!-- Hero:产线运营中枢(校准仪表台母题;右侧 LIVE 实况仪表簇) -->
    <section class="hero aw-bench aw-bench--marked aw-stagger">
      <div class="hero-main">
        <p class="aw-bench-kicker">
          {{ t('home.kicker') }} · {{ site.mode }}
        </p>
        <h1 class="hero-title">
          {{ t('home.heroTitle') }}
          <span class="aw-serif-accent-italic">{{ t('home.heroAccent') }}</span>
        </h1>
        <p class="hero-sub">
          {{ t('home.heroSub') }}
        </p>
        <div class="hero-acts">
          <button
            class="aw-pill im"
            @click="navigateTo('/town')"
          >
            <span class="i-tabler-map-2 im-pop" />
            {{ t('home.ctaTown') }}
          </button>
          <button
            class="aw-pill outline im"
            @click="navigateTo('/dcw')"
          >
            <span class="i-tabler-route im-pop" />
            {{ t('home.ctaLine') }}
          </button>
        </div>
      </div>

      <!-- 实况仪表簇:LIVE 徽标 + 三条带刻度的读数行(读数比句子更快被扫到) -->
      <div class="hero-live">
        <span class="live-badge"><span class="live-dot" />{{ t('home.live') }}</span>
        <dl class="live-rows">
          <div class="live-row">
            <dt>{{ t('home.kpi.lines') }}</dt>
            <dd class="mono">
              <b>{{ linesActive.length }}</b><small>/{{ dcw.lines.length }}</small>
            </dd>
          </div>
          <div class="live-row">
            <dt>{{ t('home.kpi.samples') }}</dt>
            <dd class="mono">
              <b>{{ daq.meta.samplesStored ?? 0 }}</b>
            </dd>
          </div>
          <div
            class="live-row"
            :class="{ 'is-alarm': alarmCount > 0 }"
          >
            <dt>{{ t('home.kpi.alarms') }}</dt>
            <dd class="mono">
              <b>{{ alarmCount }}</b>
            </dd>
          </div>
        </dl>
      </div>
      <!-- 仪表刻度母题(控制室仪器读数;纯装饰,零动画) -->
      <div
        class="hero-scale"
        aria-hidden="true"
      />
    </section>

    <!-- 量规统计带:一块仪表盘,不是一排各自为政的卡(底部量程刻度是签名) -->
    <div class="aw-gauge-band aw-stagger">
      <div class="aw-gauge">
        <span class="aw-gauge-label">{{ t('home.kpi.lines') }}</span>
        <span class="aw-gauge-value">
          <span class="aw-readout">{{ linesActive.length }}<small>/{{ dcw.lines.length }}</small></span>
        </span>
      </div>
      <div class="aw-gauge">
        <span class="aw-gauge-label">{{ t('home.kpi.dcwNodes') }}</span>
        <span class="aw-gauge-value">
          <span class="aw-readout">{{ dcw.controller.nodesOnline }}<small>/{{ dcw.controller.nodesTotal }}</small></span>
        </span>
      </div>
      <div class="aw-gauge">
        <span class="aw-gauge-label">{{ t('home.kpi.daqNodes') }}</span>
        <span class="aw-gauge-value">
          <span class="aw-readout">{{ daqOnline }}<small>/{{ daqTotal }}</small></span>
        </span>
      </div>
      <div class="aw-gauge">
        <span class="aw-gauge-label">{{ t('home.kpi.samples') }}</span>
        <span class="aw-gauge-value">
          <span class="aw-readout">{{ daq.meta.samplesStored ?? 0 }}</span>
        </span>
      </div>
      <div class="aw-gauge">
        <span class="aw-gauge-label">{{ t('home.kpi.writeRate') }}</span>
        <span class="aw-gauge-value">
          <span class="aw-readout">{{ writeRate }}<small>%</small></span>
        </span>
      </div>
      <div
        class="aw-gauge"
        :class="{ 'is-alarm': alarmCount > 0 }"
      >
        <span class="aw-gauge-label">{{ t('home.kpi.alarms') }}</span>
        <span class="aw-gauge-value">
          <span class="aw-readout">{{ alarmCount }}</span>
        </span>
      </div>
    </div>

    <!-- 大屏图阵 -->
    <!-- 执行引擎可用性(Harness CLI 环境探测;未安装不可选,派工前强校验) -->
    <section
      v-if="harnesses.length > 0"
      class="harness aw-bench aw-stagger"
    >
      <header class="aw-bench-hd">
        <h3 class="aw-bench-title">
          {{ t('home.harness.title') }}
        </h3>
        <small class="aw-bench-sub">{{ t('home.harness.sub') }}</small>
        <span class="aw-bench-meta">
          <span><b>{{ harnessOk }}</b>/{{ harnesses.length }}</span>
        </span>
      </header>
      <div class="harness-row">
        <a
          v-for="h in harnesses"
          :key="h.id"
          class="h-item"
          :class="{ off: h.available === false, link: h.available === false && h.homepage }"
          :href="h.available === false && h.homepage ? h.homepage : undefined"
          target="_blank"
          rel="noopener"
          :title="h.available === false ? (h.error ?? '') : (h.resolvedPath ?? h.command ?? '')"
        >
          <span class="h-dot" />
          <span class="h-name">{{ h.label }}</span>
          <span class="h-cmd mono">{{ h.available === false ? t('home.harness.missing') : (h.inprocess ? 'in-process' : h.command) }}</span>
          <span
            v-if="h.available === false && h.homepage"
            class="h-go"
          >↗</span>
        </a>
      </div>
    </section>

    <div class="grid aw-stagger">
      <section class="aw-bench span8">
        <header class="aw-bench-hd">
          <h3 class="aw-bench-title">
            {{ t('home.charts.trend') }}
          </h3>
          <small class="aw-bench-sub">{{ t('home.charts.trendSub') }}</small>
          <span class="aw-bench-meta">
            <span>{{ t('home.trendY') }}</span>
          </span>
        </header>
        <ClientOnly>
          <!-- 空态判据必须看「有没有**数值**」,而不是「缓冲里有没有点」:
               采样由活动批次门控(无开跑产线时不采样),此时缓冲里可能有携带 null 的
               占位点 —— 旧写法据此判为"有数据",于是跳过 graphic 提示,
               渲染出一张只有坐标系+图例、X 轴回落到 00:00~24:00 的空图。
               那比一句明确的空态更难理解(实测被评审直接判为"趋势面全是空的")。 -->
          <AwChart
            v-if="trendHasData"
            :option="trendOpt"
            class="chart h280"
          />
          <div
            v-else
            class="aw-empty chart h280"
          >
            <p class="aw-empty-title">
              {{ t('home.trendWaiting') }}
            </p>
            <p class="aw-empty-sub">
              {{ t('home.trendNeedRun') }}
            </p>
          </div>
        </ClientOnly>
      </section>
      <section class="aw-bench span4">
        <header class="aw-bench-hd">
          <h3 class="aw-bench-title">
            {{ t('home.charts.lineState') }}
          </h3>
          <span class="aw-bench-meta">
            <span><b>{{ linesActive.length }}</b>/{{ dcw.lines.length }} {{ t('home.kpi.lines') }}</span>
          </span>
        </header>
        <div class="donut-wrap">
          <div class="donut-center mono">
            <b>{{ linesActive.length }}</b>
            <small>/ {{ dcw.lines.length }}</small>
          </div>
          <ClientOnly>
            <AwChart
              :option="lineStateOpt"
              class="chart h240"
            />
          </ClientOnly>
        </div>
      </section>
      <section class="aw-bench span4">
        <header class="aw-bench-hd">
          <h3 class="aw-bench-title">
            {{ t('home.charts.pipeline') }}
          </h3>
        </header>
        <ClientOnly>
          <AwChart
            :option="pipelineOpt"
            class="chart h240"
          />
        </ClientOnly>
      </section>
      <section class="aw-bench span4">
        <header class="aw-bench-hd">
          <h3 class="aw-bench-title">
            {{ t('home.charts.writeCtl') }}
          </h3>
          <span class="aw-bench-meta">
            <span><b>{{ dcw.controller.writesTotal }}</b> {{ t('home.writesFailed') }} {{ dcw.controller.writesFailed }}</span>
          </span>
        </header>
        <ClientOnly>
          <AwChart
            :option="writeOpt"
            class="chart h240"
          />
        </ClientOnly>
      </section>
      <section class="aw-bench span4">
        <header class="aw-bench-hd">
          <h3 class="aw-bench-title">
            {{ t('home.charts.nodeState') }}
          </h3>
        </header>
        <ClientOnly>
          <AwChart
            :option="nodeStateOpt"
            class="chart h240"
          />
        </ClientOnly>
      </section>
    </div>

    <!-- 产线清单(运行中优先,最多 8 卡;余量聚合入口) -->
    <section class="fleet aw-bench aw-stagger">
      <header class="aw-bench-hd">
        <h3 class="aw-bench-title">
          {{ t('home.charts.lines') }}
        </h3>
        <small class="aw-bench-sub">{{ t('home.fleetHint') }}</small>
        <span class="aw-bench-meta">
          <span><b>{{ dcw.lines.length }}</b></span>
        </span>
      </header>
      <div class="fleet-grid">
        <NuxtLink
          v-for="l in fleetShown"
          :key="l.id"
          class="line-card"
          :class="{ on: l.active }"
          :style="{ '--lc': l.color }"
          :to="`/dcw/${l.id}`"
        >
          <div class="lc-head">
            <span class="lc-dot" />
            <b>{{ l.name }}</b>
            <span
              class="lc-state"
              :class="{ on: l.active }"
            >{{ l.active ? t('home.runNow') : t('home.standBy') }}</span>
          </div>
          <div
            v-if="l.active"
            class="lc-run mono"
          >
            <span>{{ l.product }} · {{ l.recipe }}</span>
            <small>{{ t('home.batch') }} {{ l.runId?.slice(0, 8) }} · {{ t('home.tagged') }} {{ l.tagged }}</small>
          </div>
          <div class="lc-meta mono">
            <span>{{ t('home.nodesUnit') }} {{ l.dcwCount }}</span>
            <span>{{ t('home.daqUnit') }} {{ l.daqCount }}</span>
          </div>
        </NuxtLink>
        <NuxtLink
          v-if="fleetOverflow > 0"
          class="line-card fleet-all im"
          to="/dcw"
        >
          <span class="fa-n mono">+{{ fleetOverflow }}</span>
          <span class="fa-label">{{ t('home.fleetAll') }}</span>
          <span class="i-tabler-arrow-right fa-arrow" />
        </NuxtLink>
        <p
          v-if="lineCards.length === 0"
          class="fleet-empty"
        >
          {{ t('home.noLine') }}
        </p>
      </div>
    </section>

    <!-- 插件 UI 注入区:client 面板经 ctx.ui.registerPanel({slot:'dashboard.widgets'}) 注入 -->
    <ClientOnly>
      <workshop-plugin-slot slot-name="dashboard.widgets" />
    </ClientOnly>
  </div>
</template>

<style scoped>
.home { padding: 4px; }

/* ---------- Hero:中枢横幅 + LIVE 实况(基座 = aw-bench,此处只写专属节奏) ---------- */
.hero {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--gap-block);
  padding: 30px 34px 32px;
  overflow: hidden;
}
/* 仪表刻度母题:底部细刻度尺(控制室仪器读数;纯装饰零动画,两端淡出) */
.hero-scale {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 9px;
  pointer-events: none;
  background:
    repeating-linear-gradient(90deg, color-mix(in srgb, var(--ink) 26%, transparent) 0 1px, transparent 1px 120px),
    repeating-linear-gradient(90deg, color-mix(in srgb, var(--ink) 11%, transparent) 0 1px, transparent 1px 24px);
  opacity: 0.55;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
}
.hero-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 620px;
}
.hero-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 36px;
  font-weight: 400;
  line-height: 1.12;
  letter-spacing: -0.015em;
  color: var(--ink);
}
.hero-sub {
  max-width: 54ch;
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-faint);
}
.hero-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
}
/* 实况仪表簇:左缘一道品牌刻度,与画布分节同语言 */
.hero-live {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 224px;
  padding: 15px 18px 13px;
  background: var(--frost-bg);
  border: 1px solid var(--glass-line);
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--radius-panel-sm) var(--radius-panel-sm) 0;
}
.live-badge {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  width: fit-content;
  padding: 2px 10px;
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--tone-success-dot);
  border: 1px solid color-mix(in srgb, var(--tone-success-dot) 45%, transparent);
  border-radius: var(--radius-pill);
}
.live-dot {
  width: 6px;
  height: 6px;
  background: var(--tone-success-dot);
  border-radius: 50%;
}
@media (prefers-reduced-motion: no-preference) {
  .live-dot { animation: livePulse 1.6s ease-in-out infinite; }
}
@keyframes livePulse {
  0%, 100% { box-shadow: 0 0 3px var(--tone-success-dot); }
  50% { box-shadow: 0 0 9px var(--tone-success-dot); }
}
.live-rows {
  display: flex;
  flex-direction: column;
  margin: 0;
}
.live-row {
  display: flex;
  gap: 16px;
  align-items: baseline;
  justify-content: space-between;
  padding: 7px 0;
  border-top: 1px solid var(--divider-hair);
}
.live-row:first-child { padding-top: 2px; border-top: 0; }
.live-row dt {
  font-size: 11.5px;
  color: var(--ink-faint);
}
.live-row dd {
  margin: 0;
  font-size: 13.5px;
  color: var(--ink);
}
.live-row dd b { font-weight: 500; }
.live-row dd small { font-size: 11px; color: var(--ink-faint); }
.live-row.is-alarm dt,
.live-row.is-alarm dd { color: var(--tone-danger-dot); }

/* ---------- 量规统计带:列数按可用宽度收敛(6 → 3 → 2,永不挤成一条) ---------- */
.aw-gauge-band {
  --cols: 6;
  margin-bottom: var(--gap-block);
}
@media (max-width: 1240px) {
  .aw-gauge-band { --cols: 3; }
}
@media (max-width: 720px) {
  .aw-gauge-band { --cols: 2; }
}

/* ---------- 大屏图阵 ---------- */
.grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--gap-block);
  margin-bottom: var(--gap-block);
}
.span8 { grid-column: span 8; }
.span4 { grid-column: span 4; }
@media (max-width: 1100px) {
  .span8, .span4 { grid-column: span 12; }
}
/* 面板题注:一句话说明这张图在看什么;窄屏让位给读数本身 */
.aw-bench-sub {
  overflow: hidden;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 1500px) {
  .aw-bench-sub { display: none; }
}
.chart { width: 100%; }
.h280 { height: 280px; }
.h240 { height: 240px; }
.donut-wrap { position: relative; }
.donut-center {
  position: absolute;
  top: 38%;
  left: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  transform: translateY(-50%);
  pointer-events: none;
}
.donut-center b {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.donut-center small { font-size: 11px; color: var(--ink-faint); }

/* ---------- 产线清单(基座 = aw-bench) ---------- */
.fleet { margin-bottom: var(--gap-block); }
.fleet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.line-card {
  padding: 13px 15px;
  cursor: pointer;
  background: var(--frost-bg);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel-sm);
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast),
    transform var(--transition-base),
    box-shadow var(--transition-base);
}
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  .line-card:hover {
    border-color: var(--lc, var(--accent));
    transform: translateY(-1px);
    box-shadow: var(--glass-edge), var(--shadow-float);
  }
}
.line-card.on {
  background: color-mix(in srgb, var(--lc) 7%, var(--paper-deep));
  border-color: color-mix(in srgb, var(--lc) 45%, transparent);
}
.lc-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.lc-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--lc);
  border-radius: 50%;
}
.line-card.on .lc-dot {
  background: var(--lc);
  box-shadow: 0 0 7px color-mix(in srgb, var(--lc) 70%, transparent);
}
.lc-head b { font-size: 13px; color: var(--ink); }
.lc-state {
  margin-left: auto;
  padding: 1px 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--ink-faint);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.lc-state.on {
  color: var(--tone-success-dot);
  border-color: color-mix(in srgb, var(--tone-success-dot) 45%, transparent);
}
.lc-run {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  font-size: 11.5px;
  color: color-mix(in srgb, var(--lc) 70%, var(--ink));
}
.lc-run small { font-size: 10px; color: var(--ink-faint); }
.lc-meta {
  display: flex;
  gap: 14px;
  margin-top: 9px;
  padding-top: 8px;
  font-size: 10.5px;
  color: var(--ink-faint);
  border-top: 1px solid var(--divider-hair);
}
/* ---------- Harness 可用性条:墨色药丸式引擎清单,未安装灰化 ---------- */
.harness {
  margin-bottom: var(--gap-block);
}
.harness-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 2px 0 4px;
}
.h-item {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 5px 12px;
  font-size: 11.5px;
  cursor: default;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  border: 1px solid var(--divider-hair);
  border-radius: var(--radius-pill);
  transition: border-color 0.15s, background 0.15s;
}
.h-item:hover { border-color: var(--line-strong); }
.h-item.link { cursor: pointer; }
.h-item.link:hover { border-color: var(--accent); color: var(--accent); }
.h-go { flex: none; font-size: 10px; color: var(--ink-faint); }
.h-item.link:hover .h-go { color: var(--accent); }
.h-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tone-success-dot, #4a6b57);
}
.h-item.off { opacity: 0.55; }
.h-item.off .h-dot { background: var(--tone-danger-dot, #c25a4e); }
.h-name { font-weight: 600; color: var(--ink); }
.h-item.off .h-name { color: var(--ink-soft); }
.h-cmd { font-size: 10px; color: var(--ink-faint); }
/* 全部产线入口:虚线幽灵卡,聚合清单外的余量 */
.fleet-all {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  min-height: 86px;
  color: var(--ink-faint);
  background: transparent;
  border-style: dashed;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.fleet-all:hover {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.fa-n {
  font-size: 22px;
  line-height: 1;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.fleet-all:hover .fa-n { color: var(--accent); }
.fa-label { font-size: 12px; }
.fa-arrow {
  font-size: 15px;
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.fleet-all:hover .fa-arrow { transform: translateX(3px); }
.fleet-empty {
  padding: 18px 0;
  font-size: 12px;
  color: var(--ink-faint);
  text-align: center;
}

@media (max-width: 640px) {
  .hero { padding: 24px 20px; }
  .hero-title { font-size: 28px; }
}
</style>
