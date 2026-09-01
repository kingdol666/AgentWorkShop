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
import AwChart from '@/app/components/AwChart.vue'
import type { EChartsOption } from 'echarts'

useHead({ title: () => t('titles.dashboard') })

const { t } = useI18n()
const site = useSiteConfig()
const store = useAppStore()
const daq = useDaqStream()
const dcw = useDcwStream()

// 数据宪法色板:绿主 / 数据青 / 琥珀 / 紫罗兰(与产线光晕色板同源)
const PAL = { accent: '#35e0a0', cyan: '#41c8f4', amber: '#f4c542', violet: '#b58cff', danger: '#ff6b6b' }

// ---------- 数据装载(WS 实时 + 5s 兜底;可见性调度:后台降频 30s,回前台立即补拍) ----------
onMounted(() => {
  daq.ensureWsFeed()
  dcw.ensureWsFeed()
  void Promise.all([daq.load(), dcw.load()]).then(() => pushTrend())
  useVisibleInterval(() => {
    void daq.load()
    void dcw.load()
    pushTrend()
  }, 5000, { bgMs: 30000 })
})

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
    type: 'value', min: 0, max: 100,
    name: t('home.trendY'), nameTextStyle: { color: dimC.value, fontSize: 10, align: 'left' },
    axisLabel: { color: dimC.value, fontSize: 10 },
    splitLine: { lineStyle: { color: splitC.value } },
  },
  series: trendNodes.value.map((n, i) => {
    const color = [PAL.accent, PAL.cyan, PAL.amber, PAL.violet][i % 4]
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
      { value: linesActive.value.length, name: t('home.runNow'), itemStyle: { color: PAL.accent } },
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
      { value: daq.meta.samplesStored ?? 0, itemStyle: { color: PAL.amber } },
      { value: daq.meta.consumed ?? 0, itemStyle: { color: PAL.cyan } },
      { value: daq.meta.produced ?? 0, itemStyle: { color: PAL.accent } },
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
    progress: { show: true, width: 12, itemStyle: { color: PAL.accent } },
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
const NODE_STATES = [
  { key: 'ok', color: PAL.accent },
  { key: 'warn', color: PAL.amber },
  { key: 'alarm', color: PAL.danger },
  { key: 'writing', color: PAL.cyan },
  { key: 'idle', color: '#8fa0b5' },
  { key: 'error', color: '#ff8a5c' },
  { key: 'offline', color: 'rgba(143,160,181,0.35)' },
] as const

const nodeStateOpt = computed<EChartsOption>(() => {
  const daqCount = new Map<string, number>()
  for (const n of daq.nodes) daqCount.set(n.state, (daqCount.get(n.state) ?? 0) + 1)
  const dcwCount = new Map<string, number>()
  for (const n of dcw.nodes) dcwCount.set(n.state, (dcwCount.get(n.state) ?? 0) + 1)
  const states = NODE_STATES.filter(s => daqCount.get(s.key) || dcwCount.get(s.key))
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
    <!-- Hero:产线运营中枢(暗夜航仪;右侧 LIVE 实况) -->
    <section class="hero aw-stagger">
      <div class="hero-main">
        <p class="aw-kicker">
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
      <div class="hero-live mono">
        <span class="live-badge"><span class="live-dot" />{{ t('home.live') }}</span>
        <div class="live-rows">
          <span>{{ t('home.runNow') }} <b>{{ linesActive.length }}</b>/{{ dcw.lines.length }} {{ t('home.kpi.lines') }}</span>
          <span>{{ t('home.kpi.samples') }} <b>{{ daq.meta.samplesStored ?? 0 }}</b></span>
          <span
            class="live-alarms"
            :class="{ on: alarmCount > 0 }"
          >{{ t('home.kpi.alarms') }} <b>{{ alarmCount }}</b></span>
        </div>
      </div>
      <!-- 仪表刻度母题(控制室仪器读数;纯装饰,reduced-motion 无关、零动画) -->
      <div
        class="hero-scale"
        aria-hidden="true"
      />
    </section>

    <!-- KPI 行 -->
    <div class="kpi-row aw-stagger">
      <div class="kpi">
        <span class="kpi-label">{{ t('home.kpi.lines') }}</span>
        <span class="kpi-value">{{ linesActive.length }}<small>/{{ dcw.lines.length }}</small></span>
      </div>
      <div class="kpi">
        <span class="kpi-label">{{ t('home.kpi.dcwNodes') }}</span>
        <span class="kpi-value">{{ dcw.controller.nodesOnline }}<small>/{{ dcw.controller.nodesTotal }}</small></span>
      </div>
      <div class="kpi">
        <span class="kpi-label">{{ t('home.kpi.daqNodes') }}</span>
        <span class="kpi-value">{{ daqOnline }}<small>/{{ daqTotal }}</small></span>
      </div>
      <div class="kpi">
        <span class="kpi-label">{{ t('home.kpi.samples') }}</span>
        <span class="kpi-value mono">{{ daq.meta.samplesStored ?? 0 }}</span>
      </div>
      <div class="kpi">
        <span class="kpi-label">{{ t('home.kpi.writeRate') }}</span>
        <span class="kpi-value">{{ writeRate }}<small>%</small></span>
      </div>
      <div
        class="kpi"
        :class="{ alarm: alarmCount > 0 }"
      >
        <span class="kpi-label">{{ t('home.kpi.alarms') }}</span>
        <span class="kpi-value">{{ alarmCount }}</span>
      </div>
    </div>

    <!-- 大屏图阵 -->
    <div class="grid aw-stagger">
      <section class="dpanel span8">
        <header class="dp-hd">
          <h3>{{ t('home.charts.trend') }}</h3>
          <small>{{ t('home.charts.trendSub') }}</small>
        </header>
        <ClientOnly>
          <AwChart
            :option="trendOpt"
            class="chart h280"
          />
        </ClientOnly>
      </section>
      <section class="dpanel span4">
        <header class="dp-hd">
          <h3>{{ t('home.charts.lineState') }}</h3>
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
      <section class="dpanel span4">
        <header class="dp-hd">
          <h3>{{ t('home.charts.pipeline') }}</h3>
        </header>
        <ClientOnly>
          <AwChart
            :option="pipelineOpt"
            class="chart h240"
          />
        </ClientOnly>
      </section>
      <section class="dpanel span4">
        <header class="dp-hd">
          <h3>{{ t('home.charts.writeCtl') }}</h3>
          <small class="mono">{{ dcw.controller.writesTotal }} {{ t('home.writesFailed') }} {{ dcw.controller.writesFailed }}</small>
        </header>
        <ClientOnly>
          <AwChart
            :option="writeOpt"
            class="chart h240"
          />
        </ClientOnly>
      </section>
      <section class="dpanel span4">
        <header class="dp-hd">
          <h3>{{ t('home.charts.nodeState') }}</h3>
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
    <section class="dpanel fleet aw-stagger">
      <header class="dp-hd">
        <h3>{{ t('home.charts.lines') }}</h3>
        <small>{{ t('home.fleetHint') }}</small>
        <small class="mono fleet-total">{{ dcw.lines.length }}</small>
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
  </div>
</template>

<style scoped>
.home { padding: 4px; }

/* ---------- Hero:中枢横幅 + LIVE 实况 ---------- */
.hero {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  padding: 30px 34px;
  overflow: hidden;
  background: var(--surface-glass);
  backdrop-filter: var(--aurora-blur);
  -webkit-backdrop-filter: var(--aurora-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-edge);
}
.hero::after {
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  content: '';
  background: linear-gradient(90deg, transparent, rgb(53 224 160 / 45%), transparent);
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
.hero-live {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 210px;
  padding: 16px 18px;
  background: var(--frost-bg);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-chip);
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
  gap: 7px;
  font-size: 11.5px;
  color: var(--ink-faint);
}
.live-rows b { color: var(--ink); }
.live-alarms.on { color: var(--tone-danger-dot); }
.live-alarms.on b { color: var(--tone-danger-dot); }

/* ---------- KPI 行 ---------- */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
  margin-bottom: 14px;
}
@media (max-width: 1100px) {
  .kpi-row { grid-template-columns: repeat(3, 1fr); }
}
.kpi {
  position: relative;
  padding: 14px 18px;
  overflow: hidden;
  background: var(--surface-glass);
  backdrop-filter: var(--aurora-blur);
  -webkit-backdrop-filter: var(--aurora-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-edge);
  transition: border-color var(--transition-base), transform var(--transition-base), box-shadow var(--transition-base);
}
.kpi:hover {
  border-color: color-mix(in srgb, var(--line-strong) 70%, var(--accent) 30%);
  transform: translateY(-1px);
  box-shadow: var(--glass-edge), var(--shadow-float);
}
.kpi-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-fainter);
}
.kpi-value {
  margin-top: 5px;
  font-size: 26px;
  line-height: 1.1;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.kpi-value small {
  margin-left: 2px;
  font-size: 13px;
  color: var(--ink-faint);
}
.kpi.alarm .kpi-value { color: var(--tone-danger-dot); }

/* ---------- 大屏图阵 ---------- */
.grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 12px;
  margin-bottom: 14px;
}
.span8 { grid-column: span 8; }
.span4 { grid-column: span 4; }
@media (max-width: 1100px) {
  .span8, .span4 { grid-column: span 12; }
}
.dpanel {
  position: relative;
  padding: 14px 16px 10px;
  overflow: hidden;
  background: var(--surface-glass);
  backdrop-filter: var(--aurora-blur);
  -webkit-backdrop-filter: var(--aurora-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-edge);
}
.dpanel::before {
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  content: '';
  background: linear-gradient(90deg, rgb(53 224 160 / 40%), rgb(65 200 244 / 18%) 40%, transparent 75%);
  pointer-events: none;
}
.dp-hd {
  display: flex;
  gap: 10px;
  align-items: baseline;
  margin-bottom: 6px;
}
.dp-hd h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--ink);
}
/* 工业刻度记号:面板小标前的品牌绿竖标(控制室仪表命名牌语言) */
.dp-hd h3::before {
  display: inline-block;
  width: 3px;
  height: 11px;
  margin-right: 8px;
  content: '';
  background: var(--accent);
  border-radius: 1px;
}
.dp-hd small {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--ink-fainter);
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
.donut-center b { font-size: 24px; color: var(--ink); }
.donut-center small { font-size: 11px; color: var(--ink-faint); }

/* ---------- 产线清单 ---------- */
.fleet { padding-bottom: 16px; }
.fleet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.line-card {
  padding: 12px 14px;
  cursor: pointer;
  background: var(--frost-bg);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-chip);
  transition: border-color 0.15s, background 0.15s;
}
.line-card:hover { border-color: var(--lc, var(--accent)); }
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
.lc-run small { font-size: 10px; color: var(--ink-fainter); }
.lc-meta {
  display: flex;
  gap: 14px;
  margin-top: 9px;
  padding-top: 8px;
  font-size: 10.5px;
  color: var(--ink-faint);
  border-top: 1px solid var(--divider-hair);
}
.fleet-total {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink-faint);
}
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
