<script setup lang="ts">
/**
 * 右侧 Inspector:成员/任务/记忆 三 Tab。
 * 成员:实时状态 + 队列;点击 → 时间线聚焦该 agent(独立流)。
 * 任务:根任务列表 + 子任务计数 + 状态;点击 → 聚焦任务过滤。
 */
import { useEntitiesStore } from '../../stores/workshop/entities'
import { useEventsStore } from '../../stores/workshop/events'

const props = defineProps<{ channelId: string }>()
const entities = useEntitiesStore()
const events = useEventsStore()

const tab = ref<'members' | 'tasks' | 'memory'>('members')

const agents = computed(() => entities.agents[props.channelId] ?? [])
const tasks = computed(() => entities.tasks[props.channelId] ?? [])
const rootTasks = computed(() => tasks.value.filter(t => !t.parentId))
const childCount = (id: string): number => tasks.value.filter(t => t.parentId === id).length

const focusAgent = computed(() => events.focusAgents[props.channelId] ?? null)
const setFocus = (agentId: string | null): void => {
  events.setFocusAgent(props.channelId, agentId)
}

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
          :class="{ focused: focusAgent === a.agentId }"
          @click="setFocus(focusAgent === a.agentId ? null : a.agentId)"
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
          </div>
        </div>
        <div
          v-if="focusAgent"
          class="focus-tip"
          @click="setFocus(null)"
        >
          时间线聚焦中({{ focusAgent.slice(0, 8) }})· 点击取消
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
.member.focused { background: color-mix(in srgb, var(--color-primary) 18%, transparent); }
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
.ct { opacity: 0.8; }
.focus-tip {
  padding: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-primary);
  cursor: pointer;
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  border-radius: 6px;
}
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
