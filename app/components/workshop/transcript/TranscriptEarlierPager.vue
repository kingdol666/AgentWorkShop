<script setup lang="ts">
/**
 * 时间线列首的历史翻页区:「加载更早」按钮 + 触底提示。
 * 纯呈现:loading / exhausted 由 TranscriptTimeline 的 useTranscriptHistory 持有,
 * 点击只上抛 load 事件(锚定与探底逻辑在容器侧)。
 */
defineProps<{
  /** 还可能存在更早历史(粗判;false 时按钮不渲染) */
  visible: boolean
  /** 本页拉取中(按钮禁用 + 文案切换) */
  loading: boolean
  /** 已确认没有更早历史 */
  exhausted: boolean
  /** 已加载事件数(为 0 时不显示"已到最早") */
  loadedCount: number
}>()

const emit = defineEmits<{
  load: []
}>()
</script>

<template>
  <button
    v-if="visible"
    class="earlier-btn"
    :disabled="loading"
    @click="emit('load')"
  >
    {{ loading ? $t('transcriptTimeline.k1br0ij9009') : $t('transcriptTimeline.kywgd38021') }}
  </button>
  <div
    v-if="exhausted && loadedCount > 0"
    class="earlier-done"
  >
    {{ $t('transcriptTimeline.k1kbaden003') }}
  </div>
</template>

<style scoped>
.earlier-btn {
  display: block;
  margin: 0 auto 10px;
  padding: 4px 14px;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--ink-faint);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.earlier-btn:hover:not(:disabled) {
  color: var(--ink);
  background: var(--paper-deep);
}
.earlier-btn:disabled { opacity: 0.5; cursor: default; }
.earlier-done {
  margin-bottom: 8px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  text-align: center;
  color: var(--ink-faint);
}

/* ── 窄屏(≤1023):字号与触控高度对齐过滤条 ── */
@media (max-width: 1023.98px) {
  /* 与 transcript/TranscriptFilterBar.vue 的 `.count, .sync-chip` 原为同一条选择器列表
     —— 有意重复,改一处同步所有副本。 */
  .earlier-done {
    font-size: 11.5px;
  }

  /* 与容器 .jump-latest 原共用一条 min-height 规则 —— 有意重复,改一处同步所有副本
     (副本:workshop/TranscriptTimeline.vue 的同名媒体查询块)。 */
  .earlier-btn {
    min-height: 40px;
  }
}
</style>
