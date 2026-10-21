<template>
  <div class="studio">
    <!-- 左栏:数据源 + 我的图表 -->
    <aside class="col left">
      <div class="card grow">
        <h3 class="sec">
          {{ $t('studio.sources') }}
        </h3>
        <select
          v-model="lineId"
          class="input w"
          data-test="studio-line"
          @change="loadNodes"
        >
          <option value="">
            {{ $t('data.line.any') }}
          </option>
          <option
            v-for="l in lines"
            :key="l.id"
            :value="l.id"
          >
            {{ l.name }}
          </option>
        </select>
        <div
          class="nodeList"
          data-test="studio-nodes"
        >
          <button
            v-for="n in nodes"
            :key="n.id"
            class="nodeRow"
            :title="$t('studio.dblClickAdd')"
            @dblclick="addY(n)"
          >
            <span class="nName">{{ n.name }}</span>
            <span
              v-if="n.unit"
              class="unit"
            >{{ n.unit }}</span>
            <button
              v-if="!isY(n.id)"
              class="miniAdd"
              @click.stop="addY(n)"
            >
              +Y
            </button>
          </button>
          <p
            v-if="!nodes.length"
            class="empty"
          >
            {{ $t('studio.pickLine') }}
          </p>
        </div>
      </div>
      <div class="card">
        <h3 class="sec">
          {{ $t('studio.myCharts') }}
        </h3>
        <button
          v-for="ch in charts"
          :key="ch.id"
          class="chartRow"
          data-test="studio-chart-row"
          @click="loadChart(ch)"
        >
          <span class="nName">{{ ch.title }}</span>
          <span class="unit">{{ ch.vizType }} v{{ ch.version }}</span>
          <button
            class="miniAdd"
            @click.stop="removeChart(ch.id)"
          >
            ✕
          </button>
        </button>
        <p
          v-if="!charts.length"
          class="empty"
        >
          {{ $t('studio.noCharts') }}
        </p>
      </div>
    </aside>

    <!-- 中栏:画廊 + 画布 -->
    <main class="col mid">
      <div class="card">
        <div class="row">
          <div
            class="gallery"
            data-test="studio-gallery"
          >
            <button
              v-for="vt in VIZ_TYPES"
              :key="vt"
              class="vizBtn"
              :class="{ on: vizType === vt, dim: !typeAvailable(vt) }"
              :title="vizLabels[vt]"
              @click="vizType = vt"
            >
              {{ vizLabels[vt] }}
            </button>
          </div>
        </div>
        <div class="row">
          <label class="lbl">{{ $t('data.mirror.window') }}</label>
          <select
            v-model="preset"
            class="input sel"
          >
            <option value="15">
              {{ $t('data.mirror.last15') }}
            </option>
            <option value="60">
              {{ $t('data.mirror.last60') }}
            </option>
            <option value="240">
              {{ $t('data.mirror.last240') }}
            </option>
          </select>
          <label class="lbl">{{ $t('studio.runFilter') }}</label>
          <select
            v-model="runId"
            class="input sel"
            data-test="studio-run"
          >
            <option value="">
              {{ $t('studio.noRun') }}
            </option>
            <option
              v-for="r in runs"
              :key="r.id"
              :value="r.id"
            >
              {{ r.id }} · {{ r.outcome }}
            </option>
          </select>
          <label class="lbl">{{ $t('data.mirror.agg') }}</label>
          <select
            v-model="agg"
            class="input sel"
          >
            <option value="avg">
              {{ $t('data.mirror.aggAvg') }}
            </option>
            <option value="min">
              {{ $t('data.mirror.aggMin') }}
            </option>
            <option value="max">
              {{ $t('data.mirror.aggMax') }}
            </option>
          </select>
          <button
            class="pill-btn primary"
            data-test="studio-query"
            :disabled="!yNodes.length || querying"
            @click="doQuery"
          >
            {{ querying ? $t('data.mirror.querying') : $t('data.mirror.query') }}
          </button>
        </div>
        <p
          v-if="error"
          class="err"
        >
          {{ error }}
        </p>
      </div>

      <div class="card grow canvasCard">
        <ClientOnly>
          <AwChart
            v-if="chartOption && vizType !== 'table' && vizType !== 'kpi'"
            :option="chartOption"
            style="height: 100%; width: 100%"
          />
        </ClientOnly>
        <div
          v-if="vizType === 'kpi' && series.length"
          class="kpiRow"
        >
          <div
            v-for="s in series"
            :key="s.nodeId"
            class="kpi"
          >
            <span class="kName">{{ s.name }}</span>
            <span class="kVal">{{ kpiOf(s) }}<i class="unit">{{ s.unit }}</i></span>
          </div>
        </div>
        <div
          v-if="vizType === 'table' && series.length"
          class="tblWrap"
        >
          <table class="tbl">
            <thead>
              <tr>
                <th>{{ $t('data.mirror.time') }}</th><th
                  v-for="s in series"
                  :key="s.nodeId"
                >
                  {{ s.name }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in tableRows"
                :key="r.at"
              >
                <td class="mono">
                  {{ r.time }}
                </td>
                <td
                  v-for="s in series"
                  :key="s.nodeId"
                  class="mono"
                >
                  {{ r.cells[s.nodeId] ?? '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-if="!series.length && !querying"
          class="empty big"
        >
          {{ $t('studio.canvasEmpty') }}
        </p>
      </div>
    </main>

    <!-- 右栏:字段井 + golden + 保存 -->
    <aside class="col right">
      <div class="card">
        <h3 class="sec">
          {{ $t('studio.yWell') }}
        </h3>
        <div
          class="well"
          data-test="studio-y-well"
        >
          <span
            v-for="y in yNodes"
            :key="y.nodeId"
            class="chip"
          >
            <b class="axis">{{ y.axis }}</b>
            {{ y.name }}
            <button
              class="axisBtn"
              :title="$t('studio.toggleAxis')"
              @click="toggleAxis(y.nodeId)"
            >⇄</button>
            <button
              class="axisBtn"
              @click="removeY(y.nodeId)"
            >✕</button>
          </span>
          <span
            v-if="!yNodes.length"
            class="empty"
          >{{ $t('studio.yEmpty') }}</span>
        </div>
        <h3 class="sec">
          {{ $t('studio.refWell') }}
        </h3>
        <div class="well">
          <span
            v-for="(r, i) in refLines"
            :key="i"
            class="chip"
          >
            {{ r.label }} {{ r.value }}
            <button
              class="axisBtn"
              @click="refLines.splice(i, 1)"
            >✕</button>
          </span>
          <span
            v-if="!refLines.length"
            class="empty"
          >{{ $t('studio.refEmpty') }}</span>
        </div>
        <div class="row">
          <input
            v-model="refValue"
            type="number"
            class="input numIn"
            :placeholder="$t('studio.refValue')"
          >
          <button
            class="pill-btn"
            @click="addRefFromNodeRange"
          >
            {{ $t('studio.refFromTemplate') }}
          </button>
        </div>
      </div>

      <div class="card">
        <h3 class="sec">
          {{ $t('studio.golden') }}
        </h3>
        <p class="hint">
          {{ $t('studio.goldenHint') }}
        </p>
        <div
          v-for="y in yNodes"
          :key="y.nodeId"
          class="row goldenRow"
        >
          <span class="nName">{{ y.name }}</span>
          <button
            class="pill-btn"
            :disabled="!runId"
            @click="makeGolden(y.nodeId)"
          >
            {{ $t('studio.goldenMake') }}
          </button>
          <button
            class="pill-btn"
            @click="toggleGolden(y.nodeId)"
          >
            {{ goldenOn.has(y.nodeId) ? $t('studio.goldenHide') : $t('studio.goldenShow') }}
          </button>
          <button
            class="pill-btn"
            :disabled="!runId"
            @click="scoreDeviation(y.nodeId)"
          >
            {{ $t('studio.goldenScore') }}
          </button>
        </div>
        <p
          v-if="deviation"
          class="hint"
          data-test="studio-deviation"
        >
          {{ $t('studio.deviationScore', { score: deviation.score }) }}
        </p>
      </div>

      <div class="card">
        <h3 class="sec">
          {{ $t('studio.saveSection') }}
        </h3>
        <input
          v-model="title"
          class="input w"
          :placeholder="$t('studio.chartTitle')"
          data-test="studio-title"
        >
        <div class="row">
          <select
            v-model="visibility"
            class="input sel"
          >
            <option value="private">
              {{ $t('studio.visPrivate') }}
            </option>
            <option value="line">
              {{ $t('studio.visLine') }}
            </option>
          </select>
          <button
            class="pill-btn primary"
            data-test="studio-save"
            :disabled="!title.trim() || !series.length"
            @click="saveChart"
          >
            {{ editingId ? $t('studio.update') : $t('studio.save') }}
          </button>
        </div>
        <p
          v-if="saveMsg"
          class="hint"
        >
          {{ saveMsg }}
        </p>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
/**
 * EDA 工坊(plan1 M2 + E2 Trace Viewer):
 * 主交互 = inline 字段井(Y 轴井 L/R + 参考线井)+ 双击测点入图 + 图型画廊(Show Me:
 * kpi/table 单序列约束点亮);E2 = run 过滤 + golden 相位画像生成/叠加(0-100% 轴)/偏差分。
 * 取数永远走 /daq/query 按请求鉴权(图表只存查询参数快照,不代理数据 —— B4 铁律)。
 */
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '@/app/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'

const VIZ_TYPES = ['trend', 'bar', 'scatter', 'kpi', 'table', 'histogram'] as const
type VizType = typeof VIZ_TYPES[number]

interface LineLite { id: string, name: string }
interface DaqNodeLite { id: string, name: string, unit: string, lineId: string, min?: number, max?: number }
interface YEntry { nodeId: string, name: string, unit: string, axis: 'L' | 'R' }
interface RefLine { value: number, label: string }
interface Series { nodeId: string, name: string, unit: string, points: Array<{ at: number, v: number }> }
interface ChartRow { id: string, title: string, vizType: VizType, datasource: Record<string, unknown>, encoding: Record<string, unknown>, options: Record<string, unknown>, lineId: string | null, visibility: string, version: number }
interface RunRow { id: string, outcome: string, startedAt: string, endedAt: string | null }
interface GoldenBin { phase: number, mean: number | null, std: number | null, min: number | null, max: number | null }

const { t } = useI18n()
const vizLabels = computed(() => ({
  trend: t('studio.viz.trend'),
  bar: t('studio.viz.bar'),
  scatter: t('studio.viz.scatter'),
  kpi: t('studio.viz.kpi'),
  table: t('studio.viz.table'),
  histogram: t('studio.viz.histogram'),
}))
const lines = ref<LineLite[]>([])
const nodes = ref<DaqNodeLite[]>([])
const lineId = ref('')
const charts = ref<ChartRow[]>([])
const runs = ref<RunRow[]>([])
const yNodes = ref<YEntry[]>([])
const refLines = ref<RefLine[]>([])
const refValue = ref<number | string>('')
const vizType = ref<VizType>('trend')
const preset = ref('60')
const runId = ref('')
const agg = ref<'avg' | 'min' | 'max'>('avg')
const querying = ref(false)
const error = ref('')
const series = ref<Series[]>([])
const goldenOn = ref(new Set<string>())
const goldenCache = ref(new Map<string, GoldenBin[]>())
const deviation = ref<{ score: number } | null>(null)
const title = ref('')
const visibility = ref<'private' | 'line'>('private')
const editingId = ref('')
const saveMsg = ref('')

const isY = (id: string) => yNodes.value.some(y => y.nodeId === id)
const typeAvailable = (vt: VizType) => (vt === 'kpi' || vt === 'table' ? series.value.length > 0 : yNodes.value.length > 0)

function addY(n: DaqNodeLite): void {
  if (isY(n.id)) return
  if (yNodes.value.length >= 8) {
    error.value = t('studio.yMax')
    return
  }
  yNodes.value.push({ nodeId: n.id, name: n.name, unit: n.unit, axis: yNodes.value.length === 0 ? 'L' : 'R' })
  goldenOn.value.delete(n.id)
}
function removeY(id: string): void {
  yNodes.value = yNodes.value.filter(y => y.nodeId !== id)
}
function toggleAxis(id: string): void {
  const y = yNodes.value.find(x => x.nodeId === id)
  if (y) y.axis = y.axis === 'L' ? 'R' : 'L'
}
function addRefFromNodeRange(): void {
  const v = Number(refValue.value)
  if (Number.isFinite(v) && v !== 0) {
    refLines.value.push({ value: v, label: 'ref' })
    refValue.value = ''
    return
  }
  const n = nodes.value.find(x => isY(x.id))
  if (n?.max != null) refLines.value.push({ value: Number(n.max), label: t('studio.maxRef') })
}
function kpiOf(s: Series): string {
  const last = s.points.at(-1)?.v
  return last == null ? '-' : String(Number(last.toFixed(3)))
}

const tableRows = computed(() => {
  const ats = new Set<number>()
  for (const s of series.value) for (const p of s.points) ats.add(p.at)
  return [...ats].sort((a, b) => b - a).slice(0, 200).map((at) => {
    const cells: Record<string, string> = {}
    for (const s of series.value) {
      const p = s.points.find(x => x.at === at)
      cells[s.nodeId] = p ? String(p.v) : ''
    }
    return { at, time: new Date(at).toISOString().slice(5, 19).replace('T', ' '), cells }
  })
})

const chartOption = computed(() => {
  if (!series.value.length) return null
  const units: string[] = []
  for (const s of series.value) if (s.unit && !units.includes(s.unit)) units.push(s.unit)
  const axisOf = (u: string) => Math.min(units.indexOf(u), 1)
  const yAxes = [0, 1].slice(0, Math.max(1, Math.min(units.length, 2))).map(i => ({ type: 'value' as const, name: units[i] ?? '', scale: true }))
  const seriesOut: Record<string, unknown>[] = []
  if (vizType.value === 'bar') {
    seriesOut.push(...series.value.map(s => ({
      name: s.name, type: 'bar', yAxisIndex: axisOf(s.unit),
      data: s.points.map(p => [p.at, p.v]), barMaxWidth: 24,
    })))
  }
  else if (vizType.value === 'scatter') {
    seriesOut.push(...series.value.map(s => ({
      name: s.name, type: 'scatter', yAxisIndex: axisOf(s.unit),
      symbolSize: 5, data: s.points.map(p => [p.at, p.v]),
    })))
  }
  else if (vizType.value === 'histogram') {
    for (const s of series.value) {
      const vals = s.points.map(p => p.v)
      if (!vals.length) continue
      const min = Math.min(...vals)
      const max = Math.max(...vals)
      const k = 20
      const w = (max - min) / k || 1
      const bins = Array.from({ length: k }, () => 0)
      for (const v of vals) bins[Math.min(k - 1, Math.floor((v - min) / w))]! += 1
      seriesOut.push({
        name: s.name, type: 'bar', yAxisIndex: 0, barCategoryGap: '0%',
        data: bins.map((c, i) => [Number((min + i * w).toFixed(3)), c]),
        tooltip: { formatter: (p: { dataIndex: number }) => `[${(min + p.dataIndex * w).toFixed(2)}, ${(min + (p.dataIndex + 1) * w).toFixed(2)}) : ${bins[p.dataIndex]}` },
      })
    }
  }
  else {
    seriesOut.push(...series.value.map(s => ({
      name: s.name, type: 'line', yAxisIndex: axisOf(s.unit), showSymbol: false,
      data: s.points.map(p => [p.at, p.v]),
    })))
  }
  // golden 相位叠加(0-100% 轴):均值实线 + ±std 隐形堆叠面积带
  if (vizType.value === 'trend') {
    for (const s of series.value) {
      const bins = goldenCache.value.get(s.nodeId)
      if (!bins || !goldenOn.value.has(s.nodeId)) continue
      const mk = (pick: (b: GoldenBin) => number | null) => bins.map(b => [Number((b.phase * 100).toFixed(2)), pick(b)])
      seriesOut.push({ name: `${s.name} G`, type: 'line', xAxisIndex: 1, yAxisIndex: axisOf(s.unit), showSymbol: false, lineStyle: { type: 'dashed', width: 2 }, data: mk(b => b.mean) })
      seriesOut.push({ name: `${s.name} G+`, type: 'line', xAxisIndex: 1, yAxisIndex: axisOf(s.unit), showSymbol: false, stack: `g-${s.nodeId}`, lineStyle: { opacity: 0 }, data: mk(b => (b.mean != null && b.std != null ? b.mean + b.std : null)) })
      seriesOut.push({ name: `${s.name} G-`, type: 'line', xAxisIndex: 1, yAxisIndex: axisOf(s.unit), showSymbol: false, stack: `g-${s.nodeId}`, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.12 }, data: mk(b => (b.mean != null && b.std != null ? b.mean - b.std : null)) })
    }
  }
  const xAxes: Record<string, unknown>[] = [{ type: 'time' }]
  const hasGolden = vizType.value === 'trend' && series.value.some(s => goldenOn.value.has(s.nodeId) && goldenCache.value.has(s.nodeId))
  if (hasGolden) xAxes.push({ type: 'value', min: 0, max: 100, name: '%' })
  // 参考线(挂在第一个可用 y 轴)
  if (refLines.value.length && seriesOut.length) {
    (seriesOut[0] as Record<string, unknown>).markLine = {
      silent: true,
      symbol: 'none',
      data: refLines.value.map(r => ({ yAxis: r.value, label: { formatter: `${r.label} ${r.value}` }, lineStyle: { type: 'dashed', color: '#b3403a' } })),
    }
  }
  return {
    tooltip: { trigger: 'axis' },
    legend: { type: 'scroll' },
    grid: { left: 56, right: units.length > 1 ? 56 : 24, top: 32, bottom: 64 },
    xAxis: xAxes,
    yAxis: yAxes,
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 10 }],
    toolbox: { right: 8, top: 0, feature: { saveAsImage: { title: 'PNG' } } },
    series: seriesOut,
  }
})

async function doQuery(): Promise<void> {
  querying.value = true
  error.value = ''
  try {
    const run = runs.value.find(r => r.id === runId.value)
    const to = run?.endedAt ? Date.parse(run.endedAt) : Date.now()
    const from = run ? Date.parse(run.startedAt) : to - (Number(preset.value) || 60) * 60_000
    const p = new URLSearchParams()
    if (lineId.value) p.set('line_id', lineId.value)
    p.set('node_ids', yNodes.value.map(y => y.nodeId).join(','))
    p.set('from', String(from))
    p.set('to', String(to))
    p.set('agg', agg.value)
    if (runId.value) p.set('run_id', runId.value)
    const r = await apiFetch<{ series: Series[] }>({ base: `/api/workshop/daq/query?${p.toString()}`, retries: 0 })
    series.value = r.series ?? []
    goldenOn.value = new Set([...goldenOn.value].filter(id => yNodes.value.some(y => y.nodeId === id)))
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
  finally {
    querying.value = false
  }
}

async function makeGolden(nodeId: string): Promise<void> {
  if (!runId.value) return
  try {
    await apiFetch({ base: '/api/workshop/eda/golden', init: { method: 'POST', body: JSON.stringify({ run_id: runId.value, node_id: nodeId }) } })
    saveMsg.value = t('studio.goldenMade', { node: yNodes.value.find(y => y.nodeId === nodeId)?.name ?? nodeId })
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

async function toggleGolden(nodeId: string): Promise<void> {
  if (goldenOn.value.has(nodeId)) {
    goldenOn.value.delete(nodeId)
    goldenOn.value = new Set(goldenOn.value)
    return
  }
  try {
    // golden 按 recipe+node 键:run 台账行携带 recipeId,先取 run 的配方再取画像
    const runsR = await apiFetch<{ runs: Array<{ id: string, recipeId: string }> }>({ base: `/api/workshop/eda/runs?limit=50` })
    const recipeId = (runsR.runs ?? []).find(r => r.id === runId.value)?.recipeId
    if (!recipeId) {
      error.value = t('studio.noRecipe')
      return
    }
    const g = await apiFetch<{ golden: { profile: GoldenBin[] } }>({ base: `/api/workshop/eda/golden/single?recipe_id=${encodeURIComponent(recipeId)}&node_id=${encodeURIComponent(nodeId)}` })
    goldenCache.value.set(nodeId, g.golden.profile)
    goldenOn.value.add(nodeId)
    goldenOn.value = new Set(goldenOn.value)
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

async function scoreDeviation(nodeId: string): Promise<void> {
  if (!runId.value) return
  try {
    deviation.value = await apiFetch<{ score: number }>({ base: `/api/workshop/eda/golden/deviation?run_id=${encodeURIComponent(runId.value)}&node_id=${encodeURIComponent(nodeId)}` })
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

function currentChartPayload(): Record<string, unknown> {
  return {
    title: title.value.trim(),
    viz_type: vizType.value,
    datasource: { lineId: lineId.value || null, nodeIds: yNodes.value.map(y => y.nodeId), runId: runId.value || null, preset: preset.value, agg: agg.value },
    encoding: { y: yNodes.value, refLines: refLines.value, golden: [...goldenOn.value] },
    options: {},
    line_id: lineId.value || null,
    visibility: visibility.value,
  }
}

async function saveChart(): Promise<void> {
  saveMsg.value = ''
  try {
    const payload = currentChartPayload()
    if (editingId.value) {
      const r = await apiFetch<{ chart: ChartRow }>({ base: `/api/workshop/eda/charts/${editingId.value}`, init: { method: 'PATCH', body: JSON.stringify(payload) } })
      saveMsg.value = t('studio.savedV', { v: r.chart.version })
    }
    else {
      const r = await apiFetch<{ chart: ChartRow }>({ base: '/api/workshop/eda/charts', init: { method: 'POST', body: JSON.stringify(payload) } })
      editingId.value = r.chart.id
      saveMsg.value = t('studio.savedV', { v: r.chart.version })
    }
    await loadCharts()
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

function loadChart(ch: ChartRow): void {
  editingId.value = ch.id
  title.value = ch.title
  vizType.value = ch.vizType
  const ds = ch.datasource as { lineId?: string, nodeIds?: string[], runId?: string | null, preset?: string, agg?: 'avg' | 'min' | 'max' }
  lineId.value = ds.lineId ?? ''
  runId.value = ds.runId ?? ''
  preset.value = ds.preset ?? '60'
  agg.value = ds.agg ?? 'avg'
  visibility.value = (ch.visibility as 'private' | 'line') ?? 'private'
  const enc = ch.encoding as { y?: YEntry[], refLines?: RefLine[], golden?: string[] }
  yNodes.value = enc.y ?? []
  refLines.value = enc.refLines ?? []
  goldenOn.value = new Set(enc.golden ?? [])
  void loadNodes().then(doQuery)
}

async function removeChart(id: string): Promise<void> {
  try {
    await apiFetch({ base: `/api/workshop/eda/charts/${id}`, init: { method: 'DELETE' } })
    if (editingId.value === id) editingId.value = ''
    await loadCharts()
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

async function loadNodes(): Promise<void> {
  const r = await apiFetch<{ nodes: DaqNodeLite[] }>({ base: '/api/workshop/daq', retries: 1 })
  nodes.value = (r.nodes ?? []).filter(n => !lineId.value || n.lineId === lineId.value)
}

async function loadCharts(): Promise<void> {
  const r = await apiFetch<{ charts: ChartRow[] }>({ base: '/api/workshop/eda/charts?mine=1', retries: 1 })
  charts.value = r.charts ?? []
}

onMounted(async () => {
  try {
    const [l, runsR] = await Promise.all([
      apiFetch<{ lines: LineLite[] }>({ base: '/api/workshop/dcw/lines', retries: 1 }),
      apiFetch<{ runs: RunRow[] }>({ base: '/api/workshop/eda/runs?limit=20', retries: 1 }),
    ])
    lines.value = l.lines ?? []
    runs.value = runsR.runs ?? []
    if (lines.value.length) {
      lineId.value = lines.value[0]!.id
      await loadNodes()
    }
    await loadCharts()
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
})
</script>

<style scoped>
.studio { display: grid; grid-template-columns: 250px 1fr 300px; gap: 12px; padding: 16px 20px; height: calc(100vh - 56px); }
.col { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.card { background: var(--panel, #fff); border: 1px solid var(--border, rgba(127,127,127,.25)); border-radius: 10px; padding: 10px 12px; }
.card.grow { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.sec { font-size: 12px; font-weight: 700; margin: 2px 0 8px; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
.lbl { font-size: 12px; color: var(--ink-soft, #666); }
.input { border: 1px solid var(--border, rgba(127,127,127,.35)); border-radius: 6px; padding: 4px 8px; background: transparent; color: var(--ink, #222); font-size: 12px; }
.input.w { width: 100%; margin-bottom: 6px; }
.sel { max-width: 140px; }
.numIn { width: 90px; }
.nodeList { overflow: auto; flex: 1; min-height: 0; }
.nodeRow, .chartRow { display: flex; gap: 6px; align-items: center; width: 100%; border: none; background: transparent; padding: 4px 4px; cursor: grab; border-radius: 6px; text-align: left; }
.nodeRow:hover, .chartRow:hover { background: var(--border, rgba(127,127,127,.12)); }
.nName { font-size: 12px; color: var(--ink, #222); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.unit { font-size: 11px; color: var(--ink-faint, #999); }
.miniAdd { border: 1px solid var(--border, rgba(127,127,127,.4)); background: transparent; border-radius: 6px; font-size: 11px; padding: 0 6px; cursor: pointer; }
.gallery { display: flex; gap: 4px; flex-wrap: wrap; }
.vizBtn { border: 1px solid var(--border, rgba(127,127,127,.35)); background: transparent; border-radius: 999px; padding: 3px 12px; font-size: 12px; cursor: pointer; color: var(--ink-soft, #555); }
.vizBtn.on { border-color: #4a6b57; color: #4a6b57; font-weight: 600; }
.vizBtn.dim { opacity: 0.45; }
.canvasCard { position: relative; }
.canvasCard > div:first-child { flex: 1; min-height: 220px; }
.well { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; min-height: 26px; }
.chip { display: inline-flex; gap: 4px; align-items: center; border: 1px solid var(--border, rgba(127,127,127,.35)); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
.axis { color: #4a6b57; font-weight: 700; }
.axisBtn { border: none; background: transparent; cursor: pointer; font-size: 11px; color: var(--ink-faint, #777); }
.empty { color: var(--ink-faint, #999); font-size: 12px; }
.empty.big { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.err { font-size: 12px; color: #b3403a; white-space: pre-wrap; }
.hint { font-size: 11px; color: var(--ink-faint, #888); margin: 2px 0; }
.goldenRow { gap: 4px; }
.kpiRow { display: flex; gap: 18px; flex-wrap: wrap; padding: 30px; }
.kpi { display: flex; flex-direction: column; }
.kName { font-size: 12px; color: var(--ink-soft, #666); }
.kVal { font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; }
.tblWrap { max-height: 100%; overflow: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th, .tbl td { border-bottom: 1px solid var(--border, rgba(127,127,127,.18)); padding: 3px 8px; text-align: left; }
.mono { font-variant-numeric: tabular-nums; }
@media (max-width: 1100px) {
  .studio { grid-template-columns: 1fr; height: auto; }
}
</style>
