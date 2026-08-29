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

definePageMeta({ layout: 'default' })
useHead({ title: '数采中心 · AgentWorkShop' })

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
  // meta 指标随读数帧落库节奏低频刷新(诚实可见的管线运行数据)
  redrawTimer = setInterval(() => void daq.load(), 5000)
})
onBeforeUnmount(() => {
  unsub?.()
  if (redrawTimer) clearInterval(redrawTimer)
})

const deviceName = (id: string | null): string =>
  id ? (nodeDevices.get(id) ?? `${id.slice(0, 8)}…`) : '未绑定'

// 设备名映射(device-twins 注册表;绑定列展示用)
const deviceTwins = useDeviceTwins()
const nodeDevices = new Map<string, string>()
watch(() => deviceTwins.twins, (list) => {
  for (const t of list) nodeDevices.set(t.id, t.name)
}, { immediate: true, deep: true })

const intervalOf = (intervalMs: number | null): string => {
  if (intervalMs == null) return `全局 ${daq.controller.defaultIntervalMs}ms`
  return `${intervalMs}ms`
}

/** WS 下发节拍展示(null=跟随全局;0=每帧;>0 独立间隔) */
const publishOf = (v: number | null): string => {
  if (v == null) return `全局 ${daq.controller.defaultPublishIntervalMs}ms`
  if (v === 0) return '每帧'
  return `${v}ms`
}

const stateLabel: Record<DaqNodeState, string> = {
  ok: '正常',
  warn: '预警',
  alarm: '告警',
  offline: '离线',
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
          throw new Error(`缺少必填参数:${f.label}`)
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

/** 展示态:控制器暂停或节点停用 → offline(与服务端 effectiveTwinState 同语义) */
function effectiveState(n: { enabled: boolean, state: DaqNodeState }): DaqNodeState {
  if (!daq.controller.running || !n.enabled) return 'offline'
  return n.state
}

/** 模板通道语义(server 目录为准,内置兜底;daq- 前缀兼容) */
function daqTemplateRefCh(templateRef: string): string {
  const tpl = daq.templates.find(t => t.key === daqKeyFromRef(templateRef))
    ?? DAQ_TEMPLATES.find(t => t.key === daqKeyFromRef(templateRef))
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
  thermo: '温度', pressure: '压力', tension: '张力', encoder: '编码器', camera: '视觉', gateway: '电参/网关',
}

const customTpls = computed<DaqTemplateDef[]>(() => daq.templates.filter(t => !t.builtin))
const builtinTpls = computed<DaqTemplateDef[]>(() => daq.templates.filter(t => t.builtin))

function fillTplForm(t: DaqTemplateDef, asCopy = false): void {
  tplForm.name = asCopy ? `${t.name} 副本` : t.name
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
        <h1>数采中心</h1>
        <p class="sub">
          采集 → 队列(MQTT)→ 时序库(Timescale)→ WS 实时下发全链路;节点实体与参数以服务端为准。
        </p>
      </div>
      <div class="badges mono">
        <span
          class="badge"
          :title="'时序存储后端:DAQ_TSDB_URL 可切换 TimescaleDB'"
        >TSDB · {{ daq.meta.tsdb }}</span>
        <span
          class="badge"
          :title="'消息队列:DAQ_MQTT_URL 可切换标准 MQTT broker'"
        >QUEUE · {{ daq.meta.queue }}</span>
      </div>
    </div>

    <!-- 产线门控横幅(无活动配方:采集与实时下发暂停) -->
    <div
      v-if="daq.loaded && !anyLineActive"
      class="infra-banner"
    >
      <span class="i-tabler-info-circle" />
      <span class="txt">产线未开跑 —— 数采由产线配方驱动:请在<NuxtLink to="/dcw">产线运营</NuxtLink>开跑产线,并将节点挂载到产线</span>
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
        {{ reconnecting ? '重连中…' : '重连基础设施' }}
      </button>
    </div>

    <!-- 控制器总控条 -->
    <section class="aw-tile ctrl-card">
      <div class="ctrl-left">
        <button
          class="aw-pill"
          :class="{ running: daq.controller.running }"
          @click="daq.controllerAction(daq.controller.running ? 'stop' : 'start')"
        >
          <span :class="daq.controller.running ? 'i-tabler-player-pause' : 'i-tabler-player-play'" />
          {{ daq.controller.running ? '暂停全部采集' : '恢复全部采集' }}
        </button>
        <label class="cycle mono">
          缺省周期
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
          title="节点未单独设置 WS 下发间隔时的全局缺省;0 = 随采样节拍每帧下发"
        >
          缺省下发
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
          <span>节点 {{ daq.controller.nodesOnline }}/{{ daq.controller.nodesTotal }}</span>
          <span class="sep">·</span>
          <span title="生产者已发布到队列">发布 {{ daq.meta.produced }}</span>
          <span class="sep">·</span>
          <span title="消费者已从队列取得">消费 {{ daq.meta.consumed }}</span>
          <span class="sep">·</span>
          <span
            :class="{ warn: (daq.meta.dropped ?? 0) > 0 }"
            title="队列丢失(produced-consumed)"
          >丢失 {{ daq.meta.dropped }}</span>
          <span class="sep">·</span>
          <span title="时序库累计入库样本">入库 {{ daq.meta.samplesStored }}</span>
        </span>
        <button
          class="aw-pill outline add-btn"
          @click="tplOpen = true; resetTplForm()"
        >
          <span class="i-tabler-adjustments-horizontal" />
          模板管理
        </button>
        <button
          class="aw-pill add-btn"
          @click="addOpen = true"
        >
          <span class="i-tabler-plus" />
          添加节点
        </button>
        <NuxtLink
          v-for="l in dcw.lines"
          :key="l.id"
          class="line-chip mono"
          :class="{ on: dcw.lineStateOf(l.id).active }"
          :style="dcw.lineStateOf(l.id).active ? { '--lc': l.color } : undefined"
          to="/dcw"
          :title="dcw.lineStateOf(l.id).active ? `产线运行中:${dcw.lineStateOf(l.id).productName} · ${dcw.lineStateOf(l.id).recipeName}` : `${l.name} 待机:开跑后本产线节点开始采集`"
        >
          {{ dcw.lineStateOf(l.id).active ? `● ${l.name}` : `○ ${l.name}` }}
        </NuxtLink>
        <NuxtLink
          v-if="dcw.lines.length === 0"
          class="line-chip mono"
          to="/dcw"
        >
          ○ 产线未开跑
        </NuxtLink>
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
          添加数采节点
        </h3>

        <div class="seg-row">
          <button
            class="seg"
            :class="{ on: addScenario === 'mock' }"
            @click="addScenario = 'mock'"
          >
            Mock 模拟源
          </button>
          <button
            class="seg"
            :class="{ on: addScenario === 'real' }"
            @click="addScenario = 'real'"
          >
            真实设备采集
          </button>
        </div>

        <div class="f-grid">
          <label class="f">
            <span>信号模板(量程/单位域)</span>
            <select
              v-model="addTemplate"
              class="inp"
            >
              <option
                v-for="t in daq.templates"
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
          <label
            v-if="addScenario === 'real'"
            class="f"
          >
            <span>采样周期 ms(空=跟随全局)</span>
            <input
              v-model.number="addInterval"
              type="number"
              min="200"
              max="60000"
              step="100"
              class="inp"
              placeholder="如 1000"
            >
          </label>
        </div>

        <!-- 真实场景:协议选择 + 动态参数表单 + 测试连接 -->
        <template v-if="addScenario === 'real'">
          <div class="f-grid">
            <label class="f">
              <span>通信协议</span>
              <select
                v-model="addDriver"
                class="inp"
              >
                <option
                  v-for="d in DAQ_DRIVERS.filter(x => x.status !== 'planned')"
                  :key="d.kind"
                  :value="d.kind"
                >
                  {{ d.label }}{{ driverReady(d.kind) ? '' : '(栈未装)' }}
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
              {{ addTesting ? '测试中…' : '测试连接' }}
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
            取消
          </button>
          <button
            class="aw-pill"
            :disabled="addSaving || (addScenario === 'real' && addTest != null && !addTest.ok)"
            :title="addScenario === 'real' && !(addTest && addTest.ok) ? '真实场景需先通过测试连接' : ''"
            @click="doAddNode"
          >
            {{ addSaving ? '创建中…' : (addScenario === 'real' ? '测试通过后创建并采集' : '创建节点') }}
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
          信号模板管理
        </h3>

        <p class="sec-label">
          自定义模板
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
                {{ t.min }}~{{ t.max }} {{ t.unit }} · {{ t.decimals }} 位
              </td>
              <td class="right actions">
                <button
                  class="mini-btn"
                  @click="editTpl(t)"
                >
                  编辑
                </button>
                <button
                  class="mini-btn danger"
                  @click="askDelTpl(t)"
                >
                  {{ confirmingDel === t.key ? '确认删除' : '删除' }}
                </button>
              </td>
            </tr>
            <tr v-if="!customTpls.length">
              <td
                colspan="3"
                class="empty"
              >
                暂无自定义模板 —— 从下方内置模板复制,或直接在下方表单新建。
              </td>
            </tr>
          </tbody>
        </table>

        <p class="sec-label">
          {{ tplEditing ? '编辑模板' : '新建模板' }}
        </p>
        <div class="f-grid">
          <label class="f">
            <span>名称<em>*</em></span>
            <input
              v-model="tplForm.name"
              class="inp"
              placeholder="如 烘箱湿度"
            >
          </label>
          <label class="f">
            <span>单位<em>*</em></span>
            <input
              v-model="tplForm.unit"
              class="inp"
              placeholder="如 %RH"
            >
          </label>
          <label class="f">
            <span>通道语义</span>
            <input
              v-model="tplForm.ch"
              class="inp"
              placeholder="缺省同名称"
            >
          </label>
          <label class="f">
            <span>位号代号</span>
            <input
              v-model="tplForm.code"
              class="inp"
              placeholder="缺省自动生成"
            >
          </label>
          <label class="f">
            <span>量程下限<em>*</em></span>
            <input
              v-model.number="tplForm.min"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>量程上限<em>*</em></span>
            <input
              v-model.number="tplForm.max"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>小数位</span>
            <input
              v-model.number="tplForm.decimals"
              type="number"
              min="0"
              max="4"
              class="inp"
            >
          </label>
          <label class="f">
            <span>图标</span>
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
            <span>模拟基值</span>
            <input
              v-model.number="tplForm.base"
              type="number"
              class="inp"
            >
            <small class="hint">Mock 采样中心值,缺省量程中点</small>
          </label>
          <label class="f">
            <span>模拟波幅</span>
            <input
              v-model.number="tplForm.amp"
              type="number"
              class="inp"
            >
            <small class="hint">Mock 波动幅度,缺省量程 4%</small>
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
            重置
          </button>
          <button
            class="pill-btn"
            :disabled="tplSaving"
            @click="saveTpl"
          >
            {{ tplSaving ? '保存中…' : (tplEditing ? '保存修改' : '保存模板') }}
          </button>
        </div>

        <p class="sec-label">
          内置模板(只读,可复制)
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
                {{ t.min }}~{{ t.max }} {{ t.unit }} · {{ t.decimals }} 位
              </td>
              <td class="right actions">
                <button
                  class="mini-btn"
                  @click="copyTpl(t)"
                >
                  复制
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 节点清单 -->
    <a-spin :spinning="!daq.loaded && !daq.error">
      <section class="aw-tile table-card">
        <table class="nodes-table">
          <thead>
            <tr>
              <th>节点</th>
              <th>状态</th>
              <th>实时值</th>
              <th>采样周期</th>
              <th>WS 下发</th>
              <th>驱动</th>
              <th>产线</th>
              <th>绑定设备</th>
              <th class="right">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="n in daq.nodes"
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
                  :class="[effectiveState(n)]"
                  :title="recipeWinOf(n) ? `活动配方监控窗口 ${recipeWinOf(n)!.min ?? '-∞'} ~ ${recipeWinOf(n)!.max ?? '+∞'}${recipeAlarm(n) ? '(越限报警)' : ''}` : ''"
                >{{ recipeAlarm(n) ? '配方越限' : stateLabel[effectiveState(n)] }}</span>
              </td>
              <td class="mono val">
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
                  :title="driverPlanned(n.driver) ? '预留协议:待真实通道接入' : ''"
                >{{ n.driver }}</span>
              </td>
              <td>
                <select
                  class="line-sel"
                  :value="n.lineId"
                  title="节点产线归属(未挂载产线的节点不采集)"
                  @change="setNodeLine(n.id, $event)"
                >
                  <option value="">
                    未分配
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
              <td>{{ deviceName(n.deviceBindingId) }}</td>
              <td class="right">
                <NuxtLink
                  class="console-link"
                  :to="`/daq/${n.id}`"
                >
                  <span class="i-tabler-dashboard" />
                  控制台
                </NuxtLink>
              </td>
            </tr>
            <tr v-if="daq.loaded && daq.nodes.length === 0">
              <td colspan="8">
                <div
                  class="pane-empty"
                  style="min-height: 120px;"
                >
                  <p class="pe-sub">
                    暂无数采节点 —— 在数字孪生空间从左轨「数采节点 · DAQ」拖入即可(server 建立节点实体)。
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
      {{ daq.error }}(<NuxtLink to="/workshop">前往登录</NuxtLink>)
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
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  margin-bottom: 14px;
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
.infra-banner .txt { flex: 1 1 auto; font-size: 12.5px; line-height: 1.5; }
.infra-banner .txt a { color: var(--accent); text-decoration: underline; }
.line-chip {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--tone-neutral-dot);
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-pill);
}
.line-chip.on {
  color: var(--lc, var(--tone-success-dot));
  border: 1px solid color-mix(in srgb, var(--lc, var(--tone-success-dot)) 50%, transparent);
  background: color-mix(in srgb, var(--lc, var(--tone-success-dot)) 12%, transparent);
}
.infra-banner .pill-btn { flex: 0 0 auto; color: var(--paper-raised); }

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
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float);
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

.line-sel {
  max-width: 120px;
  padding: 3px 6px;
  font-size: 10.5px;
  color: #8fa0b5;
  background: #0a111d;
  border: 1px solid rgba(45, 62, 92, 0.8);
  border-radius: 6px;
}
.line-sel:focus { outline: none; border-color: #35e0a0; }
</style>
