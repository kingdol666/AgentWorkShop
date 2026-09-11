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
          v-if="ctx.trend"
          class="trace"
          :class="{ alarm: n.state === 'alarm' || ctx.alarm }"
          :points="ctx.trend"
        />
        <!-- 无足够样本(<2 个有效值)时给一道基线,而不是留一条 points="" 的空 polyline:
             空 polyline 不渲染任何东西,单元格看上去是"坏了"而不是"还没有数据"。
             采样由活动批次门控,未开跑时这一列**本来就应该**是空的 —— 需要看得出是"待数据"。 -->
        <line
          v-else
          class="trace-idle"
          x1="0"
          :y1="TREND_H / 2"
          x2="120"
          :y2="TREND_H / 2"
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

<style scoped>
/* 行组件是渲染隔离单元:父页 scoped 选择器不穿透到这里的元素,故行内全部样式
   随组件内聚在本块。仅表格单元格的 padding/边框由父页 :deep(td) 统一供给。 */
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }

.ch { display: block; margin-top: 2px; font-size: 10px; color: var(--ink-faint); }

.val { font-size: 13px; }
.val small { margin-left: 3px; color: var(--ink-faint); }
/* 数据静默(停用/未运行/采不到数据):最后值置灰呈现,不再冒充实时值 */
.val.stale { opacity: 0.45; }
/* 越限实时值:红字(与行红底叠加仍可读) */
.val.val-alarm { color: var(--tone-danger-dot); font-weight: 700; }

/* ── 行内实时趋势(WS 读数流直驱;上下限虚线参考) ── */
.trend-cell { width: 128px; }
.trend { display: block; width: 120px; height: 26px; }
.trend .trace {
  fill: none;
  stroke: var(--tone-info-dot);
  stroke-width: 1.4;
}
.trend .trace.alarm { stroke: var(--tone-danger-dot); }
/* 待数据基线:一条极淡的中线(仅装饰 → 用 ink-fainter;非文字无对比度要求) */
.trend .trace-idle {
  stroke: var(--ink-fainter);
  stroke-width: 1;
  stroke-dasharray: 2 4;
  opacity: 0.55;
}
.trend .lim {
  stroke: color-mix(in srgb, var(--tone-warning-dot) 62%, transparent);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}
.trend .lim.max { stroke: color-mix(in srgb, var(--tone-danger-dot) 55%, transparent); }

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

/* 单节点 启动/停止采集(R:独立节点控制) */
.node-toggle {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  margin-right: 12px;
  padding: 2px 9px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  color: var(--ink);
  background: transparent;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.node-toggle:hover { border-color: var(--accent); background: var(--hover-tint); }
.node-toggle.off { color: var(--ink-soft); border-style: dashed; opacity: 0.8; }

.dev-binds { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.dev-bind-chip { display: inline-flex; gap: 4px; align-items: center; padding: 1px 7px; font-size: 11px; color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); border-radius: var(--radius-chip); }
.dev-unbind { cursor: pointer; opacity: 0.55; font-size: 10px; }
.dev-unbind:hover { opacity: 1; color: var(--tone-danger-dot); }
.dev-add { max-width: 130px; font-size: 11px; }
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
  color: var(--ink-faint);
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
