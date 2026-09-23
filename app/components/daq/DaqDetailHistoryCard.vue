<script setup lang="ts">
/**
 * 时序库历史 —— 降采样桶 + 拉取间隔覆盖 + 趋势画布 + 原始点表(后 12 点)。
 * 画布 ref 经 defineModel 反写回页面 useDaqDetailHistory 持有的同一个 ref:
 * 绘制指令与重挂定时器的唯一所有者仍是那个 composable。
 */
import type { DaqTsdbPoint } from '@/app/composables/workshop/useDaqStream'

defineProps<{
  tsdb: string
  buckets: Array<{ label: string, ms: number }>
  historyPoints: DaqTsdbPoint[]
  decimals: number | null
  /** 拉取间隔下限(ms;提示文案用) */
  minQueryMs: number
  /** 服务端缺省拉取间隔(ms;输入框 placeholder 用) */
  defaultQueryMs: number
}>()

const emit = defineEmits<{ reload: [] }>()

const bucketMs = defineModel<number>('bucketMs', { required: true })
const refreshOverrideMs = defineModel<number>('refreshOverrideMs', { required: true })
const canvasEl = defineModel<HTMLCanvasElement | null>('canvasEl', { required: true })
</script>

<template>
  <section class="col-hist aw-tile pad">
    <div class="hist-hd">
      <h3 class="sec">
        {{ $t('daqDetail.k1i535i5034') }}{{ tsdb }})
      </h3>
      <div class="hist-ctl mono">
        <select
          v-model.number="bucketMs"
          class="input"
        >
          <option
            v-for="b in buckets"
            :key="b.ms"
            :value="b.ms"
          >
            {{ b.label }}
          </option>
        </select>
        <label
          class="refresh-ctl"
          :title="$t('daqDetail.k1rfrshint001', { p0: minQueryMs })"
        >
          <span class="i-tabler-refresh" />
          <input
            v-model.number="refreshOverrideMs"
            type="number"
            :min="0"
            max="600000"
            step="500"
            :placeholder="String(defaultQueryMs)"
          >ms
        </label>
        <button
          class="pill-btn"
          @click="emit('reload')"
        >
          {{ $t('daqDetail.k3x1jg022') }}
        </button>
      </div>
    </div>
    <canvas
      ref="canvasEl"
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
          <td>{{ p.value!.toFixed(decimals ?? 2) }}</td>
          <td>{{ p.state }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.sec/.pad/.input/.hist-hd/.raw-table)在此各持一份逐字相同的副本,
   以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.sec { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
.pad { padding: 16px 18px; }
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
.hist-hd { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 10px; }

/* 历史 */
.col-hist { min-width: 0; }
.hist-ctl { display: flex; gap: 6px; align-items: center; }
/* 趋势图拉取间隔(ms;0/空 = 跟随服务端 daq.query.displayIntervalMs) */
.refresh-ctl { display: inline-flex; gap: 3px; align-items: center; font-size: 11px; color: var(--ink-soft); }
.refresh-ctl input {
  width: 62px;
  padding: 3px 6px;
  font-size: 11px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.refresh-ctl input:focus { outline: none; border-color: var(--accent); }
.hist-canvas { width: 100%; height: 130px; border: 1px solid var(--line); border-radius: var(--radius-chip); background: var(--paper-deep); }
.raw-table { width: 100%; margin-top: 10px; font-size: 11px; border-collapse: collapse; }
.raw-table th, .raw-table td { padding: 4px 6px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.raw-table th { font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-faint); }
</style>
