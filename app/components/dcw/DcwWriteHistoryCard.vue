<script setup lang="ts">
/**
 * 写历史 —— 本产线最近 12 条下发记录(时间/参数/节点/工程值/原始值/ACK/批次归属)。
 * 渲染开关(有历史才显示)在页面。
 */
import type { DcwWriteHistoryEntry } from '~/composables/workshop/useDcwStream'

defineProps<{
  lineHistory: DcwWriteHistoryEntry[]
}>()
</script>

<template>
  <section class="aw-tile table-card">
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
            {{ h.recipeRunId ? $t('dcwDetail.k6vgks7181', { p0: h.recipeRunId }) : $t('dcwDetail.manualTag') }}
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }

.table-card { overflow-x: auto; margin-bottom: 14px; }
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

@media (prefers-reduced-motion: no-preference) {
  .nodes-table tbody tr:hover { background: var(--hover-tint); }
}

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  /* 控制节点表:保留列语义,给一条可横扫的卷轴 + 首列钉住 */
  .table-card { overflow-x: auto; -webkit-overflow-scrolling: touch; }
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
}
</style>
