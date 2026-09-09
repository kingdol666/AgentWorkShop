<script setup lang="ts">
/**
 * AML 自动建模平台 —— 单页五区:概览条 / 数据集快照 / 训练作业 / 实验排行榜 / 模型注册表 + 预测控制台。
 * REST 快照(GET /api/workshop/aml/*)+ WS 实时帧(useAmlStream 经 townBus)双通道;
 * 训练判定以平台门禁为准,页面只做诚实的状态呈现与人工晋升/取消/重试入口。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useAmlStream } from '@/app/composables/workshop/useAmlStream'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useVisibleInterval } from '@/app/composables/workshop/useVisibleInterval'
import { apiFetch } from '@/app/composables/workshop/apiClient'

const { t: tt } = useI18n()

definePageMeta({ layout: 'default' })
useHead({ title: () => tt('aml.k1amlx160') })

/** 统一客户端:信封 {code,message,data} 解析取 .data(与 daq 页请求写法同源) */
function api<T>(path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>({ base: '/api/workshop/aml', path, init })
}

// ---------- 类型(对齐 server/services/workshop/aml 行投影) ----------

interface AmlRuntimeStatus {
  python: { ok: boolean, version?: string, reason?: string }
  venvReady: boolean
  queued: number
  running: number
}
interface AmlOverview {
  runtime: AmlRuntimeStatus
  counts: { datasets: number, models: number, productions: number }
}
interface AmlDatasetRow {
  id: string
  lineId: string
  productId: string
  recipeId: string
  runIds: string[]
  rowCount: number
  createdBy: string
  createdByKind: string
  note: string
  createdAt: string
}
interface SeriesSummary {
  nodeId: string
  role: string
  count: number
  mean: number
  std: number
  min: number
  max: number
  missingRatio: number
  cleanedRatio: number
}
interface LagEstimate { controlId: string, targetId: string, lagSteps: number, corr: number }
interface AmlDatasetReport {
  builtAt: string
  nodeSummaries: SeriesSummary[]
  lagEstimates: LagEstimate[]
  runProfiles: RunProfile[]
  cleaning: Record<string, { total: number, droppedState: number, droppedRange: number, droppedHampel: number, interpolated: number, missingRatio: number }>
  runsUsed: string[]
  runsDropped: { runId: string, reason: string }[]
  windowCount: { train: number, val: number, test: number }
}
interface PlatformMetrics {
  oneStepVal?: { windows: number, nrmse: number } | null
  oneStepTest?: { windows: number, nrmse: number } | null
  rolloutTest?: { windows: number, nrmse: number, horizon: number } | null
}
interface AmlJobRow {
  id: string
  datasetId: string
  purpose: string
  status: string
  stage: string
  progress: number
  metricsJson: string | null
  error: string | null
  retryCount: number
  createdAt: string
  startedAt: string | null
  endedAt: string | null
}
interface GateCheck { id: string, name: string, value: number | null, threshold: number | null, pass: boolean, detail: string }
interface GateReport { passed: boolean, checks: GateCheck[] }
interface AmlExperiment {
  id: string
  jobId: string
  datasetId: string
  parentExperimentId: string | null
  changeNote: string
  metrics: PlatformMetrics | null
  gates: GateReport | null
  status: string
  createdAt: string
}
type AmlModelStage = 'candidate' | 'shadow' | 'production' | 'retired'
interface IoSpec {
  purpose: string
  historySteps: number
  horizonSteps: number
  allNodes: string[]
  controlNodes: string[]
  targetNodes: string[]
  beatMs: number
  assumptions: string
}
interface AmlModelRow {
  id: string
  experimentId: string
  datasetId: string
  productId: string
  recipeId: string
  purpose: string
  stage: AmlModelStage
  ioSpec: IoSpec | null
  metrics: PlatformMetrics | null
  note: string
  createdAt: string
}
interface PredictResult {
  modelId: string
  stage: string
  targetNodes: string[]
  forecast: number[][]
  beatMs: number
  assumptions: string
}

// ---------- WS 实时流(aml.job / aml.dataset / aml.model 帧;连接层即注册 scene peer) ----------

const aml = useAmlStream()
const ws = useWorkshopWs()
let unsubFeed: (() => void) | null = null
let logTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  ws.ensureConnected()
  unsubFeed = aml.ensure()
  void loadOverview()
  void loadDatasets()
  void loadJobs()
  void loadModels()
  // 低频兜底轮询(WS 直推收敛状态,轮询只兜丢帧):可见性调度,后台自动降频
  useVisibleInterval(() => {
    void loadOverview()
    void loadJobs()
  }, 8000, { bgMs: 30000 })
  // 展开中的活跃作业:日志尾随 5s 轮询
  logTimer = setInterval(() => {
    const id = expandedJob.value
    if (!id || document.hidden) return
    const j = jobRows.value.find(x => x.id === id)
    if (j && isActiveStatus(j.status)) void refreshJobLogs(id)
  }, 5000)
})
onBeforeUnmount(() => {
  unsubFeed?.()
  if (logTimer) clearInterval(logTimer)
})

// 作业终态帧 → 立即收敛列表(不等轮询拍);模型晋升帧 → 注册表即时刷新
watch(() => aml.lastJob.value, (f) => {
  if (f && isTerminalStatus(f.status)) void loadJobs()
})
watch(() => aml.lastModel.value, () => {
  void loadModels()
})
watch(() => aml.lastDataset.value, () => {
  void loadDatasets()
})

// ---------- 通用小工具 ----------

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '--'
  const d = new Date(iso)
  return Number.isFinite(d.getTime())
    ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : '--'
}
function fmtNum(v: number | null | undefined, digits = 4): string {
  return v == null || !Number.isFinite(v) ? '--' : String(Number(v.toFixed(digits)))
}
function fmtPct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? '--' : `${(v * 100).toFixed(digits)}%`
}
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id
}
function isActiveStatus(s: string): boolean {
  return s === 'queued' || s === 'provisioning' || s === 'training' || s === 'evaluating'
}
function isTerminalStatus(s: string): boolean {
  return s === 'done' || s === 'failed' || s === 'cancelled' || s === 'timeout' || s === 'interrupted'
}
function canRetry(s: string): boolean {
  return s === 'failed' || s === 'timeout' || s === 'interrupted'
}
function statusLabel(s: string): string {
  const m: Record<string, string> = {
    queued: 'aml.k1amlx100', provisioning: 'aml.k1amlx101', training: 'aml.k1amlx102',
    evaluating: 'aml.k1amlx103', done: 'aml.k1amlx104', failed: 'aml.k1amlx105',
    cancelled: 'aml.k1amlx106', timeout: 'aml.k1amlx107', interrupted: 'aml.k1amlx108',
  }
  return m[s] ? tt(m[s]) : s
}
function expStatusLabel(s: string): string {
  const m: Record<string, string> = { running: 'aml.k1amlx119', gates_passed: 'aml.k1amlx080', gates_failed: 'aml.k1amlx081', failed: 'aml.k1amlx105' }
  return m[s] ? tt(m[s]) : s
}

// ---------- 1. 概览条 ----------

const overview = ref<AmlOverview | null>(null)
const overviewError = ref('')

async function loadOverview(): Promise<void> {
  try {
    overview.value = await api<AmlOverview>('')
    overviewError.value = ''
  }
  catch (err) {
    overviewError.value = apiErrorMessage(err)
  }
}

const pythonText = computed(() => {
  const rt = overview.value?.runtime
  if (!rt) return '--'
  return rt.python.ok ? (rt.python.version ?? tt('aml.k1amlx004')) : tt('aml.k1amlx005')
})
const venvText = computed(() =>
  overview.value ? (overview.value.runtime.venvReady ? tt('aml.k1amlx007') : tt('aml.k1amlx008')) : '--')

function reloadAll(): void {
  void loadOverview()
  void loadDatasets()
  void loadJobs()
  void loadModels()
}

// ---------- 2. 数据集快照 ----------

const datasets = ref<AmlDatasetRow[]>([])
const expandedDs = ref('')

async function loadDatasets(): Promise<void> {
  try {
    const data = await api<{ datasets: AmlDatasetRow[] }>('/datasets')
    datasets.value = data.datasets
  }
  catch { /* 概览条已呈现错误,列表静默保持旧值 */ }
}

interface DsDetail { loading: boolean, error: string, report: AmlDatasetReport | null }
const dsDetails = reactive<Record<string, DsDetail>>({})

async function toggleDs(id: string): Promise<void> {
  expandedDs.value = expandedDs.value === id ? '' : id
  if (expandedDs.value && !dsDetails[id]) {
    dsDetails[id] = { loading: true, error: '', report: null }
    try {
      const data = await api<{ dataset: AmlDatasetRow, report: AmlDatasetReport | null }>(`/datasets/${id}`)
      dsDetails[id] = { loading: false, error: '', report: data.report }
    }
    catch (err) {
      dsDetails[id] = { loading: false, error: apiErrorMessage(err), report: null }
    }
  }
}

// 新建数据集表单(spec 与 server/services/workshop/aml/spec.ts 的 zod 模式对齐)
const dsFormOpen = ref(false)
const dsSaving = ref(false)
const dsFormError = ref('')
const dsForm = reactive({
  lineId: '',
  productId: '',
  recipeId: '',
  beatMs: 5000,
  historySteps: 60,
  horizonSteps: 30,
  valRatio: 0.15,
  testRatio: 0.15,
  seed: 7,
  purpose: 'mpc_surrogate',
  note: '',
})
const dsNodes = reactive<Array<{ nodeId: string, role: 'control' | 'feature' | 'target' }>>([
  { nodeId: '', role: 'control' },
  { nodeId: '', role: 'target' },
])

function openDsForm(): void {
  dsFormError.value = ''
  dsFormOpen.value = true
}
function addDsNode(): void {
  dsNodes.push({ nodeId: '', role: 'feature' })
}
function removeDsNode(i: number): void {
  dsNodes.splice(i, 1)
}

async function submitDsForm(): Promise<void> {
  dsFormError.value = ''
  const nodes = dsNodes.filter(n => n.nodeId.trim()).map(n => ({ nodeId: n.nodeId.trim(), role: n.role }))
  if (!dsForm.lineId.trim() || !dsForm.productId.trim() || !dsForm.recipeId.trim()) {
    dsFormError.value = tt('aml.k1amlx161')
    return
  }
  if (nodes.length < 2 || !nodes.some(n => n.role === 'target')) {
    dsFormError.value = tt('aml.k1amlx054')
    return
  }
  dsSaving.value = true
  try {
    const data = await api<{ dataset: AmlDatasetRow, report: AmlDatasetReport | null }>('/datasets', {
      method: 'POST',
      body: JSON.stringify({
        lineId: dsForm.lineId.trim(),
        productId: dsForm.productId.trim(),
        recipeId: dsForm.recipeId.trim(),
        nodes,
        beatMs: Number(dsForm.beatMs),
        window: { historySteps: Number(dsForm.historySteps), horizonSteps: Number(dsForm.horizonSteps) },
        split: { valRatio: Number(dsForm.valRatio), testRatio: Number(dsForm.testRatio), seed: Number(dsForm.seed) },
        purpose: dsForm.purpose,
        note: dsForm.note.trim() || undefined,
      }),
    })
    message.success(tt('aml.k1amlx073', { p0: shortId(data.dataset.id), p1: data.dataset.rowCount }))
    dsFormOpen.value = false
    await loadDatasets()
  }
  catch (err) {
    dsFormError.value = apiErrorMessage(err)
  }
  finally {
    dsSaving.value = false
  }
}

// ---------- 3. 训练作业(REST 快照 + WS 实时投影合并) ----------

const jobs = ref<AmlJobRow[]>([])

async function loadJobs(): Promise<void> {
  try {
    const data = await api<{ jobs: AmlJobRow[] }>('/jobs')
    jobs.value = data.jobs
  }
  catch { /* 同上:静默保旧值 */ }
}

/** WS 实时投影覆盖 status/stage/progress(帧权威,REST 兜底) */
const jobRows = computed<Array<AmlJobRow & { live?: boolean }>>(() =>
  jobs.value.map((j) => {
    const live = aml.jobs.value.get(j.id)
    if (!live) return j
    return { ...j, status: live.status || j.status, stage: live.stage || j.stage, progress: live.progress ?? j.progress, live: true }
  }))

interface JobDetail { loading: boolean, error: string, metrics: PlatformMetrics | null, gates: GateReport | null, logs: string[] }
const jobDetails = reactive<Record<string, JobDetail>>({})
const expandedJob = ref('')

async function fetchJobLogs(id: string): Promise<string[]> {
  const data = await api<{ logs: string[] }>(`/jobs/${id}/logs?lines=120`)
  return data.logs
}

async function toggleJob(id: string): Promise<void> {
  expandedJob.value = expandedJob.value === id ? '' : id
  if (expandedJob.value && !jobDetails[id]) {
    jobDetails[id] = { loading: true, error: '', metrics: null, gates: null, logs: [] }
    try {
      const [detail, logs] = await Promise.all([
        api<{ job: AmlJobRow, metrics: PlatformMetrics | null, gates: GateReport | null }>(`/jobs/${id}`),
        fetchJobLogs(id),
      ])
      jobDetails[id] = { loading: false, error: '', metrics: detail.metrics, gates: detail.gates, logs }
    }
    catch (err) {
      jobDetails[id] = { loading: false, error: apiErrorMessage(err), metrics: null, gates: null, logs: [] }
    }
  }
}

/** 活跃作业 5s 轮询尾随日志(仅刷新日志,不重拉门禁) */
async function refreshJobLogs(id: string): Promise<void> {
  const d = jobDetails[id]
  if (!d) return
  try {
    d.logs = await fetchJobLogs(id)
  }
  catch { /* 轮询失败静默,下一拍再试 */ }
}

const confirmCancel = ref('')
const cancelling = ref('')

async function onCancelJob(id: string): Promise<void> {
  if (confirmCancel.value !== id) {
    confirmCancel.value = id
    return
  }
  confirmCancel.value = ''
  cancelling.value = id
  try {
    await api(`/jobs/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) })
    message.success(tt('aml.k1amlx097', { p0: shortId(id) }))
    await loadJobs()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    cancelling.value = ''
  }
}

const confirmRetry = ref('')
const retrying = ref('')

async function onRetryJob(id: string): Promise<void> {
  if (confirmRetry.value !== id) {
    confirmRetry.value = id
    return
  }
  confirmRetry.value = ''
  retrying.value = id
  try {
    await api(`/jobs/${id}/retry`, { method: 'POST', body: JSON.stringify({}) })
    message.success(tt('aml.k1amlx098', { p0: shortId(id) }))
    await loadJobs()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    retrying.value = ''
  }
}

// ---------- 4. 实验排行榜(选数据集 → 谱系 + 门禁) ----------

const expDatasetId = ref('')
const experiments = ref<AmlExperiment[]>([])
const expLoading = ref(false)
const expError = ref('')

async function loadExperiments(): Promise<void> {
  if (!expDatasetId.value) {
    experiments.value = []
    return
  }
  expLoading.value = true
  expError.value = ''
  try {
    const data = await api<{ experiments: AmlExperiment[] }>(`/experiments?datasetId=${encodeURIComponent(expDatasetId.value)}`)
    experiments.value = data.experiments
  }
  catch (err) {
    expError.value = apiErrorMessage(err)
  }
  finally {
    expLoading.value = false
  }
}

/** 最优行:门禁通过且测试集单步 NRMSE 最小 */
const bestExpId = computed(() => {
  let best: { id: string, nrmse: number } | null = null
  for (const e of experiments.value) {
    const n = e.metrics?.oneStepTest?.nrmse
    if (e.status === 'gates_passed' && n != null && Number.isFinite(n) && (best == null || n < best.nrmse))
      best = { id: e.id, nrmse: n }
  }
  return best?.id ?? ''
})

// ---------- 5. 模型注册表 + 预测控制台 ----------

const models = ref<AmlModelRow[]>([])

async function loadModels(): Promise<void> {
  try {
    const data = await api<{ models: AmlModelRow[] }>('/models')
    models.value = data.models
  }
  catch { /* 静默保旧值 */ }
}

const confirmPromote = ref('')
const promoting = ref('')

function promoteActionOf(m: AmlModelRow): Array<{ to: Exclude<AmlModelStage, 'candidate'>, key: string }> {
  if (m.stage === 'candidate') return [{ to: 'shadow', key: 'aml.k1amlx128' }, { to: 'production', key: 'aml.k1amlx129' }]
  if (m.stage === 'shadow') return [{ to: 'production', key: 'aml.k1amlx129' }, { to: 'retired', key: 'aml.k1amlx130' }]
  if (m.stage === 'production') return [{ to: 'retired', key: 'aml.k1amlx130' }]
  return []
}

async function onPromote(m: AmlModelRow, to: Exclude<AmlModelStage, 'candidate'>): Promise<void> {
  const key = `${m.id}:${to}`
  if (confirmPromote.value !== key) {
    confirmPromote.value = key
    return
  }
  confirmPromote.value = ''
  promoting.value = key
  try {
    const r = await api<{ ok: boolean, from?: AmlModelStage, retiredId?: string }>(`/models/${m.id}/promote`, {
      method: 'POST',
      body: JSON.stringify({ toStage: to }),
    })
    if (r.ok) message.success(tt('aml.k1amlx132', { p0: r.from ?? m.stage, p1: to }))
    await Promise.all([loadModels(), loadOverview()])
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    promoting.value = ''
  }
}

// 预测控制台:production 模型 → ioSpec → history JSON 粘贴 → forecast 表
const productionModels = computed(() => models.value.filter(m => m.stage === 'production'))
const predModelId = ref('')
const predModel = computed(() => models.value.find(m => m.id === predModelId.value) ?? null)
const predHistory = ref('')
const predControls = ref('')
const predSteps = ref<number | null>(null)
const predBusy = ref(false)
const predError = ref('')
const predResult = ref<PredictResult | null>(null)

function onPullLatest(): void {
  // 页面暂不内联拉数:引导用户走 Agent 工具取数(与任务口径一致)
  message.info(tt('aml.k1amlx146'))
}

function parseMatrix(text: string): number[][] | null {
  const t = text.trim()
  if (!t) return null
  try {
    const v: unknown = JSON.parse(t)
    if (!Array.isArray(v) || v.length === 0) return null
    const ok = v.every(r => Array.isArray(r) && r.length > 0 && r.every(x => typeof x === 'number' && Number.isFinite(x)))
    return ok ? (v as number[][]) : null
  }
  catch {
    return null
  }
}

async function doPredict(): Promise<void> {
  predError.value = ''
  predResult.value = null
  const model = predModel.value
  if (!model) return
  const history = parseMatrix(predHistory.value)
  if (!history) {
    predError.value = tt('aml.k1amlx153')
    return
  }
  const controls = predControls.value.trim() ? parseMatrix(predControls.value) : undefined
  if (predControls.value.trim() && !controls) {
    predError.value = tt('aml.k1amlx153')
    return
  }
  predBusy.value = true
  try {
    const steps = typeof predSteps.value === 'number' && Number.isFinite(predSteps.value) ? predSteps.value : undefined
    const data = await api<{ prediction: PredictResult }>(`/models/${model.id}/predict`, {
      method: 'POST',
      body: JSON.stringify({ history, controls, steps }),
    })
    predResult.value = data.prediction
    message.success(tt('aml.k1amlx154', { p0: data.prediction.forecast.length, p1: data.prediction.targetNodes.length }))
  }
  catch (err) {
    predError.value = apiErrorMessage(err)
  }
  finally {
    predBusy.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          AGENTWORKSHOP / AML STUDIO
        </p>
        <h1>{{ $t('aml.k1amlx001') }}</h1>
        <p class="sub">
          {{ $t('aml.k1amlx002') }}
        </p>
      </div>
      <div class="badges mono">
        <span
          class="badge"
          :class="{ bad: overview != null && !overview.runtime.python.ok }"
          :title="overview?.runtime.python.reason ?? ''"
        >PYTHON · {{ pythonText }}</span>
        <span
          class="badge"
          :class="{ bad: overview != null && !overview.runtime.venvReady }"
        >VENV · {{ venvText }}</span>
      </div>
    </div>

    <!-- 1. 概览条:Python 运行时 / 依赖环境 / 队列 / 计数;不 ok 给醒目提示条 -->
    <div
      v-if="overview != null && !overview.runtime.python.ok"
      class="infra-banner"
    >
      <span class="i-tabler-alert-triangle" />
      <span class="txt">{{ $t('aml.k1amlx014') }}<b class="mono">{{ overview.runtime.python.reason ?? '' }}</b></span>
    </div>
    <section
      v-if="overview"
      class="aw-tile ov-card"
    >
      <div class="ov-row mono">
        <span
          class="ov-item"
          :class="overview.runtime.python.ok ? 'ok' : 'bad'"
        >
          <span :class="overview.runtime.python.ok ? 'i-tabler-circle-check' : 'i-tabler-alert-triangle'" />
          {{ $t('aml.k1amlx003') }} · {{ pythonText }}
        </span>
        <span
          class="ov-item"
          :class="{ ok: overview.runtime.venvReady }"
        >{{ $t('aml.k1amlx006') }} · {{ venvText }}</span>
        <span class="ov-item">{{ $t('aml.k1amlx009') }} <b>{{ overview.runtime.queued }}</b></span>
        <span class="ov-item">{{ $t('aml.k1amlx010') }} <b>{{ overview.runtime.running }}</b></span>
        <span class="sep">·</span>
        <span class="ov-item">{{ $t('aml.k1amlx011') }} <b>{{ overview.counts.datasets }}</b></span>
        <span class="ov-item">{{ $t('aml.k1amlx012') }} <b>{{ overview.counts.models }}</b></span>
        <span
          class="ov-item accent"
          :title="$t('aml.k1amlx013')"
        >{{ $t('aml.k1amlx013') }} <b>{{ overview.counts.productions }}</b></span>
        <button
          class="mini-btn reload"
          @click="reloadAll"
        >
          {{ $t('aml.k1amlx017') }}
        </button>
      </div>
    </section>
    <p
      v-else-if="overviewError"
      class="err"
    >
      {{ $t('aml.k1amlx015') }}:{{ overviewError }}
    </p>

    <!-- 2. 数据集快照:注册表 + 行内展开(清洗报告/滞后估计/run 概览)+ 新建 -->
    <section class="aw-tile zone">
      <div class="zone-head">
        <h2>
          <span class="i-tabler-database" />
          {{ $t('aml.k1amlx016') }}
          <b class="mono cnt">{{ datasets.length }}</b>
        </h2>
        <div class="zone-actions">
          <button
            class="mini-btn"
            @click="loadDatasets()"
          >
            {{ $t('aml.k1amlx017') }}
          </button>
          <button
            class="pill-btn"
            @click="openDsForm"
          >
            <span class="i-tabler-plus" />
            {{ $t('aml.k1amlx018') }}
          </button>
        </div>
      </div>
      <table
        v-if="datasets.length"
        class="tbl"
      >
        <thead>
          <tr>
            <th>{{ $t('aml.k1amlx020') }}</th>
            <th>{{ $t('aml.k1amlx021') }}</th>
            <th>{{ $t('aml.k1amlx022') }}</th>
            <th class="num">
              {{ $t('aml.k1amlx023') }}
            </th>
            <th class="num">
              {{ $t('aml.k1amlx024') }}
            </th>
            <th>{{ $t('aml.k1amlx025') }}</th>
            <th>{{ $t('aml.k1amlx026') }}</th>
          </tr>
        </thead>
        <tbody>
          <template
            v-for="d in datasets"
            :key="d.id"
          >
            <tr
              class="row-main"
              :class="{ open: expandedDs === d.id }"
              @click="toggleDs(d.id)"
            >
              <td class="mono dim">
                {{ fmtTime(d.createdAt) }}
              </td>
              <td class="mono">
                {{ shortId(d.productId) }}
              </td>
              <td class="mono">
                {{ shortId(d.recipeId) }}
              </td>
              <td class="mono num">
                {{ d.rowCount }}
              </td>
              <td class="mono num">
                {{ d.runIds.length }}
              </td>
              <td>
                {{ d.createdBy }}<small
                  class="kind"
                  :class="d.createdByKind"
                >{{ d.createdByKind === 'agent' ? 'Agent' : $t('aml.k1amlx049') }}</small>
              </td>
              <td class="note-cell">
                <span
                  class="note"
                  :title="d.note"
                >{{ d.note || '--' }}</span>
              </td>
            </tr>
            <tr
              v-if="expandedDs === d.id"
              class="detail-row"
            >
              <td colspan="7">
                <div
                  v-if="dsDetails[d.id]?.loading"
                  class="dim pad"
                >
                  {{ $t('aml.k1amlx030') }}
                </div>
                <div
                  v-else-if="dsDetails[d.id]?.error"
                  class="err pad"
                >
                  {{ $t('aml.k1amlx031') }}:{{ dsDetails[d.id]?.error }}
                </div>
                <div
                  v-else-if="dsDetails[d.id]?.report"
                  class="det-grid"
                >
                  <div>
                    <p class="det-title">
                      {{ $t('aml.k1amlx027') }}
                    </p>
                    <table class="sub-tbl">
                      <thead>
                        <tr>
                          <th>{{ $t('aml.k1amlx033') }}</th>
                          <th>{{ $t('aml.k1amlx034') }}</th>
                          <th class="num">
                            {{ $t('aml.k1amlx035') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx036') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx037') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx038') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx039') }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="s in dsDetails[d.id]?.report?.nodeSummaries"
                          :key="s.nodeId"
                        >
                          <td class="mono">
                            {{ s.nodeId }}
                          </td>
                          <td>
                            <small class="role-chip">{{ s.role }}</small>
                          </td>
                          <td class="mono num">
                            {{ fmtPct(s.cleanedRatio) }}
                          </td>
                          <td class="mono num">
                            {{ fmtPct(s.missingRatio) }}
                          </td>
                          <td class="mono num">
                            {{ fmtNum(s.mean, 3) }}
                          </td>
                          <td class="mono num">
                            {{ fmtNum(s.std, 3) }}
                          </td>
                          <td class="mono num">
                            {{ fmtNum(s.min, 2) }}~{{ fmtNum(s.max, 2) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <p class="det-title">
                      {{ $t('aml.k1amlx028') }}
                    </p>
                    <table
                      v-if="dsDetails[d.id]?.report?.lagEstimates.length"
                      class="sub-tbl"
                    >
                      <thead>
                        <tr>
                          <th>{{ $t('aml.k1amlx040') }}</th>
                          <th>{{ $t('aml.k1amlx041') }}</th>
                          <th class="num">
                            {{ $t('aml.k1amlx042') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx043') }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="l in dsDetails[d.id]?.report?.lagEstimates"
                          :key="`${l.controlId}->${l.targetId}`"
                        >
                          <td class="mono">
                            {{ l.controlId }}
                          </td>
                          <td class="mono">
                            {{ l.targetId }}
                          </td>
                          <td class="mono num">
                            {{ l.lagSteps }}
                          </td>
                          <td class="mono num">
                            {{ fmtNum(l.corr, 3) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      v-else
                      class="dim"
                    >
                      {{ $t('aml.k1amlx032') }}
                    </p>
                    <p class="det-title">
                      {{ $t('aml.k1amlx029') }}
                    </p>
                    <p class="mono dim run-line">
                      {{ $t('aml.k1amlx044') }}
                      <b>{{ dsDetails[d.id]?.report?.runsUsed.length ?? 0 }}</b>
                      · {{ $t('aml.k1amlx045') }}
                      <b>{{ dsDetails[d.id]?.report?.runsDropped.length ?? 0 }}</b>
                      · {{ $t('aml.k1amlx046') }}
                      <b>{{ dsDetails[d.id]?.report?.windowCount.train }}/{{ dsDetails[d.id]?.report?.windowCount.val }}/{{ dsDetails[d.id]?.report?.windowCount.test }}</b>
                    </p>
                    <p
                      v-for="r in dsDetails[d.id]?.report?.runsDropped"
                      :key="r.runId"
                      class="mono drop-line"
                    >
                      ✗ {{ shortId(r.runId) }} — {{ r.reason }}
                    </p>
                  </div>
                </div>
                <p
                  v-else
                  class="dim pad"
                >
                  {{ $t('aml.k1amlx047') }}
                </p>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <p
        v-else
        class="empty"
      >
        {{ $t('aml.k1amlx019') }}
      </p>
    </section>

    <!-- 3. 训练作业:REST 快照 + WS 实时进度;展开 = 门禁逐项 + 日志尾随(活跃 5s 轮询) -->
    <section class="aw-tile zone">
      <div class="zone-head">
        <h2>
          <span class="i-tabler-brain" />
          {{ $t('aml.k1amlx074') }}
          <b class="mono cnt">{{ jobRows.length }}</b>
          <span
            v-if="jobRows.some(j => isActiveStatus(j.status))"
            class="live-dot"
            :title="$t('aml.k1amlx091')"
          />
        </h2>
        <button
          class="mini-btn"
          @click="loadJobs()"
        >
          {{ $t('aml.k1amlx017') }}
        </button>
      </div>
      <table
        v-if="jobRows.length"
        class="tbl"
      >
        <thead>
          <tr>
            <th>{{ $t('aml.k1amlx076') }}</th>
            <th>{{ $t('aml.k1amlx011') }}</th>
            <th>{{ $t('aml.k1amlx066') }}</th>
            <th>{{ $t('aml.k1amlx077') }}</th>
            <th>{{ $t('aml.k1amlx078') }}</th>
            <th class="prog-th">
              {{ $t('aml.k1amlx079') }}
            </th>
            <th>{{ $t('aml.k1amlx020') }}</th>
            <th class="right">
              {{ $t('aml.k1amlx127') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <template
            v-for="j in jobRows"
            :key="j.id"
          >
            <tr
              class="row-main"
              :class="{ open: expandedJob === j.id }"
              @click="toggleJob(j.id)"
            >
              <td class="mono">
                {{ shortId(j.id) }}
              </td>
              <td class="mono dim">
                {{ shortId(j.datasetId) }}
              </td>
              <td class="mono dim">
                {{ j.purpose }}
              </td>
              <td>
                <span
                  class="st-pill"
                  :class="j.status"
                >{{ statusLabel(j.status) }}</span>
              </td>
              <td class="mono dim">
                {{ j.stage || '--' }}
              </td>
              <td class="prog-cell">
                <span class="prog"><i
                  :style="{ width: `${Math.max(0, Math.min(100, j.progress))}%` }"
                  :class="{ done: j.status === 'done', bad: j.status === 'failed' }"
                /></span>
                <span class="mono prog-num">{{ Math.round(j.progress) }}%</span>
              </td>
              <td class="mono dim">
                {{ fmtTime(j.createdAt) }}
              </td>
              <td class="right acts">
                <button
                  v-if="isActiveStatus(j.status)"
                  class="mini-btn danger"
                  :disabled="cancelling === j.id"
                  @click.stop="onCancelJob(j.id)"
                >
                  {{ confirmCancel === j.id ? $t('aml.k1amlx094') : (cancelling === j.id ? $t('aml.k1amlx093') : $t('aml.k1amlx071')) }}
                </button>
                <button
                  v-if="canRetry(j.status)"
                  class="mini-btn"
                  :disabled="retrying === j.id"
                  @click.stop="onRetryJob(j.id)"
                >
                  {{ confirmRetry === j.id ? $t('aml.k1amlx096') : $t('aml.k1amlx095') }}
                </button>
              </td>
            </tr>
            <tr
              v-if="expandedJob === j.id"
              class="detail-row"
            >
              <td colspan="8">
                <div
                  v-if="jobDetails[j.id]?.loading"
                  class="dim pad"
                >
                  {{ $t('aml.k1amlx030') }}
                </div>
                <div
                  v-else-if="jobDetails[j.id]?.error"
                  class="err pad"
                >
                  {{ jobDetails[j.id]?.error }}
                </div>
                <div
                  v-else
                  class="det-grid"
                >
                  <div>
                    <p class="det-title">
                      {{ $t('aml.k1amlx083') }}
                    </p>
                    <table
                      v-if="jobDetails[j.id]?.gates?.checks.length"
                      class="sub-tbl"
                    >
                      <thead>
                        <tr>
                          <th>{{ $t('aml.k1amlx084') }}</th>
                          <th class="num">
                            {{ $t('aml.k1amlx085') }}
                          </th>
                          <th class="num">
                            {{ $t('aml.k1amlx086') }}
                          </th>
                          <th>{{ $t('aml.k1amlx118') }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="g in jobDetails[j.id]?.gates?.checks"
                          :key="g.id"
                        >
                          <td>
                            <b class="mono gate-id">{{ g.id }}</b>
                            <small class="dim"> {{ g.name }}</small>
                          </td>
                          <td class="mono num">
                            {{ fmtNum(g.value) }}
                          </td>
                          <td class="mono num dim">
                            {{ fmtNum(g.threshold) }}
                          </td>
                          <td>
                            <span
                              class="verdict"
                              :class="g.pass ? 'pass' : 'fail'"
                            >{{ g.pass ? $t('aml.k1amlx087') : $t('aml.k1amlx088') }}</span>
                            <small class="dim gate-detail">{{ g.detail }}</small>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      v-else
                      class="dim"
                    >
                      {{ $t('aml.k1amlx082') }}
                    </p>
                    <p
                      v-if="jobDetails[j.id]?.metrics?.oneStepTest"
                      class="mono dim gate-detail"
                    >
                      {{ $t('aml.k1amlx099') }}: {{ $t('aml.k1amlx116') }} {{ fmtNum(jobDetails[j.id]?.metrics?.oneStepTest?.nrmse) }}
                      <template v-if="jobDetails[j.id]?.metrics?.rolloutTest">
                        · {{ $t('aml.k1amlx117') }} {{ fmtNum(jobDetails[j.id]?.metrics?.rolloutTest?.nrmse) }}
                      </template>
                    </p>
                    <p
                      v-if="j.error"
                      class="err gate-detail"
                    >
                      {{ $t('aml.k1amlx092') }}:{{ j.error }}
                    </p>
                  </div>
                  <div>
                    <p class="det-title">
                      {{ $t('aml.k1amlx089') }}
                      <span
                        v-if="isActiveStatus(j.status)"
                        class="mono live-hint"
                      >{{ $t('aml.k1amlx091') }}</span>
                    </p>
                    <pre class="logs">{{ (jobDetails[j.id]?.logs ?? []).join('\n') || $t('aml.k1amlx090') }}</pre>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <p
        v-else
        class="empty"
      >
        {{ $t('aml.k1amlx075') }}
      </p>
    </section>

    <!-- 4. 实验排行榜:选数据集 → 谱系表(变更说明/父实验/G1/G2/门禁态),最优行高亮 -->
    <section class="aw-tile zone">
      <div class="zone-head">
        <h2>
          <span class="i-tabler-trophy" />
          {{ $t('aml.k1amlx109') }}
          <b class="mono cnt">{{ experiments.length }}</b>
        </h2>
        <div class="zone-actions">
          <select
            v-model="expDatasetId"
            class="inp-sel"
            @change="loadExperiments"
          >
            <option value="">
              {{ $t('aml.k1amlx111') }}
            </option>
            <option
              v-for="d in datasets"
              :key="d.id"
              :value="d.id"
            >
              {{ shortId(d.id) }} · {{ shortId(d.recipeId) }}
            </option>
          </select>
          <button
            class="mini-btn"
            :disabled="!expDatasetId"
            @click="loadExperiments"
          >
            {{ $t('aml.k1amlx017') }}
          </button>
        </div>
      </div>
      <table
        v-if="experiments.length"
        class="tbl"
      >
        <thead>
          <tr>
            <th>{{ $t('aml.k1amlx113') }}</th>
            <th>{{ $t('aml.k1amlx020') }}</th>
            <th>{{ $t('aml.k1amlx114') }}</th>
            <th>{{ $t('aml.k1amlx115') }}</th>
            <th
              class="num"
              :title="$t('aml.k1amlx121')"
            >
              {{ $t('aml.k1amlx116') }}
            </th>
            <th
              class="num"
              :title="$t('aml.k1amlx122')"
            >
              {{ $t('aml.k1amlx117') }}
            </th>
            <th>{{ $t('aml.k1amlx118') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in experiments"
            :key="e.id"
            :class="{ best: e.id === bestExpId }"
          >
            <td class="mono">
              <span
                v-if="e.id === bestExpId"
                class="best-tag"
              >{{ $t('aml.k1amlx120') }}</span>
              {{ shortId(e.id) }}
            </td>
            <td class="mono dim">
              {{ fmtTime(e.createdAt) }}
            </td>
            <td class="note-cell">
              <span
                class="note"
                :title="e.changeNote"
              >{{ e.changeNote || '--' }}</span>
            </td>
            <td class="mono dim">
              {{ e.parentExperimentId ? shortId(e.parentExperimentId) : '--' }}
            </td>
            <td class="mono num">
              {{ fmtNum(e.metrics?.oneStepTest?.nrmse) }}
            </td>
            <td class="mono num">
              {{ fmtNum(e.metrics?.rolloutTest?.nrmse) }}
            </td>
            <td>
              <span
                class="st-pill"
                :class="e.status"
              >{{ expStatusLabel(e.status) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p
        v-else
        class="empty"
      >
        {{ expDatasetId ? $t('aml.k1amlx112') : $t('aml.k1amlx110') }}
      </p>
      <p
        v-if="expError"
        class="err pad"
      >
        {{ expError }}
      </p>
    </section>

    <!-- 5. 模型注册表:阶段徽标 + 指标 + 两段确认晋升 -->
    <section class="aw-tile zone">
      <div class="zone-head">
        <h2>
          <span class="i-tabler-cube-3d-sphere" />
          {{ $t('aml.k1amlx123') }}
          <b class="mono cnt">{{ models.length }}</b>
        </h2>
        <button
          class="mini-btn"
          @click="loadModels()"
        >
          {{ $t('aml.k1amlx017') }}
        </button>
      </div>
      <table
        v-if="models.length"
        class="tbl"
      >
        <thead>
          <tr>
            <th>{{ $t('aml.k1amlx125') }}</th>
            <th>{{ $t('aml.k1amlx021') }}</th>
            <th>{{ $t('aml.k1amlx022') }}</th>
            <th>{{ $t('aml.k1amlx078') }}</th>
            <th :title="$t('aml.k1amlx126')">
              {{ $t('aml.k1amlx099') }}
            </th>
            <th>{{ $t('aml.k1amlx020') }}</th>
            <th class="right">
              {{ $t('aml.k1amlx127') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="m in models"
            :key="m.id"
          >
            <td class="mono">
              {{ shortId(m.id) }}
            </td>
            <td class="mono dim">
              {{ shortId(m.productId) }}
            </td>
            <td class="mono dim">
              {{ shortId(m.recipeId) }}
            </td>
            <td>
              <span
                class="stage-pill"
                :class="m.stage"
              >{{ m.stage }}</span>
            </td>
            <td class="mono dim">
              {{ $t('aml.k1amlx116') }} {{ fmtNum(m.metrics?.oneStepTest?.nrmse) }} · {{ $t('aml.k1amlx117') }} {{ fmtNum(m.metrics?.rolloutTest?.nrmse) }}
            </td>
            <td class="mono dim">
              {{ fmtTime(m.createdAt) }}
            </td>
            <td class="right acts">
              <template
                v-for="a in promoteActionOf(m)"
                :key="a.to"
              >
                <button
                  class="mini-btn"
                  :class="{ danger: a.to === 'retired' }"
                  :disabled="promoting === `${m.id}:${a.to}`"
                  @click="onPromote(m, a.to)"
                >
                  {{ confirmPromote === `${m.id}:${a.to}` ? $t('aml.k1amlx131') : $t(a.key) }}
                </button>
              </template>
              <span
                v-if="promoteActionOf(m).length === 0"
                class="dim"
              >--</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p
        v-else
        class="empty"
      >
        {{ $t('aml.k1amlx124') }}
      </p>
    </section>

    <!-- 5b. 预测控制台:production 模型 → ioSpec → history JSON → forecast 表 -->
    <section class="aw-tile zone">
      <div class="zone-head">
        <h2>
          <span class="i-tabler-chart-line" />
          {{ $t('aml.k1amlx133') }}
        </h2>
        <select
          v-if="productionModels.length"
          v-model="predModelId"
          class="inp-sel"
        >
          <option value="">
            {{ $t('aml.k1amlx134') }}
          </option>
          <option
            v-for="m in productionModels"
            :key="m.id"
            :value="m.id"
          >
            {{ shortId(m.id) }} · {{ shortId(m.recipeId) }}
          </option>
        </select>
      </div>
      <template v-if="productionModels.length">
        <div
          v-if="predModel?.ioSpec"
          class="pc-body"
        >
          <p class="det-title">
            {{ $t('aml.k1amlx136') }}
          </p>
          <div class="io-grid mono">
            <span class="io-item">{{ $t('aml.k1amlx140') }} <b>{{ predModel.ioSpec.historySteps }}</b></span>
            <span class="io-item">{{ $t('aml.k1amlx141') }} <b>{{ predModel.ioSpec.horizonSteps }}</b></span>
            <span class="io-item">{{ $t('aml.k1amlx142') }} <b>{{ predModel.ioSpec.beatMs }}ms</b></span>
            <span
              class="io-item"
              :title="predModel.ioSpec.allNodes.join(', ')"
            >{{ $t('aml.k1amlx137') }}({{ predModel.ioSpec.allNodes.length }}) <b>{{ predModel.ioSpec.allNodes.map(n => shortId(n)).join(', ') }}</b></span>
            <span
              class="io-item"
              :title="predModel.ioSpec.controlNodes.join(', ')"
            >{{ $t('aml.k1amlx138') }} <b>{{ predModel.ioSpec.controlNodes.map(n => shortId(n)).join(', ') }}</b></span>
            <span
              class="io-item"
              :title="predModel.ioSpec.targetNodes.join(', ')"
            >{{ $t('aml.k1amlx139') }} <b>{{ predModel.ioSpec.targetNodes.map(n => shortId(n)).join(', ') }}</b></span>
          </div>
          <div class="pc-form">
            <label class="pc-field">
              <span>{{ $t('aml.k1amlx143') }}</span>
              <textarea
                v-model="predHistory"
                class="inp area"
                rows="5"
                :placeholder="$t('aml.k1amlx144')"
              />
            </label>
            <div class="pc-side">
              <button
                class="ghost-btn"
                @click="onPullLatest"
              >
                <span class="i-tabler-download" />
                {{ $t('aml.k1amlx145') }}
              </button>
              <label class="pc-field">
                <span>{{ $t('aml.k1amlx156') }}</span>
                <textarea
                  v-model="predControls"
                  class="inp area"
                  rows="3"
                  :placeholder="'[[…]]'"
                />
              </label>
              <label class="pc-field">
                <span>{{ $t('aml.k1amlx147') }}</span>
                <input
                  v-model.number="predSteps"
                  type="number"
                  min="1"
                  class="inp"
                >
              </label>
              <button
                class="pill-btn"
                :disabled="predBusy || !predHistory.trim()"
                @click="doPredict"
              >
                {{ predBusy ? $t('aml.k1amlx149') : $t('aml.k1amlx148') }}
              </button>
            </div>
          </div>
          <p class="hint dim">
            {{ $t('aml.k1amlx146') }}
          </p>
          <p
            v-if="predError"
            class="err"
          >
            {{ predError }}
          </p>
          <template v-if="predResult">
            <p class="det-title">
              {{ $t('aml.k1amlx150') }}
            </p>
            <table class="sub-tbl">
              <thead>
                <tr>
                  <th class="num">
                    {{ $t('aml.k1amlx151') }}
                  </th>
                  <th class="num">
                    {{ $t('aml.k1amlx152') }}
                  </th>
                  <th
                    v-for="(n, i) in predResult.targetNodes"
                    :key="n"
                    class="num"
                  >
                    {{ shortId(n) }}<small
                      v-if="i === 0"
                      class="dim"
                    > ({{ $t('aml.k1amlx041') }})</small>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, ri) in predResult.forecast"
                  :key="ri"
                >
                  <td class="mono num">
                    {{ ri + 1 }}
                  </td>
                  <td class="mono num dim">
                    {{ fmtNum(((ri + 1) * predResult.beatMs) / 1000, 1) }}
                  </td>
                  <td
                    v-for="(v, ci) in row"
                    :key="ci"
                    class="mono num"
                  >
                    {{ fmtNum(v, 3) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="mono dim gate-detail">
              {{ $t('aml.k1amlx155') }}:{{ predResult.assumptions }}
            </p>
          </template>
        </div>
        <p
          v-else
          class="empty"
        >
          {{ $t('aml.k1amlx134') }}
        </p>
      </template>
      <p
        v-else
        class="empty"
      >
        {{ $t('aml.k1amlx135') }}
      </p>
    </section>

    <!-- 新建数据集快照(spec 与 server zod 模式对齐) -->
    <div
      v-if="dsFormOpen"
      class="modal-mask"
      @click.self="dsFormOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          {{ $t('aml.k1amlx050') }}
        </h3>
        <div class="f-grid">
          <label class="f">
            <span>{{ $t('aml.k1amlx051') }}<em>*</em></span>
            <input
              v-model="dsForm.lineId"
              class="inp"
              placeholder="line-ov-01"
            >
          </label>
          <label class="f">
            <span>{{ $t('aml.k1amlx052') }}<em>*</em></span>
            <input
              v-model="dsForm.productId"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('aml.k1amlx053') }}<em>*</em></span>
            <input
              v-model="dsForm.recipeId"
              class="inp"
            >
          </label>
        </div>
        <p class="sec-label">
          {{ $t('aml.k1amlx054') }}
        </p>
        <div class="node-rows">
          <div
            v-for="(n, i) in dsNodes"
            :key="i"
            class="node-row"
          >
            <input
              v-model="n.nodeId"
              class="inp grow"
              :placeholder="$t('aml.k1amlx056')"
            >
            <select
              v-model="n.role"
              class="inp sel"
            >
              <option value="control">
                {{ $t('aml.k1amlx057') }}
              </option>
              <option value="feature">
                {{ $t('aml.k1amlx058') }}
              </option>
              <option value="target">
                {{ $t('aml.k1amlx059') }}
              </option>
            </select>
            <button
              class="mini-btn danger"
              :disabled="dsNodes.length <= 1"
              @click="removeDsNode(i)"
            >
              ✕
            </button>
          </div>
          <button
            class="mini-btn"
            @click="addDsNode"
          >
            <span class="i-tabler-plus" />
            {{ $t('aml.k1amlx055') }}
          </button>
        </div>
        <div class="f-grid">
          <label class="f">
            <span>{{ $t('aml.k1amlx060') }}</span>
            <input
              v-model.number="dsForm.beatMs"
              type="number"
              min="1000"
              step="500"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('aml.k1amlx061') }}</span>
            <input
              v-model.number="dsForm.historySteps"
              type="number"
              min="1"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('aml.k1amlx062') }}</span>
            <input
              v-model.number="dsForm.horizonSteps"
              type="number"
              min="1"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('aml.k1amlx063') }}</span>
            <input
              v-model.number="dsForm.valRatio"
              type="number"
              min="0"
              max="0.8"
              step="0.05"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('aml.k1amlx064') }}</span>
            <input
              v-model.number="dsForm.testRatio"
              type="number"
              min="0"
              max="0.8"
              step="0.05"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('aml.k1amlx065') }}</span>
            <input
              v-model.number="dsForm.seed"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('aml.k1amlx066') }}</span>
            <select
              v-model="dsForm.purpose"
              class="inp"
            >
              <option value="mpc_surrogate">
                {{ $t('aml.k1amlx067') }}
              </option>
              <option value="quality_predict">
                {{ $t('aml.k1amlx068') }}
              </option>
            </select>
          </label>
          <label class="f wide">
            <span>{{ $t('aml.k1amlx026') }}</span>
            <input
              v-model="dsForm.note"
              class="inp"
              :placeholder="$t('aml.k1amlx069')"
            >
          </label>
        </div>
        <p
          v-if="dsFormError"
          class="m-err"
        >
          {{ dsFormError }}
        </p>
        <div class="m-actions">
          <button
            class="ghost-btn"
            @click="dsFormOpen = false"
          >
            {{ $t('aml.k1amlx071') }}
          </button>
          <button
            class="pill-btn"
            :disabled="dsSaving"
            @click="submitDsForm"
          >
            {{ dsSaving ? $t('aml.k1amlx070') : $t('aml.k1amlx072') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 4px; }
h1 { margin: 2px 0 4px; font-size: 30px; font-weight: 400; letter-spacing: -0.015em; }
.sub { margin: 0; font-size: 12.5px; opacity: 0.6; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }
.err { margin: 6px 0; font-size: 12.5px; color: var(--tone-danger-dot); }
.pad { padding: 10px 12px; }

.badges { display: flex; gap: 8px; }
.badge {
  padding: 3px 10px;
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--ink-soft);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.badge.bad { color: var(--tone-danger-dot); border-color: color-mix(in srgb, var(--tone-danger-dot) 45%, transparent); }

/* Python 不可用提示条(与 daq 基础设施横幅同语) */
.infra-banner {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 14px;
  margin-bottom: 14px;
  color: var(--tone-warning-dot);
  background: var(--tone-warning-bg);
  border: 1px solid color-mix(in srgb, var(--tone-warning-dot) 40%, transparent);
  border-radius: var(--radius-chip);
}
.infra-banner .txt { flex: 1 1 auto; font-size: 12.5px; line-height: 1.5; }

/* ── 1. 概览条 ── */
.ov-card { padding: 10px 18px; margin-bottom: 14px; }
.ov-row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; font-size: 12px; color: var(--ink-soft); }
.ov-item { display: inline-flex; gap: 5px; align-items: center; }
.ov-item b { color: var(--ink); font-weight: 700; }
.ov-item.ok { color: var(--tone-success-dot); }
.ov-item.bad { color: var(--tone-danger-dot); }
.ov-item.accent b { color: var(--accent); }
.ov-row .sep { opacity: 0.4; }
.ov-row .reload { margin-left: auto; }

/* ── 通用区块 ── */
.zone { padding: 12px 18px 14px; margin-bottom: 14px; overflow-x: auto; }
.zone-head { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.zone-head h2 { display: inline-flex; gap: 8px; align-items: center; margin: 0; font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.zone-head h2 .cnt { font-size: 11px; font-weight: 400; color: var(--ink-faint); }
.zone-actions { display: flex; gap: 8px; align-items: center; }
.live-dot {
  width: 7px;
  height: 7px;
  background: var(--tone-success-dot);
  border-radius: 50%;
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-success-dot) 60%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .live-dot { animation: amlPulse 1.8s ease-in-out infinite; }
}
@keyframes amlPulse {
  50% { opacity: 0.4; }
}

/* 表:信息密度优先,行可展开 */
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th, .tbl td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.tbl th {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line-strong);
}
.tbl .num { text-align: right; }
.tbl .right { text-align: right; }
.tbl .acts { white-space: nowrap; }
.tbl .acts .mini-btn + .mini-btn { margin-left: 6px; }
.row-main { cursor: pointer; }
@media (prefers-reduced-motion: no-preference) {
  .row-main:hover { background: var(--hover-tint); }
}
.row-main.open td { border-bottom-color: transparent; }
.note-cell { max-width: 260px; }
.note { display: inline-block; overflow: hidden; width: 100%; text-overflow: ellipsis; white-space: nowrap; }
.kind {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10px;
  border: 1px solid var(--line);
  border-radius: 99px;
  color: var(--ink-faint);
}
.kind.agent { color: var(--tone-info-dot); border-color: color-mix(in srgb, var(--tone-info-dot) 40%, transparent); }

/* 展开详情:双栏(清洗报告 | 滞后+run) */
.detail-row td { padding: 0 12px 12px; background: var(--frost-bg); }
.det-grid { display: grid; grid-template-columns: minmax(340px, 3fr) minmax(280px, 2fr); gap: 10px 22px; }
@media (max-width: 1100px) {
  .det-grid { grid-template-columns: 1fr; }
}
.det-title { margin: 10px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
.det-title:first-child { margin-top: 10px; }
.sub-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.sub-tbl th, .sub-tbl td { padding: 5px 8px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.sub-tbl th { font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-faint); }
.sub-tbl .num { text-align: right; }
.role-chip { padding: 1px 6px; font-family: var(--font-mono); font-size: 10px; background: var(--paper-deep); border-radius: 5px; color: var(--ink-soft); }
.run-line { margin: 4px 0; font-size: 11.5px; }
.run-line b { color: var(--ink); }
.drop-line { margin: 2px 0; overflow: hidden; font-size: 11px; color: var(--tone-danger-dot); text-overflow: ellipsis; white-space: nowrap; }

/* 作业状态 pill / 进度条 */
.st-pill {
  display: inline-block;
  padding: 2px 9px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  border-radius: var(--radius-pill);
}
.st-pill.queued, .st-pill.provisioning { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }
.st-pill.training, .st-pill.evaluating, .st-pill.running { color: var(--tone-info-dot); background: color-mix(in srgb, var(--tone-info-dot) 12%, transparent); }
.st-pill.done, .st-pill.gates_passed { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.failed, .st-pill.timeout, .st-pill.gates_failed { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.st-pill.cancelled, .st-pill.interrupted { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }

.prog-th { min-width: 140px; }
.prog-cell { white-space: nowrap; }
.prog {
  display: inline-block;
  width: 96px;
  height: 6px;
  overflow: hidden;
  vertical-align: middle;
  background: var(--paper-deep);
  border-radius: 3px;
}
.prog i { display: block; height: 100%; background: var(--tone-info-dot); border-radius: 3px; transition: width 0.4s ease; }
.prog i.done { background: var(--tone-success-dot); }
.prog i.bad { background: var(--tone-danger-dot); }
.prog-num { margin-left: 7px; font-size: 11px; color: var(--ink-soft); }

/* 门禁 */
.gate-id { font-weight: 700; }
.gate-detail { display: block; margin-top: 3px; font-size: 11px; }
.verdict { padding: 1px 7px; font-size: 10.5px; border-radius: 99px; }
.verdict.pass { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.verdict.fail { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.live-hint { margin-left: 8px; font-size: 10px; font-weight: 400; letter-spacing: 0; color: var(--tone-info-dot); text-transform: none; }
.logs {
  max-height: 260px;
  margin: 0;
  padding: 9px 11px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--divider-hair);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 排行榜最优行 */
tr.best { background: color-mix(in srgb, var(--accent) 9%, transparent); }
tr.best td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
.best-tag {
  margin-right: 6px;
  padding: 1px 7px;
  font-size: 10px;
  color: var(--on-accent);
  background: var(--accent);
  border-radius: 99px;
}

/* 模型阶段徽标 */
.stage-pill {
  display: inline-block;
  padding: 2px 9px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  color: var(--ink-soft);
}
.stage-pill.shadow { color: var(--tone-info-dot); border-color: color-mix(in srgb, var(--tone-info-dot) 45%, transparent); }
.stage-pill.production { color: var(--tone-success-dot); background: var(--tone-success-bg); border-color: transparent; }
.stage-pill.retired { opacity: 0.55; border-style: dashed; }

/* ── 预测控制台 ── */
.inp-sel {
  padding: 5px 10px;
  font-size: 12px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.pc-body { margin-top: 4px; }
.io-grid { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 10px; font-size: 11.5px; color: var(--ink-soft); }
.io-item b { font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
.pc-form { display: grid; grid-template-columns: minmax(300px, 3fr) minmax(220px, 2fr); gap: 12px 18px; }
@media (max-width: 1100px) {
  .pc-form { grid-template-columns: 1fr; }
}
.pc-field { display: flex; flex-direction: column; gap: 5px; margin-top: 8px; font-size: 12px; color: var(--ink-soft); }
.pc-side { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.pc-side .ghost-btn { align-self: flex-start; margin-top: 8px; }
.pc-side .pill-btn { margin-top: auto; }
.inp {
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.inp.area { resize: vertical; line-height: 1.5; }
.inp:focus { outline: none; border-color: var(--accent); }
.hint { margin: 8px 0 0; font-size: 11.5px; line-height: 1.6; }

/* ── 新建数据集弹窗(工业风:纸面 + 发丝线,与 daq 向导同语) ── */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh 16px 16px;
  background: color-mix(in srgb, var(--ink) 45%, transparent);
  backdrop-filter: blur(3px);
}
.modal {
  width: min(760px, 100%);
  max-height: 84vh;
  padding: 18px 22px 16px;
  overflow-y: auto;
  background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.25);
}
.m-title { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
.f-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 14px; margin-bottom: 10px; }
@media (max-width: 720px) {
  .f-grid { grid-template-columns: 1fr; }
}
.f { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-soft); }
.f.wide { grid-column: 1 / -1; }
.f em { margin-left: 2px; color: var(--tone-danger-dot); font-style: normal; }
.sec-label { margin: 12px 0 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
.node-rows { display: flex; flex-direction: column; gap: 7px; margin-bottom: 12px; }
.node-row { display: flex; gap: 8px; align-items: center; }
.node-row .grow { flex: 1 1 auto; }
.node-row .sel { flex: 0 0 220px; }
.m-err { margin: 6px 0; font-size: 12.5px; color: var(--tone-danger-dot); }
.m-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 12px; }

.empty { margin: 6px 0; padding: 18px 0; font-size: 12.5px; color: var(--ink-faint); text-align: center; }
</style>
