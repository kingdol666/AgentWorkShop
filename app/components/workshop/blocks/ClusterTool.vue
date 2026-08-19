<script setup lang="ts">
/**
 * 工具链块 — 同源连续工具调用聚合;harness 协作工具紫色标记。
 * 每条工具行单独渲染(tool line);长链 >4 折叠展开。
 */
import { computed, ref } from 'vue'
import { TOOL_META } from '@/app/composables/workshop/useEventBlocks'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

const toolLines = computed(() =>
  props.block.events.map((e) => {
    const text = String((e.payload as { text?: string }).text ?? '')
    const m = text.match(/^🔧\s*(\S+)/)
    const name = m?.[1] ?? 'tool'
    return { seq: e.seq, name, meta: TOOL_META[name] ?? { icon: 'i-tabler-tool', kind: 'native' as const } }
  }),
)

const expanded = ref(false)
const MAX = 4
const shown = computed(() => (expanded.value ? toolLines.value : toolLines.value.slice(0, MAX)))
const hasMore = computed(() => toolLines.value.length > MAX)
</script>

<template>
  <div class="tool-cluster">
    <div
      v-for="t in shown"
      :key="t.seq"
      class="tool-line"
      :class="t.meta.kind"
    >
      <span
        class="tool-icon"
        :class="t.meta.icon"
      />
      <span class="tool-name">{{ t.name }}</span>
      <span
        v-if="t.meta.kind === 'host'"
        class="tool-kind"
      >harness</span>
    </div>
    <button
      v-if="hasMore"
      class="more-btn"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : `全部 ${toolLines.length} 个工具` }}
    </button>
  </div>
</template>

<style scoped>
.tool-cluster {
  padding: 1px 0 4px 66px;
}
.tool-line {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 1px 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 20px;
}
.tool-icon { font-size: 12px; opacity: 0.75; }
.tool-line.host .tool-icon { color: var(--accent-violet); }
.tool-line.host .tool-name { color: var(--accent-violet); }
.tool-kind {
  padding: 0 5px;
  font-size: 8.5px;
  letter-spacing: 0.1em;
  color: var(--accent-violet);
  background: color-mix(in srgb, var(--accent-violet) 14%, transparent);
  border-radius: 2px;
}
.more-btn {
  margin: 2px 0 0;
  padding: 0 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--accent-cobalt);
  cursor: pointer;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--accent-cobalt) 35%, transparent);
  border-radius: 2px;
}
.more-btn:hover {
  background: color-mix(in srgb, var(--accent-cobalt) 8%, transparent);
}
</style>
