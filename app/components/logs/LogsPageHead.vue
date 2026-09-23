<script setup lang="ts">
/**
 * 日志页页头:aw-page-head 规范(kicker + 大标题 + 描述)+ 实时轨计数 + 手动记录入口。
 * 计数取自 WS 实时轨(ops.log 帧的环形缓冲),与结果表的 REST 快照互不干扰。
 * 手动记录只上报点击,弹窗开合与提交由页面持有(页头不持有任何状态)。
 */
defineProps<{
  /** 实时轨当前条数(useOpsLog.recent) */
  recentCount: number
}>()

defineEmits<{
  manual: []
}>()
</script>

<template>
  <!-- 页头(aw-page-head 规范:kicker + 大标题 + 描述)+ 手动记录入口 -->
  <header class="aw-page-head">
    <div>
      <p class="aw-kicker">
        agentworkshop / audit log
      </p>
      <h1>{{ $t('logs.title') }}</h1>
      <p class="sub">
        {{ $t('logs.sub') }}
      </p>
    </div>
    <div class="head-actions">
      <span
        class="live-dot"
        :title="$t('logs.liveHint')"
      /><span class="live-txt mono">{{ $t('logs.live') }} {{ recentCount }}</span>
      <button
        class="pill-btn"
        @click="$emit('manual')"
      >
        <span class="i-tabler-plus" />
        {{ $t('logs.manual') }}
      </button>
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
  animation: livePulse 2s ease-out infinite;
}
@keyframes livePulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-success-dot) 45%, transparent); }
  70% { box-shadow: 0 0 0 8px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.live-txt { font-size: 11.5px; color: var(--ink-faint); }

@media (max-width: 899px) {
  /* 手指命中区:表格内的 mini-btn 原始高度只有 ~24px。
     同一组声明(原页面 scoped 块 @media 899 内)按"样式随标记走"的约束
     逐字复制进需要它的每个组件 —— 此处与 LogsEventTable/LogsFilterCard/LogsManualModal
     的对应块是有意重复,不要合并成公共 css。 */
  .head-actions .pill-btn {
    min-height: 40px;
    padding: 8px 14px;
  }
}
</style>
