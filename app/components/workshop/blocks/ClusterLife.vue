<script setup lang="ts">
/**
 * 生命周期块(合并后显示最新状态 + 过渡次数);
 * 当前任务以标题呈现(entities.taskTitle),无实体时回退短 ID。
 */
import { computed } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()
const entities = useEntitiesStore()

const life = computed(() => {
  const last = props.block.events[props.block.events.length - 1]
  if (!last || last.type !== 'agent.status') return null
  const p = last.payload as { state: string, currentTaskId?: string | null, queued?: number, completed?: number }
  return { state: p.state, currentTaskId: p.currentTaskId ?? null, queued: p.queued ?? 0, completed: p.completed ?? 0, transitions: props.block.events.length, channelId: last.channelId }
})

const currentTitle = computed(() => {
  const l = life.value
  if (!l?.currentTaskId) return ''
  const title = entities.taskTitle(l.channelId, l.currentTaskId)
  if (title && title !== l.currentTaskId) return title
  return l.currentTaskId.slice(0, 12)
})
</script>

<template>
  <div class="life-cluster">
    <span
      v-if="life"
      class="life-dot"
      :data-state="life.state"
    />
    <div
      v-if="life"
      class="life-row"
    >
      <span class="life-state">{{ life.state }}</span>
      <span
        v-if="currentTitle"
        class="life-task"
        :title="life.currentTaskId ?? ''"
      >「{{ currentTitle }}」</span>
      <span class="life-meta">队列 {{ life.queued }} · 完成 {{ life.completed }}</span>
      <span
        v-if="life.transitions > 1"
        class="life-count"
      >{{ life.transitions }} 次状态</span>
    </div>
    <span
      v-else
      class="life-row"
    >非状态事件</span>
  </div>
</template>

<style scoped>
.life-cluster {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 1px 0 1px 20px;
  font-family: var(--font-mono);
  font-size: 11px;
  opacity: 0.88;
}
.life-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong, #666); }
.life-dot[data-state='busy'] { background: var(--accent-cobalt, #1677ff); }
.life-dot[data-state='idle'] { background: var(--accent-moss, #52c41a); }
.life-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.life-state {
  font-weight: 500;
  text-transform: uppercase;
  font-size: 9.5px;
  letter-spacing: 0.1em;
}
.life-task { overflow: hidden; max-width: 280px; text-overflow: ellipsis; white-space: nowrap; }
.life-meta { font-size: 10px; opacity: 0.6; }
.life-count { font-size: 9.5px; opacity: 0.45; }
</style>
