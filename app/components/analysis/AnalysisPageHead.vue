<script setup lang="ts">
/**
 * 数据分析页页头:aw-page-head 规范(kicker + 大标题 + 描述)+ 实时轨计数。
 * 计数 = 本会话收到的 analysis 留痕 WS 帧(useAnalysisFeed.liveCount)。
 */
defineProps<{
  /** 实时轨当前帧数 */
  liveCount: number
}>()
</script>

<template>
  <header class="aw-page-head">
    <div>
      <p class="aw-kicker">
        agentworkshop / data analysis
      </p>
      <h1>{{ $t('analysis.title') }}</h1>
      <p class="sub">
        {{ $t('analysis.sub') }}
      </p>
    </div>
    <div class="head-actions">
      <span
        class="live-dot"
        :title="$t('analysis.liveHint')"
      /><span class="live-txt mono">{{ $t('analysis.live') }} {{ liveCount }}</span>
    </div>
  </header>
</template>

<style scoped>
.head-actions { display: flex; gap: 10px; align-items: center; padding-bottom: 4px; flex-wrap: wrap; }
.sub {
  margin: 8px 0 0;
  max-width: 72ch;
  font-size: clamp(12.5px, 1.1vw, 13px);
  line-height: 1.65;
  color: var(--ink-faint);
  text-wrap: pretty;
}
/* 标题随视口收敛(窄屏不挤成两行),保持页面头度量线不被撑破 */
:deep(.aw-page-head h1) {
  font-size: clamp(22px, 3vw, 30px);
  text-wrap: pretty;
}
.live-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--tone-success-dot);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-success-dot) 45%, transparent);
  animation: analysisLivePulse 2s ease-out infinite;
}
@keyframes analysisLivePulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-success-dot) 45%, transparent); }
  70% { box-shadow: 0 0 0 8px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.live-txt { font-size: 11.5px; color: var(--ink-faint); white-space: nowrap; }
@media (max-width: 640px) {
  .head-actions { padding-bottom: 0; }
}
</style>
