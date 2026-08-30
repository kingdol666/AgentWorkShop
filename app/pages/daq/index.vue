<script setup lang="ts">
/**
 * 数采中心(DAQ Console)—— server 驱动数采的总控面。
 * 后端能力自描述(tsdb/queue/驱动族 + 管线指标)、控制器全局启停/周期、
 * 节点清单(状态/实时值/周期/绑定/驱动),点进 /daq/[id] 进入单节点专业控制台。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { DAQ_TEMPLATES, DAQ_DRIVERS, DAQ_TEMPLATE_ICONS, daqKeyFromRef, type DaqNodeView, type DaqNodeState, type DriverConfigField, type DriverTestResult as DaqDriverTestResult, type DaqTemplateDef, type DaqTemplateIcon } from '#shared/daq-protocol'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'

const { t: tt } = useI18n()

definePageMeta({ layout: 'default' })
useHead({ title: () => tt('titles.daq') })

const daq = useDaqStream()
const dcw = useDcwStream()

/** 是否存在任意运行中的产线(横幅判定) */
const anyLineActive = computed(() => dcw.lines.some(l => dcw.lineStateOf(l.id).active))

/** 节点产线归属变更(挂载到产线/移出) */
async function setNodeLine(id: string, e: Event): Promise<void> {
  const lineId = (e.target as HTMLSelectElement).value
  await daq.patchNode(id, { lineId })
  const n = daq.nodes.find(x => x.id === id)
  if (n) n.lineId = lineId
}

/** 活动配方对该节点的数采监控窗口(本线活动批次;不同 Recipe 不同窗口) */
function recipeWinOf(n: { lineId: string, id: string }): { min?: number, max?: number } | null {
  if (!n.lineId) return null
  const run = dcw.lineStateOf(n.lineId)
  if (!run.active || !run.recipeId) return null
  const r = dcw.recipes.find(x => x.id === run.recipeId)
  return r?.daqWindows?.find(w => w.nodeId === n.id) ?? null
}

/** 配方窗口越限(与服务端 alarm 判定同源;行标红) */
function recipeAlarm(n: DaqNodeView): boolean {
  const w = recipeWinOf(n)
  if (!w || n.value == null) return false
  return (w.min != null && n.value < w.min) || (w.max != null && n.value > w.max)
}
let unsub: (() => void) | null = null
let redrawTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  unsub = daq.ensureWsFeed()
  void daq.load()
  // 产线门控状态(无活动配方不采集;状态仅展示,控制在产线运营页)
  void dcw.load()
  // meta 指标随读数帧落库节奏低频刷新(诚实可见的管线运行数据);
  // 产线运行态(横幅/产线列注记)同拍刷新 —— 开跑/停线后本页 ≤5s 收敛
  redrawTimer = setInterval(() => {
    void daq.load()
    void dcw.load()
  }, 5000)
})
onBeforeUnmount(() => {
  unsub?.()
  if (redrawTimer) clearInterval(redrawTimer)
})

const deviceName = (id: string | null): string =>
  id ? (nodeDevices.get(id) ?? `${id.slice(0, 8)}…`) : tt('daq.k3own4q056')

// ---------- 节点筛选(产线 / 设备绑定 / 产线运行态 / 节点状态) ----------
const filters = reactive({ lineId: '', deviceId: '', lineRun: '', state: '' })
const hasFilters = computed(() => !!(filters.lineId || filters.deviceId || filters.lineRun || filters.state))
function clearFilters(): void {
  filters.lineId = ''
  filters.deviceId = ''
  filters.lineRun = ''
  filters.state = ''
}

/** 筛选下拉的设备选项:仅列出至少绑定了一个节点的设备(空设备筛选无意义) */
const boundDevices = computed<Array<{ id: string, name: string, count: number }>>(() => {
  const used = new Map<string, number>()
  for (const n of daq.nodes) {
    if (n.deviceBindingId) used.set(n.deviceBindingId, (used.get(n.deviceBindingId) ?? 0) + 1)
  }
  return deviceTwins.twins
    .filter(t => used.has(t.id))
    .map(t => ({ id: t.id, name: nodeDevices.get(t.id) ?? t.name, count: used.get(t.id)! }))
})

/** 产线运行态筛选语义:on = 节点所属产线开跑中;off = 待机或未分配(均未采集) */
function lineRunMatch(n: DaqNodeView): boolean {
  if (!filters.lineRun) return true
  const active = !!n.lineId && dcw.lineStateOf(n.lineId).active
  return filters.lineRun === 'on' ? active : !active
}

// ---------- 筛选产线的上下文横幅(运行态/产品/Recipe;未筛选到具体产线时回退全局门控提示) ----------
const filteredLine = computed(() => dcw.lines.find(l => l.id === filters.lineId) ?? null)
const filteredLineState = computed(() =>
  filteredLine.value ? dcw.lineStateOf(filteredLine.value.id) : null)

// ---------- 行级展示状态(真实场景语义):人为停用/未分配/产线未运行 与 故障离线 分离 ----------
// 状态机:disabled(人为停用) → unassigned(未挂产线,永不采集) → idle(产线未开跑,采集门控)
// → offline(网关暂停,或产线运行中却采不到新数据) → ok/warn/alarm(新鲜数据按量程/预警带/配方窗口派生)
type RowState = DaqNodeState | 'idle' | 'disabled' | 'unassigned'

/** 数据新鲜度:超过 max(4×有效周期, 12s) 无新样本视为「采不到数据」(容忍 5s REST 刷新拍与时钟偏差) */
function staleOf(n: DaqNodeView): boolean {
  if (!n.lastAt) return true
  const iv = n.intervalMs ?? daq.controller.defaultIntervalMs
  return Date.now() - Date.parse(n.lastAt) > Math.max(iv * 4, 12_000)
}

function rowStateOf(n: DaqNodeView): RowState {
  if (!n.enabled) return 'disabled'
  if (!n.lineId) return 'unassigned'
  if (!dcw.lineStateOf(n.lineId).active) return 'idle'
  if (!daq.controller.running || staleOf(n)) return 'offline'
  return n.state
}

/** 数据是否在线(实时值列据此区分「实时值」与「最后值」) */
function isLive(n: DaqNodeView): boolean {
  const s = rowStateOf(n)
  return s === 'ok' || s === 'warn' || s === 'alarm'
}

const rowLabel: Record<RowState, string> = {
  ok: tt('daq.k41k5c062'),
  warn: tt('daq.k49z8v063'),
  alarm: tt('daq.k3xmid064'),
  offline: tt('daq.k44c2n065'),
  idle: tt('daq.k3ozyqz117'),
  disabled: tt('daq.k1disabl130'),
  unassigned: tt('daq.k3ootr6053'),
}

/** 状态 pill(含诚实的原因提示;配方越限标签仅在数据新鲜时展示) */
function statePillOf(n: DaqNodeView): { key: RowState, label: string, tip: string } {
  const s = rowStateOf(n)
  if (s === 'offline') {
    const tip = !daq.controller.running
      ? tt('daq.k1gateoff140')
      : tt('daq.k1staled129', { p0: Math.round(Math.max((n.intervalMs ?? daq.controller.defaultIntervalMs) * 4, 12_000) / 1000) })
    return { key: s, label: rowLabel.offline, tip }
  }
  if (s === 'idle') return { key: s, label: rowLabel.idle, tip: tt('daq.k1idlehin139') }
  if ((s === 'ok' || s === 'warn' || s === 'alarm') && recipeAlarm(n)) {
    const w = recipeWinOf(n)
    return { key: 'alarm', label: tt('daq.k1l3pt51104'), tip: tt('daq.k1hrrqa1122', { p0: w?.min ?? '-∞', p1: w?.max ?? '+∞', p2: '' }) }
  }
  return { key: s, label: rowLabel[s], tip: '' }
}

const filteredNodes = computed<DaqNodeView[]>(() => daq.nodes.filter((n) => {
  if (filters.lineId && (filters.lineId === 'none' ? !!n.lineId : (n.lineId ?? '') !== filters.lineId)) return false
  if (filters.deviceId && (filters.deviceId === 'none' ? !!n.deviceBindingId : n.deviceBindingId !== filters.deviceId)) return false
  if (!lineRunMatch(n)) return false
  if (filters.state && rowStateOf(n) !== filters.state) return false
  return true
}))

// 设备名映射(device-twins 注册表;绑定列展示用)
const deviceTwins = useDeviceTwins()
const nodeDevices = new Map<string, string>()
watch(() => deviceTwins.twins, (list) => {
  for (const t of list) nodeDevices.set(t.id, t.name)
}, { immediate: true, deep: true })

const intervalOf = (intervalMs: number | null): string => {
  if (intervalMs == null) return tt('daq.k9vnp9h124', { p0: daq.controller.defaultIntervalMs })
  return `${intervalMs}ms`
}

/** WS 下发节拍展示(null=跟随全局;0=每帧;>0 独立间隔) */
const publishOf = (v: number | null): string => {
  if (v == null) return tt('daq.k9vnp9h124', { p0: daq.controller.defaultPublishIntervalMs })
  if (v === 0) return tt('daq.k41mvv078')
  return `${v}ms`
}

// ---------- 添加节点向导(mock / 真实场景 + 动态参数表单 + 测试连接) ----------
const addOpen = ref(false)
const addScenario = ref<'mock' | 'real'>('mock')
const addTemplate = ref(DAQ_TEMPLATES[0]?.key ?? 'temp-tc')
const addDriver = ref('modbus-tcp')
const addName = ref('')
const addInterval = ref<number | null>(null)
const addCfg = ref<Record<string, string | number>>({})
const addTransform = reactive({ kind: 'none' as 'none' | 'linear', scale: 1, offset: 0 })
const addTesting = ref(false)
const addTest = ref<DaqDriverTestResult | null>(null)
const addSaving = ref(false)
const addError = ref('')

const addDriverMeta = computed(() => DAQ_DRIVERS.find(d => d.kind === addDriver.value))
const addFields = computed<DriverConfigField[]>(() => addDriverMeta.value?.configFields ?? [])
const driverReady = (kind: string): boolean =>
  daq.meta.drivers.find(d => d.kind === kind)?.status !== 'planned' && (daq.meta.driverAvailable?.[kind] !== false)

watch(addDriver, () => {
  // 切协议:表单重置为 schema 缺省值
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
    addTest.value = await daq.testDriver(addDriver.value, addCfg.value)
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
    const transform = addTransform.kind === 'linear'
      ? { kind: 'linear' as const, scale: Number(addTransform.scale), offset: Number(addTransform.offset) }
      : undefined
    if (addScenario.value === 'mock') {
      await daq.createFromTemplate(`daq-${addTemplate.value}`, {
        name: addName.value ? { name: addName.value }.name : undefined,
        transform,
      })
    }
    else {
      // 校验必填
      for (const f of addFields.value) {
        if (f.required && !addCfg.value[f.key] && addCfg.value[f.key] !== 0) {
          throw new Error(tt('daq.kyuadl0125', { p0: f.label }))
        }
      }
      const tpl = daq.templates.find(t => t.key === addTemplate.value)
      await daq.createFromTemplate(`daq-${addTemplate.value}`, {
        name: addName.value || undefined,
        driver: addDriver.value as never,
        driverConfig: { ...addCfg.value },
        transform,
        intervalMs: addInterval.value,
        unit: tpl?.unit,
        min: tpl?.min,
        max: tpl?.max,
        decimals: tpl?.decimals,
      } as never)
    }
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

/** 模板通道语义(server 目录为唯一事实源;模板已删除 → 显示 templateRef 原文降级) */
function daqTemplateRefCh(templateRef: string): string {
  const tpl = daq.templates.find(t => t.key === daqKeyFromRef(templateRef))
  return tpl ? `${tpl.name} · ${tpl.ch}` : templateRef || '-'
}

// ---------- 自定义信号模板管理(server 权威 CRUD;内置只读可复制) ----------
const tplOpen = ref(false)
const tplEditing = ref<string | null>(null)
const tplSaving = ref(false)
const tplError = ref('')
const confirmingDel = ref('')
const tplForm = reactive({
  name: '', ch: '', code: '', unit: '',
  min: 0, max: 100, base: 50, amp: 2,
  decimals: 2, icon: 'thermo' as DaqTemplateIcon,
})
const ICON_LABEL: Record<DaqTemplateIcon, string> = {
  thermo: tt('daq.k422b8079'), pressure: tt('daq.k3x6ff080'), tension: tt('daq.k3z9xc081'), encoder: tt('daq.k3subk4082'), camera: tt('daq.k47atw083'), gateway: tt('daq.kz7yhbj084'),
}

const customTpls = computed<DaqTemplateDef[]>(() => daq.templates.filter(t => !t.builtin))
const builtinTpls = computed<DaqTemplateDef[]>(() => daq.templates.filter(t => t.builtin))

function fillTplForm(t: DaqTemplateDef, asCopy = false): void {
  tplForm.name = asCopy ? tt('daq.k2hbo3c126', { p0: t.name }) : t.name
  tplForm.ch = t.ch
  tplForm.code = t.code
  tplForm.unit = t.unit
  tplForm.min = t.min
  tplForm.max = t.max
  tplForm.base = t.base
  tplForm.amp = t.amp
  tplForm.decimals = t.decimals
  tplForm.icon = t.icon
}

function resetTplForm(): void {
  tplEditing.value = null
  tplError.value = ''
  confirmingDel.value = ''
  fillTplForm({ key: '', name: '', code: '', ch: '', unit: '', base: 50, amp: 2, min: 0, max: 100, decimals: 2, icon: 'thermo' })
}

function editTpl(t: DaqTemplateDef): void {
  tplEditing.value = t.key
  tplError.value = ''
  fillTplForm(t)
}

function copyTpl(t: DaqTemplateDef): void {
  tplEditing.value = null
  tplError.value = ''
  fillTplForm(t, true)
}

async function saveTpl(): Promise<void> {
  tplSaving.value = true
  tplError.value = ''
  try {
    const num = (v: number | string): number | undefined => {
      const n = Number(v)
      return v === '' || v == null || !Number.isFinite(n) ? undefined : n
    }
    const input = {
      name: tplForm.name.trim(),
      ch: tplForm.ch.trim() || undefined,
      code: tplForm.code.trim() || undefined,
      unit: tplForm.unit.trim(),
      min: num(tplForm.min)!,
      max: num(tplForm.max)!,
      base: num(tplForm.base),
      amp: num(tplForm.amp),
      decimals: num(tplForm.decimals),
      icon: tplForm.icon,
    }
    if (tplEditing.value) await daq.updateTemplate(tplEditing.value, input)
    else await daq.createTemplate(input)
    resetTplForm()
  }
  catch (err) {
    tplError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    tplSaving.value = false
  }
}

/** 两段式删除确认(避免误删;空目录风格与节点表一致) */
async function askDelTpl(t: DaqTemplateDef): Promise<void> {
  if (confirmingDel.value !== t.key) {
    confirmingDel.value = t.key
    return
  }
  try {
    await daq.removeTemplate(t.key)
  }
  catch (err) {
    tplError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    confirmingDel.value = ''
  }
}

/** 驱动是否为预留协议(meta status=planned) */
const driverPlanned = (kind: string): boolean =>
  daq.meta.drivers.find(d => d.kind === kind)?.status === 'planned'

const reconnecting = ref(false)
async function doReconnect(): Promise<void> {
  reconnecting.value = true
  try {
    await daq.reconnectInfra()
  }
  catch { /* 横幅仍在,30s 后台也会自动重试 */ }
  finally {
    reconnecting.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          AGENTWORKSHOP / DAQ CONSOLE
        </p>
        <h1>{{ $t('daq.k1emg364011') }}</h1>
        <p class="sub">
          {{ $t('daq.k1wmg2bz012') }}
        </p>
      </div>
      <div class="badges mono">
        <span
          class="badge"
          :title="$t('daq.k1tsdbtip133')"
        >TSDB · {{ daq.meta.tsdb }}</span>
        <span
          class="badge"
          :title="$t('daq.k1queuet134')"
        >QUEUE · {{ daq.meta.queue }}</span>
      </div>
    </div>

    <!-- 产线门控横幅:筛选到具体产线 → 展示该产线运行态/产品/Recipe(待机可直达产线管理);
         未筛选具体产线 → 全局门控提示 -->
    <div
      v-if="daq.loaded && filteredLine && filteredLineState"
      class="infra-banner"
      :class="{ good: filteredLineState.active }"
    >
      <span :class="filteredLineState.active ? 'i-tabler-circle-check' : 'i-tabler-info-circle'" />
      <span class="txt">
        <template v-if="filteredLineState.active">
          {{ $t('daq.k3ktxbr085') }}{{ filteredLine.name }}」{{ $t('daq.k15lvw0o105') }}<b>{{ filteredLineState.productName }}</b> · Recipe:<b>{{ filteredLineState.recipeName }}</b>
          <small class="mono">{{ $t('daq.k400lb086') }} {{ filteredLineState.runId?.slice(0, 8) }} · {{ $t('daq.k3zkt2106') }} {{ filteredLineState.startedAt?.slice(11, 19) }} {{ $t('daq.k69vag8108') }} {{ filteredLineState.taggedSamples }} {{ $t('daq.k4118o092') }}</small>
        </template>
        <template v-else>
          {{ $t('daq.k3ktxbr085') }}{{ filteredLine.name }}」{{ $t('daq.k12uge2o107') }}</template>
      </span>
      <NuxtLink
        class="pill-btn"
        :to="`/dcw/${filteredLine.id}`"
      >
        {{ filteredLineState.active ? $t('daq.k1ukoy0v093') : $t('daq.k1cg78i8109') }}
      </NuxtLink>
    </div>
    <div
      v-else-if="daq.loaded && !anyLineActive"
      class="infra-banner"
    >
      <span class="i-tabler-info-circle" />
      <span class="txt">{{ $t('daq.k19onw5w013') }}<NuxtLink to="/dcw">{{ $t('daq.k1b2tk5c014') }}</NuxtLink>{{ $t('daq.k1u9wnlg015') }}</span>
    </div>

    <!-- 基础设施降级横幅(MQTT/Timescale 不可达:在线采集停用 + 一键重连) -->
    <div
      v-if="daq.meta.infra?.degraded"
      class="infra-banner"
    >
      <span class="i-tabler-alert-triangle" />
      <span class="txt">{{ daq.meta.infra.warning }}</span>
      <button
        class="pill-btn"
        :disabled="reconnecting"
        @click="doReconnect"
      >
        {{ reconnecting ? $t('daq.k1ld43ur094') : $t('daq.kzg9805110') }}
      </button>
    </div>

    <!-- 控制器总控条:第一行 控制/指标/操作,第二行 产线状态带 -->
    <section class="aw-tile ctrl-card">
      <div class="ctrl-row">
        <div class="ctrl-left">
          <button
            class="aw-pill"
            :class="{ running: daq.controller.running }"
            @click="daq.controllerAction(daq.controller.running ? 'stop' : 'start')"
          >
            <span :class="daq.controller.running ? 'i-tabler-player-pause' : 'i-tabler-player-play'" />
            {{ daq.controller.running ? $t('daq.kpui00095') : $t('daq.knxpdpt111') }}
          </button>
          <label class="cycle mono">
            {{ $t('daq.k1ifahxj016') }}
            <input
              v-model.number="daq.controller.defaultIntervalMs"
              type="number"
              min="200"
              max="60000"
              step="100"
              @change="daq.controllerAction('config', daq.controller.defaultIntervalMs)"
            >ms
          </label>
          <label
            class="cycle mono"
            :title="$t('daq.k1e8lcoo001')"
          >
            {{ $t('daq.k1if98n0017') }}
            <input
              v-model.number="daq.controller.defaultPublishIntervalMs"
              type="number"
              min="0"
              max="60000"
              step="100"
              @change="daq.controllerAction('config', daq.controller.defaultIntervalMs, daq.controller.defaultPublishIntervalMs)"
            >ms
          </label>
        </div>
        <div class="ctrl-right">
          <span class="ctrl-metrics mono">
            <span>{{ $t('daq.k45uio067') }} {{ daq.controller.nodesOnline }}/{{ daq.controller.nodesTotal }}</span>
            <span class="sep">·</span>
            <span :title="$t('daq.k1yztsu4002')">{{ $t('daq.k3xagp087') }} {{ daq.meta.produced }}</span>
            <span class="sep">·</span>
            <span :title="$t('daq.ko09iha003')">{{ $t('daq.k427eu088') }} {{ daq.meta.consumed }}</span>
            <span class="sep">·</span>
            <span
              :class="{ warn: (daq.meta.dropped ?? 0) > 0 }"
              :title="$t('daq.k1droptip135')"
            >{{ $t('daq.k3w8go089') }} {{ daq.meta.dropped }}</span>
            <span class="sep">·</span>
            <span :title="$t('daq.kj1jbmw004')">{{ $t('daq.k3wusd090') }} {{ daq.meta.samplesStored }}</span>
          </span>
          <button
            class="aw-pill outline add-btn"
            @click="tplOpen = true; resetTplForm()"
          >
            <span class="i-tabler-adjustments-horizontal" />
            {{ $t('daq.k1f5cv0s018') }}
          </button>
          <button
            class="aw-pill add-btn"
            @click="addOpen = true"
          >
            <span class="i-tabler-plus" />
            {{ $t('daq.k1fn0ukb019') }}
          </button>
        </div>
      </div>
      <!-- 产线状态带:单行横向滚动,每产线一枚 pill(空心点=待机 / 实心呼吸点=运行中) -->
      <div class="line-strip">
        <span class="strip-label">
          <span class="i-tabler-route" />
          {{ $t('daq.k1b2o3b6020') }}<small class="mono">{{ dcw.lines.length }}</small>
        </span>
        <div class="strip-scroll">
          <NuxtLink
            v-for="l in dcw.lines"
            :key="l.id"
            class="line-pill"
            :class="{ on: dcw.lineStateOf(l.id).active }"
            :style="{ '--lc': l.color }"
            :to="`/dcw/${l.id}`"
            :title="dcw.lineStateOf(l.id).active
              ? $t('daq.k3v957u120', { p0: l.name, p1: dcw.lineStateOf(l.id).productName, p2: dcw.lineStateOf(l.id).recipeName })
              : $t('daq.k1x7jnru121', { p0: l.name })"
          >
            <span class="lp-dot" />
            <b>{{ l.name }}</b>
            <small
              v-if="dcw.lineStateOf(l.id).active"
              class="lp-run"
            >{{ dcw.lineStateOf(l.id).recipeName ?? $t('daq.k3vp67i096') }}</small>
            <small
              v-else
              class="lp-idle"
            >{{ $t('daq.k3zgkk021') }}</small>
          </NuxtLink>
          <NuxtLink
            v-if="dcw.lines.length === 0"
            class="line-pill"
            to="/dcw"
          >
            <span class="lp-dot" />
            <b>{{ $t('daq.k1el12b1022') }}</b>
            <small class="lp-idle">{{ $t('daq.k8jxxe8023') }}</small>
          </NuxtLink>
        </div>
      </div>
    </section>

    <!-- 添加节点向导:mock 模拟 / 真实设备(协议参数 + 测试连接) -->
    <div
      v-if="addOpen"
      class="modal-mask"
      @click.self="addOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          {{ $t('daq.k19rioqa024') }}
        </h3>

        <div class="seg-row">
          <button
            class="seg"
            :class="{ on: addScenario === 'mock' }"
            @click="addScenario = 'mock'"
          >
            {{ $t('daq.k1p5c1un025') }}
          </button>
          <button
            class="seg"
            :class="{ on: addScenario === 'real' }"
            @click="addScenario = 'real'"
          >
            {{ $t('daq.k1cbcp3o026') }}
          </button>
        </div>

        <div class="f-grid">
          <label class="f">
            <span>{{ $t('daq.k1fsgerc027') }}</span>
            <select
              v-model="addTemplate"
              class="inp"
            >
              <option
                v-for="t in daq.templates"
                :key="t.key"
                :value="t.key"
              >
                {{ t.name }} · {{ t.ch }}({{ t.min }}~{{ t.max }} {{ t.unit }}){{ t.builtin ? '' : $t('daq.kr45rk9097') }}
              </option>
            </select>
          </label>
          <label class="f">
            <span>{{ $t('daq.k1ce2k1y028') }}</span>
            <input
              v-model="addName"
              class="inp"
              :placeholder="$t('daq.kgpxzy3005')"
            >
          </label>
          <label
            v-if="addScenario === 'real'"
            class="f"
          >
            <span>{{ $t('daq.k13mfsfc029') }}</span>
            <input
              v-model.number="addInterval"
              type="number"
              min="200"
              max="60000"
              step="100"
              class="inp"
              :placeholder="$t('daq.k1eg1000a136')"
            >
          </label>
        </div>

        <!-- 真实场景:协议选择 + 动态参数表单 + 测试连接 -->
        <template v-if="addScenario === 'real'">
          <div class="f-grid">
            <label class="f">
              <span>{{ $t('daq.k1kt87rx030') }}</span>
              <select
                v-model="addDriver"
                class="inp"
              >
                <option
                  v-for="d in DAQ_DRIVERS.filter(x => x.status !== 'planned')"
                  :key="d.kind"
                  :value="d.kind"
                >
                  {{ d.label }}{{ driverReady(d.kind) ? '' : $t('daq.kjbqphp098') }}
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
              <span>{{ f.label }}<em v-if="f.required">*</em></span>
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
              class="pill-btn"
              :disabled="addTesting"
              @click="doTestConnection"
            >
              {{ addTesting ? $t('daq.k1fsh720099') : $t('daq.k1fstglk112') }}
            </button>
            <span
              v-if="addTest"
              class="test-result"
              :class="addTest.ok ? 'ok' : 'bad'"
            >{{ addTest.ok ? '✓' : '✗' }} {{ addTest.message }}<template v-if="addTest.latencyMs != null">({{ addTest.latencyMs }}ms)</template></span>
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
            {{ $t('daq.k3xdnn031') }}
          </button>
          <button
            class="aw-pill"
            :disabled="addSaving || (addScenario === 'real' && addTest != null && !addTest.ok)"
            :title="addScenario === 'real' && !(addTest && addTest.ok) ? $t('daq.k1needtst137') : ''"
            @click="doAddNode"
          >
            {{ addSaving ? $t('daq.k1bg4759100') : (addScenario === 'real' ? $t('daq.k7pxjxo113') : $t('daq.k1bge46t118')) }}
          </button>
        </div>
      </div>
    </div>

    <!-- 模板管理:自定义模板增删改 + 内置模板复制 -->
    <div
      v-if="tplOpen"
      class="modal-mask"
      @click.self="tplOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          {{ $t('daq.k11mv96s032') }}
        </h3>

        <p class="sec-label">
          {{ $t('daq.ktji4ky033') }}
        </p>
        <table class="tpl-table">
          <tbody>
            <tr
              v-for="t in customTpls"
              :key="t.key"
            >
              <td>
                <b>{{ t.name }}</b>
                <small class="mono dim">{{ t.code }}</small>
              </td>
              <td class="mono range">
                {{ t.min }}~{{ t.max }} {{ t.unit }} · {{ t.decimals }} {{ $t('daq.k48oi091') }}
              </td>
              <td class="right actions">
                <button
                  class="mini-btn"
                  @click="editTpl(t)"
                >
                  {{ $t('daq.k45eb0034') }}
                </button>
                <button
                  class="mini-btn danger"
                  @click="askDelTpl(t)"
                >
                  {{ confirmingDel === t.key ? $t('daq.k1hhheu3101') : $t('daq.k3xakp114') }}
                </button>
              </td>
            </tr>
            <tr v-if="!customTpls.length">
              <td
                colspan="3"
                class="empty"
              >
                {{ $t('daq.kztvzbo035') }}
              </td>
            </tr>
          </tbody>
        </table>

        <p class="sec-label">
          {{ tplEditing ? $t('daq.k1iiph0s102') : $t('daq.k1efixrj115') }}
        </p>
        <div class="f-grid">
          <label class="f">
            <span>{{ $t('daq.k3xhia036') }}<em>*</em></span>
            <input
              v-model="tplForm.name"
              class="inp"
              :placeholder="$t('daq.k5opd2t006')"
            >
          </label>
          <label class="f">
            <span>{{ $t('daq.k3x4ef037') }}<em>*</em></span>
            <input
              v-model="tplForm.unit"
              class="inp"
              placeholder="如 %RH"
            >
          </label>
          <label class="f">
            <span>{{ $t('daq.k1l477m0038') }}</span>
            <input
              v-model="tplForm.ch"
              class="inp"
              :placeholder="$t('daq.kk8o4tl007')"
            >
          </label>
          <label class="f">
            <span>{{ $t('daq.k1ayxrqb039') }}</span>
            <input
              v-model="tplForm.code"
              class="inp"
              :placeholder="$t('daq.kzn3l7l008')"
            >
          </label>
          <label class="f">
            <span>{{ $t('daq.k1l9jv5m040') }}<em>*</em></span>
            <input
              v-model.number="tplForm.min"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('daq.k1l9jv4p041') }}<em>*</em></span>
            <input
              v-model.number="tplForm.max"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('daq.k3mxmcx042') }}</span>
            <input
              v-model.number="tplForm.decimals"
              type="number"
              min="0"
              max="4"
              class="inp"
            >
          </label>
          <label class="f">
            <span>{{ $t('daq.k3xx56043') }}</span>
            <select
              v-model="tplForm.icon"
              class="inp"
            >
              <option
                v-for="ic in DAQ_TEMPLATE_ICONS"
                :key="ic"
                :value="ic"
              >
                {{ ICON_LABEL[ic] }}
              </option>
            </select>
          </label>
          <label class="f">
            <span>{{ $t('daq.k1f4eknv044') }}</span>
            <input
              v-model.number="tplForm.base"
              type="number"
              class="inp"
            >
            <small class="hint">{{ $t('daq.kytd15s045') }}</small>
          </label>
          <label class="f">
            <span>{{ $t('daq.k1f4ifpo046') }}</span>
            <input
              v-model.number="tplForm.amp"
              type="number"
              class="inp"
            >
            <small class="hint">{{ $t('daq.ksp2aji047') }}</small>
          </label>
        </div>
        <p
          v-if="tplError"
          class="m-err"
        >
          {{ tplError }}
        </p>
        <div class="m-actions">
          <button
            class="aw-pill outline"
            @click="resetTplForm"
          >
            {{ $t('daq.k48p40048') }}
          </button>
          <button
            class="pill-btn"
            :disabled="tplSaving"
            @click="saveTpl"
          >
            {{ tplSaving ? $t('daq.k1b38d59103') : (tplEditing ? $t('daq.k1b39281116') : $t('daq.k1b3dtga119')) }}
          </button>
        </div>

        <p class="sec-label">
          {{ $t('daq.k1w8s84s049') }}
        </p>
        <table class="tpl-table">
          <tbody>
            <tr
              v-for="t in builtinTpls"
              :key="t.key"
            >
              <td>
                <b>{{ t.name }}</b>
                <small class="mono dim">{{ t.code }}</small>
              </td>
              <td class="mono range">
                {{ t.min }}~{{ t.max }} {{ t.unit }} · {{ t.decimals }} {{ $t('daq.k48oi091') }}
              </td>
              <td class="right actions">
                <button
                  class="mini-btn"
                  @click="copyTpl(t)"
                >
                  {{ $t('daq.k3y694050') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 节点清单:筛选工具条(产线/设备/产线运行/状态) + 节点表 -->
    <a-spin :spinning="!daq.loaded && !daq.error">
      <section class="aw-tile table-card">
        <div class="tbl-toolbar">
          <div class="filters">
            <label class="flt">
              <span>{{ $t('daq.k3wj9n051') }}</span>
              <select
                v-model="filters.lineId"
                class="inp-sel"
              >
                <option value="">
                  {{ $t('daq.k1bkl9uj052') }}
                </option>
                <option
                  v-for="l in dcw.lines"
                  :key="l.id"
                  :value="l.id"
                >
                  {{ l.name }}
                </option>
                <option value="none">
                  {{ $t('daq.k3ootr6053') }}
                </option>
              </select>
            </label>
            <label class="flt">
              <span>{{ $t('daq.k1i8rtqt054') }}</span>
              <select
                v-model="filters.deviceId"
                class="inp-sel"
              >
                <option value="">
                  {{ $t('daq.k1bkw4m2055') }}
                </option>
                <option
                  v-for="d in boundDevices"
                  :key="d.id"
                  :value="d.id"
                >
                  {{ d.name }}({{ d.count }})
                </option>
                <option value="none">
                  {{ $t('daq.k3own4q056') }}
                </option>
              </select>
            </label>
            <label
              class="flt"
              :title="$t('daq.khb8mru009')"
            >
              <span>{{ $t('daq.k1b2tkyv057') }}</span>
              <select
                v-model="filters.lineRun"
                class="inp-sel"
              >
                <option value="">
                  {{ $t('daq.k3x4t1058') }}
                </option>
                <option value="on">
                  {{ $t('daq.k1nxm3p7059') }}
                </option>
                <option value="off">
                  {{ $t('daq.k1ulx34e060') }}
                </option>
              </select>
            </label>
            <label class="flt">
              <span>{{ $t('daq.k1iwdfef061') }}</span>
              <select
                v-model="filters.state"
                class="inp-sel"
              >
                <option value="">
                  {{ $t('daq.k3x4t1058') }}
                </option>
                <option value="ok">
                  {{ $t('daq.k41k5c062') }}
                </option>
                <option value="warn">
                  {{ $t('daq.k49z8v063') }}
                </option>
                <option value="alarm">
                  {{ $t('daq.k3xmid064') }}
                </option>
                <option value="offline">
                  {{ $t('daq.k44c2n065') }}
                </option>
              </select>
            </label>
            <button
              v-if="hasFilters"
              class="mini-btn clear-btn"
              @click="clearFilters"
            >
              {{ $t('daq.k1fygck2066') }}
            </button>
          </div>
          <span class="count mono">{{ filteredNodes.length }} / {{ daq.nodes.length }} {{ $t('daq.k45uio067') }}</span>
        </div>
        <table class="nodes-table">
          <thead>
            <tr>
              <th>{{ $t('daq.k45uio067') }}</th>
              <th>{{ $t('daq.k42w8s068') }}</th>
              <th>{{ $t('daq.k3mv305069') }}</th>
              <th>{{ $t('daq.k1l6g2ga070') }}</th>
              <th>{{ $t('daq.k3zi0nf071') }}</th>
              <th>{{ $t('daq.k4a0la072') }}</th>
              <th>{{ $t('daq.k3wj9n051') }}</th>
              <th :title="$t('daq.k1runtipc131')">
                {{ $t('daq.k1b2tkyv057') }}
              </th>
              <th :title="$t('daq.k1prdrtip132')">
                {{ $t('daq.k1prodrc128') }}
              </th>
              <th>{{ $t('daq.k1i8rtqt054') }}</th>
              <th class="right">
                {{ $t('daq.k40aa6073') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="n in filteredNodes"
              :key="n.id"
              :class="{ 'row-recipe-alarm': recipeAlarm(n) }"
            >
              <td>
                <span class="mono dim">{{ n.id.slice(0, 8) }}</span>
                <b>{{ n.name }}</b>
                <small class="mono ch">{{ daqTemplateRefCh(n.templateRef) }}</small>
              </td>
              <td>
                <span
                  class="st-pill"
                  :class="[statePillOf(n).key]"
                  :title="statePillOf(n).tip"
                >{{ statePillOf(n).label }}</span>
              </td>
              <td
                class="mono val"
                :class="{ stale: !isLive(n) }"
                :title="isLive(n) ? undefined : statePillOf(n).tip"
              >
                {{ n.value != null ? n.value.toFixed(n.decimals) : '--' }}
                <small>{{ n.unit }}</small>
              </td>
              <td class="mono">
                {{ intervalOf(n.intervalMs) }}
              </td>
              <td class="mono">
                {{ publishOf(n.publishIntervalMs) }}
              </td>
              <td>
                <span
                  class="drv-tag"
                  :class="{ planned: driverPlanned(n.driver) }"
                  :title="driverPlanned(n.driver) ? $t('daq.k1plndrv138') : ''"
                >{{ n.driver }}</span>
              </td>
              <td>
                <select
                  class="line-sel"
                  :value="n.lineId"
                  :title="$t('daq.k3q23v3010')"
                  @change="setNodeLine(n.id, $event)"
                >
                  <option value="">
                    {{ $t('daq.k3ootr6053') }}
                  </option>
                  <option
                    v-for="l in dcw.lines"
                    :key="l.id"
                    :value="l.id"
                  >
                    {{ l.name }}
                  </option>
                </select>
              </td>
              <!-- 产线运行:呼吸绿点=运行中 / 空心点=未运行(与产线状态带同一套点语义) -->
              <td>
                <span
                  v-if="n.lineId"
                  class="run-pill"
                  :class="{ on: dcw.lineStateOf(n.lineId).active }"
                  :title="$t('daq.k1runtipc131')"
                >
                  <span class="rp-dot" />
                  {{ dcw.lineStateOf(n.lineId).active ? $t('daq.k3vp67i096') : $t('daq.k3ozyqz117') }}
                </span>
                <span
                  v-else
                  class="run-pill na"
                >{{ $t('daq.k3ootr6053') }}</span>
              </td>
              <!-- 产品 / Recipe:本线活动批次(运行中才携带;停线/未分配 → --) -->
              <td class="prod-cell">
                <template v-if="n.lineId && dcw.lineStateOf(n.lineId).active">
                  <b :title="$t('daq.k1prdrtip132')">{{ dcw.lineStateOf(n.lineId).productName || '--' }}</b>
                  <small
                    class="mono"
                    :title="$t('daq.k1prdrtip132')"
                  >{{ dcw.lineStateOf(n.lineId).recipeName || '--' }}</small>
                </template>
                <span
                  v-else
                  class="dim"
                >--</span>
              </td>
              <td>{{ deviceName(n.deviceBindingId) }}</td>
              <td class="right">
                <NuxtLink
                  class="console-link"
                  :to="`/daq/${n.id}`"
                >
                  <span class="i-tabler-dashboard" />
                  {{ $t('daq.k3o3jg2074') }}
                </NuxtLink>
              </td>
            </tr>
            <tr v-if="daq.loaded && daq.nodes.length === 0">
              <td colspan="11">
                <div
                  class="pane-empty"
                  style="min-height: 120px;"
                >
                  <p class="pe-sub">
                    {{ $t('daq.kvhjyc3075') }}
                  </p>
                </div>
              </td>
            </tr>
            <tr v-else-if="daq.loaded && filteredNodes.length === 0">
              <td colspan="11">
                <div
                  class="pane-empty"
                  style="min-height: 90px;"
                >
                  <p class="pe-sub">
                    {{ $t('daq.k1w20qew076') }}
                  </p>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </a-spin>

    <p
      v-if="daq.error"
      class="err"
    >
      {{ daq.error }}(<NuxtLink to="/workshop">{{ $t('daq.k1bhhheq077') }}</NuxtLink>)
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
.badge {
  padding: 3px 10px;
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--ink-soft);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}

.ctrl-card {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 12px 18px 11px;
  margin-bottom: 14px;
}
.ctrl-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  justify-content: space-between;
}
.ctrl-left { display: flex; gap: 14px; align-items: center; }
.aw-pill.running { background: var(--accent); }
.cycle { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ink-faint); }
.cycle input {
  width: 84px;
  padding: 4px 8px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.ctrl-metrics { display: flex; gap: 8px; align-items: center; font-size: 11.5px; color: var(--ink-soft); }
.ctrl-metrics .sep { opacity: 0.4; }
.ctrl-metrics .warn { color: var(--tone-warning-dot); }

/* 产线状态带:label 固定 + 单行横向滚动(任意产线数量恒定一行高) */
.line-strip {
  display: flex;
  gap: 12px;
  align-items: center;
  padding-top: 10px;
  border-top: 1px solid var(--divider-hair);
}
.strip-label {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 6px;
  align-items: center;
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-fainter);
}
.strip-label small { font-size: 10px; color: var(--ink-faint); }
.strip-scroll {
  display: flex;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
}
.strip-scroll::-webkit-scrollbar { height: 4px; }
.strip-scroll::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 2px; }
.strip-scroll::-webkit-scrollbar-track { background: transparent; }
.line-pill {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 7px;
  align-items: center;
  padding: 4px 12px;
  font-size: 11.5px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
/* 空心点 = 待机;实心呼吸点 = 运行(状态语义承载体,非装饰) */
.line-pill .lp-dot {
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--lc, var(--ink-fainter));
  border-radius: 50%;
  opacity: 0.55;
}
.line-pill b { font-weight: 600; }
.line-pill small { font-size: 10.5px; color: var(--ink-fainter); }
.line-pill:hover { border-color: var(--lc, var(--accent)); color: var(--ink); }
.line-pill.on {
  color: var(--ink);
  background: color-mix(in srgb, var(--lc) 10%, transparent);
  border-color: color-mix(in srgb, var(--lc) 50%, transparent);
}
.line-pill.on .lp-dot {
  border-color: transparent;
  background: var(--lc);
  opacity: 1;
}
.line-pill.on .lp-run { color: color-mix(in srgb, var(--lc) 75%, var(--ink)); }
@media (prefers-reduced-motion: no-preference) {
  .line-pill.on .lp-dot { box-shadow: 0 0 7px color-mix(in srgb, var(--lc) 75%, transparent); animation: lpPulse 1.8s ease-in-out infinite; }
}
@keyframes lpPulse {
  0%, 100% { box-shadow: 0 0 3px color-mix(in srgb, var(--lc) 55%, transparent); }
  50% { box-shadow: 0 0 9px color-mix(in srgb, var(--lc) 85%, transparent); }
}

.table-card { overflow-x: auto; }
.nodes-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.nodes-table th, .nodes-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.nodes-table th {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line-strong);
}
.nodes-table td b { margin-left: 8px; }
.ch { display: block; margin-top: 2px; font-size: 10px; color: var(--ink-faint); }
.right { text-align: right; }
.val { font-size: 13px; }
.val small { margin-left: 3px; color: var(--ink-faint); }
/* 数据静默(停用/未运行/采不到数据):最后值置灰呈现,不再冒充实时值 */
.val.stale { opacity: 0.45; }

.st-pill {
  display: inline-block;
  padding: 2px 9px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  border-radius: var(--radius-pill);
}
.st-pill.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.st-pill.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
/* 配方越限行:整行淡红底 + 左缘警示条 */
tr.row-recipe-alarm { background: color-mix(in srgb, var(--tone-danger-dot, #ff6b6b) 8%, transparent); }
tr.row-recipe-alarm td:first-child { box-shadow: inset 3px 0 0 var(--tone-danger-dot, #ff6b6b); }
.st-pill.offline { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }
/* 非故障的静止态(停用/未分配/未运行):同为中性灰,与故障离线区分靠文案与提示 */
.st-pill.idle, .st-pill.disabled, .st-pill.unassigned { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }

.drv-tag {
  font-family: var(--font-mono);
  font-size: 10.5px;
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  color: var(--ink-soft);
}
.drv-tag.planned { opacity: 0.55; border-style: dashed; }

.console-link { display: inline-flex; gap: 5px; align-items: center; font-size: 12.5px; color: var(--accent); }
.err { margin-top: 14px; font-size: 13px; color: var(--tone-danger-dot); }
@media (prefers-reduced-motion: no-preference) {
  .nodes-table tbody tr:hover { background: var(--hover-tint); }
}

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
/* 筛选产线运行中:绿色语义变体 */
.infra-banner.good {
  color: var(--tone-success-dot);
  background: var(--tone-success-bg);
  border-color: color-mix(in srgb, var(--tone-success-dot) 40%, transparent);
}
.infra-banner .txt { flex: 1 1 auto; font-size: 12.5px; line-height: 1.5; }
.infra-banner .txt a { color: var(--accent); text-decoration: underline; }
.infra-banner .txt b { font-weight: 600; }
.infra-banner .txt small { margin-left: 8px; font-size: 10.5px; opacity: 0.75; }
.infra-banner .pill-btn { flex: 0 0 auto; color: var(--paper-raised); text-decoration: none; }

/* ---------- 添加节点向导 ---------- */
.ctrl-right { display: flex; gap: 12px; align-items: center; }
.add-btn { padding: 8px 16px; font-size: 13px; }
.modal-mask {
  position: fixed;
  z-index: 50;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}
.modal {
  width: 640px;
  max-width: 94vw;
  max-height: 88vh;
  overflow-y: auto;
  padding: 22px 24px;
  background: var(--surface-glass-strong);
  backdrop-filter: var(--aurora-blur);
  -webkit-backdrop-filter: var(--aurora-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-edge), var(--shadow-float);
}
.m-title { margin: 0 0 14px; font-size: 17px; }
.seg-row { display: flex; gap: 8px; margin-bottom: 14px; }
.seg {
  flex: 1;
  padding: 8px 0;
  font-size: 13px;
  cursor: pointer;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}
.seg.on {
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}
.f-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.driver-form { grid-template-columns: repeat(3, 1fr); }
.cal-form { grid-template-columns: 2fr 1fr; align-items: end; }
.f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.f em { margin-left: 3px; font-style: normal; color: var(--tone-danger-dot); }
.inp {
  width: 100%;
  padding: 6px 9px;
  font-size: 12.5px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.hint { font-size: 10px; color: var(--ink-fainter); }
.test-row { display: flex; gap: 10px; align-items: center; margin: 6px 0 4px; }
.pill-btn {
  padding: 7px 14px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--paper-raised);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill);
}
.pill-btn:disabled { opacity: 0.5; cursor: default; }
.test-result { font-family: var(--font-mono); font-size: 11px; }
.test-result.ok { color: var(--tone-success-dot); }
.test-result.bad { color: var(--tone-danger-dot); }
.m-err { margin: 8px 0 0; font-size: 12px; color: var(--tone-danger-dot); }
.m-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.aw-pill.outline { color: var(--ink); background: var(--paper-raised); border-color: var(--line-strong); }

/* ---------- 模板管理 ---------- */
.sec-label {
  margin: 14px 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.tpl-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tpl-table td { padding: 7px 8px; border-bottom: 1px solid var(--divider-hair); }
.tpl-table td b { margin-right: 8px; }
.tpl-table .range { font-size: 11.5px; color: var(--ink-soft); }
.tpl-table .empty { color: var(--ink-fainter); font-size: 12px; text-align: center; padding: 14px 0; }
.tpl-table .actions { white-space: nowrap; }
.mini-btn {
  padding: 3px 10px;
  font-size: 11.5px;
  cursor: pointer;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.mini-btn.danger { color: var(--tone-danger-dot); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }

/* ---------- 节点筛选工具条 ---------- */
.tbl-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  justify-content: space-between;
  padding: 11px 14px;
  border-bottom: 1px solid var(--divider-hair);
}
.filters { display: flex; flex-wrap: wrap; gap: 9px; align-items: flex-end; }
.flt {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink-fainter);
}
.inp-sel {
  min-width: 112px;
  padding: 4px 8px;
  font-size: 11.5px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  transition: border-color 0.15s;
}
.inp-sel:focus { outline: none; border-color: var(--accent); }
.clear-btn { margin-bottom: 1px; }
.count { padding-bottom: 4px; font-size: 11px; color: var(--ink-faint); }

.line-sel {
  max-width: 120px;
  padding: 3px 6px;
  font-size: 10.5px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  transition: border-color 0.15s;
}
.line-sel:focus { outline: none; border-color: var(--accent); }

/* 产线运行列:空心点=未运行(中性) / 呼吸绿点=运行中 —— 与产线状态带同一套点语义 */
.run-pill {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 2px 9px;
  font-size: 10.5px;
  color: var(--ink-fainter);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
}
.run-pill .rp-dot {
  width: 6px;
  height: 6px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  opacity: 0.7;
}
.run-pill.na {
  border-style: dashed;
  opacity: 0.75;
}
.run-pill.on {
  color: var(--tone-success-dot);
  border-color: color-mix(in srgb, var(--tone-success-dot) 40%, transparent);
  background: var(--tone-success-bg);
}
.run-pill.on .rp-dot {
  background: var(--tone-success-dot);
  border-color: transparent;
  opacity: 1;
}
@media (prefers-reduced-motion: no-preference) {
  .run-pill.on .rp-dot { animation: rpPulse 1.8s ease-in-out infinite; }
}
@keyframes rpPulse {
  0%, 100% { box-shadow: 0 0 2px color-mix(in srgb, var(--tone-success-dot) 55%, transparent); }
  50% { box-shadow: 0 0 7px color-mix(in srgb, var(--tone-success-dot) 85%, transparent); }
}

/* 产品 / Recipe 列:产品主行 + Recipe 副行(两行紧凑,超长省略) */
.prod-cell { max-width: 170px; }
.prod-cell b {
  display: block;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prod-cell small {
  display: block;
  margin-top: 1px;
  font-size: 10px;
  color: var(--ink-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
