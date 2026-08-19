<script setup lang="ts">
/**
 * 任务集群 — 同任务状态链(去重连续)+ 最新进度条 + assignee。
 * 状态链为 SUBMITTED → ASSIGNED → WORKING → WAITING → COMPLETED 等。
 */
import { computed } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

const entities = useEntitiesStore()
const cid = computed(() => props.block.events[0]?.channelId ?? '')

const states = computed(() => {
  const out: string[] = []
  for (const e of props.block.events) {
    if (e.type !== 'task.status') continue
    const s = String((e.payload as { state: string }).state)
    if (out[out.length - 1] !== s) out.push(s)
  }
  return out
})
const title = computed(() => {
  const ev = props.block.events.find(e => e.type === 'task.status' || e.type === 'task.progress')
  const tid = ev ? String((ev.payload as { taskId?: string }).taskId ?? '') : ''
  return entities.taskTitle(cid.value, tid)
})
const assignee = computed(() => {
  const ev = props.block.events.find(e => e.type === 'task.status' && (e.payload as { assigneeId?: string }).assigneeId)
  return ev ? entities.agentName(cid.value, (ev.payload as { assigneeId?: string }).assigneeId) : ''
})
const progress = computed(() => {
  let pct = 0
  for (const e of props.block.events) {
    if (e.type === 'task.progress') pct = Math.max(pct, (e.payload as { progress: number }).progress)
  }
  return pct
})
const hasProgress = computed(() => {
  let pct = -1
  for (const e of props.block.events) {
    if (e.type === 'task.progress') pct = Math.max(pct, (e.payload as { progress: number }).progress)
  }
  return pct >= 0
})
const stateColor: Record<string, string> = {
  SUBMITTED: 'default',
  ASSIGNED: 'processing',
  WORKING: 'processing',
  WAITING: 'warning',
  COMPLETED: 'success',
  FAILED: 'error',
  CANCELED: 'default',
}
</script>

<template>
  <div class="task-cluster">
    <a-tag
      v-for="s in states"
      :key="s"
      :color="stateColor[s] ?? 'default'"
      class="task-tag"
    >
      {{ s }}
    </a-tag>
    <span class="task-title">{{ title }}</span>
    <span
      v-if="assignee"
      class="task-assignee"
    >→ {{ assignee }}</span>
    <a-progress
      v-if="hasProgress"
      :percent="progress"
      size="small"
      class="progress"
      :show-info="true"
    />
  </div>
</template>

<style scoped>
.task-cluster {
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
  padding: 2px 0 2px 66px;
  font-size: 12px;
}
.task-tag { margin: 0 !important; }
.task-title { font-weight: 600; }
.task-assignee { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; opacity: 0.6; }
.progress { flex: 0 0 180px; margin: 0 !important; }
</style>
