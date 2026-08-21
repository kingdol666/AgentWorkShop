<script setup lang="ts">
/**
 * 流块(打字机气泡)— Codex 式散文渲染:
 *  - markdown-lite(段落/标题/列表/引用/GitHub提示框/任务列表/行内代码/加粗)替代等宽文本墙;
 *  - 实时流式:逐帧增量揭示(rAF 比例追赶;后台标签页/落定/大段全速);
 *  - 光标只在"有文本且未落定"时出现 —— 空块绝不闪烁空光标;
 *  - 落定消息与 delta 重复内容由聚类折入,正文绝不二次渲染;
 *  - 复制/引用工具条在 EventBlock 壳层悬停浮出。
 */
import { computed } from 'vue'
import { buildStreamText, isStreaming, streamCursorVisible, mdLiteMentions, type EventBlock, type MentionMember } from '@/app/composables/workshop/useEventBlocks'
import { useEntitiesStore } from '@/app/stores/workshop/entities'

const props = defineProps<{ block: EventBlock }>()

const entities = useEntitiesStore()

/** @提及点击 → 打开 Agent 抽屉(w/[wsId] provide;缺省安全兜底) */
const openAgent = inject<(target: { channelId: string, agentId: string }) => void>(
  'aw:open-agent',
  () => {},
)

const channelId = computed(() => props.block.events[0]?.channelId ?? '')

/** 本 channel 成员表(LLM 正文里的 @成员 高亮) */
const members = computed<MentionMember[]>(() =>
  (entities.agents[channelId.value] ?? []).map(a => ({ agentId: a.agentId, name: a.name })),
)

/** 正文内提及 pill 点击(事件委托) */
const onBodyClick = (ev: MouseEvent): void => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('.md-mention')
  if (!el) return
  const agentId = el.dataset.agentId
  if (agentId) openAgent({ channelId: channelId.value, agentId })
}

const full = computed(() => buildStreamText(props.block))
const streaming = computed(() => isStreaming(props.block))

/** 揭示游标 */
const visible = ref(0)
let rafId: number | null = null

const stopReveal = (): void => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

const step = (): void => {
  const target = full.value.length
  if (visible.value >= target) {
    rafId = null
    return
  }
  const remaining = target - visible.value
  const chunk = Math.max(24, Math.min(1024, Math.ceil(remaining / 16)))
  visible.value = Math.min(target, visible.value + chunk)
  rafId = requestAnimationFrame(step)
}

const scheduleReveal = (): void => {
  if (rafId !== null) return
  rafId = requestAnimationFrame(step)
}

const pageHidden = (): boolean => typeof document !== 'undefined' && document.hidden

watch([full, () => props.block.settled], ([t, settled]) => {
  if (!t) {
    visible.value = 0
    return
  }
  if (settled || t.length - visible.value > 4000 || pageHidden()) {
    stopReveal()
    visible.value = t.length
    return
  }
  if (visible.value > t.length) visible.value = t.length
  if (visible.value < t.length) scheduleReveal()
}, { immediate: true })

/** 回前台兜底:后台期间 rAF 暂停(游标冻结)→ 可见时重新驱动 */
const onVisibility = (): void => {
  if (document.hidden) return
  if (visible.value < full.value.length) {
    stopReveal()
    scheduleReveal()
  }
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  if (props.block.settled || pageHidden()) {
    visible.value = full.value.length
  }
  else {
    visible.value = Math.min(visible.value, full.value.length)
    scheduleReveal()
  }
})
onBeforeUnmount(() => {
  stopReveal()
  document.removeEventListener('visibilitychange', onVisibility)
})

/**
 * 打字光标(streamCursorVisible 权威语义):仅当"已有文本 &&(流式未落定 || 揭示未追平)"
 * 时显示。空文本块不渲染光标 —— 杜绝空光标闪烁。
 */
const showCursor = computed(() =>
  streamCursorVisible(full.value.length, visible.value, streaming.value),
)

const rendered = computed(() => mdLiteMentions(full.value.slice(0, visible.value), members.value))
</script>

<template>
  <div
    v-if="block.coveredBy"
    class="stream-covered"
  >
    <span class="i-tabler-corner-right-up" />
    <span>内容并入了后续回复块(不再重复渲染)</span>
  </div>
  <div
    v-else-if="full"
    class="stream-bubble"
    :class="{ settled: block.settled }"
    @click="onBodyClick"
  >
    <!-- eslint-disable-next-line vue/no-v-html -- 内容经 escapeHtml 转义后仅注入受控标记 -->
    <div class="stream-text prose">
      <span v-html="rendered" /><span
        v-if="showCursor"
        class="cursor"
      >▋</span>
    </div>
  </div>
  <div
    v-else-if="streaming"
    class="stream-pending"
  >
    <span class="pending-dot" /><span class="pending-dot" /><span class="pending-dot" />
  </div>
</template>

<style scoped>
.stream-bubble {
  position: relative;
  padding: 2px 0 6px;
}

.stream-text {
  padding: 8px 12px;
  font-size: 12.5px;
  line-height: 1.68;
  color: var(--ink);
  background: var(--paper-raised);
  border: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
  border-left: 2px solid var(--accent);
  border-radius: var(--radius-chip);
  transition: border-left-color 0.2s ease;
}
.stream-bubble.settled .stream-text {
  border-left-color: color-mix(in srgb, var(--accent) 28%, transparent);
}

.prose :deep(p) { margin: 0 0 6px; }
.prose :deep(p:last-child) { margin-bottom: 0; }
.prose :deep(h3),
.prose :deep(h4),
.prose :deep(h5) {
  margin: 10px 0 4px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
}
.prose :deep(h3):first-child,
.prose :deep(h4):first-child,
.prose :deep(h5):first-child { margin-top: 2px; }
.prose :deep(ul) {
  margin: 2px 0 6px;
  padding-left: 18px;
}
.prose :deep(li) { margin: 1px 0; }
.prose :deep(code) {
  padding: 0.5px 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-radius: 3px;
}
.prose :deep(blockquote) {
  margin: 4px 0;
  padding: 2px 10px;
  color: var(--ink-soft, inherit);
  border-left: 2px solid color-mix(in srgb, var(--ink) 18%, transparent);
}
.prose :deep(b) { font-weight: 600; }

/* 围栏代码块:头栏(语言 + 复制)+ 等宽正文(现代 harness 标配) */
.prose :deep(.code-block) {
  margin: 6px 0;
  overflow: hidden;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}

.prose :deep(.code-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 4px 10px;
  border-bottom: 1px solid var(--divider-hair);
}

.prose :deep(.code-lang) {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
}

.prose :deep(.code-copy) {
  padding: 1px 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-soft, inherit);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  transition: color var(--transition-fast), border-color var(--transition-fast);
}

.prose :deep(.code-copy:hover) {
  color: var(--ink);
  border-color: var(--line-strong);
}

.prose :deep(.code-block pre) {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
}

.prose :deep(.code-block code) {
  padding: 0;
  font-size: 11px;
  line-height: 1.55;
  background: transparent;
  border-radius: 0;
}

.cursor {
  display: inline-block;
  color: var(--accent);
  animation: blink 0.9s step-end infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
.stream-pending {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 6px 0;
}
.pending-dot {
  width: 4px;
  height: 4px;
  background: var(--ink-faint);
  border-radius: 50%;
  animation: pulse 1.1s ease-in-out infinite;
}
.pending-dot:nth-child(2) { animation-delay: 0.18s; }
.pending-dot:nth-child(3) { animation-delay: 0.36s; }
@keyframes pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}
.stream-covered {
  display: flex;
  gap: 6px;
  padding: 1px 0;
  align-items: center;
  font-size: 11px;
  opacity: 0.5;
  color: var(--ink-soft, inherit);
}
</style>
