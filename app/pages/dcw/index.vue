<script setup lang="ts">
/**
 * 智控中心(DCW Console)—— 写控制网关总控面(与 /daq 数采中心对称)。
 * 用户只面向工艺量纲:模板域(物理含义/单位/安全量程)驱动节点创建;
 * 设定值下发(工程量)由系统完成换算/写 PLC/回读校验;Recipe 配方管理 +
 * 生产批次隔离(逐参数一键下发 + 批次数据视图)。
 */
import { onBeforeUnmount, onMounted, reactive, ref, watch, computed } from 'vue'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import { DCW_DRIVERS, type LineQueryResult, type RecipeRunData } from '#shared/dcw-protocol'
import type { DriverConfigField } from '#shared/daq-protocol'

definePageMeta({ layout: 'default' })
useHead({ title: '智控中心 · AgentWorkShop' })

const dcw = useDcwStream()
const deviceTwins = useDeviceTwins()
let unsub: (() => void) | null = null

onMounted(() => {
  unsub = dcw.ensureWsFeed()
  void dcw.load()
  void deviceTwins.load()
})
onBeforeUnmount(() => unsub?.())

const deviceName = (id: string | null): string =>
  id ? (deviceTwins.twins.find(t => t.id === id)?.name ?? `${id.slice(0, 8)}…`) : '未绑定'

const stateLabel: Record<string, string> = {
  ok: '已设定', writing: '写入中', error: '写失败', offline: '停用', idle: '待设定',
}

/** 模板通道语义(server 目录为准;dcw- 前缀兼容) */
function dcwTemplateRefCh(templateRef: string): string {
  const tpl = dcw.templates.find(t => t.key === (templateRef.startsWith('dcw-') ? templateRef.slice(4) : templateRef))
  return tpl ? `${tpl.name} · ${tpl.ch}` : templateRef || '-'
}

// ---------- 行内设定(每节点独立写命令;输入缓存按节点 id 隔离) ----------
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
    if (outcome.ok) writeOk.value = `节点 ${nodeId.slice(0, 6)} 设定成功(${outcome.readback ?? value})`
    else writeError.value = outcome.message
  }
  catch (err) {
    writeError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    writingId.value = ''
  }
}

// ---------- 添加节点向导(mock / 真实 PLC + 换算参数 + 测试连接) ----------
const addOpen = ref(false)
const addScenario = ref<'mock' | 'real'>('mock')
const addTemplate = ref(dcw.templates[0]?.key ?? '')
const addDriver = ref<'mock' | 'modbus-tcp' | 'opcua'>('mock')
const addName = ref('')
const addHold = ref<number | null>(null)
const addCfg = ref<Record<string, string | number>>({})
const addTesting = ref(false)
const addTest = ref<{ ok: boolean, message: string } | null>(null)
const addSaving = ref(false)
const addError = ref('')

const addDriverMeta = computed(() => DCW_DRIVERS.find(d => d.kind === addDriver.value))
const addFields = computed<DriverConfigField[]>(() => addDriverMeta.value?.configFields ?? [])

watch(addDriver, () => {
  const cfg: Record<string, string | number> = {}
  for (const f of addFields.value) {
    if (f.default !== undefined) cfg[f.key] = f.default as string | number
  }
  addCfg.value = cfg
  addTest.value = null
}, { immediate: true })

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
      if (f.required && !addCfg.value[f.key] && addCfg.value[f.key] !== 0) {
        throw new Error(`缺少必填参数:${f.label}`)
      }
    }
    const tpl = dcw.templates.find(t => t.key === addTemplate.value)
    await dcw.createFromTemplate(`dcw-${addTemplate.value}`, {
      name: addName.value || undefined,
      driver: addScenario.value === 'real' ? addDriver.value : 'mock',
      driverConfig: addScenario.value === 'real' ? { ...addCfg.value } : {},
      holdIntervalMs: addHold.value,
      unit: tpl?.unit,
      decimals: tpl?.decimals,
      min: tpl?.min,
      max: tpl?.max,
    })
    addOpen.value = false
    addName.value = ''
    addTest.value = null
  }
  catch (err) {
    addError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    addSaving.value = false
  }
}

// ---------- 产线运行控制(开跑必设配方;窗口内数采逐样本打标) ----------
const lineProductId = ref('')
const lineRecipeId = ref('')
const lineBusy = ref(false)
const lineMsg = ref('')
const lineErr = ref('')

const lineRecipes = computed(() => dcw.recipes.filter(r => r.productId === lineProductId.value))

async function doLineStart(): Promise<void> {
  lineBusy.value = true
  lineMsg.value = ''
  lineErr.value = ''
  try {
    if (!lineRecipeId.value) {
      throw new Error('开跑前必须先设定配方:请选择产品与配方(配方需含工艺参数)')
    }
    await dcw.startLine(lineRecipeId.value)
    lineMsg.value = `产线已开跑:${dcw.line.productName} · ${dcw.line.recipeName}(批次 ${dcw.line.runId})`
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
    const was = `${dcw.line.productName ?? ''} · ${dcw.line.recipeName ?? ''}`
    await dcw.stopLine()
    lineMsg.value = `产线已停止(${was});窗口数据保留可查`
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
    const p = await dcw.createProduct({ name: productForm.name.trim(), description: productForm.description.trim() })
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
  filterProductId.value ? dcw.recipes.filter(r => r.productId === filterProductId.value) : dcw.recipes,
)
const productName = (id: string): string => dcw.products.find(p => p.id === id)?.name ?? id

// ---------- 产线数据查询(产品/配方/参数/时间/间隔) ----------
const query = reactive({
  productId: '',
  recipeId: '',
  paramKey: '',
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
      productId: query.productId || undefined,
      recipeId: query.recipeId || undefined,
      paramKey: query.paramKey || undefined,
      fromMs: Date.now() - query.lastMin * 60_000,
      toMs: Date.now(),
      bucketMs: query.bucketMs > 0 ? query.bucketMs : undefined,
      limit: 2000,
    })
    if (queryResult.value.channels.length === 0) queryError.value = '窗口内无匹配数据(检查产品/配方/时间范围;仅产线运行中的样本带产品标识)'
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

// ---------- Recipe 配方管理 ----------
const recipeOpen = ref(false)
const recipeEditing = ref<string | null>(null)
const recipeSaving = ref(false)
const recipeError = ref('')
const recipeForm = reactive({ productId: '', name: '', description: '', params: [] as Array<{ templateRef: string, value: number | '' }> })
const applyResult = ref<{ runId: string, ok: number, total: number } | null>(null)
const runDataView = ref<{ runId: string, data: RecipeRunData } | null>(null)
const runDataLoading = ref(false)

function openRecipeCreate(): void {
  recipeEditing.value = null
  recipeError.value = ''
  recipeForm.productId = filterProductId.value || lineProductId.value || dcw.products[0]?.id || ''
  recipeForm.name = ''
  recipeForm.description = ''
  recipeForm.params = [{ templateRef: dcw.templates[0]?.key ?? '', value: '' }]
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
  recipeForm.params = r.params.map(p => ({ templateRef: p.templateRef.startsWith('dcw-') ? p.templateRef.slice(4) : p.templateRef, value: p.value }))
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
        .filter(p => p.templateRef && p.value !== '' && Number.isFinite(Number(p.value)))
        .map(p => ({ templateRef: `dcw-${p.templateRef}`, value: Number(p.value) })),
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
    if (ok < run.results.length) writeError.value = `配方下发部分失败:${run.results.filter(r => !r.ok).map(r => r.message).join(';')}`
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
  if (!p) return '-'
  const v = p.value ?? p.avg
  return v != null ? Number(v).toFixed(2) : '-'
}

/** 模板量程(配方行提示) */
const tplRange = (key: string): string => {
  const t = dcw.templates.find(x => x.key === key)
  return t ? `${t.min}~${t.max} ${t.unit}` : ''
}
</script>

<template>
  <div class="page">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          AGENTWORKSHOP / LINE OPERATIONS
        </p>
        <h1>产线运营管理</h1>
        <p class="sub">
          产品 / 配方 / 数据查询 / 参数控制 / 数采启停一体化:开跑必设配方,窗口内数采逐样本携带产品与配方标识,实现真实的产品级数据隔离;PLC 底层(换算/写/回读)由系统封装。
        </p>
      </div>
      <div class="badges mono">
        <span class="badge">DRIVERS · {{ dcw.nodes.length }} 通道</span>
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
          {{ dcw.controller.running ? '暂停全部控制' : '恢复全部控制' }}
        </button>
      </div>
      <div class="ctrl-right">
        <span class="ctrl-metrics mono">
          <span>节点 {{ dcw.controller.nodesOnline }}/{{ dcw.controller.nodesTotal }}</span>
          <span class="sep">·</span>
          <span title="累计写命令">写入 {{ dcw.controller.writesTotal }}</span>
          <span class="sep">·</span>
          <span
            :class="{ warn: dcw.controller.writesFailed > 0 }"
            title="累计写失败"
          >失败 {{ dcw.controller.writesFailed }}</span>
        </span>
        <button
          class="aw-pill add-btn"
          @click="addOpen = true"
        >
          <span class="i-tabler-plus" />
          添加控制节点
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

    <!-- 产线运行控制:开跑必设配方;窗口内数采逐样本打标 -->
    <section class="aw-tile line-card">
      <div class="line-status">
        <span
          class="line-dot"
          :class="{ on: dcw.line.active }"
        />
        <div class="line-info">
          <b>{{ dcw.line.active ? '产线运行中' : '产线停止' }}</b>
          <small
            v-if="dcw.line.active"
            class="mono dim"
          >{{ dcw.line.productName }} · {{ dcw.line.recipeName }} · 批次 {{ dcw.line.runId }} · 开跑 {{ dcw.line.startedAt?.slice(11, 19) }} · 已打标 {{ dcw.line.taggedSamples }} 样本</small>
          <small
            v-else
            class="dim"
          >选择产品与配方后开跑;运行中的每条数采数据将携带产品/配方/批次标识</small>
        </div>
      </div>
      <div class="line-ctl">
        <label class="ctl-sel">
          <span>产品</span>
          <select
            v-model="lineProductId"
            class="inp"
            @change="lineRecipeId = ''"
          >
            <option value="">
              选择产品…
            </option>
            <option
              v-for="p in dcw.products"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </select>
        </label>
        <label class="ctl-sel">
          <span>配方</span>
          <select
            v-model="lineRecipeId"
            class="inp"
            :disabled="!lineProductId"
          >
            <option value="">
              选择配方…
            </option>
            <option
              v-for="r in lineRecipes"
              :key="r.id"
              :value="r.id"
              :disabled="r.params.length === 0"
            >
              {{ r.name }}{{ r.params.length === 0 ? '(无参数,不可开跑)' : `(${r.params.length} 参数)` }}
            </option>
          </select>
        </label>
        <button
          v-if="!dcw.line.active"
          class="pill-btn"
          :disabled="lineBusy || !lineRecipeId"
          :title="!lineRecipeId ? '开跑前必须先设定配方' : '下发配方参数并开始打标数据采集'"
          @click="doLineStart"
        >
          ▶ 开始数采
        </button>
        <button
          v-else
          class="pill-btn stop"
          :disabled="lineBusy"
          @click="doLineStop"
        >
          ■ 停止数采
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

    <!-- 添加控制节点向导 -->
    <div
      v-if="addOpen"
      class="modal-mask"
      @click.self="addOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          添加控制节点
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
            真实 PLC 写入
          </button>
        </div>

        <div class="f-grid">
          <label class="f">
            <span>控制模板(物理含义/单位/安全量程)</span>
            <select
              v-model="addTemplate"
              class="inp"
            >
              <option
                v-for="t in dcw.templates"
                :key="t.key"
                :value="t.key"
              >
                {{ t.name }} · {{ t.ch }}({{ t.min }}~{{ t.max }} {{ t.unit }}){{ t.builtin ? '' : ' · 自定义' }}
              </option>
            </select>
          </label>
          <label class="f">
            <span>节点名称(可选)</span>
            <input
              v-model="addName"
              class="inp"
              placeholder="缺省按模板自增命名"
            >
          </label>
          <label class="f">
            <span>保写周期 ms(空=仅手动下发)</span>
            <input
              v-model.number="addHold"
              type="number"
              min="0"
              max="3600000"
              step="500"
              class="inp"
              placeholder="如 5000(心跳重下发)"
            >
          </label>
        </div>

        <template v-if="addScenario === 'real'">
          <div class="f-grid">
            <label class="f">
              <span>通信协议</span>
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
              {{ addTesting ? '测试中…' : '测试连接' }}
            </button>
            <span
              v-if="addTest"
              class="test-result"
              :class="addTest.ok ? 'good' : 'bad'"
            >{{ addTest.ok ? '✓' : '✗' }} {{ addTest.message }}</span>
          </div>
        </template>

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
            取消
          </button>
          <button
            class="aw-pill"
            :disabled="addSaving"
            @click="doAddNode"
          >
            {{ addSaving ? '创建中…' : '创建节点' }}
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
              <th>控制节点</th>
              <th>状态</th>
              <th>当前设定</th>
              <th>设定下发</th>
              <th>工艺量程</th>
              <th>保写周期</th>
              <th>绑定设备</th>
              <th class="right">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="n in dcw.nodes"
              :key="n.id"
            >
              <td>
                <span class="mono dim">{{ n.id.slice(0, 8) }}</span>
                <b>{{ n.name }}</b>
                <small class="mono ch">{{ dcwTemplateRefCh(n.templateRef) }}</small>
              </td>
              <td>
                <span
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
                  >
                  <button
                    class="mini-btn write-btn"
                    :disabled="writingId === n.id || setInputs[n.id] == null || setInputs[n.id] === ''"
                    @click="doWrite(n.id, Number(setInputs[n.id]))"
                  >
                    {{ writingId === n.id ? '写入中' : '下发' }}
                  </button>
                </div>
              </td>
              <td class="mono dim">
                {{ n.min }} ~ {{ n.max }} {{ n.unit }}
              </td>
              <td class="mono">
                {{ n.holdIntervalMs == null ? '手动' : `${n.holdIntervalMs}ms` }}
              </td>
              <td>{{ deviceName(n.deviceBindingId) }}</td>
              <td class="right">
                <button
                  class="mini-btn danger"
                  @click="dcw.removeNode(n.id)"
                >
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="dcw.loaded && dcw.nodes.length === 0">
              <td colspan="8">
                <div
                  class="pane-empty"
                  style="min-height: 120px;"
                >
                  <p class="pe-sub">
                    暂无控制节点 —— 点击右上「添加控制节点」从工艺模板创建。
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
        <h3>产品与配方</h3>
        <span class="panel-tag mono">{{ dcw.products.length }} 产品 / {{ visibleRecipes.length }} 配方</span>
        <button
          class="pill-btn"
          style="margin-left: auto;"
          @click="openRecipeCreate"
        >
          + 新建配方
        </button>
        <button
          class="mini-btn"
          @click="productOpen = true"
        >
          + 新建产品
        </button>
      </div>
      <p class="recipe-sub">
        一个产品可有多个配方;配方 = 工艺参数集(控制模板 + 目标工程值)。产线开跑时选定配方,其参数随开跑下发,
        数采数据逐样本携带产品/配方/批次标识。
      </p>

      <!-- 产品管理行 -->
      <div
        v-if="dcw.products.length"
        class="product-row"
      >
        <button
          class="prod-chip"
          :class="{ on: filterProductId === '' }"
          @click="filterProductId = ''"
        >
          全部
        </button>
        <button
          v-for="p in dcw.products"
          :key="p.id"
          class="prod-chip"
          :class="{ on: filterProductId === p.id }"
          :title="p.description"
          @click="filterProductId = p.id"
        >
          {{ p.name }}
          <span
            class="prod-del"
            title="删除产品"
            @click.stop="dcw.removeProduct(p.id)"
          >×</span>
        </button>
      </div>
      <p
        v-else
        class="dim"
        style="margin: 6px 0 12px; font-size: 12px;"
      >
        暂无产品 —— 点击「新建产品」创建(配方必挂产品;数据按产品隔离)。
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
              {{ (dcw.templates.find(t => t.key === p.templateRef.replace('dcw-', ''))?.ch ?? p.templateRef) }} = {{ p.value }}
            </span>
          </div>
          <div class="recipe-actions">
            <button
              class="pill-btn"
              @click="doApplyRecipe(r.id)"
            >
              ▶ 下发
            </button>
            <button
              class="mini-btn"
              @click="openRecipeEdit(r.id)"
            >
              编辑
            </button>
            <button
              class="mini-btn danger"
              @click="dcw.removeRecipe(r.id)"
            >
              删除
            </button>
          </div>
        </div>
        <div
          v-if="dcw.recipes.length === 0"
          class="pane-empty"
          style="grid-column: 1 / -1;"
        >
          暂无配方 —— 点击「新建配方」定义产品工艺参数集。
        </div>
      </div>

      <div
        v-if="applyResult"
        class="banner good"
      >
        配方批次 {{ applyResult.runId }} 下发完成:{{ applyResult.ok }}/{{ applyResult.total }} 参数成功
        <button
          class="mini-btn"
          style="margin-left: 10px;"
          :disabled="runDataLoading"
          @click="doViewRun(applyResult.runId)"
        >
          {{ runDataLoading ? '加载中…' : '查看批次数据' }}
        </button>
      </div>

      <!-- 批次列表 -->
      <div
        v-if="dcw.runs.length"
        class="runs"
      >
        <p class="sec-label">
          生产批次(数据隔离窗口)
        </p>
        <table class="nodes-table">
          <thead>
            <tr>
              <th>批次</th>
              <th>配方</th>
              <th>窗口</th>
              <th>参数结果</th>
              <th class="right">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="run in [...dcw.runs].reverse().slice(0, 8)"
              :key="run.id"
            >
              <td class="mono">
                {{ run.id }}
              </td>
              <td>{{ run.recipeName }}</td>
              <td class="mono dim">
                {{ run.startedAt.slice(5, 19) }} ~ {{ run.endedAt ? run.endedAt.slice(5, 19) : '进行中' }}
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
                  批次数据
                </button>
                <button
                  v-if="!run.endedAt"
                  class="mini-btn"
                  @click="dcw.closeRun(run.id)"
                >
                  关闭批次
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
            批次数据 · {{ runDataView.data.run.recipeName }}({{ runDataView.runId }})
          </h3>
          <p class="sec-label">
            数采通道汇总(批次窗口内,产品隔离)
          </p>
          <table class="nodes-table">
            <thead>
              <tr>
                <th>通道</th>
                <th>节点</th>
                <th>最新</th>
                <th>均值</th>
                <th>min ~ max</th>
                <th>样本</th>
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
                  窗口内无数采样本
                </td>
              </tr>
            </tbody>
          </table>
          <p class="sec-label">
            写历史(批次窗口内)
          </p>
          <table class="nodes-table">
            <thead>
              <tr>
                <th>参数</th>
                <th>节点</th>
                <th>工程值</th>
                <th>原始值</th>
                <th>结果</th>
                <th>时刻</th>
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
                  >{{ w.ok ? 'ACK' : '失败' }}</span>
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
                  窗口内无写记录
                </td>
              </tr>
            </tbody>
          </table>
          <div class="m-actions">
            <button
              class="aw-pill outline"
              @click="runDataView = null"
            >
              关闭
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
          {{ recipeEditing ? '编辑配方' : '新建配方' }}
        </h3>
        <div class="f-grid">
          <label class="f">
            <span>所属产品<em>*</em></span>
            <select
              v-model="recipeForm.productId"
              class="inp"
            >
              <option
                v-for="p in dcw.products"
                :key="p.id"
                :value="p.id"
              >
                {{ p.name }}
              </option>
            </select>
          </label>
          <label class="f">
            <span>配方名称<em>*</em></span>
            <input
              v-model="recipeForm.name"
              class="inp"
              placeholder="如 0.8mm 光学膜"
            >
          </label>
          <label class="f">
            <span>描述</span>
            <input
              v-model="recipeForm.description"
              class="inp"
              placeholder="产品/工艺说明(可选)"
            >
          </label>
        </div>
        <p class="sec-label">
          工艺参数(引用控制模板 + 目标工程值)
        </p>
        <div
          v-for="(p, i) in recipeForm.params"
          :key="i"
          class="f-grid param-row"
        >
          <label class="f">
            <span>控制模板</span>
            <select
              v-model="p.templateRef"
              class="inp"
            >
              <option
                v-for="t in dcw.templates"
                :key="t.key"
                :value="t.key"
              >
                {{ t.ch }}({{ t.min }}~{{ t.max }} {{ t.unit }})
              </option>
            </select>
          </label>
          <label class="f">
            <span>目标值({{ tplRange(p.templateRef) }})<em>*</em></span>
            <input
              v-model.number="p.value"
              type="number"
              class="inp"
              :step="0.1"
            >
          </label>
          <button
            class="mini-btn danger param-del"
            @click="recipeForm.params.splice(i, 1)"
          >
            移除
          </button>
        </div>
        <button
          class="mini-btn"
          @click="recipeForm.params.push({ templateRef: dcw.templates[0]?.key ?? '', value: '' })"
        >
          + 添加参数
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
            取消
          </button>
          <button
            class="pill-btn"
            :disabled="recipeSaving"
            @click="saveRecipe"
          >
            {{ recipeSaving ? '保存中…' : '保存配方' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 产线数据查询(产品/配方/参数/时间/间隔) -->
    <section class="aw-tile query-card">
      <p class="sec-label">
        产线数据查询(产品 · 配方 · 工艺参数 · 时间 · 间隔)
      </p>
      <div class="q-grid">
        <label class="f">
          <span>产品</span>
          <select
            v-model="query.productId"
            class="inp"
            @change="query.recipeId = ''"
          >
            <option value="">
              全部产品
            </option>
            <option
              v-for="p in dcw.products"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>配方</span>
          <select
            v-model="query.recipeId"
            class="inp"
            :disabled="!query.productId"
          >
            <option value="">
              全部配方
            </option>
            <option
              v-for="r in dcw.recipes.filter(x => !query.productId || x.productId === query.productId)"
              :key="r.id"
              :value="r.id"
            >
              {{ r.name }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>工艺参数</span>
          <select
            v-model="query.paramKey"
            class="inp"
          >
            <option value="">
              全部通道
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
          <span>最近(分钟)</span>
          <input
            v-model.number="query.lastMin"
            type="number"
            min="1"
            max="10080"
            class="inp"
          >
        </label>
        <label class="f">
          <span>聚合间隔 ms(0=原始点)</span>
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
            {{ queryBusy ? '查询中…' : '查询' }}
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
              <th>通道</th>
              <th>节点</th>
              <th>点数</th>
              <th>首值</th>
              <th>末值</th>
              <th>区间</th>
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
      v-if="dcw.history.length"
      class="aw-tile table-card"
    >
      <p class="sec-label">
        写历史(最近 {{ dcw.history.length }} 条)
      </p>
      <table class="nodes-table">
        <tbody>
          <tr
            v-for="h in dcw.history.slice(0, 12)"
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
              >{{ h.ok ? 'ACK' : '失败' }}</span>
            </td>
            <td class="dim">
              {{ h.recipeRunId ? `批次 ${h.recipeRunId}` : '手动' }}
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
          新建产品
        </h3>
        <div class="f-grid">
          <label class="f">
            <span>产品名称<em>*</em></span>
            <input
              v-model="productForm.name"
              class="inp"
              placeholder="如 0.8mm 光学膜"
            >
          </label>
          <label class="f">
            <span>描述</span>
            <input
              v-model="productForm.description"
              class="inp"
              placeholder="产品/工艺说明(可选)"
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
            取消
          </button>
          <button
            class="pill-btn"
            :disabled="productSaving"
            @click="doCreateProduct"
          >
            {{ productSaving ? '创建中…' : '创建产品' }}
          </button>
        </div>
      </div>
    </div>

    <p
      v-if="dcw.error"
      class="err"
    >
      {{ dcw.error }}(<NuxtLink to="/workshop">前往登录</NuxtLink>)
    </p>
  </div>
</template>

<style scoped>
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
.param-row { align-items: end; }
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
