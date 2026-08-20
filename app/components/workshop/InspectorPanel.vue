<script setup lang="ts">
/**
 * 右侧 Inspector:成员/任务/记忆 三 Tab。
 * 成员:实时状态 + 队列;点击 → 打开 Agent 抽屉(独立流/队列/记忆)。
 * 任务:根任务列表;点击 → 打开 Task 抽屉(状态时间线/交付物/取消)。
 */
import { useEntitiesStore } from '@/app/stores/workshop/entities'

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{
  (e: 'openAgent' | 'openTask', id: string): void
}>()
const entities = useEntitiesStore()

const tab = ref<'members' | 'tasks' | 'memory' | 'stats'>('members')

const agents = computed(() => entities.agents[props.channelId] ?? [])
const tasks = computed(() => entities.tasks[props.channelId] ?? [])
const rootTasks = computed(() => tasks.value.filter(t => !t.parentId))

// 成员能力画像(koda 运营信号):按任务历史算成功率/均耗时
const capability = computed(() => {
  const map = new Map<string, { total: number, completed: number, failed: number, durationSum: number }>()
  for (const t of tasks.value) {
    if (t.state !== 'COMPLETED' && t.state !== 'FAILED') continue
    const agg = map.get(t.assigneeId) ?? { total: 0, completed: 0, failed: 0, durationSum: 0 }
    agg.total += 1
    if (t.state === 'COMPLETED') {
      agg.completed += 1
      if (t.updatedAt && t.createdAt) {
        agg.durationSum += Math.max(0, new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime())
      }
    }
    else {
      agg.failed += 1
    }
    map.set(t.assigneeId, agg)
  }
  return map
})
const capLine = (agentId: string): string => {
  const agg = capability.value.get(agentId)
  if (!agg || agg.total === 0) return '暂无历史'
  const rate = Math.round((agg.completed / agg.total) * 100)
  const avg = agg.completed > 0 ? Math.round(agg.durationSum / agg.completed / 1000) : 0
  return `成功率 ${rate}% · 均耗 ${avg}s · 失败 ${agg.failed}`
}
const childCount = (id: string): number => tasks.value.filter(t => t.parentId === id).length

const stateDot: Record<string, string> = {
  idle: '#52c41a',
  busy: '#1677ff',
  stopped: '#8c8c8c',
}
const taskStateColor: Record<string, string> = {
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
  <div class="inspector">
    <a-tabs
      v-model:active-key="tab"
      size="small"
      class="tabs"
    >
      <a-tab-pane
        key="members"
        tab="成员"
      >
        <div
          v-for="a in agents"
          :key="a.agentId"
          class="member"
          @click="emit('openAgent', a.agentId)"
        >
          <span
            class="dot"
            :style="{ background: stateDot[a.state] ?? '#8c8c8c' }"
          />
          <div class="member-info">
            <div class="member-name">
              {{ a.name }}
              <a-tag
                :color="a.role === 'lead' ? 'purple' : 'blue'"
                class="role"
              >
                {{ a.role }}
              </a-tag>
            </div>
            <div class="member-meta">
              {{ a.state }} · 队列{{ a.queued ?? 0 }} · 完成{{ a.completed ?? 0 }}
              <span
                v-if="a.currentTaskId"
                class="ct"
              >· 执行 {{ a.currentTaskId.slice(0, 6) }}</span>
            </div>
            <div class="member-cap">
              {{ capLine(a.agentId) }}
            </div>
          </div>
        </div>
      </a-tab-pane>

      <a-tab-pane
        key="tasks"
        tab="任务"
      >
        <div
          v-for="t in rootTasks"
          :key="t.id"
          class="task"
          @click="emit('openTask', t.id)"
        >
          <div class="task-head">
            <a-tag
              :color="taskStateColor[t.state] ?? 'default'"
              class="state"
            >
              {{ t.state }}
            </a-tag>
            <span class="task-title">{{ t.title }}</span>
          </div>
          <div class="task-meta">
            {{ t.id.slice(0, 8) }} · {{ t.progress }}%
            <span v-if="childCount(t.id)">· 子任务 {{ childCount(t.id) }}</span>
            <span v-if="t.artifacts">· 交付 {{ t.artifacts }}</span>
          </div>
          <a-progress
            v-if="t.state === 'WORKING'"
            :percent="t.progress"
            size="small"
            :show-info="false"
          />
        </div>
        <div
          v-if="rootTasks.length === 0"
          class="empty"
        >
          暂无任务
        </div>
      </a-tab-pane>

      <a-tab-pane
        key="memory"
        tab="记忆"
      >
        <workshop-memory-panel :channel-id="channelId" />
      </a-tab-pane>

      <a-tab-pane
        key="stats"
        tab="统计"
      >
        <workshop-stats-panel :channel-id="channelId" />
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<style scoped>
.inspector {
  height: 100%;
  padding: 0 8px;
  overflow-y: auto;
}
.tabs { height: 100%; }
.tabs :deep(.ant-tabs-content-holder) {
  overflow-y: auto;
}
.tabs :deep(.ant-tabs-nav) {
  margin-bottom: 8px;
}
.member {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  margin: 2px 0;
  cursor: pointer;
  border-radius: 6px;
}
.member:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
.member-info { flex: 1 1 auto; min-width: 0; }
.member-name {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}
.role { margin-inline-start: 0; font-size: 10px; line-height: 14px; }
.member-meta { font-size: 11px; font-family: ui-monospace, Consolas, monospace; opacity: 0.55; }

.member-cap {
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--ink-faint);
}
.ct { opacity: 0.8; }
.task { padding: 6px 8px; margin: 2px 0; border-radius: 6px; }
.task:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.task-head { display: flex; gap: 6px; align-items: center; }
.state { margin-inline-end: 0; font-size: 10px; }
.task-title {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-meta { font-size: 11px; font-family: ui-monospace, Consolas, monospace; opacity: 0.55; }
.empty { padding: 16px 8px; font-size: 12px; opacity: 0.4; }
</style>
