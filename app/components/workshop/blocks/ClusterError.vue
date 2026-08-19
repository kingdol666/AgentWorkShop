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
  padding: 1px 0 4px 66px;
}
.error-line {
  display: flex;
  gap: 7px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 20px;
  color: var(--accent-vermilion, #ff4d4f);
}
.error-code { padding: 0 5px; font-size: 9px; background: color-mix(in srgb, var(--accent-vermilion, #ff4d4f) 14%, transparent); border-radius: 2px; }
.error-text { overflow-wrap: anywhere; word-break: break-word; }
.more-btn {
  padding: 0 6px;
  font-size: 9.5px;
  color: var(--accent-vermilion, #ff4d4f);
  cursor: pointer;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--accent-vermilion, #ff4d4f) 35%, transparent);
  border-radius: 2px;
}
.more-btn:hover { background: color-mix(in srgb, var(--accent-vermilion, #ff4d4f) 8%, transparent); }
</style>
