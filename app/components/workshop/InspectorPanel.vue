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
/** 实体基线(WS 快照)是否已到达:未到时列表为空 ≠ 真的没有,展示同步提示 */
const synced = computed(() => entities.channels[props.channelId] !== undefined)

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
  return `成功率 ${rate}% / 均耗 ${avg}s / 失败 ${agg.failed}`
}
const childCount = (id: string): number => tasks.value.filter(t => t.parentId === id).length

const stateDot: Record<string, string> = {
  idle: 'var(--tone-success-dot)',
  busy: 'var(--tone-info-dot)',
  stopped: 'var(--tone-neutral-dot)',
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
          class="member aw-tile"
          role="button"
          tabindex="0"
          @click="emit('openAgent', a.agentId)"
          @keydown.enter="emit('openAgent', a.agentId)"
        >
          <span
            class="dot"
            :style="{ background: stateDot[a.state] ?? 'var(--tone-neutral-dot)' }"
          />
          <div class="member-info">
            <div class="member-name">
              <span class="name-text">{{ a.name }}</span>
              <span
                class="role-chip"
                :class="a.role"
              >{{ a.role }}</span>
            </div>
            <div class="member-meta">
              <template v-if="a.state === 'busy' && a.currentTaskTitle">
                {{ a.currentTaskTitle }}
                <span
                  v-if="a.currentTaskProgress != null"
                  class="prog"
                >{{ a.currentTaskProgress }}%</span>
              </template>
              <template v-else>
                {{ a.state }}
                <template v-if="a.queued">
                  · 队列 {{ a.queued }}
                </template>
                <template v-if="a.completed">
                  · 完成 {{ a.completed }}
                </template>
              </template>
            </div>
            <div class="member-cap">
              {{ capLine(a.agentId) }}
            </div>
          </div>
        </div>
        <div
          v-if="agents.length === 0"
          class="empty"
        >
          {{ synced ? '暂无成员' : '成员同步中…' }}
        </div>
      </a-tab-pane>

      <a-tab-pane
        key="tasks"
        tab="任务"
      >
        <div
          v-for="t in rootTasks"
          :key="t.id"
          class="task aw-tile"
          role="button"
          tabindex="0"
          @click="emit('openTask', t.id)"
          @keydown.enter="emit('openTask', t.id)"
        >
          <div class="task-head">
            <span class="state-chip aw-mono">{{ t.state }}</span>
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
          {{ synced ? '暂无任务' : '任务同步中…' }}
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
  gap: 9px;
  align-items: center;
  padding: 8px 10px;
  margin: 3px 0;
  cursor: pointer;
}
.member:hover { border-color: var(--line-strong); }
.dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
.member-info { flex: 1 1 auto; min-width: 0; }
.member-name {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 13px;
}
.name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 角色 chip:lead 墨色填充 / worker 发丝线(去 antd 彩色 tag,色锁) */
.role-chip {
  flex: 0 0 auto;
  padding: 0 7px;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  line-height: 16px;
  text-transform: uppercase;
  border-radius: var(--radius-pill);
}
.role-chip.lead { color: var(--on-accent); background: var(--accent); }
.role-chip.worker { color: var(--ink-soft); border: 1px solid var(--line-strong); }
.member-meta { font-size: 11px; font-family: var(--font-mono); color: var(--ink-faint); }
.prog { padding: 0 5px; color: var(--tone-info-dot); background: color-mix(in srgb, var(--tone-info-dot) 10%, transparent); border-radius: var(--radius-pill); }

.member-cap {
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--ink-faint);
}
.ct { opacity: 0.8; }
.task {
  padding: 8px 10px;
  margin: 3px 0;
  cursor: pointer;
}
.task:hover { border-color: var(--line-strong); }
.task-head { display: flex; gap: 6px; align-items: center; }
/* 状态 chip:等宽枚举 + 细边(不靠彩色 tag 堆叠,色锁;语义仍由文字传达) */
.state-chip {
  flex: none;
  padding: 1px 7px;
  font-size: 9.5px;
  line-height: 15px;
  letter-spacing: 0.04em;
  color: var(--ink-soft);
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.task-title {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-meta { font-size: 11px; font-family: var(--font-mono); color: var(--ink-faint); }
.empty { padding: 16px 8px; font-size: 12px; color: var(--ink-faint); }
</style>
