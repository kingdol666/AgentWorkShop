<script setup lang="ts">
/**
 * 产线操作页页头:aw-page-head 规范(kicker + 大标题 + 描述)+ WS 实时轨计数。
 * 计数取自 useOpsLog.recent(WS ops.log 帧环形缓冲),与流水主体互不干扰。
 */
defineProps<{
  /** 实时轨当前条数(useOpsLog.recent) */
  recentCount: number
}>()
</script>

<template>
  <header class="aw-page-head">
    <div>
      <p class="aw-kicker">
        agentworkshop / line operations
      </p>
      <h1>{{ $t('operations.title') }}</h1>
      <p class="sub">
        {{ $t('operations.sub') }}
      </p>
    </div>
    <div class="head-actions">
      <span
        class="live-dot"
        :title="$t('operations.liveHint')"
      /><span class="live-txt mono">{{ $t('operations.live') }} {{ recentCount }}</span>
    </div>
  </header>
</template>

<style scoped>
.head-actions { display: flex; gap: 10px; align-items: center; padding-bottom: 4px; }
.sub { margin: 8px 0 0; font-size: 13px; color: var(--ink-faint); }
.live-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--tone-success-dot);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-success-dot) 45%, transparent);
  animation: opsLivePulse 2s ease-out infinite;
}
@keyframes opsLivePulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-success-dot) 45%, transparent); }
  70% { box-shadow: 0 0 0 8px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.live-txt { font-size: 11.5px; color: var(--ink-faint); }
</style>
