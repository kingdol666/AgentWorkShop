<script setup lang="ts">
/**
 * Transcript 时间线:过滤条(全部/消息/任务/错误)+ 事件流 + 自动吸底。
 * 事件按"同 agent + 同类连续"聚合为 turn block 渲染(Codex/OpenHands 风格),
 * 相同来源连续内容不断裂;虚拟滚动在 P2。
 */
import { useEventsStore, type EventFilter } from '../../stores/workshop/events'
import { aggregateEvents } from '../../composables/workshop/useEventBlocks'

const props = defineProps<{ channelId: string }>()
const events = useEventsStore()
const scroller = ref<HTMLElement | null>(null)
const stickBottom = ref(true)

const filter = computed({
  get: () => events.filters[props.channelId] ?? 'all',
  set: (v: EventFilter) => events.setFilter(props.channelId, v),
})

const timeline = computed(() => events.timeline(props.channelId))
/** 聚合块视图:过滤后事件 → turn blocks */
const blocks = computed(() => aggregateEvents(timeline.value))

const onScroll = (): void => {
  const el = scroller.value
  if (!el) return
  stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

watch(() => timeline.value.length, async () => {
  if (!stickBottom.value) return
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
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
      <span class="count">{{ timeline.length }} 事件 / {{ blocks.length }} 块</span>
    </div>
    <div
      ref="scroller"
      class="scroller"
      @scroll="onScroll"
    >
      <div
        v-if="timeline.length === 0"
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
.empty {
  padding: 40px 16px;
  font-size: 12px;
  text-align: center;
  opacity: 0.35;
}
</style>
