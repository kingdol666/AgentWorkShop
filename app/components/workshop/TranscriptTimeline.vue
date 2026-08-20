<script setup lang="ts">
/**
 * Transcript 时间线:过滤条(全部/消息/任务/错误)+ cluster 块流 + 自动吸底。
 * 事件经 useClusteredBlocks 增量聚类(turn block,内容智能去重),
 * 流式更新只命中变化的块组件;新帧到达保持吸底。
 * 历史窗口:默认最近 200 帧(loadHistory);顶部"加载更早"按 beforeSeq 向上翻页。
 */
import { useEventsStore, type EventFilter } from '@/app/stores/workshop/events'
import { useClusteredBlocks } from '@/app/composables/workshop/useClusteredBlocks'

const props = defineProps<{ channelId: string }>()
const events = useEventsStore()
const scroller = ref<HTMLElement | null>(null)
const stickBottom = ref(true)

const filter = computed({
  get: () => events.filters[props.channelId] ?? 'all',
  set: (v: EventFilter) => events.setFilter(props.channelId, v),
})

const { blocks, totalEvents } = useClusteredBlocks(() => props.channelId)

// ===== 向上翻页历史 =====
const loadingEarlier = ref(false)
const earlierExhausted = ref(false)
/** 已加载事件数 vs 持久化总量 → 是否可能还有更早(粗判,点击时由 loadEarlier 探底) */
const loadedCount = computed(() => events.ring(props.channelId).items.length)
const maybeMore = computed(() => !earlierExhausted.value && loadedCount.value > 0)
const loadEarlier = async (): Promise<void> => {
  if (loadingEarlier.value || earlierExhausted.value) return
  loadingEarlier.value = true
  // 记住滚动位置:头部插入后保持视口锚定(不吸底跳变)
  const el = scroller.value
  const anchor = el ? { top: el.scrollTop, height: el.scrollHeight } : null
  try {
    const hasMore = await events.loadEarlier(props.channelId)
    if (!hasMore) earlierExhausted.value = true
    if (el && anchor) {
      await nextTick()
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top
    }
  }
  finally {
    loadingEarlier.value = false
  }
}

const onScroll = (): void => {
  const el = scroller.value
  if (!el) return
  stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

/** 吸底:新块出现 / seq 增长 / 块内容尺寸变化(可能高增)后滚到底 */
const scrollToBottom = async (): Promise<void> => {
  if (!stickBottom.value) return
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(() => blocks.value.length, () => {
  void scrollToBottom()
})
watch(() => events.lastSeq(props.channelId), () => {
  void scrollToBottom()
})

const filterOptions: Array<{ value: EventFilter, label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'messages', label: '消息' },
  { value: 'tasks', label: '任务' },
  { value: 'team', label: '团队' },
  { value: 'errors', label: '错误' },
]
</script>

<template>
  <div class="transcript">
    <div class="filter-bar">
      <a-segmented
        v-model:value="filter"
        size="small"
        :options="filterOptions"
      />
      <span class="count">{{ totalEvents }} 事件 / {{ blocks.length }} 块</span>
    </div>
    <div
      ref="scroller"
      class="scroller"
      @scroll="onScroll"
    >
      <div class="column">
        <button
          v-if="maybeMore"
          class="earlier-btn"
          :disabled="loadingEarlier"
          @click="loadEarlier"
        >
          {{ loadingEarlier ? '加载中…' : '加载更早的事件' }}
        </button>
        <div
          v-if="earlierExhausted && loadedCount > 0"
          class="earlier-done"
        >
          已加载全部历史(最早 1 条起)
        </div>
        <div
          v-if="blocks.length === 0"
          class="empty"
        >
          等待事件…(提交任务后此处实时渲染 Agent 执行过程)
        </div>
        <workshop-event-block
          v-for="b in blocks"
          :key="b.id"
          :block="b"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.transcript {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.filter-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent);
}
.count {
  font-size: 11px;
  font-family: var(--font-mono);
  opacity: 0.45;
}
.scroller {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
/* Codex 式阅读列:宽屏下内容居中,阅读行宽 ~900px;首载轻淡入 */
.column {
  max-width: 900px;
  padding: 10px 4px 24px;
  margin: 0 auto;
  animation: column-in 0.28s ease-out;
}
@keyframes column-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.earlier-btn {
  display: block;
  margin: 0 auto 10px;
  padding: 3px 14px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--accent-cobalt);
  cursor: pointer;
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--accent-cobalt) 40%, transparent);
  border-radius: 10px;
}
.earlier-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-cobalt) 8%, transparent);
}
.earlier-btn:disabled { opacity: 0.5; cursor: default; }
.earlier-done {
  margin-bottom: 8px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  text-align: center;
  opacity: 0.35;
}
.empty {
  padding: 40px 16px;
  font-size: 12px;
  text-align: center;
  opacity: 0.35;
}
</style>
