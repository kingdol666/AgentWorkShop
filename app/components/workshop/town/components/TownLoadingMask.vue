<script setup lang="ts">
/**
 * 小镇视图 · 加载遮罩(全页 / 舞台各一份,同一形态)。
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 显隐由父组件持有的 ready 经 props 传入(与原先模板内 v-if="!ready" 同义),
 * 样式为本组件模板专属规则。
 */
import type { TownLoadingMaskProps } from '@/app/composables/workshop/town/town-relay-props'

defineProps<TownLoadingMaskProps>()
</script>

<template>
  <div
    v-if="!ready"
    data-hud="town-loading"
    class="loading-mask"
  >
    <div class="loading-spinner" />
    <span class="loading-text">{{ $t('townView.kvjdqfg059') }}</span>
  </div>
</template>

<style scoped>
/* ===== 加载遮罩 ===== */
.loading-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: center;
  justify-content: center;
  background: var(--hud-bg);
}
.loading-spinner {
  width: 30px;
  height: 30px;
  border: 2.5px solid var(--hud-line);
  border-top-color: var(--hud-accent);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
.loading-text {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.24em;
  color: var(--hud-dim);
}
@keyframes spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .rpg-line.live .rpg-bubble, .ty-dot, .loading-spinner { animation: none; }
}

@media (max-width: 1023px) {
  .loading-text { font-size: 12px; }
}
</style>
