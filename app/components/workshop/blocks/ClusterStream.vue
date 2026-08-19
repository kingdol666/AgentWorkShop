<script setup lang="ts">
/**
 * 流块(打字机气泡)— 独立渲染组件:
 *  - delta 已由 store 聚合为单连续帧;此处消费 buildStreamText 的完整文本
 *  - 实时流式:逐帧增量揭示(每帧比例式追赶,避免高频 delta 抖动)
 *  - 落定消息顶替重复落定帧(聚类已折入) — 内容绝不二次渲染
 */
import { computed } from 'vue'
import { buildStreamText, isStreaming } from '@/app/composables/workshop/useEventBlocks'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

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

watch([full, () => props.block.settled], ([t, settled]) => {
  if (!t) {
    visible.value = 0
    return
  }
  if (settled || t.length - visible.value > 4000) {
    // 落定 / 大段历史:全速完成
    stopReveal()
    visible.value = t.length
    return
  }
  if (visible.value > t.length) visible.value = t.length
  if (visible.value < t.length) scheduleReveal()
}, { immediate: true })

onMounted(() => {
  if (props.block.settled) {
    visible.value = full.value.length
  }
  else {
    visible.value = Math.min(visible.value, full.value.length)
    scheduleReveal()
  }
})
onBeforeUnmount(stopReveal)

/** 打字光标:未落定或揭示未追平 */
const showCursor = computed(() => streaming.value || visible.value < full.value.length)
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
  >
    <pre class="stream-text">{{ full.slice(0, visible) }}<span
      v-if="showCursor"
      class="cursor"
    >▋</span></pre>
  </div>
  <div
    v-else
    class="stream-empty"
  >
    (空输出)
  </div>
</template>

<style scoped>
.stream-bubble {
  padding: 2px 0 6px 66px;
}
.stream-text {
  margin: 0;
  padding: 8px 12px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-left: 2px solid var(--accent-cobalt);
  border-radius: 2px;
}
.cursor {
  color: var(--accent-moss);
  animation: blink 0.9s step-end infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
.stream-covered {
  display: flex;
  gap: 6px;
  padding: 1px 0 1px 66px;
  align-items: center;
  font-size: 11px;
  opacity: 0.5;
  color: var(--ink-soft, inherit);
}
.stream-empty {
  padding: 2px 0 6px 66px;
  font-size: 11px;
  opacity: 0.4;
}
</style>
