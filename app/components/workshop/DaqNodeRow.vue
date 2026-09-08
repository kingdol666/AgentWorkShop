<script setup lang="ts">
/**
 * DaqNodeRow —— 数采节点表格行(渲染隔离单元)。
 *
 * 行级派生态(pill/趋势串/限值线/产线运行态/节拍文案)全部在本组件 computed 内求值,
 * 只追踪「本行节点」的响应式依赖:其它行/其它节点的 WS 读数帧失效不再波及本行 patch
 * (等价 v-memo 的隔离效果,但 v-memo 在 SSR 编译产物引用未定义的 _cache 导致 500,
 * 子组件 props 身份跳过是 SSR 安全形态)。父层 v-for 传稳定节点引用,依赖不变零重渲。
 */
import { computed } from 'vue'
import { message } from 'ant-design-vue'
import { useDaqStream, type DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import { apiErrorMessage } from '@/app/utils/api-error'
import { daqKeyFromRef, type DaqNodeState } from '#shared/daq-protocol'

const props = defineProps<{ n: DaqNodeLive }>()

const { t } = useI18n()
const daq = useDaqStream()
const dcw = useDcwStream()
const deviceTwins = useDeviceTwins()

// ---------- 行级展示状态(与页面筛选同源的诚实状态机) ----------
type RowState = DaqNodeState | 'idle' | 'disabled' | 'unassigned'

/** 数据新鲜度:超过 max(4×有效周期, 12s) 无新样本视为「采不到数据」(容忍 5s REST 刷新拍与时钟偏差) */
function staleOf(n: DaqNodeLive): boolean {
  if (!n.lastAt) return true
  const iv = n.intervalMs ?? daq.controller.defaultIntervalMs
  return Date.now() - Date.parse(n.lastAt) > Math.max(iv * 4, 12_000)
}

function rowStateOf(n: DaqNodeLive): RowState {
  if (!n.enabled) return 'disabled'
  if (!n.lineId) return 'unassigned'
  if (!dcw.lineStateOf(n.lineId).active) return 'idle'
  if (!daq.controller.running || staleOf(n)) return 'offline'
  return n.state
}

function isLive(n: DaqNodeLive): boolean {
  const s = rowStateOf(n)
  return s === 'ok' || s === 'warn' || s === 'alarm'
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
function recipeAlarm(n: DaqNodeLive): boolean {
  const w = recipeWinOf(n)
  if (!w || n.value == null) return false
  return (w.min != null && n.value < w.min) || (w.max != null && n.value > w.max)
}

/** 行内趋势的有效限值:活动配方窗口优先,节点预警带兜底,皆无 → 不画限值线 */
function limitOf(n: DaqNodeLive): { min: number | null | undefined, max: number | null | undefined } {
  const w = recipeWinOf(n)
  if (w && (w.min != null || w.max != null)) return { min: w.min, max: w.max }
  if (n.warnLow != null || n.warnHigh != null) return { min: n.warnLow, max: n.warnHigh }
  return { min: null, max: null }
}

// ---------- 行内趋势(SVG polyline;数据节拍由 store 合批,本组件按行失效) ----------
const TREND_W = 120
const TREND_H = 26

function trendPath(hist: number[]): string {
  const vals = hist.filter(Number.isFinite)
  if (vals.length < 2) return ''
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  return vals.map((v, i) => `${((i / (vals.length - 1)) * TREND_W).toFixed(1)},${(TREND_H - ((v - min) / span) * (TREND_H - 2) - 1).toFixed(1)}`).join(' ')
}

/** 上下限参考线在趋势图内的 y 坐标(量程不可知或无数据时返回 null 不画) */
function limitY(hist: number[], limit: number | undefined | null): number | null {
  if (limit == null || !Number.isFinite(limit)) return null
  const vals = hist.filter(Number.isFinite)
  if (vals.length < 2) return null
  const min = Math.min(...vals, limit)
  const max = Math.max(...vals, limit)
  const span = max - min || 1
  return Number((TREND_H - ((limit - min) / span) * (TREND_H - 2) - 1).toFixed(1))
}

/** 状态 pill(含诚实的原因提示;配方越限标签仅在数据新鲜时展示) */
function statePillOf(n: DaqNodeLive): { key: RowState, label: string, tip: string } {
  const s = rowStateOf(n)
  const offlineLabel = t('daq.k44c2n065')
  if (s === 'offline') {
    if (n.lastError) return { key: s, label: offlineLabel, tip: n.lastError }
    const tip = !daq.controller.running
      ? t('daq.k1gateoff140')
      : t('daq.k1staled129', { p0: Math.round(Math.max((n.intervalMs ?? daq.controller.defaultIntervalMs) * 4, 12_000) / 1000) })
    return { key: s, label: offlineLabel, tip }
  }
  const labels: Record<RowState, string> = {
    ok: t('daq.k41k5c062'),
    warn: t('daq.k49z8v063'),
    alarm: t('daq.k3xmid064'),
    offline: offlineLabel,
    idle: t('daq.k3ozyqz117'),
    disabled: t('daq.k1disabl130'),
    unassigned: t('daq.k3ootr6053'),
  }
  if (s === 'idle') return { key: s, label: labels.idle, tip: t('daq.k1idlehin139') }
  if ((s === 'ok' || s === 'warn' || s === 'alarm') && recipeAlarm(n)) {
    const w = recipeWinOf(n)
    return { key: 'alarm', label: t('daq.k1l3pt51104'), tip: t('daq.k1hrrqa1122', { p0: w?.min ?? '-∞', p1: w?.max ?? '+∞', p2: '' }) }
  }
  return { key: s, label: labels[s], tip: '' }
}

/** 模板通道语义(server 目录为唯一事实源;模板已删除 → 显示 templateRef 原文降级) */
function daqTemplateRefCh(templateRef: string): string {
  const tpl = daq.templates.find(x => x.key === daqKeyFromRef(templateRef))
  return tpl ? `${tpl.name} · ${tpl.ch}` : templateRef || '-'
}

const intervalOf = (intervalMs: number | null): string => {
  if (intervalMs == null) return t('daq.k9vnp9h124', { p0: daq.controller.defaultIntervalMs })
  return `${intervalMs}ms`
}

/** WS 下发节拍展示(null=跟随全局;0=每帧;>0 独立间隔) */
const publishOf = (v: number | null): string => {
  if (v == null) return t('daq.k9vnp9h124', { p0: daq.controller.defaultPublishIntervalMs })
  if (v === 0) return t('daq.k41mvv078')
  return `${v}ms`
}

/** 驱动是否为预留协议(meta status=planned) */
const driverPlanned = (kind: string): boolean =>
  daq.meta.drivers.find(d => d.kind === kind)?.status === 'planned'

const nodeDeviceIds = (n: DaqNodeLive): string[] =>
  n.deviceIds ?? (n.deviceBindingId ? [n.deviceBindingId] : [])
const deviceNameById = (id: string): string =>
  deviceTwins.twins.find(x => x.id === id)?.name ?? id
/** 绑定设备下拉选项:全部真实设备孪生(剔除 daq/dcw 伪孪生) */
const bindableDeviceTwins = computed(() =>
  deviceTwins.twins.filter(x => x.kind !== 'daq' && !(x.modelRef ?? '').startsWith('daq-') && !(x.modelRef ?? '').startsWith('dcw-')))

// ---------- 行渲染上下文:本节点依赖变化才重算(隔离单元核心) ----------
const ctx = computed(() => {
  const n = props.n
  const lim = limitOf(n)
  const ls = n.lineId ? dcw.lineStateOf(n.lineId) : null
  return {
    tpl: daqTemplateRefCh(n.templateRef),
    pill: statePillOf(n),
    alarm: recipeAlarm(n),
    live: isLive(n),
    trend: trendPath(n.hist),
    limMin: limitY(n.hist, lim.min),
    limMax: limitY(n.hist, lim.max),
    interval: intervalOf(n.intervalMs),
    publish: publishOf(n.publishIntervalMs),
    lineActive: !!ls?.active,
    lineProduct: ls?.productName ?? '',
    lineRecipe: ls?.recipeName ?? '',
  }
})

// ---------- 行内交互(与原页面实现同构;toast 后端可读原因) ----------
/** 单节点独立 启动/停止采集(PATCH enabled;server 权威,本地乐观翻转 + WS/轮询收敛)。
 *  n 即 store 内响应式对象(身份同源),此处乐观翻转与原页面实现一致 */
async function toggleNodeEnabled(): Promise<void> {
  const node = props.n
  const next = !node.enabled
  try {
    await daq.patchNode(node.id, { enabled: next })
    node.enabled = next
    if (!next) node.state = 'offline'
    message.success(next ? t('daq.k1nodestart147') : t('daq.k1nodestop146'))
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function setNodeLine(e: Event): Promise<void> {
  const lineId = (e.target as HTMLSelectElement).value
  try {
    await daq.patchNode(props.n.id, { lineId })
    const node = props.n
    node.lineId = lineId
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

/** 节点绑定设备(多对多:add 挂新设备 / remove 摘除一台;server 落库) */
async function addNodeDevice(e: Event): Promise<void> {
  const deviceId = (e.target as HTMLSelectElement).value
  if (!deviceId) return
  const node = props.n
  if (node.deviceIds?.includes(deviceId)) return
  try {
    await daq.setNodeBindings(node.id, [...(node.deviceIds ?? []), deviceId])
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  ;(e.target as HTMLSelectElement).value = ''
}

async function removeNodeDevice(deviceId: string): Promise<void> {
  const node = props.n
  try {
    await daq.setNodeBindings(node.id, (node.deviceIds ?? []).filter(d => d !== deviceId))
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}
</script>

<template>
  <tr :class="{ 'row-recipe-alarm': ctx.alarm }">
    <td>
      <span class="mono dim">{{ n.id.slice(0, 8) }}</span>
      <b>{{ n.name }}</b>
      <small class="mono ch">{{ ctx.tpl }}</small>
    </td>
    <td>
      <span
        class="st-pill"
        :class="[ctx.pill.key]"
        :title="ctx.pill.tip"
      >{{ ctx.pill.label }}</span>
    </td>
    <td
      class="mono val"
      :class="{ 'stale': !ctx.live, 'val-alarm': n.state === 'alarm' || ctx.alarm }"
      :title="ctx.live ? undefined : ctx.pill.tip"
    >
      {{ n.value != null ? n.value.toFixed(n.decimals) : '--' }}
      <small>{{ n.unit }}</small>
    </td>
    <td class="trend-cell">
      <svg
        class="trend"
        viewBox="0 0 120 26"
        preserveAspectRatio="none"
        :title="$t('daq.k1trnd002')"
      >
        <line
          v-if="ctx.limMin != null"
          class="lim"
          x1="0"
          :y1="ctx.limMin"
          x2="120"
          :y2="ctx.limMin"
        />
        <line
          v-if="ctx.limMax != null"
          class="lim max"
          x1="0"
          :y1="ctx.limMax"
          x2="120"
          :y2="ctx.limMax"
        />
        <polyline
          class="trace"
          :class="{ alarm: n.state === 'alarm' || ctx.alarm }"
          :points="ctx.trend"
        />
      </svg>
    </td>
    <td class="mono">
      {{ ctx.interval }}
    </td>
    <td class="mono">
      {{ ctx.publish }}
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
        @change="setNodeLine"
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
        :class="{ on: ctx.lineActive }"
        :title="$t('daq.k1runtipc131')"
      >
        <span class="rp-dot" />
        {{ ctx.lineActive ? $t('daq.k3vp67i096') : $t('daq.k3ozyqz117') }}
      </span>
      <span
        v-else
        class="run-pill na"
      >{{ $t('daq.k3ootr6053') }}</span>
    </td>
    <!-- 产品 / Recipe:本线活动批次(运行中才携带;停线/未分配 → --) -->
    <td class="prod-cell">
      <template v-if="n.lineId && ctx.lineActive">
        <b :title="$t('daq.k1prdrtip132')">{{ ctx.lineProduct || '--' }}</b>
        <small
          class="mono"
          :title="$t('daq.k1prdrtip132')"
        >{{ ctx.lineRecipe || '--' }}</small>
      </template>
      <span
        v-else
        class="dim"
      >--</span>
    </td>
    <td>
      <div class="dev-binds">
        <span
          v-for="did in nodeDeviceIds(n)"
          :key="did"
          class="dev-bind-chip"
          :title="$t('daq.k2bindtip137')"
        >
          {{ deviceNameById(did) }}
          <span
            class="dev-unbind"
            title="unbind"
            @click="removeNodeDevice(did)"
          >✕</span>
        </span>
        <select
          class="line-sel dev-add"
          :value="''"
          :title="$t('daq.k2bindtip137')"
          @change="addNodeDevice"
        >
          <option value="">
            {{ $t('daq.k3own4q056') }}
          </option>
          <option
            v-for="d in bindableDeviceTwins"
            :key="d.id"
            :value="d.id"
            :disabled="(n.deviceIds ?? []).includes(d.id)"
          >
            {{ deviceNameById(d.id) }}
          </option>
        </select>
      </div>
    </td>
    <td class="right">
      <button
        class="node-toggle"
        :class="{ off: !n.enabled }"
        :title="n.enabled ? $t('daq.k1nodestop146') : $t('daq.k1nodestart147')"
        @click="toggleNodeEnabled"
      >
        <span :class="n.enabled ? 'i-tabler-player-pause' : 'i-tabler-player-play'" />
        {{ n.enabled ? $t('daq.k1nodestop146') : $t('daq.k1nodestart147') }}
      </button>
      <NuxtLink
        class="console-link"
        :to="`/daq/${n.id}`"
      >
        <span class="i-tabler-dashboard" />
        {{ $t('daq.k3o3jg2074') }}
      </NuxtLink>
    </td>
  </tr>
</template>
