<script setup lang="ts">
/**
 * 实时状态卡 —— 大数 + live 趋势画布 + 事实清单(驱动/周期/下发节拍/预警带/量程/绑定设备)。
 * 画布 ref 经 defineModel 反写回页面 useDaqDetailHistory 持有的同一个 ref:
 * 绘制指令的唯一所有者仍是那个 composable,本组件只负责把 <canvas> 挂上去。
 */
import type { DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import type { DaqTemplateDef } from '#shared/daq-protocol'

const props = defineProps<{
  node: DaqNodeLive
  tpl: DaqTemplateDef | null
  boundDeviceName: string
  /** 采集周期全局缺省(节点未设独立周期时展示) */
  defaultIntervalMs: number
  /** WS 下发节拍全局缺省(跟随全局时展示) */
  defaultPublishMs: number
  driverPlanned: (kind: string) => boolean
}>()

const { t } = useI18n()

/** <canvas> 引用(defineModel 反写;与 DaqNodePanel 的 tableEl 同款做法) */
const canvasEl = defineModel<HTMLCanvasElement | null>('canvasEl', { required: true })

/** WS 下发节拍展示(null=跟随全局;0=每帧;>0 独立间隔) */
function publishLabel(v: number | null): string {
  if (v == null) return t('daqDetail.k9vnp9h053', { p0: props.defaultPublishMs })
  if (v === 0) return t('daqDetail.k1m1zwux030')
  return `${v}ms`
}
</script>

<template>
  <section class="col-live">
    <div class="aw-tile value-card">
      <p class="aw-kicker">
        {{ $t('daqDetail.k1fx2vik032') }} {{ tpl?.ch ?? '-' }}
      </p>
      <div class="big-val mono">
        {{ node.value != null ? node.value.toFixed(node.decimals) : '--' }}<small>{{ node.unit }}</small>
      </div>
      <canvas
        ref="canvasEl"
        class="live-canvas"
      />
      <dl class="facts mono">
        <div>
          <dt>{{ $t('daqDetail.k4a0la003') }}</dt>
          <dd>{{ node.driver }}{{ driverPlanned(node.driver) ? $t('daqDetail.kz8zr9v035') : '' }}</dd>
        </div>
        <div>
          <dt>{{ $t('daqDetail.k3xg3w004') }}</dt>
          <dd>{{ node.intervalMs ?? $t('daqDetail.k9vnp9h053', { p0: defaultIntervalMs }) }}</dd>
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
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.sec/.pad/.input/.hist-hd/.raw-table)在此各持一份逐字相同的副本,
   以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

/* 实时值卡 */
.value-card { padding: 16px 18px; }
.big-val { margin: 8px 0 10px; font-size: 40px; line-height: 1.1; color: var(--accent); }
.big-val small { margin-left: 8px; font-size: 15px; color: var(--ink-faint); }
.live-canvas { width: 100%; height: 64px; border: 1px solid var(--line); border-radius: var(--radius-chip); background: var(--paper-deep); }
.facts { display: flex; flex-direction: column; gap: 4px; margin: 14px 0 0; }
.facts div { display: flex; justify-content: space-between; font-size: 11.5px; }
.facts dt { color: var(--ink-faint); }
.facts dd { margin: 0; color: var(--ink); }
</style>
