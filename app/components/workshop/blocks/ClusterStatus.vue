<script setup lang="ts">
/**
 * 状态/思考块 — Codex 式可折叠手风琴:
 *  - 默认折叠:暗色单行预览(最新一条事件的首行摘要)+ 条目计数,占用一行;
 *  - 点击展开:全部事件的完整文本(限高滚动,等宽字体——多为工具文档/中间输出);
 *  - 块追加新事件时折叠预览实时刷新(计数 +N)。
 */
import { computed, ref } from 'vue'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

interface StatusLine { seq: number, text: string }

const lines = computed<StatusLine[]>(() =>
  props.block.events.map(e => ({
    seq: e.seq,
    text: String((e.payload as { text?: string }).text ?? ''),
  })),
)

/** 折叠预览:最新事件首行(截 120 字符) */
const preview = computed(() => {
  const last = lines.value[lines.value.length - 1]
  if (!last) return '(空)'
  const firstLine = last.text.split('\n').find(l => l.trim().length > 0) ?? ''
  const flat = firstLine.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : (flat || '(空)')
})

const expanded = ref(false)
const toggle = (): void => {
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="status-cluster">
    <button
      class="st-toggle"
      :aria-expanded="expanded"
      @click="toggle"
    >
      <span
        class="chev"
        :class="{ open: expanded }"
      >▸</span>
      <span class="st-label">思考 / 中间输出</span>
      <span class="st-count">{{ lines.length }}</span>
      <span
        v-if="!expanded"
        class="st-preview"
      >{{ preview }}</span>
    </button>
    <div
      v-if="expanded"
      class="st-detail"
    >
      <div
        v-for="l in lines"
        :key="l.seq"
        class="st-line"
      >
        <span class="st-mark">·</span>
        <pre class="st-text">{{ l.text }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* open-tag msg-act 折叠行形态:内容列起点对齐,无双重缩进 */
.status-cluster { padding: 1px 0 4px 2px; }
.st-toggle {
  display: flex;
  gap: 7px;
  align-items: baseline;
  width: 100%;
  min-width: 0;
  padding: 2px 4px 2px 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
}
.st-toggle:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
.chev {
  flex: 0 0 auto;
  font-size: 9px;
  line-height: 15px;
  color: var(--ink-faint);
  transition: transform 0.12s ease;
}
.chev.open { transform: rotate(90deg); }
.st-label {
  flex: 0 0 auto;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
}
.st-count {
  flex: 0 0 auto;
  padding: 0 4px;
  font-size: 9px;
  line-height: 13px;
  color: var(--ink-soft);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  border-radius: var(--radius-chip);
  align-self: center;
}
.st-preview {
  min-width: 0;
  overflow: hidden;
  font-style: italic;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
}
.st-detail {
  max-height: 320px;
  margin: 2px 0 2px 16px;
  overflow-y: auto;
  padding: 4px 8px;
  background: color-mix(in srgb, var(--ink) 3.5%, transparent);
  border-left: 2px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 0 3px 3px 0;
}
.st-line {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.st-line + .st-line { margin-top: 4px; }
.st-mark { flex: 0 0 auto; color: var(--ink-faint); }
.st-text {
  min-width: 0;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
