<script setup lang="ts">
/**
 * Agent lanes 视图(P1):每个 agent 一列并排流(相邻面板范式,2-4 agent 最佳)。
 * 列头:状态徽标 + 队列上下文;列内:该 agent 的事件卡片(独立滚动)。
 */
import { useEntitiesStore } from '../../stores/workshop/entities'
import { useEventsStore } from '../../stores/workshop/events'

const props = defineProps<{ channelId: string }>()
const entities = useEntitiesStore()
const events = useEventsStore()

const agents = computed(() => entities.agents[props.channelId] ?? [])

const laneEvents = (agentId: string) =>
  events.ring(props.channelId).items.filter(e => e.agentId === agentId)

const stateDot: Record<string, string> = {
  idle: '#52c41a',
  busy: '#1677ff',
  stopped: '#8c8c8c',
}
</script>

<template>
  <div class="lanes">
    <div
      v-if="agents.length === 0"
      class="empty"
    >
      等待成员快照…
    </div>
    <div
      v-for="a in agents"
      :key="a.agentId"
      class="lane"
    >
      <div class="lane-head">
        <span
          class="dot"
          :style="{ background: stateDot[a.state] ?? '#8c8c8c' }"
        />
        <span class="lane-name">{{ a.name }}</span>
        <a-tag
          :color="a.role === 'lead' ? 'purple' : 'blue'"
          class="role"
        >
          {{ a.role }}
        </a-tag>
        <span class="lane-meta">{{ a.state }} · Q{{ a.queued ?? 0 }}</span>
      </div>
      <div class="lane-body">
        <div
          v-if="laneEvents(a.agentId).length === 0"
          class="lane-empty"
        >
          暂无事件
        </div>
        <workshop-event-card
          v-for="e in laneEvents(a.agentId)"
          :key="`${e.seq}-${e.type}`"
          :event="e"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.lanes {
  display: flex;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
  overflow-x: auto;
}
.lane {
  display: flex;
  flex: 0 0 320px;
  flex-direction: column;
  min-width: 260px;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 8px;
}
.lane-head {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 10px;
  font-size: 13px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
.lane-name { font-weight: 700; }
.role { margin-inline-end: 0; font-size: 10px; line-height: 14px; }
.lane-meta {
  flex: 1 1 auto;
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  opacity: 0.5;
  text-align: right;
}
.lane-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.lane-empty,
.empty {
  padding: 20px 8px;
  font-size: 12px;
  opacity: 0.4;
  text-align: center;
}
</style>
