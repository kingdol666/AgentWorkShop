<script setup lang="ts">
/**
 * 其他事件块 — 未识别类型行式展示。
 */
import { computed, ref } from 'vue'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

const lines = computed(() =>
  props.block.events.map(e => ({ seq: e.seq, type: e.type })),
)
const expanded = ref(false)
const MAX = 6
const shown = computed(() => (expanded.value ? lines.value : lines.value.slice(0, MAX)))
const hasMore = computed(() => lines.value.length > MAX)
</script>

<template>
  <div class="other-cluster">
    <div
      v-for="l in shown"
      :key="l.seq"
      class="other-row"
    >
      <span class="i-tabler-dots" />
      <span class="other-type">{{ l.type }}</span>
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
.other-cluster { padding: 1px 0 4px 20px; }
.other-row {
  display: flex;
  gap: 7px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 20px;
  opacity: 0.65;
}
.more-btn {
  padding: 0 6px;
  font-size: 9.5px;
  color: var(--accent-cobalt);
  cursor: pointer;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--accent-cobalt) 35%, transparent);
  border-radius: var(--radius-chip);
}
.more-btn:hover { background: color-mix(in srgb, var(--accent-cobalt) 8%, transparent); }
</style>
