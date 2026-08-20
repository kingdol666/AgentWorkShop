<script setup lang="ts">
/**
 * 消息路由块 — 从→到 + 类型徽章 + 文本预览;每行独立。
 * 短消息单行预览;长消息(>120 字符)折叠预览 + 点击展开全文。
 */
import { computed, ref } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()
const entities = useEntitiesStore()

const PREVIEW_MAX = 120

const lines = computed(() =>
  props.block.events.map((_e, i) => {
    const e = props.block.events[i]!
    const meta = (e.payload as { metadata?: Record<string, unknown> }).metadata ?? {}
    const fromId = typeof meta['x-aw-from-agent'] === 'string' ? meta['x-aw-from-agent'] as string : ''
    const toId = typeof meta['x-aw-target-agent'] === 'string' ? meta['x-aw-target-agent'] as string : ''
    const priority = meta['x-aw-msg-priority'] === 'immediate' ? 'immediate' : 'task'
    const taskKind = typeof meta['x-aw-task-kind'] === 'string' ? meta['x-aw-task-kind'] as string : ''
    const kind = taskKind === 'assign'
      ? { icon: 'i-tabler-send', label: '任务派发', tone: 'assign' as const }
      : taskKind === 'cancel'
        ? { icon: 'i-tabler-circle-x', label: '取消通知', tone: 'notice' as const }
        : taskKind === 'child-completed'
          ? { icon: 'i-tabler-circle-check', label: '子任务完成', tone: 'notice' as const }
          : priority === 'immediate'
            ? { icon: 'i-tabler-bolt', label: '实时注入', tone: 'immediate' as const }
            : { icon: 'i-tabler-message', label: '协作消息', tone: 'peer' as const }
    const parts = (e.payload as { parts?: Array<{ text?: string }> }).parts ?? []
    const text = parts.map(p => p.text ?? '').join('\n').trim()
    const seq = e.seq
    const channelId = e.channelId
    const long = text.length > PREVIEW_MAX
    return { seq, kind, channelId, from: fromId, to: toId, text, long, preview: long ? `${text.slice(0, PREVIEW_MAX)}…` : text, i }
  }),
)
const expandedRows = ref(new Set<number>())
const toggle = (i: number): void => {
  const s = new Set(expandedRows.value)
  if (s.has(i)) s.delete(i)
  else s.add(i)
  expandedRows.value = s
}

const expanded = ref(false)
const MAX = 4
const shown = computed(() => (expanded.value ? lines.value : lines.value.slice(0, MAX)))
const hasMore = computed(() => lines.value.length > MAX)
</script>

<template>
  <div class="route-cluster">
    <div
      v-for="r in shown"
      :key="r.seq"
      class="route-row"
    >
      <span
        class="route-badge"
        :data-tone="r.kind.tone"
      ><span :class="r.kind.icon" /> {{ r.kind.label }}</span>
      <span class="route-path">{{ r.from ? entities.agentName(r.channelId, r.from) : 'system' }} → {{ r.to ? entities.agentName(r.channelId, r.to) : '(广播)' }}</span>
      <template v-if="r.long && expandedRows.has(r.i)">
        <span class="route-full">
          <pre class="route-full-text">{{ r.text }}</pre>
          <button
            class="expand-btn"
            @click="toggle(r.i)"
          >收起</button>
        </span>
      </template>
      <template v-else>
        <span
          v-if="r.text"
          class="route-text"
        >{{ r.preview }}</span>
        <button
          v-if="r.long"
          class="expand-btn"
          title="展开全文"
          @click="toggle(r.i)"
        >
          展开
        </button>
      </template>
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
.route-cluster { padding: 1px 0 4px 20px; }
.route-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 1px 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 20px;
  flex-wrap: wrap;
}
.route-badge {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 0 6px;
  font-size: 9.5px;
  border-radius: 2px;
}
.route-badge[data-tone='assign'] { color: var(--accent-cobalt); background: color-mix(in srgb, var(--accent-cobalt) 12%, transparent); }
.route-badge[data-tone='immediate'] { color: var(--accent-amber); background: color-mix(in srgb, var(--accent-amber) 15%, transparent); }
.route-badge[data-tone='notice'] { color: var(--accent-moss); background: color-mix(in srgb, var(--accent-moss) 12%, transparent); }
.route-badge[data-tone='peer'] { color: var(--accent-violet); background: color-mix(in srgb, var(--accent-violet) 14%, transparent); }
.route-path { flex: 0 0 auto; opacity: 0.6; }
.route-text { overflow-wrap: anywhere; word-break: break-word; opacity: 0.85; }
.route-full {
  flex: 1 1 100%;
  margin: 2px 0 1px;
}
.route-full-text {
  max-height: 260px;
  margin: 0 0 2px;
  overflow-y: auto;
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  background: color-mix(in srgb, var(--ink) 3.5%, transparent);
  border-left: 2px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 0 3px 3px 0;
}
.expand-btn {
  flex: 0 0 auto;
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--accent-cobalt);
  cursor: pointer;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--accent-cobalt) 35%, transparent);
  border-radius: 2px;
}
.expand-btn:hover { background: color-mix(in srgb, var(--accent-cobalt) 8%, transparent); }
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
