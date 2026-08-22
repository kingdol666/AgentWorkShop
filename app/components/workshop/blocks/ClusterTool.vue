<script setup lang="ts">
/**
 * 工具链块 — Codex 式紧凑工具行:图标 + 工具名 + 参数预览(`🔧 name(args)`),
 * harness 协作工具紫色标记;长链 >4 折叠展开。
 */
import { computed, ref } from 'vue'
import { TOOL_META } from '@/app/composables/workshop/useEventBlocks'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

/** 解析 `🔧 name(arg preview)` 行 */
const toolLines = computed(() =>
  props.block.events.map((e) => {
    const text = String((e.payload as { text?: string }).text ?? '')
    const m = text.match(/^🔧\s*(\S+?)(?:\(([\s\S]*)\))?$/)
    const name = m?.[1] ?? 'tool'
    const args = m?.[2] ?? ''
    return { seq: e.seq, name, args, meta: TOOL_META[name] ?? { icon: 'i-tabler-tool', kind: 'native' as const } }
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
        v-if="t.args"
        class="tool-args"
        :title="t.args"
      >{{ t.args }}</span>
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
      {{ expanded ? '收起' : `展开全部 ${toolLines.length} 个调用` }}
    </button>
  </div>
</template>

<style scoped>
.tool-cluster {
  padding: 1px 0 4px 20px;
}
.tool-line {
  display: flex;
  gap: 7px;
  align-items: baseline;
  min-width: 0;
  padding: 1.5px 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 19px;
}
.tool-icon {
  flex: 0 0 auto;
  font-size: 12px;
  line-height: 19px;
  opacity: 0.7;
}
.tool-name { flex: 0 0 auto; font-weight: 500; }
.tool-args {
  min-width: 0;
  overflow: hidden;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}
.tool-line.host .tool-icon,
.tool-line.host .tool-name {
  font-weight: 600;
  color: var(--ink);
}
.tool-kind {
  flex: 0 0 auto;
  align-self: center;
  padding: 0 5px;
  font-size: 8.5px;
  letter-spacing: 0.1em;
  line-height: 14px;
  color: var(--ink-faint);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.tool-line:hover .tool-args { opacity: 1; }
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
