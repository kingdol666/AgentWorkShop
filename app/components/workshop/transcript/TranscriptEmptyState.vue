<script setup lang="ts">
/**
 * 时间线列内三态占位:连接中骨架 / 真空态 / 过滤空态(互斥,原 v-if 链整体搬入)。
 * 纯呈现:连接态与计数由 TranscriptTimeline 传入;过滤空态的档位标签由容器统一构建。
 */
import type { WsState } from '@/app/stores/workshop/connection'

defineProps<{
  /** WS 连接中且尚无块(骨架态) */
  connecting: boolean
  /** 聚类后的块数 */
  blockCount: number
  /** 过滤前的事件总数 */
  totalEvents: number
  /** 断线待对齐(连接中 / 待重放) */
  syncing: boolean
  /** WS 连接态 */
  connState: WsState
  /** 当前过滤档位标签(过滤空态文案用) */
  filterLabel: string
}>()
</script>

<template>
  <!-- 连接中骨架:头像圆 + 双行占位,布局对齐最终块形态(免跳变) -->
  <div
    v-if="connecting"
    class="skel-stack"
  >
    <div
      v-for="n in 3"
      :key="n"
      class="skel-row"
      :style="{ '--d': `${(n - 1) * 0.12}s` }"
    >
      <span class="aw-skel skel-ava" />
      <div class="skel-lines">
        <span class="aw-skel skel-line name" />
        <span class="aw-skel skel-line w70" />
        <span class="aw-skel skel-line w45" />
      </div>
    </div>
  </div>
  <div
    v-else-if="blockCount === 0 && totalEvents === 0"
    class="empty"
  >
    <!-- 同步中 ≠ 空:诚实区分(快照未到时不断言"无事件") -->
    <span
      v-if="syncing || connState !== 'open'"
      class="i-tabler-refresh empty-icon"
    />
    <span
      v-else
      class="i-tabler-message-dots empty-icon"
    />
    <p class="empty-title">
      {{ syncing || connState !== 'open' ? $t('transcriptTimeline.klnne6o010') : $t('transcriptTimeline.k126izdm022') }}
    </p>
    <p class="empty-hint">
      {{ syncing || connState !== 'open' ? $t('transcriptTimeline.k1iuqpxj011') : $t('transcriptTimeline.kuyjpmi023') }}
    </p>
  </div>
  <!-- 过滤空态:有事件但当前过滤无匹配(区别于真空) -->
  <div
    v-else-if="blockCount === 0"
    class="empty filtered"
  >
    <span class="i-tabler-filter-off empty-icon" />
    <p class="empty-title">
      {{ $t('transcriptTimeline.ktuo1zg004') }}
    </p>
    <p class="empty-hint">
      「{{ filterLabel }}」{{ $t('transcriptTimeline.kapxgq4006') }}
    </p>
  </div>
</template>

<style scoped>
/* 空态:编辑部式 serif 标题(pane-empty 声部) */
.empty {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  padding: 72px 16px;
  text-align: center;
}
.empty-icon {
  font-size: 28px;
  color: var(--ink-faint);
}
.empty-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}
.empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--ink-faint);
}

/* 连接中骨架:对齐块行网格(26px 头像列 + 内容列),行间延迟入场 */
.skel-stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 26px 6px;
}

.skel-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 10px;
  animation: aw-rise 0.4s cubic-bezier(0.22, 0.68, 0.36, 1) backwards;
  animation-delay: var(--d, 0s);
}

.skel-ava {
  width: 26px;
  height: 26px;
  border-radius: 50%;
}

.skel-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skel-line {
  height: 11px;
}

.skel-line.name { width: 120px; height: 13px; }
.skel-line.w70 { width: 70%; }
.skel-line.w45 { width: 45%; }

@media (prefers-reduced-motion: reduce) {
  .skel-row { animation: none; }
}

/* ── 窄屏(≤1023):空态提示放大一档 ── */
@media (max-width: 1023.98px) {
  .empty-hint {
    font-size: 13px;
  }
}
</style>
