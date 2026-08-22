<script setup lang="ts">
/**
 * Artifact 交付物卡片:按 part 内容渲染文本/代码(JSON 检测 + diff/代码高亮占位),
 * 可折叠展开全文 + 复制;命名 deliverable/summary 加金色左边条(交付物语义)。
 */
const props = defineProps<{
  artifact: { artifactId: string, name?: string, parts: Array<{ text?: string }> }
}>()

const text = computed(() =>
  props.artifact.parts.map(p => p.text ?? '').join('\n').trim(),
)

const isJson = computed(() => {
  const t = text.value
  if (!t) return false
  try {
    JSON.parse(t)
    return true
  }
  catch {
    return false
  }
})

const isDeliverable = computed(() =>
  props.artifact.name === 'deliverable' || props.artifact.name === 'summary' || props.artifact.name === 'result' || props.artifact.name === 'goal-summary',
)

/** 工件语义图标(交付物/汇总/输出/输入/goal 收口总结) */
const artifactIcon = computed(() => {
  switch (props.artifact.name) {
    case 'deliverable': return 'i-tabler-package'
    case 'summary': return 'i-tabler-list-check'
    case 'result': return 'i-tabler-circle-check'
    case 'output': return 'i-tabler-file-text'
    case 'input': return 'i-tabler-inbox'
    case 'goal-summary': return 'i-tabler-flag'
    default: return 'i-tabler-receipt-2'
  }
})

const expanded = ref(false)
const shortText = computed(() => {
  const t = text.value
  return t.length > 200 && !expanded.value ? `${t.slice(0, 200)}…` : t
})

const copied = ref(false)
const copy = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  }
  catch { /* 剪贴板不可用忽略 */ }
}
</script>

<template>
  <div
    class="artifact-card"
    :class="{ deliverable: isDeliverable }"
  >
    <div class="artifact-head">
      <span class="tag"><span :class="artifactIcon" /></span>
      <span class="name">{{ artifact.name ?? 'artifact' }}</span>
      <a-button
        size="small"
        type="text"
        class="op"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : '展开' }}
      </a-button>
      <a-button
        size="small"
        type="text"
        class="op"
        @click="copy"
      >
        {{ copied ? '已复制' : '复制' }}
      </a-button>
    </div>
    <pre
      class="artifact-body"
      :class="{ json: isJson }"
    >{{ shortText || '(空)' }}</pre>
  </div>
</template>

<style scoped>
.artifact-card {
  margin: 2px 0;
  padding: 4px 8px;
  background: color-mix(in srgb, currentColor 4%, transparent);
  border-left: 2px solid var(--ink-faint);
  border-radius: var(--radius-chip);
}
.artifact-card.deliverable { border-left-color: var(--tone-warning-dot); }
.artifact-head {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  opacity: 0.85;
}
.name { font-weight: 600; }
.op { font-size: 11px; opacity: 0.7; }
.artifact-body {
  margin: 4px 0 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.artifact-body.json { color: #69b1ff; }
</style>
