<script setup lang="ts">
/**
 * 批次数据视图 —— 数采通道聚合表(最新/均值/min~max/点数)+ 写记录表(工程值/原始值/ACK)。
 */
import type { RecipeRunData } from '#shared/dcw-protocol'

defineProps<{
  runDataView: { runId: string, data: RecipeRunData } | null
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div
    v-if="runDataView"
    class="modal-mask"
    @click.self="emit('close')"
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
          @click="emit('close')"
        >
          {{ $t('dcwDetail.k3x62t043') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }

.nodes-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.nodes-table th, .nodes-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.nodes-table th { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); border-bottom: 1px solid var(--line-strong); }
.nodes-table td b { margin-left: 8px; }

.st-pill { display: inline-block; padding: 3px 9px; font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.04em; border-radius: var(--radius-pill); }
.st-pill.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.writing { color: var(--ink); background: var(--hover-tint); }
.st-pill.error, .st-pill.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.st-pill.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.st-pill.offline, .st-pill.idle { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }
.st-pill.paused { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }

.sec-label { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); }

.modal-mask { position: fixed; z-index: 50; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--scrim); backdrop-filter: blur(2px); }
.modal { width: 680px; max-width: 94vw; max-height: 88vh; overflow-y: auto; padding: 22px 24px; background: var(--surface-glass-strong); backdrop-filter: var(--aurora-blur); border: 1px solid var(--glass-line); border-radius: var(--radius-panel); box-shadow: var(--glass-edge), var(--shadow-float); }
.m-title { margin: 0 0 14px; font-size: 17px; }

.m-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.aw-pill.outline { color: var(--ink); background: var(--paper-raised); border-color: var(--line-strong); }

@media (prefers-reduced-motion: no-preference) {
  .nodes-table tbody tr:hover { background: var(--hover-tint); }
}

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  .nodes-table { min-width: 1080px; }
  .nodes-table th,
  .nodes-table td { white-space: nowrap; }
  .nodes-table thead > tr > th:first-child,
  .nodes-table tbody > tr > td:first-child {
    position: sticky;
    left: 0;
    z-index: 2;
    background: var(--paper-raised);
    box-shadow: 1px 0 0 var(--line);
  }
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .aw-pill {
    min-height: 40px;
  }
  /* 弹窗表单:两列/三列在窄屏一律落成一列,否则标签被压成竖排字 */
  .modal {
    width: calc(100vw - 20px);
    max-width: calc(100vw - 20px);
    padding: 16px 14px;
  }
  .m-actions { flex-wrap: wrap; }
  .m-actions > * { flex: 1 1 auto; }
}
</style>
