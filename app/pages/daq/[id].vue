<script setup lang="ts">
/**
 * 数采节点控制台(/daq/[id])—— 单节点专业控制面。
 * 实时值 + live 趋势(WS 流);参数控制(server DaqNode 单点参数:启停/周期/
 * 驱动/量程/预警带);设备绑定;时序库历史查询(降采样桶选择)。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import { daqKeyFromRef, DAQ_DRIVERS, type DaqDriverKind, type DaqNodeState, type DriverConfigField, type DriverTestResult as DaqDriverTestResult } from '#shared/daq-protocol'

const { t } = useI18n()

definePageMeta({ layout: 'default' })

const route = useRoute()
const nodeId = computed(() => String(route.params.id ?? ''))
const daq = useDaqStream()
const dcw = useDcwStream()
void dcw.load()
const deviceTwins = useDeviceTwins()

const node = computed(() => daq.nodeById(nodeId.value) ?? null)
// server 模板目录为唯一事实源:模板被删除时降级显示 key 原文,不再回退到
// 打包内置常量(那会渲染过期语义)
const tpl = computed(() => {
  const key = node.value ? daqKeyFromRef(node.value.templateRef) : ''
  return daq.templates.find(t => t.key === key) ?? null
})
const stateLabel: Record<DaqNodeState, string> = { ok: t('daqDetail.k41k5c026'), warn: t('daqDetail.k49z8v027'), alarm: t('daqDetail.k3xmid028'), offline: t('daqDetail.k44c2n029') }
const effectiveState = (): DaqNodeState => {
  const n = node.value
  if (!n) return 'offline'
  if (!daq.controller.running || !n.enabled) return 'offline'
  return n.state
}

let unsub: (() => void) | null = null
onMounted(() => {
  unsub = daq.ensureWsFeed()
  void daq.load()
  void deviceTwins.load()
})
onBeforeUnmount(() => unsub?.())

/** WS 下发节拍展示(null=跟随全局;0=每帧;>0 独立间隔) */
function publishLabel(v: number | null): string {
  if (v == null) return t('daqDetail.k9vnp9h053', { p0: daq.controller.defaultPublishIntervalMs })
  if (v === 0) return t('daqDetail.k1m1zwux030')
  return `${v}ms`
}

// ---------- 参数表单(server 单点控制;变更经 PATCH 落库,node.changed 帧回灌) ----------
const form = reactive({
  enabled: true,
  driver: 'mock' as DaqDriverKind,
  lineId: '',
  followGlobal: true,
  intervalMs: 1000,
  calKind: 'none' as 'none' | 'linear',
  calScale: 1,
  calOffset: 0,
  publishFollow: true,
  publishEveryFrame: false,
  publishMs: 1000,
  unit: '',
  decimals: 1,
  min: 0,
  max: 100,
  warnLow: null as number | null,
  warnHigh: null as number | null,
})
watch(node, (n) => {
  if (!n) return
  form.enabled = n.enabled
  form.lineId = n.lineId ?? ''
  form.driver = n.driver
  form.followGlobal = n.intervalMs == null
  form.intervalMs = n.intervalMs ?? daq.controller.defaultIntervalMs
  // WS 下发节拍:null=跟随全局;0=每帧;>0 独立间隔
  form.publishFollow = n.publishIntervalMs == null
  form.publishEveryFrame = n.publishIntervalMs === 0
  form.publishMs = n.publishIntervalMs == null ? daq.controller.defaultPublishIntervalMs : n.publishIntervalMs
  form.unit = n.unit
  form.decimals = n.decimals
  form.min = n.min
  form.max = n.max
  form.warnLow = n.warnLow
  form.warnHigh = n.warnHigh
}, { immediate: true })

// 驱动连接参数编辑(真实协议:host/register/endpoint...;schema 驱动渲染)
const driverCfg = ref<Record<string, string | number>>({})
const driverFields = computed<DriverConfigField[]>(() =>
  DAQ_DRIVERS.find(d => d.kind === form.driver)?.configFields ?? [])
watch(node, (n) => {
  if (n) driverCfg.value = { ...(n.driverConfig as Record<string, string | number>) }
}, { immediate: true })
watch(() => form.driver, () => {
  // 切换协议且目标无参数 → 填 schema 缺省
  if (driverFields.value.length && Object.keys(driverCfg.value).length === 0) {
    const cfg: Record<string, string | number> = {}
    for (const f of driverFields.value) if (f.default !== undefined) cfg[f.key] = f.default as string | number
    driverCfg.value = cfg
  }
}, { immediate: true })
const testing = ref(false)
const testResult = ref<DaqDriverTestResult | null>(null)
async function doTest(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    // 先保存当前驱动与参数,再测(测存量节点 = 测已落库配置)
    await daq.patchNode(nodeId.value, { driver: form.driver, driverConfig: { ...driverCfg.value } })
    testResult.value = await daq.testNode(nodeId.value)
  }
  catch (err) {
    testResult.value = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  finally {
    testing.value = false
  }
}

const saving = ref(false)
async function saveParams(): Promise<void> {
  const n = node.value
  if (!n || saving.value) return
  saving.value = true
  try {
    await daq.patchNode(n.id, {
      enabled: form.enabled,
      driver: form.driver,
      lineId: form.lineId,
      driverConfig: { ...driverCfg.value },
      intervalMs: form.followGlobal ? null : Math.max(120, Math.min(60_000, Math.round(form.intervalMs))),
      publishIntervalMs: form.publishFollow
        ? null
        : (form.publishEveryFrame ? 0 : Math.max(0, Math.min(60_000, Math.round(form.publishMs)))),
      unit: form.unit,
      decimals: Math.max(0, Math.min(6, Math.round(form.decimals))),
      min: form.min,
      max: form.max,
      warnLow: form.warnLow,
      warnHigh: form.warnHigh,
    })
  }
  finally {
    saving.value = false
  }
}

/** 驱动是否为预留协议(meta status=planned) */
function driverPlanned(kind: string): boolean {
  return daq.meta.drivers.find(d => d.kind === kind)?.status === 'planned'
}

// ---------- 设备绑定 ----------
const bindDeviceId = ref('')
const boundDeviceName = computed(() => {
  const id = node.value?.deviceBindingId
  if (!id) return ''
  return deviceTwins.twins.find(t => t.id === id)?.name ?? `${id.slice(0, 8)}…`
})
function onBindToggle(): void {
  void daq.bindNode(nodeId.value, node.value?.deviceBindingId ? null : (bindDeviceId.value || null))
}
const availableDevices = computed(() =>
  deviceTwins.twins.filter(t => t.kind !== 'daq' && t.id !== node.value?.id),
)

// ---------- 历史(时序库) ----------
type ChartRow = { at: number, value?: number, avg?: number, min?: number, max?: number }
const historyPoints = ref<ChartRow[]>([])
const bucketMs = ref<number>(5000)
const histLoading = ref(false)
const BUCKETS = [
  { label: t('daqDetail.k3lha20031'), ms: 0 },
  { label: '1s 桶', ms: 1000 },
  { label: '5s 桶', ms: 5000 },
  { label: '30s 桶', ms: 30000 },
]
async function loadHistory(): Promise<void> {
  if (!nodeId.value) return
  histLoading.value = true
  try {
    const pts = await daq.samplesOf(nodeId.value, {
      toMs: Date.now(),
      bucketMs: bucketMs.value || undefined,
      limit: 400,
    })
    // 接口 DESC 返回 → 图表时间正序
    historyPoints.value = [...pts].reverse() as ChartRow[]
  }
  finally {
    histLoading.value = false
    drawChart()
  }
}

const chartCanvas = ref<HTMLCanvasElement | null>(null)
const trendColor = '#35e0a0'
const gridColor = 'rgba(120,135,160,0.18)'
const inkColor = 'rgba(140,155,175,0.8)'
function drawChart(): void {
  const cv = chartCanvas.value
  if (!cv) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = cv.clientWidth
  const h = cv.clientHeight
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr
    cv.height = h * dpr
  }
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  for (let i = 1; i < 4; i++) {
    ctx.strokeStyle = gridColor
    ctx.beginPath()
    ctx.moveTo(0, (h / 4) * i)
    ctx.lineTo(w, (h / 4) * i)
    ctx.stroke()
  }
  const rows = historyPoints.value
  if (rows.length < 2) return
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const r of rows) {
    const v = r.value ?? r.avg ?? r.min ?? 0
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  const span = Math.max(hi - lo, 1e-9)
  ctx.strokeStyle = inkColor
  ctx.font = '10px monospace'
  ctx.fillStyle = inkColor
  ctx.fillText(hi.toFixed(2), 4, 11)
  ctx.fillText(lo.toFixed(2), 4, h - 4)
  ctx.strokeStyle = trendColor
  ctx.lineWidth = 1.6
  ctx.beginPath()
  rows.forEach((r, i) => {
    const x = (i / (rows.length - 1)) * w
    const y = h - (((r.value ?? r.avg ?? 0) - lo) / span) * (h - 16) - 8
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
}

/** live 趋势(WS hist 环形缓冲;独立小画布,与历史图互补) */
const liveCanvas = ref<HTMLCanvasElement | null>(null)
let uiTimer: ReturnType<typeof setInterval> | null = null
function drawLive(): void {
  const cv = liveCanvas.value
  const n = node.value
  if (!cv || !n || n.hist.length < 2) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = cv.clientWidth
  const h = cv.clientHeight
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr
    cv.height = h * dpr
  }
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const hi = Math.max(...n.hist)
  const lo = Math.min(...n.hist)
  const span = Math.max(hi - lo, 1e-9)
  ctx.strokeStyle = 'rgba(65,200,244,0.9)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  n.hist.forEach((v, i) => {
    const x = (i / (n.hist.length - 1)) * w
    const y = h - ((v - lo) / span) * (h - 6) - 3
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
}
onMounted(() => {
  void loadHistory()
  // live 趋势重绘循环(仅浏览器;SSR 安全)
  uiTimer = setInterval(() => {
    drawLive()
  }, 800)
})
onBeforeUnmount(() => {
  if (uiTimer) clearInterval(uiTimer)
})

watch(bucketMs, () => void loadHistory())
</script>

<template>
  <div class="page">
    <p class="aw-kicker">
      <NuxtLink
        to="/daq"
        class="back"
      >{{ $t('daqDetail.k1emg364001') }}</NuxtLink> / NODE {{ nodeId.slice(0, 8).toUpperCase() }}
    </p>
    <div class="aw-page-head">
      <h1>{{ node?.name ?? nodeId }}</h1>
      <span
        class="st-pill"
        :class="[effectiveState()]"
      >{{ stateLabel[effectiveState()] }}</span>
    </div>

    <p
      v-if="!node && daq.error"
      class="err"
    >
      {{ daq.error }}(<NuxtLink to="/workshop">{{ $t('daqDetail.k1bhhheq002') }}</NuxtLink>)
    </p>

    <div
      v-if="node"
      class="grid"
    >
      <!-- 左列:实时状态卡 -->
      <section class="col-live">
        <div class="aw-tile value-card">
          <p class="aw-kicker">
            {{ $t('daqDetail.k1fx2vik032') }} {{ tpl?.ch ?? '-' }}
          </p>
          <div class="big-val mono">
            {{ node.value != null ? node.value.toFixed(node.decimals) : '--' }}<small>{{ node.unit }}</small>
          </div>
          <canvas
            ref="liveCanvas"
            class="live-canvas"
          />
          <dl class="facts mono">
            <div>
              <dt>{{ $t('daqDetail.k4a0la003') }}</dt>
              <dd>{{ node.driver }}{{ driverPlanned(node.driver) ? $t('daqDetail.kz8zr9v035') : '' }}</dd>
            </div>
            <div>
              <dt>{{ $t('daqDetail.k3xg3w004') }}</dt>
              <dd>{{ node.intervalMs ?? $t('daqDetail.k9vnp9h053', { p0: daq.controller.defaultIntervalMs }) }}</dd>
            </div>
            <div>
              <dt>{{ $t('daqDetail.k3w6td005') }}</dt>
              <dd>{{ publishLabel(node.publishIntervalMs) }}</dd>
            </div>
            <div>
              <dt>{{ $t('daqDetail.k3x5tpx006') }}</dt>
              <dd>{{ node.warnLow ?? '-∞' }} ~ {{ node.warnHigh ?? '+∞' }}</dd>
            </div>
            <div>
              <dt>{{ $t('daqDetail.k1hjj0jf007') }}</dt>
              <dd>{{ node.min }} ~ {{ node.max }}</dd>
            </div>
            <div>
              <dt>{{ $t('daqDetail.k1i8rtqt008') }}</dt>
              <dd>{{ boundDeviceName || $t('daqDetail.k3own4q036') }}</dd>
            </div>
          </dl>
        </div>
      </section>

      <!-- 中列:参数控制 -->
      <section class="col-form aw-tile pad">
        <h3 class="sec">
          {{ $t('daqDetail.kd9d69j009') }}
        </h3>
        <form
          class="form-grid"
          @submit.prevent="saveParams"
        >
          <label class="field">
            <span>{{ $t('daqDetail.k1iw7tbf010') }}</span>
            <button
              type="button"
              class="toggle"
              :class="{ on: form.enabled }"
              @click="form.enabled = !form.enabled"
            >
              {{ form.enabled ? $t('daqDetail.k3w3j8f037') : $t('daqDetail.k3n5aaj045') }}
            </button>
          </label>
          <label class="field">
            <span>{{ $t('daqDetail.k12k23od011') }}</span>
            <select
              v-model="form.lineId"
              class="input"
            >
              <option value="">
                {{ $t('daqDetail.k3ootr6012') }}
              </option>
              <option
                v-for="l in dcw.lines"
                :key="l.id"
                :value="l.id"
              >
                {{ l.name }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ $t('daqDetail.k1l6smxo013') }}</span>
            <select
              v-model="form.driver"
              class="input"
            >
              <option
                v-for="d in DAQ_DRIVERS"
                :key="d.kind"
                :value="d.kind"
                :disabled="d.status === 'planned'"
              >
                {{ d.label }}{{ d.status === 'planned' ? $t('daqDetail.kz8zr9v035') : '' }}
              </option>
            </select>
          </label>
          <label class="field row">
            <button
              type="button"
              class="toggle slim"
              :class="{ on: form.followGlobal }"
              @click="form.followGlobal = !form.followGlobal"
            >
              {{ form.followGlobal ? $t('daqDetail.k1k2ueyq038') : $t('daqDetail.k1cgi8fy046') }}
            </button>
            <input
              v-model.number="form.intervalMs"
              type="number"
              min="200"
              max="60000"
              step="100"
              class="input"
              :disabled="form.followGlobal"
            ><small>ms</small>
          </label>
          <label class="field row">
            <button
              type="button"
              class="toggle slim"
              :class="{ on: form.calKind === 'linear' }"
              title="采集标定 decoder:物理值 = scale × PLC采集值 + offset"
              @click="form.calKind = form.calKind === 'linear' ? 'none' : 'linear'"
            >
              {{ form.calKind === 'linear' ? $t('daqDetail.k1eru4r1039') : $t('daqDetail.k3oktae047') }}
            </button>
            <input
              v-model.number="form.calScale"
              type="number"
              step="0.1"
              class="input"
              :disabled="form.calKind !== 'linear'"
              title="decode 斜率(≠0)"
            >
            <input
              v-model.number="form.calOffset"
              type="number"
              step="0.1"
              class="input"
              :disabled="form.calKind !== 'linear'"
              title="decode 截距"
            ><small>decoder</small>
          </label>
          <label class="field row">
            <button
              type="button"
              class="toggle slim"
              :class="{ on: form.publishFollow }"
              @click="form.publishFollow = !form.publishFollow"
            >
              {{ form.publishFollow ? $t('daqDetail.k1k2t5o7040') : $t('daqDetail.k1cggz5f048') }}
            </button>
            <span
              class="toggle slim"
              :class="{ on: form.publishEveryFrame }"
              style="cursor: pointer;"
              @click="form.publishEveryFrame = !form.publishEveryFrame"
            >{{ form.publishEveryFrame ? $t('daqDetail.k41mvv041') : $t('daqDetail.k3n42dj049') }}</span>
            <input
              v-model.number="form.publishMs"
              type="number"
              min="0"
              max="60000"
              step="100"
              class="input"
              :disabled="form.publishFollow || form.publishEveryFrame"
            ><small>ms</small>
          </label>
          <label class="field">
            <span>{{ $t('daqDetail.k3x4ef014') }}</span>
            <input
              v-model="form.unit"
              class="input"
            >
          </label>
          <label class="field">
            <span>{{ $t('daqDetail.k3mxmcx015') }}</span>
            <input
              v-model.number="form.decimals"
              type="number"
              min="0"
              max="6"
              class="input"
            >
          </label>
          <div class="field-row">
            <label class="field">
              <span>{{ $t('daqDetail.k1l9jv5m016') }}</span>
              <input
                v-model.number="form.min"
                type="number"
                step="any"
                class="input"
              >
            </label>
            <label class="field">
              <span>{{ $t('daqDetail.k1md63hm017') }}</span>
              <input
                v-model.number="form.warnLow"
                type="number"
                step="any"
                class="input"
              >
            </label>
            <label class="field">
              <span>{{ $t('daqDetail.k1md63gp018') }}</span>
              <input
                v-model.number="form.warnHigh"
                type="number"
                step="any"
                class="input"
              >
            </label>
            <label class="field">
              <span>{{ $t('daqDetail.k1l9jv4p019') }}</span>
              <input
                v-model.number="form.max"
                type="number"
                step="any"
                class="input"
              >
            </label>
          </div>
          <button
            class="aw-pill"
            type="submit"
            :disabled="saving"
          >
            {{ saving ? $t('daqDetail.k1as0g50042') : $t('daqDetail.ksn9cgo050') }}
          </button>
        </form>

        <!-- 驱动连接参数(mock 空;真实协议 schema 动态表单 + 测试连接) -->
        <template v-if="driverFields.length">
          <h3 class="sec mt">
            {{ $t('daqDetail.k1p9gioa033') }} {{ DAQ_DRIVERS.find(d => d.kind === form.driver)?.label }}
          </h3>
          <div class="driver-grid">
            <label
              v-for="f in driverFields"
              :key="f.key"
              class="field"
            >
              <span>{{ f.label }}<em v-if="f.required">*</em></span>
              <select
                v-if="f.type === 'select'"
                v-model="driverCfg[f.key]"
                class="input"
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
                v-model="driverCfg[f.key]"
                :type="f.type === 'number' ? 'number' : 'text'"
                :placeholder="f.placeholder"
                class="input"
              >
            </label>
          </div>
          <div class="test-row">
            <button
              class="pill-btn"
              :disabled="testing"
              @click="doTest"
            >
              {{ testing ? $t('daqDetail.k1fsh720043') : $t('daqDetail.k1fstglk051') }}
            </button>
            <span
              v-if="testResult"
              class="test-out mono"
              :class="testResult.ok ? 'ok' : 'bad'"
            >{{ testResult.ok ? '✓' : '✗' }} {{ testResult.message }}</span>
          </div>
        </template>

        <h3 class="sec mt">
          {{ $t('daqDetail.k1ie6qju020') }}
        </h3>
        <div class="bind-row">
          <select
            v-model="bindDeviceId"
            class="input grow"
          >
            <option value="">
              {{ $t('daqDetail.kjobzu3021') }}
            </option>
            <option
              v-for="dv in availableDevices"
              :key="dv.id"
              :value="dv.id"
            >
              {{ dv.name }}
            </option>
          </select>
          <button
            class="pill-btn"
            @click="onBindToggle"
          >
            {{ boundDeviceName ? $t('daqDetail.k479eh044') : $t('daqDetail.k452a8052') }}
          </button>
        </div>
      </section>

      <!-- 右列:时序库历史 -->
      <section class="col-hist aw-tile pad">
        <div class="hist-hd">
          <h3 class="sec">
            {{ $t('daqDetail.k1i535i5034') }}{{ daq.meta.tsdb }})
          </h3>
          <div class="hist-ctl mono">
            <select
              v-model.number="bucketMs"
              class="input"
            >
              <option
                v-for="b in BUCKETS"
                :key="b.ms"
                :value="b.ms"
              >
                {{ b.label }}
              </option>
            </select>
            <button
              class="pill-btn"
              @click="loadHistory"
            >
              {{ $t('daqDetail.k3x1jg022') }}
            </button>
          </div>
        </div>
        <canvas
          ref="chartCanvas"
          class="hist-canvas"
        />
        <table class="raw-table mono">
          <thead>
            <tr><th>{{ $t('daqDetail.k40vsf023') }}</th><th>{{ $t('daqDetail.k48v5024') }}</th><th>{{ $t('daqDetail.k4bza025') }}</th></tr>
          </thead>
          <tbody>
            <tr
              v-for="(p, i) in historyPoints.filter(r => r.value != null).slice(-12).reverse()"
              :key="i"
            >
              <td>{{ new Date(p.at).toLocaleTimeString('zh-CN', { hour12: false }) }}</td>
              <td>{{ p.value!.toFixed(node?.decimals ?? 2) }}</td>
              <td>{{ p.state }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 4px; }
.back { color: var(--ink-faint); text-decoration: none; }
.back:hover { color: var(--accent); }
.aw-page-head h1 { margin: 2px 0 4px; font-size: 26px; font-weight: 400; letter-spacing: -0.01em; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.sec { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
.mt { margin-top: 22px; }
.err { margin-top: 14px; font-size: 13px; color: var(--tone-danger-dot); }

.grid {
  display: grid;
  gap: 14px;
  align-items: start;
  grid-template-columns: minmax(260px, 340px) minmax(320px, 1fr) minmax(280px, 380px);
}
@media (max-width: 1100px) {
  .grid { grid-template-columns: 1fr; }
}
.pad { padding: 16px 18px; }

/* 实时值卡 */
.value-card { padding: 16px 18px; }
.big-val { margin: 8px 0 10px; font-size: 40px; line-height: 1.1; color: var(--accent); }
.big-val small { margin-left: 8px; font-size: 15px; color: var(--ink-faint); }
.live-canvas { width: 100%; height: 64px; border: 1px solid var(--line); border-radius: var(--radius-chip); background: var(--paper-deep); }
.facts { display: flex; flex-direction: column; gap: 4px; margin: 14px 0 0; }
.facts div { display: flex; justify-content: space-between; font-size: 11.5px; }
.facts dt { color: var(--ink-faint); }
.facts dd { margin: 0; color: var(--ink); }

/* 参数表单 */
.form-grid { display: flex; flex-direction: column; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-faint); flex: 1; }
.field.row { flex-direction: row; align-items: center; gap: 8px; }
.field.row small { color: var(--ink-faint); }
.field-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.input {
  width: 100%;
  padding: 6px 9px;
  font-size: 12.5px;
  color: var(--ink);
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.input:disabled { opacity: 0.45; }
.grow { flex: 1 1 auto; }
.toggle {
  align-self: flex-start;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  color: var(--tone-neutral-dot);
  background: var(--tone-neutral-bg);
  border: 0;
  border-radius: var(--radius-chip);
}
.toggle.on { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.toggle.slim { padding: 6px 10px; font-size: 11.5px; }
.pill-btn {
  padding: 7px 14px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--paper-raised);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill);
}
.bind-row { display: flex; gap: 8px; }
.driver-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.field em { margin-left: 2px; font-style: normal; color: var(--tone-danger-dot); }
.test-row { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
.pill-btn {
  padding: 7px 14px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--paper-raised);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill);
}
.pill-btn:disabled { opacity: 0.5; }
.test-out { font-size: 11px; }
.test-out.ok { color: var(--tone-success-dot); }
.test-out.bad { color: var(--tone-danger-dot); }

/* 历史 */
.col-hist { min-width: 0; }
.hist-hd { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.hist-ctl { display: flex; gap: 6px; }
.hist-canvas { width: 100%; height: 130px; border: 1px solid var(--line); border-radius: var(--radius-chip); background: var(--paper-deep); }
.raw-table { width: 100%; margin-top: 10px; font-size: 11px; border-collapse: collapse; }
.raw-table th, .raw-table td { padding: 4px 6px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.raw-table th { font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-fainter); }

.st-pill {
  display: inline-block;
  padding: 3px 11px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  border-radius: var(--radius-pill);
}
.st-pill.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.st-pill.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.st-pill.offline { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }
</style>
