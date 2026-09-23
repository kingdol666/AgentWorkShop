<script setup lang="ts">
/**
 * 时间线过滤条:档位 segmented + 事件/块计数 + 连接诚实态 chip。
 * 纯呈现:状态全部由 TranscriptTimeline 持有(档位经 v-model:filter 双向绑定,
 * 标签选项由容器统一构建 —— 与过滤空态文案同源,见容器 filterLabel)。
 */
import type { EventFilter } from '@/app/stores/workshop/events'
import type { WsState } from '@/app/stores/workshop/connection'

defineProps<{
  /** 档位选项(value 与容器 filter 同域) */
  options: Array<{ value: EventFilter, label: string }>
  /** 过滤前的事件总数 */
  totalEvents: number
  /** 聚类后的块数 */
  blockCount: number
  /** 断线待对齐(连接中 / 待重放) */
  syncing: boolean
  /** WS 连接态 */
  connState: WsState
  /** 最后数据时间(x 秒前;无数据为空串) */
  lastDataAgo: string
}>()

const filter = defineModel<EventFilter>('filter', { required: true })
</script>

<template>
  <div class="filter-bar">
    <a-segmented
      v-model:value="filter"
      size="small"
      :options="options"
    />
    <span class="count">{{ totalEvents }} {{ $t('transcriptTimeline.k1atjpx1005') }} {{ blockCount }} {{ $t('transcriptTimeline.k4a9o007') }}</span>
    <!-- 连接诚实态:断线待对齐 → 同步中脉搏;在线 → 最后数据时间(open-tag 规范) -->
    <span
      class="sync-chip"
      :data-state="syncing ? 'syncing' : connState"
      :title="syncing ? $t('transcriptTimeline.syncLag') : $t('transcriptTimeline.kglov3b025', { p0: lastDataAgo || $t('transcriptTimeline.none') })"
    >
      <span
        v-if="syncing"
        class="sync-pulse"
      />
      <span
        v-else-if="connState === 'open'"
        class="i-tabler-point-filled sync-dot"
      />
      {{ syncing ? $t('transcriptTimeline.k3lmtk3008') : connState === 'open' ? lastDataAgo || $t('transcriptTimeline.k3y2p8020') : $t('transcriptTimeline.k44c2n024') }}
    </span>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 16px;
  background: var(--paper-raised);
  border-bottom: 1px solid var(--line);
}
.count {
  font-size: 11px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
}
/* 连接诚实态 chip:同步中琥珀脉搏 / 在线绿点+最后数据时间 / 离线灰 */
.sync-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  margin-left: auto;
  padding: 1px 8px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border-radius: var(--radius-pill);
}
.sync-chip[data-state='syncing'] {
  color: var(--tone-warning-dot);
}
.sync-chip[data-state='open'] .sync-dot {
  font-size: 7px;
  color: var(--tone-success-dot);
}
.sync-pulse {
  width: 6px;
  height: 6px;
  background: var(--tone-warning-dot);
  border-radius: 50%;
  animation: sync-breath 1.2s ease-in-out infinite;
}
@keyframes sync-breath {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .sync-pulse { animation: none; opacity: 0.8; }
}

/* ── 窄屏(≤1023):过滤条换行 + segmented 独占一行 ── */
@media (max-width: 1023.98px) {
  .filter-bar {
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 10px;
  }

  .filter-bar :deep(.ant-segmented) {
    flex: 1 1 100%;
  }

  /* 原为 `.count, .sync-chip, .earlier-done` 一条选择器列表,拆组件后随各自标记落位:
     `.earlier-done` 的同一份声明在 transcript/TranscriptEarlierPager.vue —— 有意重复,
     改一处同步所有副本。 */
  .count,
  .sync-chip {
    font-size: 11.5px;
  }
}
</style>
