<script setup lang="ts">
/**
 * 状态文本块 — 连续中间状态提示列(非工具标记);
 * 每行独立行号(delta 状态不加冗余),长文本换行展示。
 */
import { computed, ref } from 'vue'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

const lines = computed(() =>
  props.block.events.map((e, i) => {
    const text = String((e.payload as { text?: string }).text ?? '')
    const isTool = /^🔧\s*\S+/.test(text)
    return { seq: e.seq, i, text, isTool }
  }),
)
const expanded = ref(false)
const MAX = 4
const shown = computed(() => (expanded.value ? lines.value : lines.value.slice(0, MAX)))
const hasMore = computed(() => lines.value.length > MAX)
</script>

<template>
  <div class="status-cluster">
    <div
      v-for="(l, idx) in shown"
      :key="l.seq"
      class="status-line"
      :data-alt="l.isTool ? 'tool' : idx % 2 === 1 ? 'alt' : 'main'"
    >
      <span class="st-dot" />
      <span class="status-text">{{ l.text }}</span>
    </div>
    <button
      v-if="hasMore"
      class="more-btn"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : `全部 ${lines.length} 行` }}
    </button>
  </div>
</template>

<style scoped>
.status-cluster { padding: 1px 0 4px 66px; }
.status-line {
  display: flex;
  gap: 7px;
  align-items: baseline;
  padding: 1px 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
}
.status-line[data-alt='main'] { color: var(--ink-soft, inherit); }
.st-dot {
  flex: 0 0 auto;
  width: 4px;
  height: 4px;
  margin-top: 5px;
  background: var(--ink-faint, #999);
}
.status-text {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}
.more-btn {
  margin: 2px 0 0;
  padding: 0 6px;
  font-size: 9.5px;
  color: var(--accent-cobalt);
  cursor: pointer;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--accent-cobalt) 35%, transparent);
  border-radius: 2px;
}
.more-btn:hover { background: color-mix(in srgb, var(--accent-cobalt) 8%, transparent); }
</style>
