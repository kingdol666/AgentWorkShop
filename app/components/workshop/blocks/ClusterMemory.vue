<script setup lang="ts">
/**
 * 记忆沉淀行 — scope+|标题|
 */
import { computed, ref } from 'vue'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

const lines = computed(() =>
  props.block.events.map(e => ({
    seq: e.seq,
    scope: String((e.payload as { scope: string }).scope),
    title: String((e.payload as { title: string }).title),
  })),
)
const expanded = ref(false)
const MAX = 8
const shown = computed(() => (expanded.value ? lines.value : lines.value.slice(0, MAX)))
const hasMore = computed(() => lines.value.length > MAX)
</script>

<template>
  <div class="memory-cluster">
    <div
      v-for="m in shown"
      :key="m.seq"
      class="memory-line"
    >
      <span class="i-tabler-bookmark" />
      <span
        class="mem-scope"
        :data-scope="m.scope"
      >{{ m.scope }}</span>
      <span class="mem-title">{{ m.title }}</span>
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
.memory-cluster { padding: 1px 0 4px 20px; }
.memory-line {
  display: flex;
  gap: 7px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 20px;
}
.mem-scope {
  padding: 0 5px;
  font-size: 8.5px;
  letter-spacing: 0.08em;
  border-radius: var(--radius-chip);
}
.mem-scope[data-scope='shared'] { color: var(--accent-violet); background: color-mix(in srgb, var(--accent-violet) 14%, transparent); }
.mem-scope[data-scope='private'] { color: var(--accent-cobalt); background: color-mix(in srgb, var(--accent-cobalt) 12%, transparent); }
.mem-title { overflow-wrap: anywhere; word-break: break-word; }
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
