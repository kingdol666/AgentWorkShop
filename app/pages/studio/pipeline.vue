<template>
  <div
    class="page"
    data-test="pipeline-page"
  >
    <header class="aw-page-head">
      <div>
        <h1>{{ $t('studio.pipeline.title') }}</h1>
        <p class="sub">
          {{ $t('studio.pipeline.sub') }}
        </p>
      </div>
      <NuxtLink
        class="pill-btn outline"
        to="/studio"
      >{{ $t('studio.pipeline.backToStudio') }}</NuxtLink>
    </header>

    <!-- Step 1 拉取数据 -->
    <section class="cardBlock">
      <h2><span class="stepNo">1</span>{{ $t('studio.pipeline.s1') }}</h2>
      <div class="row">
        <select
          v-model="lineId"
          data-test="pipeline-lines"
          class="field"
          @change="loadNodes"
        >
          <option
            value=""
            disabled
          >
            {{ $t('studio.pipeline.pickLine') }}
          </option>
          <option
            v-for="l in lines"
            :key="l.id"
            :value="l.id"
          >
            {{ l.name }}
          </option>
        </select>
        <select
          v-model="windowMin"
          class="field narrow"
        >
          <option :value="15">
            {{ $t('studio.pipeline.w15') }}
          </option>
          <option :value="60">
            {{ $t('studio.pipeline.w60') }}
          </option>
          <option :value="240">
            {{ $t('studio.pipeline.w240') }}
          </option>
        </select>
        <select
          v-model="agg"
          class="field narrow"
        >
          <option value="avg">
            avg
          </option>
          <option value="min">
            min
          </option>
          <option value="max">
            max
          </option>
        </select>
        <button
          class="pill-btn"
          data-test="pipeline-fetch"
          :disabled="querying || !lineId || !pickNodes.length"
          @click="doFetch"
        >
          {{ querying ? $t('studio.pipeline.fetching') : $t('studio.pipeline.fetch') }}
        </button>
      </div>
      <div
        class="row wrap"
        data-test="pipeline-nodes"
      >
        <button
          v-for="n in nodes"
          :key="n.id"
          class="chip"
          :class="{ on: pickNodes.includes(n.id) }"
          @click="toggleNode(n.id)"
        >
          {{ n.name }}<span
            v-if="n.unit"
            class="unit"
          > {{ n.unit }}</span>
        </button>
      </div>
      <div class="importRow">
        <textarea
          v-model="importCsv"
          class="code import"
          rows="3"
          spellcheck="false"
          data-test="pipeline-import"
          :placeholder="$t('studio.pipeline.importPlaceholder')"
        />
        <button
          class="pill-btn outline"
          data-test="pipeline-import-btn"
          :disabled="!importCsv.trim()"
          @click="importTable"
        >
          {{ $t('studio.pipeline.importBtn') }}
        </button>
      </div>
    </section>

    <!-- Step 2 数据表 + 后处理 -->
    <section class="cardBlock">
      <h2><span class="stepNo">2</span>{{ $t('studio.pipeline.s2') }}</h2>
      <div
        v-if="viewRows.length"
        class="tableWrap"
        data-test="pipeline-table"
      >
        <table class="grid">
          <thead>
            <tr>
              <th
                v-for="c in tableCols"
                :key="c"
              >
                {{ c }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, i) in viewRows.slice(0, 8)"
              :key="i"
            >
              <td
                v-for="c in tableCols"
                :key="c"
              >
                {{ r[c] }}
              </td>
            </tr>
          </tbody>
        </table>
        <p class="hint">
          {{ $t('studio.pipeline.rowsInfo', { n: viewRows.length, show: Math.min(viewRows.length, 8) }) }}
        </p>
      </div>
      <p
        v-else
        class="hint"
      >
        {{ $t('studio.pipeline.noRows') }}
      </p>
      <div class="codeRow">
        <textarea
          v-model="transformCode"
          class="code"
          rows="5"
          spellcheck="false"
          data-test="pipeline-code"
          :placeholder="$t('studio.pipeline.codePlaceholder')"
        />
        <div class="codeSide">
          <button
            class="pill-btn"
            data-test="pipeline-apply"
            :disabled="!viewRows.length"
            @click="applyTransform"
          >
            {{ $t('studio.pipeline.applyTransform') }}
          </button>
          <button
            class="pill-btn outline"
            data-test="pipeline-reset"
            @click="resetTransform"
          >
            {{ $t('studio.pipeline.resetTransform') }}
          </button>
          <p
            v-if="transformError"
            class="err"
            role="alert"
          >
            {{ transformError }}
          </p>
          <p
            v-else-if="applied"
            class="hint"
          >
            {{ $t('studio.pipeline.transformedTo', { n: viewRows.length }) }}
          </p>
        </div>
      </div>
    </section>

    <!-- Step 3 图表配置 -->
    <section class="cardBlock">
      <h2><span class="stepNo">3</span>{{ $t('studio.pipeline.s3') }}</h2>
      <div class="row wrap">
        <label class="lbl">{{ $t('studio.pipeline.chartType') }}
          <select
            v-model="chartType"
            data-test="pipeline-type"
            class="field narrow"
          >
            <option value="line">
              line
            </option>
            <option value="bar">
              bar
            </option>
            <option value="scatter">
              scatter
            </option>
            <option value="pie">
              pie
            </option>
            <option value="histogram">
              histogram
            </option>
          </select>
        </label>
        <label class="lbl">X
          <select
            v-model="cfg.xField"
            data-test="pipeline-xfield"
            class="field narrow"
          >
            <option
              v-for="f in viewFields"
              :key="f.name"
              :value="f.name"
            >
              {{ f.name }}
            </option>
          </select>
        </label>
        <label
          v-if="chartType !== 'pie' && chartType !== 'histogram'"
          class="lbl"
        >Y
          <select
            v-model="cfg.yFields"
            data-test="pipeline-yfields"
            class="field narrow"
            multiple
          >
            <option
              v-for="f in viewFields.filter(f => f.numeric)"
              :key="f.name"
              :value="f.name"
            >
              {{ f.name }}
            </option>
          </select>
        </label>
        <label
          v-else
          class="lbl"
        >{{ $t('studio.pipeline.valueField') }}
          <select
            v-model="cfg.yFields[0]"
            data-test="pipeline-yfields"
            class="field narrow"
          >
            <option
              v-for="f in viewFields.filter(f => f.numeric)"
              :key="f.name"
              :value="f.name"
            >
              {{ f.name }}
            </option>
          </select>
        </label>
        <label class="lbl">{{ $t('studio.pipeline.groupBy') }}
          <select
            v-model="cfg.groupField"
            data-test="pipeline-group"
            class="field narrow"
          >
            <option value="">
              —
            </option>
            <option
              v-for="f in viewFields.filter(f => !f.numeric)"
              :key="f.name"
              :value="f.name"
            >
              {{ f.name }}
            </option>
          </select>
        </label>
        <label
          v-if="chartType !== 'pie' && chartType !== 'histogram'"
          class="lbl"
        >{{ $t('studio.pipeline.agg') }}
          <select
            v-model="cfg.agg"
            class="field narrow"
          >
            <option value="avg">
              avg
            </option>
            <option value="sum">
              sum
            </option>
            <option value="min">
              min
            </option>
            <option value="max">
              max
            </option>
            <option value="count">
              count
            </option>
          </select>
        </label>
        <label class="lbl">{{ $t('studio.pipeline.chartTitle') }}
          <input
            v-model="cfg.title"
            class="field"
            data-test="pipeline-title"
          >
        </label>
        <label class="lbl">{{ $t('studio.pipeline.refLine') }}
          <input
            v-model="refLineInput"
            class="field tiny"
            data-test="pipeline-refline"
          >
        </label>
      </div>
    </section>

    <!-- Step 4 模板 -->
    <section class="cardBlock">
      <h2><span class="stepNo">4</span>{{ $t('studio.pipeline.s4') }}</h2>
      <div class="row wrap">
        <input
          v-model="templateName"
          class="field"
          data-test="pipeline-template-name"
          :placeholder="$t('studio.pipeline.templateName')"
        >
        <button
          class="pill-btn"
          data-test="pipeline-template-save"
          :disabled="!templateName.trim()"
          @click="saveTemplate"
        >
          {{ $t('studio.pipeline.templateSave') }}
        </button>
        <span
          v-if="templateMsg"
          class="hint"
        >{{ templateMsg }}</span>
      </div>
      <div
        class="row wrap"
        data-test="pipeline-templates"
      >
        <button
          v-for="tp in templates"
          :key="tp.id"
          class="chip tpl"
          data-test="pipeline-template-item"
          :title="`${tp.chartType} · ${tp.description || tp.name}`"
          @click="applyTemplate(tp)"
        >
          {{ tp.name }}<span class="unit"> · {{ tp.chartType }}</span>
          <span
            class="del"
            @click.stop="removeTemplate(tp.id)"
          >×</span>
        </button>
      </div>
    </section>

    <!-- Step 5 绘图与输出 -->
    <section class="cardBlock">
      <h2><span class="stepNo">5</span>{{ $t('studio.pipeline.s5') }}</h2>
      <div class="row wrap">
        <button
          class="pill-btn"
          data-test="pipeline-draw"
          :disabled="!canDraw"
          @click="draw"
        >
          {{ $t('studio.pipeline.draw') }}
        </button>
        <button
          class="pill-btn outline"
          data-test="pipeline-viewer"
          :disabled="!hasDrawn"
          @click="viewerOpen = true"
        >
          {{ $t('studio.pipeline.openViewer') }}
        </button>
        <button
          class="pill-btn outline"
          data-test="pipeline-download"
          :disabled="!hasDrawn"
          @click="downloadPng"
        >
          {{ $t('studio.pipeline.download') }}
        </button>
        <button
          class="pill-btn outline"
          data-test="pipeline-save-chart"
          :disabled="!hasDrawn"
          @click="saveChart"
        >
          {{ $t('studio.pipeline.saveChart') }}
        </button>
        <button
          class="pill-btn outline"
          data-test="pipeline-save-result"
          :disabled="!hasDrawn"
          @click="saveResult"
        >
          {{ $t('studio.pipeline.saveResult') }}
        </button>
        <span
          v-if="saveMsg"
          class="hint"
        >{{ saveMsg }}</span>
        <span
          v-if="saveErr"
          class="err"
          role="alert"
        >{{ saveErr }}</span>
      </div>
      <div
        v-if="hasDrawn"
        class="chartHost"
        data-test="pipeline-chart"
      >
        <ClientOnly>
          <AwChart
            ref="chartRef"
            :option="option"
            :height="380"
          />
        </ClientOnly>
      </div>
    </section>

    <!-- 在线查看器外壳 -->
    <Teleport to="body">
      <div
        v-if="viewerOpen"
        class="viewer"
        data-test="pipeline-viewer-shell"
        @click.self="viewerOpen = false"
      >
        <div class="viewerBody">
          <div class="viewerBar">
            <b>{{ cfg.title || $t('studio.pipeline.chartTitle') }}</b>
            <span class="unit">{{ $t('studio.pipeline.viewerHint') }}</span>
            <button
              class="pill-btn outline"
              data-test="pipeline-viewer-download"
              @click="downloadPng"
            >
              PNG
            </button>
            <button
              class="pill-btn outline"
              data-test="pipeline-viewer-close"
              @click="viewerOpen = false"
            >
              ✕
            </button>
          </div>
          <div class="viewerChart">
            <ClientOnly>
              <AwChart
                :option="viewerOption"
                :height="420"
              />
            </ClientOnly>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch } from '@/app/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'
import { deriveFields, runTransform, buildPipelineOption, type PipelineConfig, type PipelineRow } from '@/app/utils/chart-pipeline'
// echarts 导入链在 dev SSR 摸 document → 必须 client-only 异步组件(静态 import 会在服务端求值)
const AwChart = defineAsyncComponent(() => import('@/app/components/AwChart.vue'))

const { t } = useI18n()

interface LineLite { id: string, name: string }
interface DaqNodeLite { id: string, name: string, unit?: string, lineId?: string }
interface TemplateRow { id: string, name: string, description: string, chartType: string, config: Record<string, unknown> }

const lines = ref<LineLite[]>([])
const nodes = ref<DaqNodeLite[]>([])
const lineId = ref('')
const pickNodes = ref<string[]>([])
const windowMin = ref(60)
const agg = ref<'avg' | 'min' | 'max'>('avg')
const querying = ref(false)

const rawRows = ref<PipelineRow[]>([])
const viewRows = ref<PipelineRow[]>([])
const transformCode = ref('')
const transformError = ref('')
const applied = ref(false)

const chartType = ref<'line' | 'bar' | 'scatter' | 'pie' | 'histogram'>('line')
const cfg = ref<PipelineConfig>({ xField: 'at', yFields: [], groupField: '', agg: 'avg', title: '', yMin: null, yMax: null, refLine: null })
const refLineInput = ref('')
const hasDrawn = ref(false)
const viewerOpen = ref(false)
const chartRef = ref<{ chartResize?: () => void } | null>(null)
const chartInstance = computed(() => (chartRef.value as unknown as { chart?: { getDataURL: (o?: Record<string, unknown>) => string } } | null)?.chart ?? null)

const templates = ref<TemplateRow[]>([])
const templateName = ref('')
const templateMsg = ref('')
const saveMsg = ref('')
const saveErr = ref('')

const option = ref<Record<string, unknown>>({})
const viewerOption = computed(() => ({ ...option.value, toolbox: { feature: { saveAsImage: { pixelRatio: 2 } } } }))

const tableCols = computed(() => deriveFields(viewRows.value).map(f => f.name))
const viewFields = computed(() => deriveFields(viewRows.value))
const canDraw = computed(() => viewRows.value.length > 0 && Boolean(cfg.value.xField) && cfg.value.yFields.filter(Boolean).length > 0)

function toggleNode(id: string): void {
  pickNodes.value = pickNodes.value.includes(id) ? pickNodes.value.filter(x => x !== id) : [...pickNodes.value, id]
}

const importCsv = ref('')

/** CSV/TSV 导入(首行为表头;数值自动转型)——线上拉取之外的第二数据入口 */
function importTable(): void {
  const text = importCsv.value.trim()
  if (!text) return
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return
  const first = lines[0] ?? ''
  const sep = first.includes('\t') ? '\t' : ','
  const header = first.split(sep).map(h => h.trim().replace(/^"|"$/g, ''))
  const out: PipelineRow[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split(sep)
    const row: PipelineRow = {}
    header.forEach((h, i) => {
      const raw = (cells[i] ?? '').trim().replace(/^"|"$/g, '')
      const num = Number(raw)
      row[h] = raw !== '' && Number.isFinite(num) ? num : raw
    })
    out.push(row)
  }
  rawRows.value = out
  viewRows.value = out
  applied.value = false
  hasDrawn.value = false
  transformError.value = ''
  const numeric = deriveFields(out).filter(f => f.numeric && f.name !== 'at')
  cfg.value = { ...cfg.value, xField: header[0] ?? 'at', yFields: numeric.slice(0, 1).map(f => f.name) }
}

async function loadNodes(): Promise<void> {
  pickNodes.value = []
  const r = await apiFetch<{ nodes: DaqNodeLite[] }>({ base: '/api/workshop/daq', retries: 1 })
  nodes.value = (r.nodes ?? []).filter(n => !lineId.value || n.lineId === lineId.value)
}

/** daq/query 的 series 点阵 → 宽表行(at + 每测点一列,列名=测点名) */
function seriesToRows(series: Array<{ nodeId: string, name?: string, points: Array<{ x: number | string, y: number }> }>): PipelineRow[] {
  const keyOf = (s: { nodeId: string, name?: string }) => nodes.value.find(n => n.id === s.nodeId)?.name ?? s.name ?? s.nodeId
  const byAt = new Map<string, PipelineRow>()
  for (const s of series) {
    const key = keyOf(s)
    for (const p of s.points ?? []) {
      const at = new Date(p.x).toISOString()
      const row = byAt.get(at) ?? { at }
      row[key] = p.y
      byAt.set(at, row)
    }
  }
  return [...byAt.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

async function doFetch(): Promise<void> {
  querying.value = true
  transformError.value = ''
  applied.value = false
  hasDrawn.value = false
  saveMsg.value = ''
  saveErr.value = ''
  try {
    const to = Date.now()
    const from = to - windowMin.value * 60_000
    const p = new URLSearchParams()
    p.set('line_id', lineId.value)
    p.set('node_ids', pickNodes.value.join(','))
    p.set('from', String(from))
    p.set('to', String(to))
    p.set('agg', agg.value)
    const r = await apiFetch<{ series: Array<{ nodeId: string, name?: string, points: Array<{ x: number | string, y: number }> }> }>({ base: `/api/workshop/daq/query?${p.toString()}`, retries: 0 })
    rawRows.value = seriesToRows(r.series ?? [])
    viewRows.value = rawRows.value
    if (!cfg.value.yFields.length && viewFields.value.length) {
      const numeric = viewFields.value.filter(f => f.numeric && f.name !== 'at')
      cfg.value = { ...cfg.value, xField: 'at', yFields: numeric.slice(0, 1).map(f => f.name) }
    }
  }
  catch (e) {
    transformError.value = apiErrorMessage(e)
  }
  finally {
    querying.value = false
  }
}

function applyTransform(): void {
  const out = runTransform(rawRows.value, transformCode.value)
  transformError.value = out.error
  if (!out.error) {
    viewRows.value = out.rows
    applied.value = true
    hasDrawn.value = false
  }
}

function resetTransform(): void {
  transformCode.value = ''
  transformError.value = ''
  applied.value = false
  viewRows.value = rawRows.value
}

function draw(): void {
  cfg.value = { ...cfg.value, refLine: refLineInput.value.trim() === '' ? null : Number(refLineInput.value) }
  if (Number.isNaN(cfg.value.refLine as unknown as number)) cfg.value.refLine = null
  option.value = buildPipelineOption(chartType.value, cfg.value, viewRows.value) as unknown as Record<string, unknown>
  hasDrawn.value = true
}

function downloadPng(): void {
  const inst = chartInstance.value
  if (!inst) return
  const url = inst.getDataURL({ pixelRatio: 2, backgroundColor: '#101418' })
  const a = document.createElement('a')
  a.href = url
  a.download = `${cfg.value.title || 'eda-pipeline'}.png`
  a.click()
}

async function saveChart(): Promise<void> {
  saveMsg.value = ''
  saveErr.value = ''
  try {
    await apiFetch({ base: '/api/workshop/eda/charts', init: { method: 'POST', body: JSON.stringify({
      title: cfg.value.title || t('studio.pipeline.chartTitle'),
      viz_type: `pipeline-${chartType.value}`,
      datasource: { line_id: lineId.value, node_ids: pickNodes.value, window_min: windowMin.value, source_agg: agg.value },
      encoding: { ...cfg.value, refLine: cfg.value.refLine ?? null },
      transform: { code: transformCode.value },
      options: { template: currentTemplateId.value || null },
      line_id: lineId.value,
    }) } })
    saveMsg.value = t('studio.pipeline.savedChart')
  }
  catch (e) { saveErr.value = apiErrorMessage(e) }
}

async function saveResult(): Promise<void> {
  saveMsg.value = ''
  saveErr.value = ''
  try {
    const numericCols = viewFields.value.filter(f => f.numeric).map(f => f.name)
    const stats: Record<string, { min: number, max: number, avg: number }> = {}
    for (const col of numericCols) {
      const vals = viewRows.value.map(r => r[col]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (vals.length) stats[col] = { min: Math.min(...vals), max: Math.max(...vals), avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 1e4) / 1e4 }
    }
    await apiFetch({ base: '/api/workshop/analysis', init: { method: 'POST', body: JSON.stringify({
      line_id: lineId.value,
      title: cfg.value.title || t('studio.pipeline.resultTitle'),
      category: 'eda-pipeline',
      summary: t('studio.pipeline.resultSummary', { n: viewRows.value.length, cols: numericCols.length }),
      conclusions: numericCols.map(c => `${c}: min=${stats[c]?.min} max=${stats[c]?.max} avg=${stats[c]?.avg}`),
      report: t('studio.pipeline.resultReport', { type: chartType.value, rows: viewRows.value.length }),
      metrics: { rows: viewRows.value.length, columns: viewFields.value.length, stats },
      context: { pipeline: true, chart_type: chartType.value, config: cfg.value, template_id: currentTemplateId.value || null, transform_code: transformCode.value },
      window_from: new Date(Date.now() - windowMin.value * 60_000).toISOString(),
      window_to: new Date().toISOString(),
    }) } })
    saveMsg.value = t('studio.pipeline.savedResult')
  }
  catch (e) { saveErr.value = apiErrorMessage(e) }
}

const currentTemplateId = ref('')

async function loadTemplates(): Promise<void> {
  const r = await apiFetch<{ templates: TemplateRow[] }>({ base: '/api/workshop/eda/templates', retries: 1 })
  templates.value = r.templates ?? []
}

async function saveTemplate(): Promise<void> {
  templateMsg.value = ''
  try {
    await apiFetch({ base: '/api/workshop/eda/templates', init: { method: 'POST', body: JSON.stringify({
      name: templateName.value.trim(),
      description: `${chartType.value} · x=${cfg.value.xField} · y=${cfg.value.yFields.join(',')}`,
      chart_type: chartType.value,
      config: { ...cfg.value, transform_code: transformCode.value },
    }) } })
    templateName.value = ''
    templateMsg.value = t('studio.pipeline.templateSaved')
    await loadTemplates()
  }
  catch (e) { templateMsg.value = apiErrorMessage(e) }
}

function applyTemplate(tp: TemplateRow): void {
  currentTemplateId.value = tp.id
  chartType.value = (tp.chartType as typeof chartType.value) || 'line'
  const c = { ...(tp.config ?? {}) } as unknown as PipelineConfig & { transform_code?: string }
  cfg.value = {
    xField: c.xField ?? 'at',
    yFields: Array.isArray(c.yFields) ? c.yFields : (c.yFields ? [String(c.yFields)] : []),
    groupField: c.groupField ?? '',
    agg: c.agg ?? 'avg',
    title: c.title ?? '',
    yMin: c.yMin ?? null,
    yMax: c.yMax ?? null,
    refLine: c.refLine ?? null,
  }
  refLineInput.value = cfg.value.refLine == null ? '' : String(cfg.value.refLine)
  if (typeof c.transform_code === 'string') transformCode.value = c.transform_code
  templateMsg.value = t('studio.pipeline.templateApplied', { name: tp.name })
  if (viewRows.value.length && canDraw.value) draw()
}

async function removeTemplate(id: string): Promise<void> {
  await apiFetch({ base: `/api/workshop/eda/templates/${id}`, init: { method: 'DELETE' } })
  if (currentTemplateId.value === id) currentTemplateId.value = ''
  await loadTemplates()
}

onMounted(async () => {
  try {
    const [l, tp] = await Promise.all([
      apiFetch<{ lines: LineLite[] }>({ base: '/api/workshop/dcw/lines', retries: 1 }),
      apiFetch<{ templates: TemplateRow[] }>({ base: '/api/workshop/eda/templates', retries: 1 }),
    ])
    lines.value = l.lines ?? []
    templates.value = tp.templates ?? []
  }
  catch { /* 首屏失败不拖垮页面 */ }
})
</script>

<style scoped>
.page { display: flex; flex-direction: column; gap: 14px; padding-bottom: 40px }
.aw-page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px }
.sub { color: var(--text-dim, #8fa0ad); font-size: 12px; margin-top: 4px }
.cardBlock { background: var(--panel, rgba(255,255,255,.03)); border: 1px solid var(--line, rgba(255,255,255,.08)); border-radius: 12px; padding: 14px 16px }
.cardBlock h2 { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; margin-bottom: 10px }
.stepNo { width: 20px; height: 20px; border-radius: 6px; background: var(--accent, #35e0a0); color: #06121c; font-size: 12px; display: inline-flex; align-items: center; justify-content: center }
.row { display: flex; gap: 8px; align-items: center; margin: 6px 0 }
.row.wrap { flex-wrap: wrap }
.field { background: var(--bg-deep, rgba(0,0,0,.25)); border: 1px solid var(--line, rgba(255,255,255,.1)); border-radius: 8px; color: inherit; padding: 6px 10px; font-size: 12px; min-width: 170px }
.field.narrow { min-width: 110px }
.field.tiny { min-width: 84px }
.lbl { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim, #8fa0ad) }
.chip { border: 1px solid var(--line, rgba(255,255,255,.12)); background: transparent; color: inherit; border-radius: 999px; padding: 3px 12px; font-size: 12px; cursor: pointer }
.chip.on { border-color: var(--accent, #35e0a0); color: var(--accent, #35e0a0) }
.chip.tpl .unit { opacity: .6 }
.chip.tpl .del { margin-left: 6px; opacity: .5 }
.chip.tpl .del:hover { opacity: 1; color: #e57373 }
.unit { opacity: .65; font-size: 11px }
.tableWrap { overflow: auto; max-height: 240px; border: 1px solid var(--line, rgba(255,255,255,.08)); border-radius: 8px }
.grid { border-collapse: collapse; width: 100%; font-size: 12px }
.grid th { text-align: left; position: sticky; top: 0; background: var(--bg-deep, rgba(0,0,0,.4)); padding: 6px 10px; border-bottom: 1px solid var(--line, rgba(255,255,255,.1)) }
.grid td { padding: 4px 10px; border-bottom: 1px solid var(--line, rgba(255,255,255,.05)); white-space: nowrap }
.hint { color: var(--text-dim, #8fa0ad); font-size: 12px }
.err { color: #e57373; font-size: 12px }
.codeRow { display: flex; gap: 12px; align-items: flex-start; margin-top: 8px }
.importRow { display: flex; gap: 8px; align-items: flex-start; margin-top: 8px }
.importRow .import { flex: 1; max-width: 640px }
.code { flex: 1; font-family: ui-monospace, Consolas, monospace; font-size: 12px; background: var(--bg-deep, rgba(0,0,0,.3)); border: 1px solid var(--line, rgba(255,255,255,.1)); border-radius: 8px; color: inherit; padding: 8px 10px; resize: vertical }
.codeSide { display: flex; flex-direction: column; gap: 8px; max-width: 220px }
.chartHost { margin-top: 10px; border: 1px solid var(--line, rgba(255,255,255,.08)); border-radius: 10px; padding: 8px }
.viewer { position: fixed; inset: 0; z-index: 90; background: rgba(4,8,12,.78); display: flex; align-items: center; justify-content: center; padding: 4vh 4vw }
.viewerBody { width: 100%; max-width: 1100px; background: var(--panel, #0e141b); border: 1px solid var(--line, rgba(255,255,255,.12)); border-radius: 14px; overflow: hidden }
.viewerBar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line, rgba(255,255,255,.08)) }
.viewerBar b { font-size: 13px }
.viewerBar .unit { flex: 1 }
.viewerChart { padding: 8px 12px 12px }
</style>
