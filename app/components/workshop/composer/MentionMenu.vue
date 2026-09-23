<script setup lang="ts">
/**
 * @提及菜单(open-tag mention-menu):候选 = Agent ∪ active 人类成员。
 * 只负责渲染与派发;高亮下标(mentionHi)由 Composer.vue 持有并回传。
 */
import { agentHueColor } from '@/app/composables/workshop/useEventBlocks'
import type { MentionCandidate } from '@/app/composables/workshop/useComposerMentions'

defineProps<{
  candidates: MentionCandidate[]
  highlighted: number
}>()

const emit = defineEmits<{
  (e: 'pick' | 'hover', index: number): void
}>()
</script>

<template>
  <div class="mention-menu">
    <div class="mention-title">
      {{ $t('composer.k1bxvc46004') }}
    </div>
    <button
      v-for="(c, i) in candidates"
      :key="c.key"
      type="button"
      class="mention-opt"
      :class="{ sel: i === highlighted }"
      @mousedown.prevent="emit('pick', i)"
      @mouseenter="emit('hover', i)"
    >
      <span
        class="aw-avatar mention-ava"
        :class="c.type === 'agent' ? 'is-agent' : 'is-user'"
        :style="{ '--av': c.type === 'agent' ? agentHueColor(c.id) : 'var(--ink-faint)' }"
      >{{ c.type === 'agent' ? 'A' : '人' }}</span>
      <span class="mention-name">@{{ c.name }}</span>
      <span class="mention-role">{{ c.role }}</span>
      <span
        v-if="c.type === 'agent'"
        class="mention-state"
        :class="c.state"
        :title="c.state"
      />
    </button>
  </div>
</template>

<style scoped>
/* @提及菜单(open-tag mention-menu) */
.mention-menu {
  position: absolute;
  right: 12px;
  bottom: 100%;
  left: 12px;
  z-index: 20;
  max-height: 264px;
  margin-bottom: 8px;
  overflow: auto;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float);
}
.mention-opt {
  display: flex;
  gap: 9px;
  align-items: center;
  width: 100%;
  padding: 7px 12px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.mention-opt:hover,
.mention-opt.sel { background: var(--paper-deep); }
.mention-ava { width: 20px; height: 20px; font-size: 10px; }
.mention-ava.is-user { color: var(--on-accent); background: var(--ink-faint); }
.mention-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
.mention-role {
  flex: none;
  font-size: 10.5px;
  color: var(--ink-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.mention-title {
  padding: 5px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-faint);
}

/* 成员状态点:busy = 暖橙脉冲,idle = 静灰 */
.mention-state {
  flex: none;
  width: 7px;
  height: 7px;
  background: var(--ink-fainter);
  border-radius: 50%;
  opacity: 0.7;
}

.mention-state.busy {
  background: var(--tone-live-dot);
  opacity: 1;
}

/* 窄屏覆盖(≤1023.98px):原 Composer.vue 同段规则按选择器归属拆分到此 */
@media (max-width: 1023.98px) {
  .mention-role,
  .mention-title {
    font-size: 11.5px;
  }

  .mention-opt {
    min-height: 44px;
  }
}
</style>
