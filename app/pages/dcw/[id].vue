<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { DCW_DRIVERS, type DcwTemplateIcon, type LineQueryResult, type RecipeRunData } from '#shared/dcw-protocol'
import type { DriverConfigField } from '#shared/daq-protocol'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import { useDaqStream } from '~/composables/workshop/useDaqStream'
import { useDeviceTwins } from '~/composables/workshop/useDeviceTwins'

const { t } = useI18n()

const route = useRoute()
const dcw = useDcwStream()
const daq = useDaqStream()
const deviceTwins = useDeviceTwins()
void daq.load()

/** 路由产线 id;总览页「产线管理」进入 */
const lineId = computed(() => String(route.params.id ?? ''))
const line = computed(() => dcw.lines.find(l => l.id === lineId.value))
const ls = computed(() => dcw.lineStateOf(lineId.value))

void dcw.load()
/** WS 喂帧:节点变更(dcw.node.changed)/写 ACK 实时收敛 —— 本页状态同步的通道 */
const unsubDcw = dcw.ensureWsFeed()
onUnmounted(() => unsubDcw())

const deviceName = (id: string | null): string =>
  id ? (deviceTwins.twins.find(t => t.id === id)?.name ?? id) : t('dcwDetail.k3own4q121')

const stateLabel: Record<string, string> = {
  idle: t('dcwDetail.k3zgkk122'), writing: t('dcwDetail.k3l3h80123'), ok: '已 ACK', error: t('dcwDetail.k40reu124'), offline: t('dcwDetail.k44c2n125'),
}

function dcwTemplateRefCh(templateRef?: string): string {
  const ref = templateRef ?? ''
  const tpl = dcw.templates.find(t => t.key === (ref.startsWith('dcw-') ? ref.slice(4) : ref))
  return tpl?.ch ?? ref
}

/** 配方参数窗口提示:目标节点的全局工艺量程 */
function nodeMin(nodeId: string): number | undefined {
  return dcw.nodeById(nodeId)?.min
}
function nodeMax(nodeId: string): number | undefined {
  return dcw.nodeById(nodeId)?.max
}

/** 本产线数采节点(配方监控窗口的可选目标) */
const lineDaqNodes = computed(() => daq.nodes.filter(n => n.lineId === lineId.value))

/** 监控窗口 chip 显示:数采节点参数语义 */
function daqNodeCh(nodeId: string): string {
  return daq.nodeById(nodeId)?.name ?? nodeId
}

// ---------- 产线作用域数据(仅本产线 + 未分配收编) ----------
/** 本产线节点(直写表) */
const lineNodes = computed(() => dcw.nodes.filter(n => n.lineId === lineId.value))
/** 本产线产品 */
const lineProducts = computed(() => dcw.products.filter(p => p.lineId === lineId.value))
/** 本产线配方 */
const lineRecipesAll = computed(() => dcw.recipes.filter(r => r.lineId === lineId.value))
/** 本产线批次 */
const lineRuns = computed(() => dcw.runs.filter(r => r.lineId === lineId.value))
/** 本产线写历史(按本产线节点过滤) */
const lineHistory = computed(() => {
  const ids = new Set(lineNodes.value.map(n => n.id))
  return dcw.history.filter(h => ids.has(h.nodeId))
})
/** 未分配节点/产品(可收编进本产线) */
const unassignedNodes = computed(() => dcw.nodes.filter(n => !n.lineId))
const unassignedProducts = computed(() => dcw.products.filter(p => !p.lineId))

async function adoptNode(id: string): Promise<void> {
  await dcw.patchNode(id, { lineId: lineId.value })
  const n = dcw.nodeById(id)
  if (n) n.lineId = lineId.value
}
async function adoptProduct(id: string): Promise<void> {
  await dcw.updateProduct(id, { lineId: lineId.value })
  await dcw.load()
}

// ---------- 直写 ----------
const setInputs = reactive<Record<string, number | ''>>({})
const writingId = ref('')
const writeError = ref('')
const writeOk = ref('')

async function doWrite(nodeId: string, value: number): Promise<void> {
  writingId.value = nodeId
  writeError.value = ''
  writeOk.value = ''
  try {
    const outcome = await dcw.write(nodeId, value)
    if (outcome.ok) {
      writeOk.value = t('dcwDetail.k1alcbyu182', { p0: dcw.nodeById(nodeId)?.name ?? nodeId, p1: outcome.message })
      setInputs[nodeId] = ''
    }
    else {
      writeError.value = t('dcwDetail.kl1e9x9183', { p0: dcw.nodeById(nodeId)?.name ?? nodeId, p1: outcome.message })
    }
  }
  catch (err) {
    writeError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    writingId.value = ''
  }
}

// ---------- 逐节点 控制开启/暂停 ----------
const togglingId = ref('')
/** 开启/暂停单个节点的控制:暂停后服务端拒绝一切下发(409 当前节点暂停),本地即时收敛状态 */
async function toggleControl(nodeId: string, enabled: boolean): Promise<void> {
  togglingId.value = nodeId
  writeError.value = ''
  try {
    await dcw.patchNode(nodeId, { enabled })
    const n = dcw.nodeById(nodeId)
    if (n) {
      n.enabled = enabled
      if (!enabled) n.state = 'offline'
      else if (n.state === 'offline') n.state = 'idle'
    }
  }
  catch (err) {
    writeError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    togglingId.value = ''
  }
}

// ---------- 添加控制节点向导 ----------
const addOpen = ref(false)
const addScenario = ref<'mock' | 'real'>('mock')
const addTemplate = ref(dcw.templates[0]?.key ?? '')
const addDriver = ref<'mock' | 'modbus-tcp' | 'opcua'>('mock')
const addName = ref('')
const addHold = ref<number | null>(null)
const addCfg = ref<Record<string, string | number>>({})
const addTransform = reactive({ kind: 'none' as 'none' | 'linear', scale: 1, offset: 0 })
const addSemantics = ref('')
const addTesting = ref(false)
const addTest = ref<{ ok: boolean, message: string } | null>(null)
const addSaving = ref(false)
const addError = ref('')

const addDriverMeta = computed(() => DCW_DRIVERS.find(d => d.kind === addDriver.value))
const addFields = computed<DriverConfigField[]>(() => addDriverMeta.value?.configFields ?? [])

function resetAddCfg(): void {
  const cfg: Record<string, string | number> = {}
  for (const f of addFields.value) {
    if (f.default !== undefined) cfg[f.key] = f.default
  }
  addCfg.value = cfg
  addTest.value = null
}
void resetAddCfg()

async function doTestConnection(): Promise<void> {
  addTesting.value = true
  addTest.value = null
  try {
    addTest.value = await dcw.testDriver(addDriver.value, addCfg.value)
  }
  catch (err) {
    addTest.value = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  finally {
    addTesting.value = false
  }
}

async function doAddNode(): Promise<void> {
  addSaving.value = true
  addError.value = ''
  try {
    for (const f of addFields.value) {
      if (f.required && (addCfg.value[f.key] === undefined || addCfg.value[f.key] === '')) {
        throw new Error(t('dcwDetail.k8x1un1184', { p0: f.label }))
      }
    }
    const transform = addTransform.kind === 'linear'
      ? { kind: 'linear' as const, scale: Number(addTransform.scale), offset: Number(addTransform.offset) }
      : undefined
    await dcw.createFromTemplate(`dcw-${addTemplate.value}`, {
      name: addName.value.trim() || undefined,
      driver: addDriver.value,
      driverConfig: { ...addCfg.value },
      transform,
      holdIntervalMs: addHold.value,
      lineId: lineId.value,
      semantics: addSemantics.value.trim() || undefined,
    })
    addOpen.value = false
    addName.value = ''
    addSemantics.value = ''
  }
  catch (err) {
    addError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    addSaving.value = false
  }
}

// ---------- 添加控制节点模板(自定义创建) ----------
const tplOpen = ref(false)
const tplSaving = ref(false)
const tplError = ref('')
const tplOk = ref('')

function openTplModal(): void {
  tplOpen.value = true
  tplError.value = ''
  tplOk.value = ''
}

const tplForm = reactive({
  name: '', ch: '', code: '', unit: '', min: '' as number | '', max: '' as number | '',
  decimals: 1, icon: 'gateway' as DcwTemplateIcon, semantics: '',
})
const tplIcons: Array<{ key: DcwTemplateIcon, label: string }> = [
  { key: 'thermo', label: t('dcwDetail.k422b8126') },
  { key: 'pressure', label: t('dcwDetail.k3x6ff127') },
  { key: 'tension', label: t('dcwDetail.k3z9xc128') },
  { key: 'encoder', label: t('dcwDetail.kjb3vhs129') },
  { key: 'camera', label: t('dcwDetail.k47atw130') },
  { key: 'gateway', label: t('dcwDetail.k48c07131') },
]

async function doCreateTemplate(): Promise<void> {
  tplSaving.value = true
  tplError.value = ''
  tplOk.value = ''
  try {
    if (!tplForm.name.trim()) throw new Error(t('dcwDetail.k6ugbw2132'))
    if (tplForm.unit.trim() === '') throw new Error(t('dcwDetail.kx3pg59133'))
    if (tplForm.min === '' || tplForm.max === '') throw new Error(t('dcwDetail.k13awowo134'))
    const tpl = await dcw.createTemplate({
      name: tplForm.name.trim(),
      ch: tplForm.ch.trim() || tplForm.name.trim(),
      code: tplForm.code.trim() || 'CUSTOM',
      unit: tplForm.unit.trim(),
      min: Number(tplForm.min),
      max: Number(tplForm.max),
      decimals: Number(tplForm.decimals) || 0,
      icon: tplForm.icon,
      semantics: tplForm.semantics.trim() || undefined,
    })
    // 新模板即刻可选:添加控制节点向导自动选中它,下拉随 store 响应式更新
    addTemplate.value = tpl.key
    tplOk.value = t('dcwDetail.ky4e1tr185', { p0: tpl.name })
    tplForm.name = ''
    tplForm.ch = ''
    tplForm.code = ''
    tplForm.unit = ''
    tplForm.min = ''
    tplForm.max = ''
    tplForm.semantics = ''
  }
  catch (err) {
    tplError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    tplSaving.value = false
  }
}

// ---------- 产线开跑/停止(逐产线) ----------
const lineProductId = ref('')
const lineRecipeId = ref('')
const lineBusy = ref(false)
const lineMsg = ref('')
const lineErr = ref('')

const lineRecipes = computed(() => lineRecipesAll.value.filter(r => r.productId === lineProductId.value))

async function doLineStart(): Promise<void> {
  lineBusy.value = true
  lineMsg.value = ''
  lineErr.value = ''
  try {
    if (!lineRecipeId.value) {
      throw new Error(t('dcwDetail.k1b6qe0r135'))
    }
    await dcw.startLine(lineId.value, lineRecipeId.value)
    lineMsg.value = t('dcwDetail.k17jteb9186', { p0: ls.value.productName, p1: ls.value.recipeName, p2: ls.value.runId })
  }
  catch (err) {
    lineErr.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    lineBusy.value = false
  }
}

async function doLineStop(): Promise<void> {
  lineBusy.value = true
  lineMsg.value = ''
  lineErr.value = ''
  try {
    const was = `${ls.value.productName ?? ''} · ${ls.value.recipeName ?? ''}`
    await dcw.stopLine(lineId.value)
    lineMsg.value = t('dcwDetail.kzl49pd187', { p0: was })
  }
  catch (err) {
    lineErr.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    lineBusy.value = false
  }
}

// ---------- 产品管理 ----------
const productOpen = ref(false)
const productSaving = ref(false)
const productError = ref('')
const productForm = reactive({ name: '', description: '' })
const filterProductId = ref('')

async function doCreateProduct(): Promise<void> {
  productSaving.value = true
  productError.value = ''
  try {
    const p = await dcw.createProduct({ name: productForm.name.trim(), description: productForm.description.trim(), lineId: lineId.value })
    lineProductId.value = p.id
    filterProductId.value = p.id
    productOpen.value = false
    productForm.name = ''
    productForm.description = ''
  }
  catch (err) {
    productError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    productSaving.value = false
  }
}

const visibleRecipes = computed(() =>
  filterProductId.value
    ? lineRecipesAll.value.filter(r => r.productId === filterProductId.value)
    : lineRecipesAll.value,
)
const productName = (id: string): string => dcw.products.find(p => p.id === id)?.name ?? id

// ---------- 产线数据查询(产品/配方/参数/时间/间隔;限定本产线通道) ----------
const query = reactive({
  productId: '',
  recipeId: '',
  paramKey: '',
  nodeId: '',
  lastMin: 30,
  bucketMs: 0,
})
const queryResult = ref<LineQueryResult | null>(null)
const queryBusy = ref(false)
const queryError = ref('')

async function doQuery(): Promise<void> {
  queryBusy.value = true
  queryError.value = ''
  queryResult.value = null
  try {
    queryResult.value = await dcw.queryLine({
      lineId: lineId.value,
      productId: query.productId || undefined,
      recipeId: query.recipeId || undefined,
      paramKey: query.paramKey || undefined,
      nodeId: query.nodeId || undefined,
      fromMs: Date.now() - query.lastMin * 60_000,
      toMs: Date.now(),
      bucketMs: query.bucketMs > 0 ? query.bucketMs : undefined,
      limit: 2000,
    })
    if (queryResult.value.channels.length === 0) queryError.value = t('dcwDetail.kszv5sq136')
  }
  catch (err) {
    queryError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    queryBusy.value = false
  }
}

/** 查询参数选项(DAQ 模板 key,含自定义) */
const daqParamKeys = computed(() => dcw.templates.map(t => t.key))

// ---------- Recipe 配方管理(参数节点级绑定) ----------
const recipeOpen = ref(false)
const recipeEditing = ref<string | null>(null)
const recipeSaving = ref(false)
const recipeError = ref('')
const recipeForm = reactive({
  productId: '',
  name: '',
  description: '',
  params: [] as Array<{ nodeId: string, value: number | '', min: number | '', max: number | '' }>,
  daqWindows: [] as Array<{ nodeId: string, min: number | '', max: number | '' }>,
})
const applyResult = ref<{ runId: string, ok: number, total: number } | null>(null)
const runDataView = ref<{ runId: string, data: RecipeRunData } | null>(null)
const runDataLoading = ref(false)

function openRecipeCreate(): void {
  recipeEditing.value = null
  recipeError.value = ''
  recipeForm.productId = filterProductId.value || lineProductId.value || lineProducts.value[0]?.id || ''
  recipeForm.name = ''
  recipeForm.description = ''
  recipeForm.params = [{ nodeId: lineNodes.value[0]?.id ?? '', value: '', min: '', max: '' }]
  recipeForm.daqWindows = []
  recipeOpen.value = true
}

function openRecipeEdit(id: string): void {
  const r = dcw.recipes.find(x => x.id === id)
  if (!r) return
  recipeEditing.value = id
  recipeError.value = ''
  recipeForm.productId = r.productId
  recipeForm.name = r.name
  recipeForm.description = r.description
  recipeForm.params = r.params.map(p => ({
    nodeId: p.nodeId,
    value: p.value,
    min: p.min ?? '',
    max: p.max ?? '',
  }))
  recipeForm.daqWindows = (r.daqWindows ?? []).map(w => ({
    nodeId: w.nodeId,
    min: w.min ?? '',
    max: w.max ?? '',
  }))
  recipeOpen.value = true
}

async function saveRecipe(): Promise<void> {
  recipeSaving.value = true
  recipeError.value = ''
  try {
    const input = {
      productId: recipeForm.productId,
      name: recipeForm.name.trim(),
      description: recipeForm.description.trim(),
      params: recipeForm.params
        .filter(p => p.nodeId && p.value !== '' && Number.isFinite(Number(p.value)))
        .map(p => ({
          nodeId: p.nodeId,
          value: Number(p.value),
          ...(p.min !== '' && Number.isFinite(Number(p.min)) ? { min: Number(p.min) } : {}),
          ...(p.max !== '' && Number.isFinite(Number(p.max)) ? { max: Number(p.max) } : {}),
        })),
      daqWindows: recipeForm.daqWindows
        .filter(w => w.nodeId && (w.min !== '' || w.max !== ''))
        .map(w => ({
          nodeId: w.nodeId,
          ...(w.min !== '' && Number.isFinite(Number(w.min)) ? { min: Number(w.min) } : {}),
          ...(w.max !== '' && Number.isFinite(Number(w.max)) ? { max: Number(w.max) } : {}),
        })),
    }
    if (recipeEditing.value) await dcw.updateRecipe(recipeEditing.value, input)
    else await dcw.createRecipe(input)
    recipeOpen.value = false
  }
  catch (err) {
    recipeError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    recipeSaving.value = false
  }
}

async function doApplyRecipe(id: string): Promise<void> {
  applyResult.value = null
  writeError.value = ''
  try {
    const run = await dcw.applyRecipe(id)
    const ok = run.results.filter(r => r.ok).length
    applyResult.value = { runId: run.id, ok, total: run.results.length }
    if (ok < run.results.length) writeError.value = t('dcwDetail.ks7szkt188', { p0: run.results.filter(r => !r.ok).map(r => r.message).join(';') })
  }
  catch (err) {
    writeError.value = err instanceof Error ? err.message : String(err)
  }
}

async function doViewRun(id: string): Promise<void> {
  runDataLoading.value = true
  try {
    const data = await dcw.runData(id)
    runDataView.value = { runId: id, data }
  }
  catch (err) {
    writeError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    runDataLoading.value = false
  }
}

/** 查询点位展示(原始值或桶均值) */
function fmtPoint(p: { value?: number, avg?: number } | undefined): string {
  const v = p?.value ?? p?.avg
  return v == null ? '--' : String(Math.round(v * 1000) / 1000)
}
</script>

<template>
  <div
    v-if="dcw.loaded && !line"
    class="page"
  >
    <p class="banner bad">
      {{ $t('dcwDetail.k19337yp018') }}
    </p>
    <NuxtLink
      class="pill-btn"
      to="/dcw"
    >
      {{ $t('dcwDetail.kllwu1c019') }}
    </NuxtLink>
  </div>
  <div
    v-else
    class="page"
  >
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          <span
            class="line-chip"
            :style="{ background: line?.color ?? '#3aa0ff' }"
          />AGENTWORKSHOP / LINE / {{ line?.name ?? lineId }}
        </p>
        <h1>{{ line?.name ?? $t('dcwDetail.k1b2snna151') }} · {{ $t('dcwDetail.k1l0iow1137') }}</h1>
        <p class="sub">
          {{ line?.description || $t('dcwDetail.kzcbfki152') }}
        </p>
      </div>
      <div class="badges mono">
        <span class="badge">{{ $t('dcwDetail.k45uio082') }} {{ lineNodes.length }}</span>
        <span class="badge">{{ $t('dcwDetail.k3waz1025') }} {{ lineProducts.length }}</span>
        <span class="badge">{{ $t('dcwDetail.k48grv027') }} {{ lineRecipesAll.length }}</span>
      </div>
    </div>

    <!-- 网关总控条 -->
    <section class="aw-tile ctrl-card">
      <div class="ctrl-left">
        <button
          class="aw-pill"
          :class="{ running: dcw.controller.running }"
          @click="dcw.startStop(dcw.controller.running ? 'stop' : 'start')"
        >
          <span :class="dcw.controller.running ? 'i-tabler-player-pause' : 'i-tabler-player-play'" />
          {{ dcw.controller.running ? $t('dcwDetail.kplrsg153') : $t('dcwDetail.knxgni9169') }}
        </button>
      </div>
      <div class="ctrl-right">
        <span class="ctrl-metrics mono">
          <span>{{ $t('dcwDetail.k45uio082') }} {{ dcw.controller.nodesOnline }}/{{ dcw.controller.nodesTotal }}</span>
          <span class="sep">·</span>
          <span :title="$t('dcwDetail.kd3ygmn001')">{{ $t('dcwDetail.k3wtib138') }} {{ dcw.controller.writesTotal }}</span>
          <span class="sep">·</span>
          <span
            :class="{ warn: dcw.controller.writesFailed > 0 }"
            :title="$t('dcwDetail.kd3znl0002')"
          >{{ $t('dcwDetail.k3yit7139') }} {{ dcw.controller.writesFailed }}</span>
        </span>
        <button
          class="aw-pill outline"
          :title="$t('dcwDetail.kc4ixly003')"
          @click="openTplModal"
        >
          <span class="i-tabler-template" />
          {{ $t('dcwDetail.k1972dx9020') }}
        </button>
        <button
          class="aw-pill add-btn"
          @click="addOpen = true"
        >
          <span class="i-tabler-plus" />
          {{ $t('dcwDetail.k1976uns021') }}
        </button>
      </div>
    </section>

    <!-- 写错误/成功横幅 -->
    <p
      v-if="writeError || writeOk"
      class="banner"
      :class="writeError ? 'bad' : 'good'"
    >
      {{ writeError || writeOk }}
    </p>

    <!-- 未分配资产收编(历史节点/产品迁移到本产线) -->
    <section
      v-if="unassignedNodes.length || unassignedProducts.length"
      class="aw-tile adopt-card"
    >
      <b class="adopt-title">{{ $t('dcwDetail.kaebkky022') }}</b>
      <div class="adopt-list">
        <span
          v-for="n in unassignedNodes"
          :key="n.id"
          class="adopt-chip"
        >
          {{ n.name }}
          <button
            class="mini-btn"
            @click="adoptNode(n.id)"
          >
            {{ $t('dcwDetail.kyjp9fg023') }}
          </button>
        </span>
        <span
          v-for="p in unassignedProducts"
          :key="p.id"
          class="adopt-chip"
        >
          {{ p.name }}({{ $t('dcwDetail.k3km252140') }}<button
            class="mini-btn"
            @click="adoptProduct(p.id)"
          >
            {{ $t('dcwDetail.kyjp9fg023') }}
          </button>
        </span>
      </div>
    </section>

    <!-- 产线运行控制:开跑必设配方;窗口内数采逐样本打标 -->
    <section class="aw-tile line-card">
      <div class="line-status">
        <span
          class="line-dot"
          :class="{ on: ls.active }"
        />
        <div class="line-info">
          <b>{{ ls.active ? $t('dcwDetail.k1pxrhx0154') : $t('dcwDetail.k1b2hxmx170') }}</b>
          <small
            v-if="ls.active"
            class="mono dim"
          >{{ ls.productName }} · {{ ls.recipeName }} · {{ $t('dcwDetail.k400lb075') }} {{ ls.runId }} · {{ $t('dcwDetail.k3zkt2166') }} {{ ls.startedAt?.slice(11, 19) }} {{ $t('dcwDetail.k69vag8168') }} {{ ls.taggedSamples }} {{ $t('dcwDetail.k4118o085') }}</small>
          <small
            v-else
            class="dim"
          >{{ $t('dcwDetail.k19pof14024') }}</small>
        </div>
      </div>
      <div class="line-ctl">
        <label class="ctl-sel">
          <span>{{ $t('dcwDetail.k3waz1025') }}</span>
          <select
            v-model="lineProductId"
            class="inp"
            @change="lineRecipeId = ''"
          >
            <option value="">
              {{ $t('dcwDetail.kuisodh026') }}
            </option>
            <option
              v-for="p in lineProducts"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </select>
        </label>
        <label class="ctl-sel">
          <span>{{ $t('dcwDetail.k48grv027') }}</span>
          <select
            v-model="lineRecipeId"
            class="inp"
            :disabled="!lineProductId"
          >
            <option value="">
              {{ $t('dcwDetail.kutxzsz028') }}
            </option>
            <option
              v-for="r in lineRecipes"
              :key="r.id"
              :value="r.id"
              :disabled="r.params.length === 0"
            >
              {{ r.name }}{{ r.params.length === 0 ? $t('dcwDetail.k1hicmch155') : $t('dcwDetail.k1lzfi4g180', { p0: r.params.length }) }}
            </option>
          </select>
        </label>
        <button
          v-if="!ls.active"
          class="pill-btn"
          :disabled="lineBusy || !lineRecipeId"
          :title="!lineRecipeId ? '开跑前必须先设定配方' : '下发配方参数并开始打标数据采集'"
          @click="doLineStart"
        >
          {{ $t('dcwDetail.kfb8vml029') }}
        </button>
        <button
          v-else
          class="pill-btn stop"
          :disabled="lineBusy"
          @click="doLineStop"
        >
          {{ $t('dcwDetail.k1xyhd2y030') }}
        </button>
      </div>
      <p
        v-if="lineErr"
        class="banner bad"
        style="margin-top: 10px;"
      >
        {{ lineErr }}
      </p>
      <p
        v-if="lineMsg"
        class="banner good"
        style="margin-top: 10px;"
      >
        {{ lineMsg }}
      </p>
    </section>

    <!-- 添加控制节点模板(自定义创建) -->
    <div
      v-if="tplOpen"
      class="modal-mask"
      @click.self="tplOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          {{ $t('dcwDetail.k1x4vam0031') }} <small class="dim mono">{{ $t('dcwDetail.k3x23c141') }} {{ dcw.templates.filter(t => t.builtin).length }} · {{ $t('dcwDetail.k3t616a142') }} {{ dcw.templates.filter(t => !t.builtin).length }}</small>
        </h3>
        <p class="dim tpl-hint">
          {{ $t('dcwDetail.ke1iyud032') }}
        </p>

        <div class="tpl-chips">
          <span
            v-for="t in dcw.templates"
            :key="t.key"
            class="tpl-chip"
            :title="`${t.code} · ${t.min}~${t.max} ${t.unit}${t.semantics ? ` · ${t.semantics}` : ''}`"
          >
            {{ t.name }} <small class="mono">{{ t.min }}~{{ t.max }}{{ t.unit }}</small>
            <em
              class="tpl-tag"
              :class="{ builtin: t.builtin }"
            >{{ t.builtin ? $t('dcwDetail.k3x23c141') : $t('dcwDetail.k3t616a142') }}</em>
          </span>
        </div>

        <p class="sec-label">
          {{ $t('dcwDetail.k169eb4s033') }}
        </p>
        <div class="f-grid tpl-form">
          <label class="f">
            <span>{{ $t('dcwDetail.k1f55q76034') }}<em>*</em></span>
            <input
              v-model="tplForm.name"
              class="inp"
              :placeholder="$t('dcwDetail.k1tooi3o004')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k1bqk219035') }}</span>
            <input
              v-model="tplForm.ch"
              class="inp"
              :placeholder="$t('dcwDetail.k698qz0005')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k1ayxrqb036') }}</span>
            <input
              v-model="tplForm.code"
              class="inp"
              placeholder="如 MOTOR · I"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k3x4ef037') }}<em>*</em></span>
            <input
              v-model="tplForm.unit"
              class="inp"
              placeholder="如 A"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k1l9jv5m038') }}<em>*</em></span>
            <input
              v-model.number="tplForm.min"
              type="number"
              class="inp"
              :placeholder="$t('dcwDetail.kxz9174006')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k1l9jv4p039') }}<em>*</em></span>
            <input
              v-model.number="tplForm.max"
              type="number"
              class="inp"
              :placeholder="$t('dcwDetail.kxz9167007')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k3mxmcx040') }}</span>
            <input
              v-model.number="tplForm.decimals"
              type="number"
              min="0"
              max="4"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k3xx56041') }}</span>
            <select
              v-model="tplForm.icon"
              class="inp"
            >
              <option
                v-for="ic in tplIcons"
                :key="ic.key"
                :value="ic.key"
              >
                {{ ic.label }}
              </option>
            </select>
          </label>
        </div>
        <label class="f">
          <span>{{ $t('dcwDetail.knjmyfr042') }}</span>
          <textarea
            v-model="tplForm.semantics"
            class="inp"
            rows="2"
            :placeholder="$t('dcwDetail.k1qdnfzc008')"
          />
        </label>

        <p
          v-if="tplOk"
          class="banner good"
          style="margin-top: 10px;"
        >
          {{ tplOk }}
        </p>
        <p
          v-if="tplError"
          class="m-err"
        >
          {{ tplError }}
        </p>
        <div class="m-actions">
          <button
            class="aw-pill outline"
            @click="tplOpen = false"
          >
            {{ $t('dcwDetail.k3x62t043') }}
          </button>
          <button
            class="pill-btn"
            :disabled="tplSaving || !tplForm.name.trim() || tplForm.unit.trim() === '' || tplForm.min === '' || tplForm.max === ''"
            @click="doCreateTemplate"
          >
            {{ tplSaving ? $t('dcwDetail.k1bg4759156') : $t('dcwDetail.k1bg9nga171') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 添加控制节点向导 -->
    <div
      v-if="addOpen"
      class="modal-mask"
      @click.self="addOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          {{ $t('dcwDetail.k1976uns021') }}
        </h3>

        <div class="seg-row">
          <button
            class="seg"
            :class="{ on: addScenario === 'mock' }"
            @click="addScenario = 'mock'"
          >
            Mock 模拟 PLC
          </button>
          <button
            class="seg"
            :class="{ on: addScenario === 'real' }"
            @click="addScenario = 'real'"
          >
            {{ $t('dcwDetail.kyj8fen044') }}
          </button>
        </div>

        <div class="f-grid">
          <label class="f">
            <span>{{ $t('dcwDetail.k1ejzwqp045') }}</span>
            <select
              v-model="addTemplate"
              class="inp"
            >
              <option
                v-for="t in dcw.templates"
                :key="t.key"
                :value="t.key"
              >
                {{ t.name }} · {{ t.ch }}({{ t.min }}~{{ t.max }} {{ t.unit }}){{ t.builtin ? '' : $t('dcwDetail.kr45rk9157') }}
              </option>
            </select>
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k1ce2k1y046') }}</span>
            <input
              v-model="addName"
              class="inp"
              :placeholder="$t('dcwDetail.kgpxzy3009')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k1vyb8im047') }}</span>
            <input
              v-model.number="addHold"
              type="number"
              min="0"
              max="3600000"
              step="500"
              class="inp"
              :placeholder="$t('dcwDetail.kb1srz0010')"
            >
          </label>
        </div>

        <!-- 数据语义标定 encode(物理设定值 → PLC 设定值;mock/真实均可用) -->
        <div class="f-grid cal-form">
          <label class="f">
            <span>{{ $t('dcwDetail.kiune1f048') }}</span>
            <select
              v-model="addTransform.kind"
              class="inp"
            >
              <option value="none">
                {{ $t('dcwDetail.kkzy0k049') }}
              </option>
              <option value="linear">
                线性标定:PLC值 = (物理值 - offset) / scale
              </option>
            </select>
          </label>
          <label class="f">
            <span>scale / offset</span>
            <div style="display: flex; gap: 6px;">
              <input
                v-model.number="addTransform.scale"
                type="number"
                step="0.1"
                class="inp"
                :disabled="addTransform.kind !== 'linear'"
                title="decoder 斜率(≠0):物理值 = scale × PLC值 + offset;下发时自动取逆"
              >
              <input
                v-model.number="addTransform.offset"
                type="number"
                step="0.1"
                class="inp"
                :disabled="addTransform.kind !== 'linear'"
                title="decoder 截距"
              >
            </div>
          </label>
        </div>

        <template v-if="addScenario === 'real'">
          <div class="f-grid">
            <label class="f">
              <span>{{ $t('dcwDetail.k1kt87rx050') }}</span>
              <select
                v-model="addDriver"
                class="inp"
              >
                <option
                  v-for="d in DCW_DRIVERS.filter(x => x.status !== 'builtin')"
                  :key="d.kind"
                  :value="d.kind"
                >
                  {{ d.label }}
                </option>
              </select>
            </label>
          </div>
          <div
            v-if="addFields.length"
            class="f-grid driver-form"
          >
            <label
              v-for="f in addFields"
              :key="f.key"
              class="f"
            >
              <span>{{ f.label }}<em
                v-if="f.required"
                style="color: var(--tone-danger-dot); font-style: normal;"
              >*</em></span>
              <select
                v-if="f.type === 'select'"
                v-model="addCfg[f.key]"
                class="inp"
              >
                <option
                  v-for="o in f.options"
                  :key="o.value"
                  :value="o.value"
                >
                  {{ o.label }}
                </option>
              </select>
              <input
                v-else
                v-model="addCfg[f.key]"
                :type="f.type === 'number' ? 'number' : 'text'"
                :placeholder="f.placeholder"
                class="inp"
              >
              <small
                v-if="f.hint"
                class="hint"
              >{{ f.hint }}</small>
            </label>
          </div>
          <div class="test-row">
            <button
              class="pill-btn outline"
              :disabled="addTesting"
              @click="doTestConnection"
            >
              {{ addTesting ? $t('dcwDetail.k1fsh720158') : $t('dcwDetail.k1fstglk172') }}
            </button>
            <span
              v-if="addTest"
              class="test-result"
              :class="addTest.ok ? 'good' : 'bad'"
            >{{ addTest.ok ? '✓' : '✗' }} {{ addTest.message }}</span>
          </div>
        </template>

        <label class="f">
          <span>{{ $t('dcwDetail.k1hgizn7051') }}</span>
          <textarea
            v-model="addSemantics"
            class="inp"
            rows="2"
            :placeholder="$t('dcwDetail.k12bnyt9011')"
          />
        </label>

        <p
          v-if="addError"
          class="m-err"
        >
          {{ addError }}
        </p>

        <div class="m-actions">
          <button
            class="aw-pill outline"
            @click="addOpen = false"
          >
            {{ $t('dcwDetail.k3xdnn052') }}
          </button>
          <button
            class="aw-pill"
            :disabled="addSaving"
            @click="doAddNode"
          >
            {{ addSaving ? $t('dcwDetail.k1bg4759156') : $t('dcwDetail.k1bge46t173') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 控制节点清单 -->
    <a-spin :spinning="!dcw.loaded && !dcw.error">
      <section class="aw-tile table-card">
        <table class="nodes-table">
          <thead>
            <tr>
              <th>{{ $t('dcwDetail.k1e2dtkt053') }}</th>
              <th>{{ $t('dcwDetail.k403cy054') }}</th>
              <th>{{ $t('dcwDetail.k42w8s055') }}</th>
              <th>{{ $t('dcwDetail.k1deqh0d056') }}</th>
              <th>{{ $t('dcwDetail.k1k79ec9057') }}</th>
              <th>{{ $t('dcwDetail.k1dexou6058') }}</th>
              <th>{{ $t('dcwDetail.k1b1nnaa059') }}</th>
              <th>{{ $t('dcwDetail.k1i8rtqt060') }}</th>
              <th class="right">
                {{ $t('dcwDetail.k40aa6061') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="n in lineNodes"
              :key="n.id"
              :class="{ 'node-paused': !n.enabled }"
            >
              <td>
                <span class="mono dim">{{ n.id.slice(0, 8) }}</span>
                <b>{{ n.name }}</b>
                <small class="mono ch">{{ dcwTemplateRefCh(n.templateRef) }}</small>
              </td>
              <td>
                <button
                  class="ctrl-toggle"
                  :class="{ on: n.enabled }"
                  :disabled="togglingId === n.id"
                  :title="n.enabled ? '暂停该节点控制:下发将被拒绝' : '开启该节点控制:恢复可下发'"
                  @click="toggleControl(n.id, !n.enabled)"
                >
                  <span class="ct-dot" />
                  {{ n.enabled ? $t('dcwDetail.k3o3ib3159') : $t('dcwDetail.k3n93ed062') }}
                </button>
              </td>
              <td>
                <span
                  v-if="!n.enabled"
                  class="st-pill paused"
                >{{ $t('dcwDetail.k3n93ed062') }}</span>
                <span
                  v-else
                  class="st-pill"
                  :class="n.state"
                >{{ stateLabel[n.state] ?? n.state }}</span>
              </td>
              <td class="mono val">
                {{ n.value != null ? n.value.toFixed(n.decimals) : '--' }}
                <small>{{ n.unit }}</small>
                <small
                  v-if="n.lastAckAt"
                  class="dim"
                > · {{ n.lastAckAt.slice(11, 19) }}</small>
              </td>
              <td>
                <div class="write-row">
                  <input
                    v-model.number="setInputs[n.id]"
                    type="number"
                    class="inp write-inp mono"
                    :placeholder="`${n.min}~${n.max}`"
                    :min="n.min"
                    :max="n.max"
                    :step="10 ** -n.decimals"
                    :disabled="!n.enabled"
                    :title="!n.enabled ? '当前节点暂停:开启控制后方可设定' : ''"
                  >
                  <button
                    class="mini-btn write-btn"
                    :disabled="!n.enabled || writingId === n.id || setInputs[n.id] == null || setInputs[n.id] === ''"
                    :title="!n.enabled ? '当前节点暂停:开启控制后方可设定' : '下发设定值'"
                    @click="doWrite(n.id, Number(setInputs[n.id]))"
                  >
                    {{ writingId === n.id ? $t('dcwDetail.k3l3h80123') : $t('dcwDetail.k3w6td174') }}
                  </button>
                </div>
              </td>
              <td class="mono dim">
                {{ n.min }} ~ {{ n.max }} {{ n.unit }}
              </td>
              <td class="mono">
                {{ n.holdIntervalMs == null ? $t('dcwDetail.k3zul4160') : `${n.holdIntervalMs}ms` }}
              </td>
              <td>{{ deviceName(n.deviceBindingId) }}</td>
              <td class="right">
                <button
                  class="mini-btn danger"
                  @click="dcw.removeNode(n.id)"
                >
                  {{ $t('dcwDetail.k3xakp063') }}
                </button>
              </td>
            </tr>
            <tr v-if="dcw.loaded && lineNodes.length === 0">
              <td colspan="9">
                <div
                  class="pane-empty"
                  style="min-height: 120px;"
                >
                  <p class="pe-sub">
                    {{ $t('dcwDetail.k1wtecyw064') }}
                  </p>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </a-spin>

    <!-- 产品与配方管理 -->
    <section class="aw-tile recipe-card">
      <div class="recipe-hd">
        <h3>{{ $t('dcwDetail.k1j8w3hd065') }}</h3>
        <span class="panel-tag mono">{{ lineProducts.length }} {{ $t('dcwDetail.k1av3wgs143') }} {{ visibleRecipes.length }} {{ $t('dcwDetail.k48grv027') }}</span>
        <button
          class="pill-btn"
          style="margin-left: auto;"
          @click="openRecipeCreate"
        >
          {{ $t('dcwDetail.k1akm6dc066') }}
        </button>
        <button
          class="mini-btn"
          @click="productOpen = true"
        >
          {{ $t('dcwDetail.k1aka0ki067') }}
        </button>
      </div>
      <p class="recipe-sub">
        {{ $t('dcwDetail.k6bl2q8068') }}
      </p>

      <!-- 产品管理行 -->
      <div
        v-if="lineProducts.length"
        class="product-row"
      >
        <button
          class="prod-chip"
          :class="{ on: filterProductId === '' }"
          @click="filterProductId = ''"
        >
          {{ $t('dcwDetail.k3x4t1069') }}
        </button>
        <button
          v-for="p in lineProducts"
          :key="p.id"
          class="prod-chip"
          :class="{ on: filterProductId === p.id }"
          :title="p.description"
          @click="filterProductId = p.id"
        >
          {{ p.name }}
          <span
            class="prod-del"
            :title="$t('dcwDetail.k1bpfjgx012')"
            @click.stop="dcw.removeProduct(p.id)"
          >×</span>
        </button>
      </div>
      <p
        v-else
        class="dim"
        style="margin: 6px 0 12px; font-size: 12px;"
      >
        {{ $t('dcwDetail.knov3zg070') }}
      </p>

      <div class="recipe-grid">
        <div
          v-for="r in visibleRecipes"
          :key="r.id"
          class="recipe-item"
        >
          <div class="recipe-name">
            <b>{{ r.name }}</b>
            <small class="dim">{{ productName(r.productId) }}</small>
            <small class="mono dim">{{ r.id }}</small>
          </div>
          <p
            v-if="r.description"
            class="dim desc"
          >
            {{ r.description }}
          </p>
          <div class="recipe-params mono">
            <span
              v-for="(p, i) in r.params"
              :key="i"
              class="param-chip"
            >
              {{ (dcw.templates.find(t => t.key === (p.templateRef ?? '').replace('dcw-', ''))?.ch ?? p.templateRef) }} = {{ p.value }}
            </span>
            <span
              v-for="(w, i) in r.daqWindows"
              :key="`w-${i}`"
              class="param-chip daqwin"
              :title="$t('dcwDetail.k1l11api013')"
            >
              ◎ {{ daqNodeCh(w.nodeId) }} ∈ [{{ w.min ?? '-∞' }}, {{ w.max ?? '+∞' }}]
            </span>
          </div>
          <div class="recipe-actions">
            <button
              class="pill-btn"
              @click="doApplyRecipe(r.id)"
            >
              {{ $t('dcwDetail.k1497qvr071') }}
            </button>
            <button
              class="mini-btn"
              @click="openRecipeEdit(r.id)"
            >
              {{ $t('dcwDetail.k45eb0072') }}
            </button>
            <button
              class="mini-btn danger"
              @click="dcw.removeRecipe(r.id)"
            >
              {{ $t('dcwDetail.k3xakp063') }}
            </button>
          </div>
        </div>
        <div
          v-if="visibleRecipes.length === 0"
          class="pane-empty"
          style="grid-column: 1 / -1;"
        >
          {{ $t('dcwDetail.keko1xy073') }}
        </div>
      </div>

      <div
        v-if="applyResult"
        class="banner good"
      >
        {{ $t('dcwDetail.k1l3hrvp144') }} {{ applyResult.runId }} {{ $t('dcwDetail.k1g3lh2v167') }}{{ applyResult.ok }}/{{ applyResult.total }} {{ $t('dcwDetail.k1bqci06149') }}
        <button
          class="mini-btn"
          style="margin-left: 10px;"
          :disabled="runDataLoading"
          @click="doViewRun(applyResult.runId)"
        >
          {{ runDataLoading ? $t('dcwDetail.k1br0ij9161') : $t('dcwDetail.kxwei5175') }}
        </button>
      </div>

      <!-- 批次列表 -->
      <div
        v-if="lineRuns.length"
        class="runs"
      >
        <p class="sec-label">
          {{ $t('dcwDetail.k1rjer8d074') }}
        </p>
        <table class="nodes-table">
          <thead>
            <tr>
              <th>{{ $t('dcwDetail.k400lb075') }}</th>
              <th>{{ $t('dcwDetail.k48grv027') }}</th>
              <th>{{ $t('dcwDetail.k4497j076') }}</th>
              <th>{{ $t('dcwDetail.k1bqhtmu077') }}</th>
              <th class="right">
                {{ $t('dcwDetail.k40aa6061') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="run in [...lineRuns].reverse().slice(0, 8)"
              :key="run.id"
            >
              <td class="mono">
                {{ run.id }}
              </td>
              <td>{{ run.recipeName }}</td>
              <td class="mono dim">
                {{ run.startedAt.slice(5, 19) }} ~ {{ run.endedAt ? run.endedAt.slice(5, 19) : $t('dcwDetail.k3vpfg9162') }}
              </td>
              <td>
                <span
                  class="st-pill"
                  :class="run.results.every(r => r.ok) ? 'ok' : 'warn'"
                >{{ run.results.filter(r => r.ok).length }}/{{ run.results.length }}</span>
              </td>
              <td class="right">
                <button
                  class="mini-btn"
                  :disabled="runDataLoading"
                  @click="doViewRun(run.id)"
                >
                  {{ $t('dcwDetail.k1dzwrdp078') }}
                </button>
                <button
                  v-if="!run.endedAt"
                  class="mini-btn"
                  @click="dcw.closeRun(run.id)"
                >
                  {{ $t('dcwDetail.k1blr7y7079') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 批次数据视图 -->
      <div
        v-if="runDataView"
        class="modal-mask"
        @click.self="runDataView = null"
      >
        <div class="modal">
          <h3 class="m-title">
            {{ $t('dcwDetail.k11lq94k145') }} {{ runDataView.data.run.recipeName }}({{ runDataView.runId }})
          </h3>
          <p class="sec-label">
            {{ $t('dcwDetail.k1me41w8080') }}
          </p>
          <table class="nodes-table">
            <thead>
              <tr>
                <th>{{ $t('dcwDetail.k48hde081') }}</th>
                <th>{{ $t('dcwDetail.k45uio082') }}</th>
                <th>{{ $t('dcwDetail.k40t11083') }}</th>
                <th>{{ $t('dcwDetail.k3xuaw084') }}</th>
                <th>min ~ max</th>
                <th>{{ $t('dcwDetail.k4118o085') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="d in runDataView.data.daq"
                :key="d.nodeId"
              >
                <td>{{ d.ch }}<small class="mono dim"> {{ d.unit }}</small></td>
                <td>{{ d.nodeName }}</td>
                <td class="mono">
                  {{ d.latest }}
                </td>
                <td class="mono">
                  {{ d.avg }}
                </td>
                <td class="mono dim">
                  {{ d.min }} ~ {{ d.max }}
                </td>
                <td class="mono dim">
                  {{ d.cnt }}
                </td>
              </tr>
              <tr v-if="runDataView.data.daq.length === 0">
                <td
                  colspan="6"
                  class="dim"
                  style="text-align: center; padding: 12px;"
                >
                  {{ $t('dcwDetail.kd457ry086') }}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="sec-label">
            {{ $t('dcwDetail.k12b7cxs087') }}
          </p>
          <table class="nodes-table">
            <thead>
              <tr>
                <th>{{ $t('dcwDetail.k3xbjr088') }}</th>
                <th>{{ $t('dcwDetail.k45uio082') }}</th>
                <th>{{ $t('dcwDetail.k3ncbsh089') }}</th>
                <th>{{ $t('dcwDetail.k3lh3mz090') }}</th>
                <th>{{ $t('dcwDetail.k454pg091') }}</th>
                <th>{{ $t('dcwDetail.k40ieu092') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(w, i) in runDataView.data.writes"
                :key="i"
              >
                <td>{{ w.param }}</td>
                <td>{{ w.nodeName }}</td>
                <td class="mono">
                  {{ w.eng }}
                </td>
                <td class="mono dim">
                  {{ w.raw }}
                </td>
                <td>
                  <span
                    class="st-pill"
                    :class="w.ok ? 'ok' : 'alarm'"
                  >{{ w.ok ? 'ACK' : $t('dcwDetail.k3yit7139') }}</span>
                </td>
                <td class="mono dim">
                  {{ w.at.slice(5, 19) }}
                </td>
              </tr>
              <tr v-if="runDataView.data.writes.length === 0">
                <td
                  colspan="6"
                  class="dim"
                  style="text-align: center; padding: 12px;"
                >
                  {{ $t('dcwDetail.knzcp8i093') }}
                </td>
              </tr>
            </tbody>
          </table>
          <div class="m-actions">
            <button
              class="aw-pill outline"
              @click="runDataView = null"
            >
              {{ $t('dcwDetail.k3x62t043') }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 配方编辑弹窗 -->
    <div
      v-if="recipeOpen"
      class="modal-mask"
      @click.self="recipeOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          {{ recipeEditing ? $t('dcwDetail.k1iiwk0i163') : $t('dcwDetail.k1efq0r9176') }}
        </h3>
        <div class="f-grid">
          <label class="f">
            <span>{{ $t('dcwDetail.k1dw4fzf094') }}<em>*</em></span>
            <select
              v-model="recipeForm.productId"
              class="inp"
            >
              <option
                v-for="p in lineProducts"
                :key="p.id"
                :value="p.id"
              >
                {{ p.name }}
              </option>
            </select>
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k1l3f8so095') }}<em>*</em></span>
            <input
              v-model="recipeForm.name"
              class="inp"
              :placeholder="$t('dcwDetail.k12c11vm014')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k40gkk096') }}</span>
            <input
              v-model="recipeForm.description"
              class="inp"
              :placeholder="$t('dcwDetail.k1hxx8hy015')"
            >
          </label>
        </div>
        <p class="sec-label">
          {{ $t('dcwDetail.ka1kfgh097') }}
        </p>
        <div
          v-for="(p, i) in recipeForm.params"
          :key="i"
          class="param-row"
        >
          <label class="f">
            <span>{{ $t('dcwDetail.k1e2dtkt053') }}</span>
            <select
              v-model="p.nodeId"
              class="inp"
            >
              <option
                v-for="n in lineNodes"
                :key="n.id"
                :value="n.id"
              >
                {{ n.name }}({{ dcwTemplateRefCh(n.templateRef) }} · {{ n.min }}~{{ n.max }} {{ n.unit }})
              </option>
            </select>
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k3renp2098') }}<em>*</em></span>
            <input
              v-model.number="p.value"
              type="number"
              class="inp"
              :step="0.1"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k134rw3b146') }}{{ nodeMin(p.nodeId) ?? '-' }})</span>
            <input
              v-model.number="p.min"
              type="number"
              class="inp"
              :step="0.1"
              :placeholder="$t('dcwDetail.k5vew9z016')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.khrv911147') }}{{ nodeMax(p.nodeId) ?? '-' }})</span>
            <input
              v-model.number="p.max"
              type="number"
              class="inp"
              :step="0.1"
              :placeholder="$t('dcwDetail.kzoh5pr017')"
            >
          </label>
          <button
            class="mini-btn danger param-del"
            @click="recipeForm.params.splice(i, 1)"
          >
            {{ $t('dcwDetail.k44idg099') }}
          </button>
        </div>
        <button
          class="mini-btn"
          @click="recipeForm.params.push({ nodeId: lineNodes[0]?.id ?? '', value: '', min: '', max: '' })"
        >
          {{ $t('dcwDetail.k1broh7h100') }}
        </button>
        <p class="sec-label">
          {{ $t('dcwDetail.k1h5gues101') }}
        </p>
        <div
          v-for="(w, i) in recipeForm.daqWindows"
          :key="`dw-${i}`"
          class="param-row"
        >
          <label class="f">
            <span>{{ $t('dcwDetail.k1empnnb102') }}</span>
            <select
              v-model="w.nodeId"
              class="inp"
            >
              <option
                v-for="n in lineDaqNodes"
                :key="n.id"
                :value="n.id"
              >
                {{ n.name }}({{ n.min }}~{{ n.max }} {{ n.unit }})
              </option>
            </select>
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.kqm08ap103') }}</span>
            <input
              v-model.number="w.min"
              type="number"
              class="inp"
              :step="0.1"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.kpypf8g104') }}</span>
            <input
              v-model.number="w.max"
              type="number"
              class="inp"
              :step="0.1"
            >
          </label>
          <button
            class="mini-btn danger param-del"
            @click="recipeForm.daqWindows.splice(i, 1)"
          >
            {{ $t('dcwDetail.k44idg099') }}
          </button>
        </div>
        <button
          class="mini-btn"
          :disabled="lineDaqNodes.length === 0"
          :title="lineDaqNodes.length === 0 ? '本产线暂无数采节点' : ''"
          @click="recipeForm.daqWindows.push({ nodeId: lineDaqNodes[0]?.id ?? '', min: '', max: '' })"
        >
          {{ $t('dcwDetail.kv1de1p105') }}
        </button>
        <p
          v-if="recipeError"
          class="m-err"
        >
          {{ recipeError }}
        </p>
        <div class="m-actions">
          <button
            class="aw-pill outline"
            @click="recipeOpen = false"
          >
            {{ $t('dcwDetail.k3xdnn052') }}
          </button>
          <button
            class="pill-btn"
            :disabled="recipeSaving"
            @click="saveRecipe"
          >
            {{ recipeSaving ? $t('dcwDetail.k1b38d59164') : $t('dcwDetail.k1b3kwg0177') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 产线数据查询(产品/配方/参数/时间/间隔) -->
    <section class="aw-tile query-card">
      <p class="sec-label">
        {{ $t('dcwDetail.k1us3jse106') }}
      </p>
      <div class="q-grid">
        <label class="f">
          <span>{{ $t('dcwDetail.k3waz1025') }}</span>
          <select
            v-model="query.productId"
            class="inp"
            @change="query.recipeId = ''"
          >
            <option value="">
              {{ $t('dcwDetail.k1bkl1jx107') }}
            </option>
            <option
              v-for="p in lineProducts"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k48grv027') }}</span>
          <select
            v-model="query.recipeId"
            class="inp"
            :disabled="!query.productId"
          >
            <option value="">
              {{ $t('dcwDetail.k1bkx7cr108') }}
            </option>
            <option
              v-for="r in visibleRecipes"
              :key="r.id"
              :value="r.id"
            >
              {{ r.name }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k1demcae109') }}</span>
          <select
            v-model="query.paramKey"
            class="inp"
          >
            <option value="">
              {{ $t('dcwDetail.k1bkx7ya110') }}
            </option>
            <option
              v-for="k in daqParamKeys"
              :key="k"
              :value="k"
            >
              {{ k }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k45uio082') }}</span>
          <select
            v-model="query.nodeId"
            class="inp"
          >
            <option value="">
              {{ $t('dcwDetail.k1bkul3k111') }}
            </option>
            <option
              v-for="n in lineDaqNodes"
              :key="n.id"
              :value="n.id"
            >
              {{ n.name }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.kx2ojn0112') }}</span>
          <input
            v-model.number="query.lastMin"
            type="number"
            min="1"
            max="10080"
            class="inp"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.kjvnvn4113') }}</span>
          <input
            v-model.number="query.bucketMs"
            type="number"
            min="0"
            step="100"
            class="inp"
          >
        </label>
        <div class="f q-actions">
          <button
            class="pill-btn"
            :disabled="queryBusy"
            @click="doQuery"
          >
            {{ queryBusy ? $t('dcwDetail.k1eyx09r165') : $t('dcwDetail.k416ek178') }}
          </button>
        </div>
      </div>
      <p
        v-if="queryError"
        class="banner bad"
        style="margin-top: 8px;"
      >
        {{ queryError }}
      </p>
      <div
        v-if="queryResult"
        class="q-result"
      >
        <table class="nodes-table">
          <thead>
            <tr>
              <th>{{ $t('dcwDetail.k48hde081') }}</th>
              <th>{{ $t('dcwDetail.k45uio082') }}</th>
              <th>{{ $t('dcwDetail.k42kcu114') }}</th>
              <th>{{ $t('dcwDetail.k49ujb115') }}</th>
              <th>{{ $t('dcwDetail.k40pvw116') }}</th>
              <th>{{ $t('dcwDetail.k3xho3117') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in queryResult.channels"
              :key="c.nodeId"
            >
              <td>{{ c.ch }}<small class="mono dim"> {{ c.unit }}</small></td>
              <td>{{ c.nodeName }}</td>
              <td class="mono">
                {{ c.points.length }}
              </td>
              <td class="mono">
                {{ fmtPoint(c.points[0]) }}
              </td>
              <td class="mono">
                {{ fmtPoint(c.points[c.points.length - 1]) }}
              </td>
              <td class="mono dim">
                {{ new Date(c.points[0]?.at ?? 0).toLocaleTimeString() }} ~ {{ new Date(c.points[c.points.length - 1]?.at ?? 0).toLocaleTimeString() }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 写历史 -->
    <section
      v-if="lineHistory.length"
      class="aw-tile table-card"
    >
      <p class="sec-label">
        {{ $t('dcwDetail.kw7ym9b148') }} {{ lineHistory.length }} {{ $t('dcwDetail.k40bfz150') }}
      </p>
      <table class="nodes-table">
        <tbody>
          <tr
            v-for="h in lineHistory.slice(0, 12)"
            :key="h.id"
          >
            <td class="mono dim">
              {{ h.at.slice(5, 19) }}
            </td>
            <td>{{ h.param }}</td>
            <td>{{ h.nodeName }}</td>
            <td class="mono">
              {{ h.eng }}
            </td>
            <td class="mono dim">
              raw {{ h.raw ?? '-' }}
            </td>
            <td>
              <span
                class="st-pill"
                :class="h.ok ? 'ok' : 'alarm'"
              >{{ h.ok ? 'ACK' : $t('dcwDetail.k3yit7139') }}</span>
            </td>
            <td class="dim">
              {{ h.recipeRunId ? $t('dcwDetail.k6vgks7181', { p0: h.recipeRunId }) : '手动' }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 新建产品弹窗 -->
    <div
      v-if="productOpen"
      class="modal-mask"
      @click.self="productOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          {{ $t('dcwDetail.k1efduyf118') }}
        </h3>
        <div class="f-grid">
          <label class="f">
            <span>{{ $t('dcwDetail.k1avjrl6119') }}<em>*</em></span>
            <input
              v-model="productForm.name"
              class="inp"
              :placeholder="$t('dcwDetail.k12c11vm014')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcwDetail.k40gkk096') }}</span>
            <input
              v-model="productForm.description"
              class="inp"
              :placeholder="$t('dcwDetail.k1hxx8hy015')"
            >
          </label>
        </div>
        <p
          v-if="productError"
          class="m-err"
        >
          {{ productError }}
        </p>
        <div class="m-actions">
          <button
            class="aw-pill outline"
            @click="productOpen = false"
          >
            {{ $t('dcwDetail.k3xdnn052') }}
          </button>
          <button
            class="pill-btn"
            :disabled="productSaving"
            @click="doCreateProduct"
          >
            {{ productSaving ? $t('dcwDetail.k1bg4759156') : $t('dcwDetail.k1bg4kn6179') }}
          </button>
        </div>
      </div>
    </div>

    <p
      v-if="dcw.error"
      class="err"
    >
      {{ dcw.error }}(<NuxtLink to="/workshop">{{ $t('dcwDetail.k1bhhheq120') }}</NuxtLink>)
    </p>
  </div>
</template>

<style scoped>
.line-chip {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 8px;
  vertical-align: -1px;
  border-radius: 3px;
  box-shadow: 0 0 10px currentColor;
}
.param-chip.daqwin { color: #41c8f4; border-color: rgba(65, 200, 244, 0.4); }
.adopt-card { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.adopt-title { font-size: 12px; color: var(--aw-dim, #8fa0b5); flex: none; padding-top: 4px; }
.adopt-list { display: flex; gap: 8px; flex-wrap: wrap; }
.adopt-chip {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 4px 8px;
  font-size: 11px;
  color: #e8eef8;
  background: rgba(13, 20, 32, 0.7);
  border: 1px solid rgba(60, 80, 110, 0.5);
  border-radius: 8px;
}
.page { padding: 4px; }
h1 { margin: 2px 0 4px; font-size: 30px; font-weight: 400; letter-spacing: -0.015em; }
.sub { margin: 0; font-size: 12.5px; opacity: 0.6; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }
.badges { display: flex; gap: 8px; }
.badge { padding: 3px 10px; font-size: 11px; letter-spacing: 0.05em; color: var(--ink-soft); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

.ctrl-card { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; padding: 14px 18px; margin-bottom: 14px; }
.ctrl-left { display: flex; gap: 14px; align-items: center; }
.aw-pill.running { background: var(--accent); }
.ctrl-right { display: flex; gap: 12px; align-items: center; }
.ctrl-metrics { display: flex; gap: 8px; align-items: center; font-size: 11.5px; color: var(--ink-soft); }
.ctrl-metrics .sep { opacity: 0.4; }
.ctrl-metrics .warn { color: var(--tone-warning-dot); }
.add-btn { padding: 8px 16px; font-size: 13px; }

.banner { padding: 9px 14px; margin: 0 0 12px; font-size: 12.5px; border-radius: var(--radius-chip); }
.banner.bad { color: var(--tone-danger-dot); background: var(--tone-danger-bg); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 40%, transparent); }
.banner.good { color: var(--tone-success-dot); background: var(--tone-success-bg); border: 1px solid color-mix(in srgb, var(--tone-success-dot) 40%, transparent); }

.table-card { overflow-x: auto; margin-bottom: 14px; }
.nodes-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.nodes-table th, .nodes-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.nodes-table th { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); border-bottom: 1px solid var(--line-strong); }
.nodes-table td b { margin-left: 8px; }
.ch { display: block; margin-top: 2px; font-size: 10px; color: var(--ink-faint); }
.right { text-align: right; }
.val { font-size: 13px; }
.val small { margin-left: 3px; color: var(--ink-faint); }

.st-pill { display: inline-block; padding: 2px 9px; font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.04em; border-radius: var(--radius-pill); }
.st-pill.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.writing { color: var(--ink); background: var(--hover-tint); }
.st-pill.error, .st-pill.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.st-pill.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.st-pill.offline, .st-pill.idle { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }
.st-pill.paused { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }

/* 逐节点 控制开关 */
.ctrl-toggle { display: inline-flex; gap: 6px; align-items: center; padding: 3px 10px; font-size: 11.5px; cursor: pointer; color: var(--ink-faint); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-pill); }
.ctrl-toggle .ct-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone-neutral-dot); }
.ctrl-toggle.on { color: var(--tone-success-dot); border-color: color-mix(in srgb, var(--tone-success-dot) 45%, transparent); }
.ctrl-toggle.on .ct-dot { background: var(--tone-success-dot); box-shadow: 0 0 6px var(--tone-success-dot); }
.ctrl-toggle:disabled { opacity: 0.55; cursor: wait; }
.node-paused td { opacity: 0.6; }
.node-paused .write-row { opacity: 0.5; }

/* 模板弹窗 */
.tpl-hint { margin: 0 0 10px; font-size: 12px; }
.tpl-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
.tpl-chip { display: inline-flex; gap: 6px; align-items: center; padding: 3px 9px; font-size: 11.5px; color: var(--ink-soft); background: var(--paper-deep); border: 1px solid var(--line); border-radius: var(--radius-chip); }
.tpl-chip small { color: var(--ink-faint); }
.tpl-tag { padding: 1px 6px; font-size: 10px; font-style: normal; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: var(--radius-pill); }
.tpl-tag.builtin { color: var(--ink-faint); border-color: var(--line-strong); }

.write-row { display: flex; gap: 6px; align-items: center; }
.write-inp { width: 92px; padding: 4px 8px; }
.write-btn { padding: 5px 12px; }
.mini-btn { padding: 4px 10px; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); margin-right: 4px; }
.mini-btn.danger { color: var(--tone-danger-dot); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }
.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

.line-card { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; padding: 14px 18px; margin-bottom: 14px; }
.line-status { display: flex; gap: 12px; align-items: center; min-width: 260px; }
.line-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--tone-neutral-dot); box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone-neutral-dot) 20%, transparent); }
.line-dot.on { background: var(--tone-success-dot); box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone-success-dot) 22%, transparent); animation: linePulse 1.6s infinite; }
@keyframes linePulse { 0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone-success-dot) 25%, transparent); } 50% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--tone-success-dot) 8%, transparent); } }
.line-info b { font-size: 14px; }
.line-info small { display: block; margin-top: 2px; font-size: 11px; }
.line-ctl { display: flex; gap: 10px; align-items: flex-end; }
.ctl-sel { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--ink-faint); }
.ctl-sel .inp { min-width: 150px; }
.pill-btn.stop { background: var(--tone-danger-dot); border-color: var(--tone-danger-dot); }
.product-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
.prod-chip { display: inline-flex; gap: 6px; align-items: center; padding: 4px 12px; font-size: 12px; cursor: pointer; color: var(--ink-soft); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-pill); }
.prod-chip.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.prod-del { color: var(--tone-danger-dot); font-weight: 700; }
.query-card { padding: 14px 18px; margin-bottom: 14px; }
.q-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; align-items: end; }
.q-grid .f { font-size: 11px; color: var(--ink-faint); }
.q-actions { justify-content: flex-end; }
.q-result { margin-top: 12px; overflow-x: auto; }
.cal-form { grid-template-columns: 2fr 1fr; align-items: end; }
.recipe-card { padding: 16px 18px; margin-bottom: 14px; }
.recipe-hd { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
.recipe-hd h3 { margin: 0; font-size: 16px; }
.panel-tag { padding: 2px 8px; font-size: 11px; color: var(--ink-soft); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }
.recipe-sub { margin: 0 0 14px; font-size: 12px; color: var(--ink-faint); }
.recipe-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.recipe-item { padding: 12px 14px; background: var(--paper-deep); border: 1px solid var(--line); border-radius: var(--radius-chip); }
.recipe-name b { font-size: 13.5px; }
.recipe-name small { margin-left: 8px; }
.desc { margin: 4px 0; font-size: 12px; }
.recipe-params { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.param-chip { padding: 2px 8px; font-size: 11px; color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); border-radius: var(--radius-chip); }
.recipe-actions { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
.sec-label { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); }
.runs { margin-top: 6px; }
.pill-btn { padding: 6px 14px; font-size: 12.5px; cursor: pointer; color: var(--paper-raised); background: var(--accent); border: 1px solid var(--accent); border-radius: var(--radius-pill); }
.pill-btn.outline { color: var(--ink); background: var(--paper-raised); border-color: var(--line-strong); }
.pill-btn:disabled { opacity: 0.5; cursor: default; }

.modal-mask { position: fixed; z-index: 50; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--scrim); backdrop-filter: blur(2px); }
.modal { width: 680px; max-width: 94vw; max-height: 88vh; overflow-y: auto; padding: 22px 24px; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: var(--radius-panel); box-shadow: var(--shadow-float); }
.m-title { margin: 0 0 14px; font-size: 17px; }
.seg-row { display: flex; gap: 8px; margin-bottom: 14px; }
.seg { flex: 1; padding: 8px 0; font-size: 13px; cursor: pointer; color: var(--ink-faint); background: var(--paper-deep); border: 1px solid var(--line); border-radius: var(--radius-chip); }
.seg.on { font-weight: 600; color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.f-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.driver-form { grid-template-columns: repeat(3, 1fr); }
.param-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr auto; gap: 8px; align-items: end; margin-bottom: 8px; }
.param-row .f { flex: 1; }
.param-del { margin-bottom: 2px; }
.f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.f em { margin-left: 3px; font-style: normal; }
.hint { font-size: 10px; color: var(--ink-fainter); }
.test-row { display: flex; gap: 10px; align-items: center; margin: 6px 0 4px; }
.test-result { font-family: var(--font-mono); font-size: 11px; }
.test-result.good { color: var(--tone-success-dot); }
.test-result.bad { color: var(--tone-danger-dot); }
.m-err { margin: 8px 0 0; font-size: 12px; color: var(--tone-danger-dot); }
.m-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.aw-pill.outline { color: var(--ink); background: var(--paper-raised); border-color: var(--line-strong); }
.err { margin-top: 14px; font-size: 13px; color: var(--tone-danger-dot); }
@media (prefers-reduced-motion: no-preference) {
  .nodes-table tbody tr:hover { background: var(--hover-tint); }
}
</style>
