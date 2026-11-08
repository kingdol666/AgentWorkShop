<script setup lang="ts">
/**
 * 工具链块 — Codex 式紧凑工具行:图标 + 工具名 + 参数预览(`🔧 name(args)`),
 * harness 协作工具紫色标记;长链 >4 折叠展开。
 */
import { computed, ref } from 'vue'
import { TOOL_META } from '@/app/composables/workshop/useEventBlocks'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

/** 解析工具行:AgentBlock v1 结构块优先(payload={block});正则反解 🔧 文本退路径(compat)。
 *  去重:omp 等原生发射同一调用会有「结构帧+文本帧」两条(payload.block.text 与文本帧同文),
 *  文本帧若已被任一结构块的 text 覆盖则跳过,避免双行。 */
const toolLines = computed(() => {
  const events = props.block.events
  const covered = new Set<string>()
  for (const e of events) {
    const b = (e.payload as { block?: { text?: string } }).block
    if (b?.text) covered.add(b.text)
  }
  return events.flatMap((e) => {
    const structured = (e.payload as { block?: { tool?: string, argsPreview?: string | null, phase?: string, status?: string } }).block
    const text = String((e.payload as { text?: string }).text ?? '')
    if (structured && structured.tool) {
      const suffix = structured.phase === 'end'
        ? (structured.status === 'error' ? ' ❌' : structured.status === 'ok' ? ' ✓' : '')
        : ''
      return [{
        seq: e.seq,
        time: formatLocalClock(e.at),
        name: String(structured.tool),
        args: String(structured.argsPreview ?? '') + suffix,
        meta: TOOL_META[String(structured.tool)] ?? { icon: 'i-tabler-tool', kind: 'native' as const },
      }]
    }
    // 已被结构块覆盖的文本帧跳过(去重);无结构覆盖时正则反解
    if (covered.has(text)) return []
    const m = text.match(/^🔧\s*(\S+?)(?:\(([\s\S]*)\))?$/)
    if (!m) return []
    const name = m[1] ?? 'tool'
    const args = m[2] ?? ''
    return [{ seq: e.seq, time: formatLocalClock(e.at), name, args, meta: TOOL_META[name] ?? { icon: 'i-tabler-tool', kind: 'native' as const } }]
  })
})

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
      <time class="tool-time aw-mono">{{ t.time }}</time>
      <span class="tool-node" />
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
        v-if="t.meta.kind !== 'native'"
        class="tool-kind"
        :class="t.meta.kind"
      >{{ t.meta.kind === 'industrial' ? $t('clusterTool.kindIndustrial') : 'harness' }}</span>
    </div>
    <button
      v-if="hasMore"
      class="more-btn"
      @click="expanded = !expanded"
    >
      {{ expanded ? $t('clusterTool.k40p82001') : $t('clusterTool.expandAll', { p0: toolLines.length }) }}
    </button>
  </div>
</template>

<style scoped>
/* open-tag AgentActivity 活动流形态:左缘活动行 —— mono 时间 → 节点 → 内容;
 * 工具调用节点为方点(视觉区别于状态圆点),host 协作工具紫调强调 */
.tool-cluster {
  position: relative;
  padding: 1px 0 5px 2px;
}
.tool-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
  padding: 1.5px 0;
  font-family: var(--font-body);
  font-size: 12px;
  line-height: 1.6;
}
.tool-time {
  flex: 0 0 34px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
}
.tool-node {
  flex: 0 0 7px;
  align-self: center;
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--line-strong);
  border-radius: 2.5px;
  background: var(--paper-raised);
}
.tool-icon {
  flex: 0 0 auto;
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.75;
}
.tool-name { flex: 0 0 auto; font-family: var(--font-mono); font-weight: 500; font-size: 11.5px; }
.tool-args {
  min-width: 0;
  max-width: min(52ch, 100%);
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}
.tool-line.host .tool-node {
  border-color: var(--ink);
  background: color-mix(in srgb, var(--ink) 14%, var(--paper-raised));
}
.tool-line.host .tool-icon,
.tool-line.host .tool-name {
  font-weight: 600;
  color: var(--ink);
}
.tool-line.host .tool-icon { opacity: 1; }
/* 产线工业工具:琥珀强调(与 /operations 时间线 write 轨同族),写控一眼可辨 */
.tool-line.industrial .tool-node {
  border-color: #c98922;
  background: color-mix(in srgb, #c98922 22%, var(--paper-raised));
}
.tool-line.industrial .tool-icon,
.tool-line.industrial .tool-name {
  font-weight: 700;
  color: #c98922;
}
.tool-line.industrial .tool-icon { opacity: 1; }
.tool-line.industrial .tool-args { color: color-mix(in srgb, #c98922 62%, var(--ink-soft)); opacity: 1; }
.tool-kind {
  flex: 0 0 auto;
  align-self: center;
  padding: 0 5px;
  font-size: 8.5px;
  letter-spacing: 0.1em;
  line-height: 14px;
  color: var(--ink-faint);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
}
.tool-kind.industrial {
  color: #c98922;
  border-color: color-mix(in srgb, #c98922 55%, var(--line));
  background: color-mix(in srgb, #c98922 10%, transparent);
}
.tool-line:hover .tool-args { opacity: 1; }
.more-btn {
  margin-top: 5px;
  margin-left: 49px;
  padding: 1px 10px;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.more-btn:hover {
  color: var(--ink);
  background: var(--hover-tint);
  border-color: var(--ink-fainter);
}
</style>
