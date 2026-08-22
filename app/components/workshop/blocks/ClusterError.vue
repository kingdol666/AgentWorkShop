<script setup lang="ts">
/**
 * 错误块 — 逐行 code:message;时限错误底色强调。
 */
import { computed, ref } from 'vue'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

const lines = computed(() =>
  props.block.events.map(e => ({
    seq: e.seq,
    code: String((e.payload as { code?: string }).code ?? ''),
    text: String((e.payload as { message?: string }).message ?? ''),
  })),
)
const expanded = ref(false)
const MAX = 3
const shown = computed(() => (expanded.value ? lines.value : lines.value.slice(0, MAX)))
const hasMore = computed(() => lines.value.length > MAX)
</script>

<template>
  <div class="error-cluster">
    <div
      v-for="er in shown"
      :key="er.seq"
      class="error-line"
    >
      <span class="i-tabler-alert-triangle" />
      <span
        v-if="er.code"
        class="error-code"
      >{{ er.code }}</span>
      <span class="error-text">{{ er.text }}</span>
    </div>
    <button
      v-if="hasMore"
      class="more-btn"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : `全部 ${lines.length} 条` }}
    </button>
  </div>
</template>

<style scoped>
.error-cluster {
  padding: 1px 0 4px 20px;
}
/* 错误块体:danger 底色轻染(与任务 FAILED chip 同一视觉语义) */
.error-line {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 20px;
  color: var(--tone-danger-dot);
}
.error-line:first-child {
  background: var(--tone-danger-bg);
  border-radius: var(--radius-chip);
}
.error-code { padding: 0 5px; font-size: 9px; background: color-mix(in srgb, var(--tone-danger-dot) 14%, transparent); border-radius: var(--radius-chip); }
.error-text { overflow-wrap: anywhere; word-break: break-word; }
.more-btn {
  margin-top: 4px;
  padding: 1px 10px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.more-btn:hover {
  color: var(--ink);
  background: var(--hover-tint);
  border-color: var(--ink-fainter);
}
</style>
