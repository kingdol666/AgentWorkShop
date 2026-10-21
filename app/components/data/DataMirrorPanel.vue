<template>
  <div class="mirror">
    <!-- 查询条:产线 → 节点多选 → 时间窗 → 聚合 -->
    <div class="card qbar">
      <div class="row">
        <label class="lbl">{{ t('data.line.label') }}</label>
        <select
          v-model="lineId"
          class="input sel"
          data-test="data-line-sel"
          @change="onLineChange"
        >
          <option value="">
            {{ t('data.line.any') }}
          </option>
          <option
            v-for="l in lines"
            :key="l.id"
            :value="l.id"
          >
            {{ l.name }}
          </option>
        </select>
        <label class="lbl">{{ t('data.mirror.window') }}</label>
        <select
          v-model="preset"
          class="input sel"
          data-test="data-preset"
        >
          <option value="15">
            {{ t('data.mirror.last15') }}
          </option>
          <option value="60">
            {{ t('data.mirror.last60') }}
          </option>
          <option value="240">
            {{ t('data.mirror.last240') }}
          </option>
          <option value="custom">
            {{ t('data.mirror.custom') }}
          </option>
        </select>
        <template v-if="preset === 'custom'">
          <input
            v-model="fromText"
            type="datetime-local"
            class="input"
          >
          <input
            v-model="toText"
            type="datetime-local"
            class="input"
          >
        </template>
        <label class="lbl">{{ t('data.mirror.agg') }}</label>
        <select
          v-model="agg"
          class="input sel"
          data-test="data-agg"
        >
          <option value="avg">
            {{ t('data.mirror.aggAvg') }}
          </option>
          <option value="min">
            {{ t('data.mirror.aggMin') }}
          </option>
          <option value="max">
            {{ t('data.mirror.aggMax') }}
          </option>
        </select>
        <label class="chk"><input
          v-model="includeBand"
          type="checkbox"
        >{{ t('data.mirror.band') }}</label>
        <button
          class="pill-btn primary"
          data-test="data-query"
          :disabled="querying"
          @click="doQuery"
        >
          {{ querying ? t('data.mirror.querying') : t('data.mirror.query') }}
        </button>
        <button
          class="pill-btn"
          :disabled="!series.length"
          @click="exportOpen = true"
        >
          {{ t('data.mirror.export') }}
        </button>
      </div>
      <div
        class="row nodes"
        data-test="data-nodes"
      >
        <label class="lbl">{{ t('data.mirror.nodes') }}</label>
        <template
          v-for="g in nodeGroups"
          :key="g.lineId"
        >
          <span
            v-if="nodeGroups.length > 1"
            class="grp"
          >{{ g.lineName }}</span>
          <label
            v-for="n in g.nodes"
            :key="n.id"
            class="chk node-chip"
            :title="n.semantics || n.templateKey"
          >
            <input
              v-model="picked"
              type="checkbox"
              :value="n.id"
            >
            {{ n.name }}<span
              v-if="n.unit"
              class="unit"
            >{{ n.unit }}</span>
          </label>
        </template>
        <span
          v-if="!nodeGroups.length"
          class="empty"
        >{{ t('data.mirror.noNodes') }}</span>
      </div>
      <p
        v-if="runHint.runId"
        class="hint"
      >
        {{ t('data.mirror.runScope', { run: runHint.runId }) }}
      </p>
      <p
        v-if="error"
        class="err"
        data-test="data-error"
      >
        {{ error }}
      </p>
    </div>

    <!-- 多序列图 -->
    <div class="card chartCard">
      <ClientOnly>
        <AwChart
          v-if="chartOption"
          :option="chartOption"
          style="height: 340px; width: 100%"
        />
      </ClientOnly>
      <p
        v-if="!series.length && !querying"
        class="empty big"
      >
        {{ t('data.mirror.empty') }}
      </p>
      <p
        v-if="truncatedNote"
        class="hint"
      >
        {{ truncatedNote }}
      </p>
    </div>

    <!-- 预览表(前 100 行,列=节点) -->
    <div
      v-if="series.length"
      class="card"
    >
      <h3 class="sec">
        {{ t('data.mirror.preview') }}
      </h3>
      <div class="tblWrap">
        <table
          class="tbl"
          data-test="data-preview"
        >
          <thead>
            <tr>
              <th>{{ t('data.mirror.time') }}</th>
              <th
                v-for="s in series"
                :key="s.nodeId"
              >
                {{ s.name }}<span
                  v-if="s.unit"
                  class="unit"
                >({{ s.unit }})</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in previewRows"
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
      <p class="hint">
        {{ t('data.mirror.previewNote', { n: previewRows.length, total: totalPoints }) }}
      </p>
    </div>

    <!-- 导出弹窗 -->
    <div
      v-if="exportOpen"
      class="modalMask"
      @click.self="exportOpen = false"
    >
      <div class="modal">
        <h3 class="sec">
          {{ t('data.mirror.exportTitle', { n: picked.length }) }}
        </h3>
        <label class="lbl">{{ t('data.mirror.exportTitleLabel') }}</label>
        <input
          v-model="exportTitle"
          class="input w"
        >
        <label class="lbl">{{ t('data.mirror.exportNoteLabel') }}</label>
        <input
          v-model="exportNote"
          class="input w"
        >
        <label class="chk"><input
          v-model="exportMerge"
          type="checkbox"
        >{{ t('data.mirror.exportMerge') }}</label>
        <div class="row end">
          <button
            class="pill-btn"
            @click="exportOpen = false"
          >
            {{ t('data.mirror.cancel') }}
          </button>
          <button
            class="pill-btn primary"
            data-test="data-export-go"
            :disabled="exporting"
            @click="doExport"
          >
            {{ exporting ? t('data.mirror.exporting') : t('data.mirror.exportOk') }}
          </button>
        </div>
        <div
          v-if="exportJob"
          class="jobResult"
          data-test="data-export-result"
        >
          <template v-if="exportJob.status === 'ready'">
            <p class="ok">
              {{ t('data.mirror.exportDone', { rows: exportJob.result?.totalRows ?? 0 }) }}
            </p>
            <p>
              <a :href="fileUrl('manifest.json')">{{ t('data.mirror.manifest') }}</a>
              <a
                v-if="exportJob.result?.mergedFile"
                :href="fileUrl('merged.csv')"
              >merged.csv</a>
              <a
                v-for="f in exportJob.result?.files ?? []"
                :key="f.nodeId"
                :href="fileUrl(`nodes/${f.nodeId}.csv`)"
              >{{ f.nodeId }}.csv</a>
            </p>
          </template>
          <p
            v-else-if="exportJob.status === 'failed'"
            class="err"
          >
            {{ exportJob.error }}
          </p>
          <p
            v-else
            class="hint"
          >
            {{ t('data.mirror.exportRunning') }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 数据管理台 · 镜像数据面板(plan1 M1):
 * 产线/节点多选 + 时间窗 + 聚合 → /daq/query 批量查询(服务端桶聚合) → 多序列图 +
 * 预览表 → 自定义导出(异步任务,产物 manifest/nodes/merged 下载)。
 * 护栏在服务端(节点≤8/每节点≤2000 点/窗≤7 天/并发≤2),前端只做引导。
 */
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '@/app/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'

interface DaqNodeLite { id: string, name: string, unit: string, lineId: string, templateKey: string, semantics?: string, enabled?: number }
interface LineLite { id: string, name: string }
interface Series { nodeId: string, name: string, unit: string, points: Array<{ at: number, v: number }>, band?: Array<{ at: number, lo: number, hi: number }>, truncated?: boolean }
interface QueryResp { series: Series[], window: { fromMs: number, toMs: number, bucketMs: number, agg: string }, activeRun?: { runId?: string } }
interface ExportJob { id: string, status: 'running' | 'ready' | 'failed', error?: string, result?: { totalRows?: number, files?: Array<{ nodeId: string, rows: number }>, mergedFile?: string, dir?: string } }

const { t } = useI18n()
const lines = ref<LineLite[]>([])
const allNodes = ref<DaqNodeLite[]>([])
const lineId = ref('')
const picked = ref<string[]>([])
const preset = ref('60')
const fromText = ref('')
const toText = ref('')
const agg = ref<'avg' | 'min' | 'max'>('avg')
const includeBand = ref(false)
const querying = ref(false)
const error = ref('')
const series = ref<Series[]>([])
const windowInfo = ref<QueryResp['window'] | null>(null)
const runHint = ref<{ runId?: string }>({})
const exportOpen = ref(false)
const exporting = ref(false)
const exportTitle = ref('')
const exportNote = ref('')
const exportMerge = ref(false)
const exportJob = ref<ExportJob | null>(null)

const nodeGroups = computed(() => {
  const visible = allNodes.value.filter(n => !lineId.value || n.lineId === lineId.value)
  const byLine = new Map<string, DaqNodeLite[]>()
  for (const n of visible) {
    const list = byLine.get(n.lineId) ?? []
    list.push(n)
    byLine.set(n.lineId, list)
  }
  return [...byLine.entries()].map(([lid, nodes]) => ({ lineId: lid, lineName: lines.value.find(l => l.id === lid)?.name ?? lid, nodes }))
})

const truncatedNote = computed(() => {
  const t = series.value.filter(s => s.truncated)
  return t.length ? t('data.mirror.truncated', { n: t.length }) : ''
})

const totalPoints = computed(() => series.value.reduce((a, s) => a + s.points.length, 0))

const previewRows = computed(() => {
  const ats = new Set<number>()
  for (const s of series.value) for (const p of s.points) ats.add(p.at)
  const sorted = [...ats].sort((a, b) => b - a).slice(0, 100)
  return sorted.map((at) => {
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
  // 双轴:按单位分组,第一组左轴、第二组右轴(更多单位提示用同色系分组仍可读)
  const units: string[] = []
  for (const s of series.value) if (s.unit && !units.includes(s.unit)) units.push(s.unit)
  const axisOf = (u: string) => Math.min(units.indexOf(u), 1)
  const palette = ['#4a6b57', '#8aa07c', '#c9a26a', '#b3714f', '#6f8296', '#4e4e4e', '#7d6b8a', '#5d7d7b']
  const yAxes = [0, 1].slice(0, Math.max(1, Math.min(units.length, 2))).map(i => ({
    type: 'value' as const,
    name: units[i] ?? '',
    scale: true,
  }))
  const legend: string[] = []
  const chartSeries: Record<string, unknown>[] = []
  series.value.forEach((s, i) => {
    legend.push(s.name)
    const base: Record<string, unknown> = {
      name: s.name,
      type: 'line',
      yAxisIndex: axisOf(s.unit),
      showSymbol: false,
      data: s.points.map(p => [p.at, p.v]),
      color: palette[i % palette.length],
    }
    chartSeries.push(base)
    if (s.band) {
      chartSeries.push({
        name: `${s.name}±`,
        type: 'line',
        yAxisIndex: axisOf(s.unit),
        showSymbol: false,
        lineStyle: { opacity: 0.25 },
        data: s.band.map(b => [b.at, b.hi]),
        color: palette[i % palette.length],
        stack: `band-${i}`,
        tooltip: { show: false },
      })
      chartSeries.push({
        name: `${s.name}±_lo`,
        type: 'line',
        yAxisIndex: axisOf(s.unit),
        showSymbol: false,
        lineStyle: { opacity: 0 },
        areaStyle: { color: palette[i % palette.length], opacity: 0.12 },
        data: s.band.map(b => [b.at, b.lo]),
        color: palette[i % palette.length],
        stack: `band-${i}`,
        tooltip: { show: false },
      })
    }
  })
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: legend, type: 'scroll' },
    grid: { left: 56, right: units.length > 1 ? 56 : 24, top: 36, bottom: 48 },
    xAxis: { type: 'time' },
    yAxis: yAxes,
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
    series: chartSeries,
  }
})

function fileUrl(rel: string): string {
  return `/api/workshop/daq/export-file?job=${encodeURIComponent(exportJob.value?.id ?? '')}&path=${encodeURIComponent(rel)}`
}

function windowMs(): { fromMs: number, toMs: number } {
  const to = Date.now()
  if (preset.value === 'custom') {
    return {
      fromMs: fromText.value ? Date.parse(fromText.value) : to - 3600_000,
      toMs: toText.value ? Date.parse(toText.value) : to,
    }
  }
  const minutes = Number(preset.value) || 60
  return { fromMs: to - minutes * 60_000, toMs: to }
}

function onLineChange(): void {
  const visible = nodeGroups.value.flatMap(g => g.nodes.map(n => n.id))
  picked.value = picked.value.filter(id => visible.includes(id)).slice(0, 8)
}

async function doQuery(): Promise<void> {
  querying.value = true
  error.value = ''
  try {
    const { fromMs, toMs } = windowMs()
    const p = new URLSearchParams()
    if (lineId.value) p.set('line_id', lineId.value)
    if (picked.value.length) p.set('node_ids', picked.value.join(','))
    p.set('from', String(Math.round(fromMs)))
    p.set('to', String(Math.round(toMs)))
    p.set('agg', agg.value)
    if (includeBand.value) p.set('include_band', '1')
    const r = await apiFetch<QueryResp>({ base: '/api/workshop/daq/query', init: undefined, path: `?${p.toString()}`, retries: 0 })
    series.value = r.series ?? []
    windowInfo.value = r.window ?? null
    runHint.value = r.activeRun ?? {}
  }
  catch (e) {
    error.value = apiErrorMessage(e)
    series.value = []
  }
  finally {
    querying.value = false
  }
}

async function doExport(): Promise<void> {
  exporting.value = true
  exportJob.value = null
  try {
    const { fromMs, toMs } = windowMs()
    const r = await apiFetch<{ job: ExportJob }>({
      base: '/api/workshop/daq/export',
      init: {
        method: 'POST',
        body: JSON.stringify({
          line_id: lineId.value || undefined,
          node_ids: picked.value.length ? picked.value : undefined,
          from: Math.round(fromMs),
          to: Math.round(toMs),
          title: exportTitle.value || undefined,
          note: exportNote.value || undefined,
          merge: exportMerge.value,
        }),
      },
    })
    exportJob.value = r.job
    // 轮询任务至终态(并发=1 队列,大导出可能排队;上限 5 分钟)
    for (let i = 0; i < 150 && exportJob.value?.status === 'running'; i++) {
      await new Promise(res => setTimeout(res, 2000))
      const d = await apiFetch<{ job: ExportJob }>({ base: `/api/workshop/daq/export/${exportJob.value.id}` })
      exportJob.value = d.job
    }
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
  finally {
    exporting.value = false
  }
}

onMounted(async () => {
  try {
    const [daq, dcwLines] = await Promise.all([
      apiFetch<{ nodes: DaqNodeLite[] }>({ base: '/api/workshop/daq', retries: 1 }),
      apiFetch<{ lines: LineLite[] }>({ base: '/api/workshop/dcw/lines', retries: 1 }),
    ])
    allNodes.value = daq.nodes ?? []
    lines.value = dcwLines.lines ?? []
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
})
</script>

<style scoped>
.mirror { display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--panel, var(--bg-soft, #fff)); border: 1px solid var(--border, rgba(127, 127, 127, 0.25)); border-radius: 10px; padding: 12px 14px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row.end { justify-content: flex-end; margin-top: 10px; }
.row.nodes { margin-top: 8px; row-gap: 4px; }
.lbl { font-size: 12px; color: var(--ink-soft, #666); white-space: nowrap; }
.sel { min-width: 120px; }
.input { border: 1px solid var(--border, rgba(127,127,127,.35)); border-radius: 6px; padding: 4px 8px; background: transparent; color: var(--ink, #222); font-size: 12px; }
.input.w { width: 100%; margin-bottom: 6px; }
.chk { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--ink, #222); cursor: pointer; }
.node-chip { border: 1px solid var(--border, rgba(127,127,127,.3)); border-radius: 999px; padding: 2px 10px; }
.node-chip input { accent-color: #4a6b57; }
.unit { color: var(--ink-faint, #999); margin-left: 2px; }
.grp { font-size: 12px; font-weight: 600; color: var(--ink-soft, #555); margin-left: 6px; }
.empty { color: var(--ink-faint, #999); font-size: 12px; }
.empty.big { text-align: center; padding: 48px 0; }
.hint { font-size: 12px; color: var(--ink-faint, #888); margin: 6px 0 0; }
.err { font-size: 12px; color: #b3403a; margin: 6px 0 0; white-space: pre-wrap; }
.ok { font-size: 12px; color: #3f7d54; }
.sec { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
.mono { font-variant-numeric: tabular-nums; font-size: 12px; }
.tblWrap { max-height: 300px; overflow: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th, .tbl td { border-bottom: 1px solid var(--border, rgba(127,127,127,.18)); padding: 3px 8px; text-align: left; white-space: nowrap; }
.modalMask { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: var(--panel, #fff); color: var(--ink, #222); border-radius: 12px; padding: 16px 18px; width: min(520px, 92vw); }
.jobResult { margin-top: 10px; border-top: 1px dashed var(--border, rgba(127,127,127,.3)); padding-top: 8px; }
.jobResult a { margin-right: 10px; font-size: 12px; }
</style>
