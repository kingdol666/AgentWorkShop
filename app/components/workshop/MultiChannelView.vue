<script setup lang="ts">
/**
 * 多 channel 同屏视图(P2):workspace 挂载的全部 channel 并排 mini 时间线。
 * 单条 WS 连接多路 sub 的 UI 呈现面;每列独立事件流 + 状态头(seq/事件数/活跃任务)。
 */
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useEventsStore } from '@/app/stores/workshop/events'

const props = defineProps<{ wsId: string }>()
const emit = defineEmits<{ (e: 'openTask', taskId: string): void }>()

const wsStore = useWorkspacesStore()
const entities = useEntitiesStore()
const events = useEventsStore()

const columns = computed(() =>
  (wsStore.workspaces.find(w => w.id === props.wsId)?.channelIds ?? []).map((id) => {
    const agents = entities.agents[id] ?? []
    const tasks = entities.tasks[id] ?? []
    return {
      id,
      name: entities.channels[id]?.name ?? id.slice(0, 8),
      busy: agents.filter(a => a.state === 'busy').length,
      agents: agents.length,
      activeTasks: tasks.filter(t => !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state)).length,
      seq: events.lastSeq(id),
      items: events.ring(id).items.slice(-120), // 每列最近 120 帧(轻量)
    }
  }))

/** 迷你事件行:单行摘要(时间 + 类型图标 + 主体) */
const summaryOf = (e: { type: string, at: string, agentId?: string, payload: unknown }): string => {
  const p = e.payload as Record<string, unknown>
  switch (e.type) {
    case 'task.status': return `${String(p.state)} ${String(p.taskId ?? '').slice(0, 6)}`
    case 'task.progress': return `${String(p.progress ?? '')}%`
    case 'agent.delta': return `…${String(p.delta ?? '').slice(-24)}`
    case 'agent.message': return `${String((p.parts as Array<{ text?: string }> | undefined)?.[0]?.text ?? '').slice(0, 40)}`
    case 'a2a.message': return `📨 ${String((p.parts as Array<{ text?: string }> | undefined)?.[0]?.text ?? '').slice(0, 30)}`
    case 'a2a.artifact': return `📦 ${String((p.artifact as { name?: string } | undefined)?.name ?? '')}`
    case 'memory.saved': return `🧠 ${String(p.title ?? '')}`
    case 'agent.member': return `👤 ${String(p.op ?? '')} ${String(p.name ?? '')}`
    case 'agent.status': return `${String(p.state)}`
    case 'error': return `✖ ${String(p.code ?? '')}`
    default: return e.type
  }
}
</script>

<template>
  <div class="split">
    <div
      v-if="columns.length === 0"
      class="empty"
    >
      左侧挂载多个 Channel 后在此同屏观察
    </div>
    <div
      v-for="col in columns"
      :key="col.id"
      class="col"
    >
      <div class="col-head">
        <span class="col-name">{{ col.name }}</span>
        <span class="col-meta">{{ col.agents }}a · {{ col.busy }}忙 · {{ col.activeTasks }}任务 · seq{{ col.seq }}</span>
      </div>
      <div class="col-body">
        <div
          v-if="col.items.length === 0"
          class="col-empty"
        >
          等待事件…
        </div>
        <div
          v-for="e in col.items"
          :key="`${col.id}-${e.seq}`"
          class="mini-event"
          :class="{ clickable: e.type === 'task.status' || e.type === 'a2a.artifact' }"
          @click="e.type === 'task.status' && emit('openTask', (e.payload as { taskId: string }).taskId)"
        >
          <span class="me-time">{{ e.at.slice(11, 19) }}</span>
          <span class="me-agent">{{ e.agentId?.slice(0, 4) ?? 'sys' }}</span>
          <span class="me-text">{{ summaryOf(e) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.split {
  display: flex;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
  overflow-x: auto;
}
.col {
  display: flex;
  flex: 0 0 360px;
  flex-direction: column;
  min-width: 300px;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 8px;
}
.col-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.col-name { font-size: 13px; font-weight: 700; }
.col-meta {
  flex: 1 1 auto;
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  opacity: 0.5;
  text-align: right;
}
.col-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
}
.mini-event {
  display: flex;
  gap: 6px;
  padding: 2px 8px;
  line-height: 1.6;
}
.mini-event.clickable { cursor: pointer; }
.mini-event.clickable:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.me-time { flex: 0 0 auto; opacity: 0.4; }
.me-agent { flex: 0 0 auto; opacity: 0.6; }
.me-text {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-empty,
.empty {
  padding: 20px 8px;
  font-size: 12px;
  opacity: 0.4;
  text-align: center;
}
</style>
