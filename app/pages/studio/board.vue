<template>
  <div class="page">
    <header class="head">
      <h1 class="title">
        {{ $t('board.title') }}
      </h1>
      <NuxtLink
        to="/studio"
        class="back"
      >{{ $t('board.backToStudio') }}</NuxtLink>
    </header>

    <div class="row">
      <select
        v-model="boardId"
        class="input sel"
        data-test="board-sel"
      >
        <option value="">
          {{ $t('board.pick') }}
        </option>
        <option
          v-for="b in boards"
          :key="b.id"
          :value="b.id"
        >
          {{ b.title }}
        </option>
      </select>
      <button
        class="pill-btn"
        @click="load"
      >
        {{ $t('data.ledger.refresh') }}
      </button>
      <span class="grow" />
      <label class="lbl">{{ $t('board.windowOverride') }}</label>
      <select
        v-model="windowPreset"
        class="input sel"
        data-test="board-window"
      >
        <option value="">
          {{ $t('board.keepChart') }}
        </option>
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
    </div>

    <!-- 建板:勾选我的图表 → 自动流式布局 -->
    <div
      v-if="!boardId"
      class="card"
    >
      <h3 class="sec">
        {{ $t('board.create') }}
      </h3>
      <div class="row">
        <input
          v-model="newTitle"
          class="input w"
          :placeholder="$t('board.boardTitle')"
        >
        <select
          v-model="newVis"
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
          data-test="board-create"
          :disabled="!newTitle.trim() || !pickedCharts.length"
          @click="createBoard"
        >
          {{ $t('board.createBtn', { n: pickedCharts.length }) }}
        </button>
      </div>
      <div class="row">
        <label
          v-for="ch in charts"
          :key="ch.id"
          class="chk"
        >
          <input
            v-model="pickedCharts"
            type="checkbox"
            :value="ch.id"
          > {{ ch.title }}
        </label>
        <p
          v-if="!charts.length"
          class="empty"
        >
          {{ $t('studio.noCharts') }}
        </p>
      </div>
    </div>

    <!-- 看板画布:12 栅格 + 逐卡查询(全局时间覆盖) -->
    <div
      v-if="detail"
      class="grid"
      data-test="board-grid"
    >
      <div
        v-for="item in detail.charts"
        :key="item.gridPos?.chartId ?? Math.random()"
        class="cell"
        :style="{ gridColumn: `${(item.gridPos?.x ?? 0) + 1} / span ${item.gridPos?.w ?? 4}`, gridRow: `${(item.gridPos?.y ?? 0) + 1} / span ${item.gridPos?.h ?? 3}` }"
      >
        <div class="cellHead">
          <span class="cTitle">{{ item.chart?.title ?? (item.inaccessible ? $t('board.inaccessible') : '?') }}</span>
          <button
            class="mini"
            @click="move(item.gridPos!, -1, 0)"
          >
            ←
          </button>
          <button
            class="mini"
            @click="move(item.gridPos!, 1, 0)"
          >
            →
          </button>
          <button
            class="mini"
            @click="move(item.gridPos!, 0, -1)"
          >
            ↑
          </button>
          <button
            class="mini"
            @click="move(item.gridPos!, 0, 1)"
          >
            ↓
          </button>
          <button
            class="mini"
            @click="resize(item.gridPos!, -1)"
          >
            －
          </button>
          <button
            class="mini"
            @click="resize(item.gridPos!, 1)"
          >
            ＋
          </button>
        </div>
        <div class="cellChart">
          <ClientOnly>
            <AwChart
              v-if="item.chart && !item.inaccessible"
              :key="cardKey(item)"
              :option="cardOption(item)"
              :height="Math.max(240, (item.gridPos?.h ?? 3) * 60)"
              style="width: 100%"
            />
          </ClientOnly>
        </div>
        <p
          v-if="item.inaccessible"
          class="empty"
        >
          {{ $t('board.noReadChart') }}
        </p>
      </div>
    </div>

    <div
      v-if="detail"
      class="row end"
    >
      <button
        class="pill-btn primary"
        data-test="board-save"
        @click="saveLayout"
      >
        {{ $t('board.saveLayout') }}
      </button>
    </div>
    <p
      v-if="msg"
      class="hint"
    >
      {{ msg }}
    </p>
    <p
      v-if="error"
      class="err"
    >
      {{ error }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * EDA 看板(plan1 M3):12 栅格 gridPos + 逐卡查询 + 全局时间范围覆盖。
 * 布局编辑 = 移动箭头 + 宽度增减(评审 M2 建议的最小实现;自由指针拖拽后续增强)。
 * 内嵌图表按 B4 逐个判定,不可见卡显式标示(旁路防护可见化)。
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { EChartsOption } from 'echarts'
import { apiFetch } from '@/app/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'
import { buildTrendOption, type TrendRefLine, type TrendSeries, type TrendYEntry } from '@/app/utils/chart-trend'
import { buildPipelineOption, type PipelineConfig, type PipelineRow } from '@/app/utils/chart-pipeline'

interface GridPos { chartId: string, x: number, y: number, w: number, h: number }
interface ChartRow {
  id: string
  title: string
  vizType: string
  version: number
  datasource: { lineId?: string, nodeIds?: string[], runId?: string | null, preset?: string, agg?: string }
  encoding?: { y?: TrendYEntry[], refLines?: TrendRefLine[], golden?: string[] }
  options?: { pipeline?: { chartType?: string, cfg?: PipelineConfig, rows?: PipelineRow[] } }
}
interface BoardDetail {
  dashboard: { id: string, title: string, layout: GridPos[], filters: Record<string, unknown>, version: number }
  charts: Array<{ chart: ChartRow | null, gridPos: GridPos | null, inaccessible: boolean }>
}

const { t } = useI18n()
const boards = ref<Array<{ id: string, title: string }>>([])
const charts = ref<ChartRow[]>([])
const boardId = ref('')
const detail = ref<BoardDetail | null>(null)
const pickedCharts = ref<string[]>([])
const newTitle = ref('')
const newVis = ref<'private' | 'line'>('private')
const windowPreset = ref('')
const msg = ref('')
const error = ref('')

const EMPTY_OPTION: EChartsOption = {}
const cardOption = (item: BoardDetail['charts'][number]): EChartsOption => {
  const ch = item.chart
  if (!ch) return EMPTY_OPTION
  return cardOptions.value.get(ch.id) ?? EMPTY_OPTION
}

const cardKey = (item: BoardDetail['charts'][number]): string => {
  const id = item.chart?.id ?? 'none'
  return `${id}-${item.chart?.version ?? 0}-${cardOptions.value.has(id) ? 'ready' : 'pending'}-${item.chart?.options?.pipeline ? 'p' : 'q'}`
}

const cardOptions = computed(() => {
  const out = new Map<string, EChartsOption>()
  for (const [, opt] of optionsStore.value) out.set(opt.chartId, opt.option)
  return out
})
/** 逐卡 option 缓存(拉数后填充);shallowRef —— ref 的深度 UnwrapRef 会把 EChartsOption 解构坏 */
const optionsStore = shallowRef(new Map<string, { chartId: string, option: EChartsOption }>())

async function load(): Promise<void> {
  try {
    const [b, c] = await Promise.all([
      apiFetch<{ dashboards: Array<{ id: string, title: string }> }>({ base: '/api/workshop/eda/dashboards', retries: 1 }),
      apiFetch<{ charts: ChartRow[] }>({ base: '/api/workshop/eda/charts?mine=1', retries: 1 }),
    ])
    boards.value = b.dashboards ?? []
    charts.value = c.charts ?? []
    if (boardId.value) await openBoard(boardId.value)
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

async function openBoard(id: string): Promise<void> {
  boardId.value = id
  const r = await apiFetch<BoardDetail>({ base: `/api/workshop/eda/dashboards/${id}` })
  detail.value = r
  await Promise.all((r.charts ?? []).filter(x => x.chart).map(x => queryCard(x.chart!)))
}

async function queryCard(ch: ChartRow): Promise<void> {
  const snap = ch.options?.pipeline
  if (ch.vizType === 'pipeline' && snap?.rows?.length) {
    optionsStore.value.set(ch.id, {
      chartId: ch.id,
      option: buildPipelineOption((snap.chartType ?? 'line') as never, (snap.cfg ?? {}) as PipelineConfig, snap.rows),
    })
    optionsStore.value = new Map(optionsStore.value)
    return
  }
  const ds = ch.datasource ?? {}
  const to = Date.now()
  const minutes = windowPreset.value ? Number(windowPreset.value) : (Number(ds.preset) || 60)
  const from = to - minutes * 60_000
  try {
    const p = new URLSearchParams()
    if (ds.lineId) p.set('line_id', ds.lineId)
    p.set('node_ids', (ds.nodeIds ?? []).join(','))
    p.set('from', String(from))
    p.set('to', String(to))
    p.set('agg', ds.agg ?? 'avg')
    // F2:保存图表携带的 run 维度必须随行 —— 按批次建的图在看板只含该批样本
    if (ds.runId) p.set('run_id', ds.runId)
    const r = await apiFetch<{ series: TrendSeries[] }>({ base: `/api/workshop/daq/query?${p.toString()}`, retries: 0 })
    // F2/F3:与 /studio 共用同一 trend option 构建器(双轴按单位、紧凑防重叠)
    const option = buildTrendOption({
      series: r.series ?? [],
      refLines: ch.encoding?.refLines ?? [],
      compact: true,
    })
    optionsStore.value.set(ch.id, { chartId: ch.id, option })
    optionsStore.value = new Map(optionsStore.value)
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

async function createBoard(): Promise<void> {
  try {
    const layout = pickedCharts.value.map((chartId, i) => ({ chartId, x: (i * 4) % 12, y: Math.floor((i * 4) / 12) * 3, w: 4, h: 3 }))
    const r = await apiFetch<{ dashboard: { id: string } }>({
      base: '/api/workshop/eda/dashboards',
      init: { method: 'POST', body: JSON.stringify({ title: newTitle.value.trim(), layout, visibility: newVis.value }) },
    })
    newTitle.value = ''
    pickedCharts.value = []
    await load()
    await openBoard(r.dashboard.id)
    msg.value = t('board.created')
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

function move(pos: GridPos, dx: number, dy: number): void {
  pos.x = Math.min(Math.max(pos.x + dx, 0), 11)
  pos.y = Math.max(pos.y + dy, 0)
}

function resize(pos: GridPos, dw: number): void {
  pos.w = Math.min(Math.max(pos.w + dw, 1), 12)
}

async function saveLayout(): Promise<void> {
  if (!detail.value) return
  try {
    await apiFetch({ base: `/api/workshop/eda/dashboards/${detail.value.dashboard.id}`, init: { method: 'PATCH', body: JSON.stringify({ layout: detail.value.dashboard.layout }) } })
    msg.value = t('board.layoutSaved')
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

onMounted(load)

// 选中看板即加载(v-model 只改 id;不 watch 的话下拉选择后永不加载详情 —— 实机演示发现)
watch(boardId, (id) => {
  if (id) void openBoard(id)
})

// M3 全局时间覆盖:变更即驱动全部 panel 重查(plan 验收"筛选器/时间范围驱动多 panel")
watch(windowPreset, () => {
  if (!detail.value) return
  for (const item of detail.value.charts) {
    if (item.chart) void queryCard(item.chart)
  }
})
</script>

<style scoped>
.page { display: flex; flex-direction: column; gap: 10px; padding: 16px 20px; }
.head { display: flex; justify-content: space-between; align-items: baseline; }
.title { font-size: 18px; font-weight: 700; margin: 0; }
.back { font-size: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row.end { justify-content: flex-end; }
.grow { flex: 1; }
.card { background: var(--panel, #fff); border: 1px solid var(--border, rgba(127,127,127,.25)); border-radius: 10px; padding: 10px 12px; }
.sec { font-size: 12px; font-weight: 700; margin: 0 0 8px; }
.lbl { font-size: 12px; color: var(--ink-soft, #666); }
.input { border: 1px solid var(--border, rgba(127,127,127,.35)); border-radius: 6px; padding: 4px 8px; background: transparent; color: var(--ink, #222); font-size: 12px; }
.input.w { min-width: 240px; }
.sel { max-width: 160px; }
.chk { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; border: 1px solid var(--border, rgba(127,127,127,.3)); border-radius: 999px; padding: 2px 10px; cursor: pointer; }
.grid { display: grid; grid-template-columns: repeat(12, 1fr); grid-auto-rows: minmax(220px, auto); gap: 8px; }
.cell { background: var(--panel, #fff); border: 1px solid var(--border, rgba(127,127,127,.25)); border-radius: 10px; padding: 8px; min-height: 200px; display: flex; flex-direction: column; }
.cellChart { flex: 1; min-height: 120px; }
.cellHead { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; }
.cTitle { font-size: 12px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mini { border: 1px solid var(--border, rgba(127,127,127,.35)); background: transparent; border-radius: 4px; font-size: 10px; padding: 0 5px; cursor: pointer; }
.empty { color: var(--ink-faint, #999); font-size: 12px; }
.hint { font-size: 12px; color: var(--ink-faint, #888); }
.err { font-size: 12px; color: #b3403a; white-space: pre-wrap; }
</style>
