<script setup lang="ts">
/**
 * 任务板看板视图(P1):按状态分列(待启动/执行中/等待汇总/已完成/异常)。
 * 任务卡:标题 + assignee + 进度 + 子任务数;点击 → Task 抽屉(emit)。
 */
import { useEntitiesStore } from '@/app/stores/workshop/entities'

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{ (e: 'openTask', taskId: string): void }>()

const entities = useEntitiesStore()
const tasks = computed(() => entities.tasks[props.channelId] ?? [])

const columns = computed(() => [
  { key: 'todo', title: '待启动', states: ['SUBMITTED', 'ASSIGNED'], color: 'var(--ink-faint)' },
  { key: 'doing', title: '执行中', states: ['WORKING'], color: 'var(--accent-cobalt)' },
  { key: 'waiting', title: '等待汇总', states: ['WAITING'], color: 'var(--accent-amber)' },
  { key: 'done', title: '已完成', states: ['COMPLETED'], color: 'var(--accent-moss)' },
  { key: 'bad', title: '异常/取消', states: ['FAILED', 'CANCELED'], color: 'var(--accent-vermilion)' },
].map(col => ({
  ...col,
  items: tasks.value.filter(t => col.states.includes(t.state)),
})))

const agentName = (id: string): string =>
  entities.agentById(props.channelId, id)?.name ?? id.slice(0, 6)
const childCount = (id: string): number =>
  tasks.value.filter(t => t.parentId === id).length
</script>

<template>
  <div class="board">
    <div
      v-for="col in columns"
      :key="col.key"
      class="col"
    >
      <div class="col-head">
        <span
          class="bar"
          :style="{ background: col.color }"
        />
        <span class="col-title">{{ col.title }}</span>
        <span class="col-count">{{ col.items.length }}</span>
      </div>
      <div class="col-body">
        <div
          v-for="t in col.items"
          :key="t.id"
          class="card"
          @click="emit('openTask', t.id)"
        >
          <div class="card-title">
            {{ t.title }}
          </div>
          <div class="card-meta">
            {{ t.id.slice(0, 8) }} · {{ agentName(t.assigneeId) }}
            <span v-if="childCount(t.id)">· 子 {{ childCount(t.id) }}</span>
            <span v-if="t.artifacts">· 📦{{ t.artifacts }}</span>
          </div>
          <a-progress
            v-if="t.state === 'WORKING' && t.progress > 0"
            :percent="t.progress"
            size="small"
            :show-info="false"
          />
        </div>
        <div
          v-if="col.items.length === 0"
          class="col-empty"
        >
          —
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.board {
  display: flex;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
  overflow-x: auto;
}
.col {
  display: flex;
  flex: 1 0 200px;
  flex-direction: column;
  min-width: 200px;
}
.col-head {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 4px 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  background: color-mix(in srgb, currentColor 6%, transparent);
  border-radius: 0;
}
.bar { width: 8px; height: 8px; border-radius: 1px; }
.col-count {
  margin-left: auto;
  font-family: var(--font-mono);
  opacity: 0.5;
}
.col-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 6px 0;
  overflow-y: auto;
}
.card {
  padding: 8px 10px;
  margin-bottom: 6px;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip, 8px);
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.card:hover {
  border-color: var(--accent-cobalt);
  transform: translate(-1px, -1px);
}
.card-title {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-meta {
  margin-top: 2px;
  font-size: 11px;
  font-family: var(--font-mono);
  opacity: 0.55;
}
.col-empty {
  padding: 8px;
  font-size: 12px;
  opacity: 0.25;
  text-align: center;
}
</style>
