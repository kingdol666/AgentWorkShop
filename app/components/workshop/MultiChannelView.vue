<script setup lang="ts">
/**
 * 多 channel 同屏视图(P2):workspace 挂载的全部 channel 并排 mini 时间线。
 * 单条 WS 连接多路 sub 的 UI 呈现面;每列独立事件流 + 状态头(seq/事件数/活跃任务)。
 */
import { useStorage } from '@vueuse/core'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useEventsStore } from '@/app/stores/workshop/events'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'

const { t } = useI18n()

const props = defineProps<{ wsId: string }>()
const emit = defineEmits<{ (e: 'openTask', taskId: string): void }>()

// 每列宽度拖拽调节(PaneSplitter;按 channelId 持久化,双击复位默认宽)
const COL_W_DEFAULT = 360
const colWidths = useStorage<Record<string, number>>('aw.harness.mcColW', {})
const colWidth = (id: string): number => colWidths.value[id] ?? COL_W_DEFAULT
const resizeCol = (id: string, d: number): void => {
  colWidths.value = { ...colWidths.value, [id]: Math.min(760, Math.max(300, colWidth(id) + d)) }
}
const resetCol = (id: string): void => {
  const next = { ...colWidths.value }
  Reflect.deleteProperty(next, id)
  colWidths.value = next
}

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
      /** 实体基线(WS 快照)是否已到达:未到时计数不可信 */
      synced: entities.channels[id] !== undefined,
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
    case 'a2a.message': return `文本 ${String((p.parts as Array<{ text?: string }> | undefined)?.[0]?.text ?? '').slice(0, 40)}`
    case 'a2a.artifact': return `交付 ${String((p.artifact as { name?: string } | undefined)?.name ?? '')}`
    case 'memory.saved': return t('multiChannelView.kfvue7n009', { p0: String(p.title ?? '') })
    case 'agent.member': return t('multiChannelView.khq39oe010', { p0: String(p.op ?? ''), p1: String(p.name ?? '') })
    case 'agent.status': return `${String(p.state)}`
    case 'error': return t('multiChannelView.k16wopr9011', { p0: String(p.code ?? '') })
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
      {{ $t('multiChannelView.k1bfi9ms001') }}
    </div>
    <template
      v-for="col in columns"
      :key="col.id"
    >
      <div
        class="col"
        :style="{ flexBasis: `${colWidth(col.id)}px` }"
      >
        <div class="col-head">
          <span class="col-name">{{ col.name }}</span>
          <span class="col-meta">
            <template v-if="col.synced">{{ col.agents }}a / {{ $t('multiChannelView.k4by6003') }}{{ col.busy }} / {{ $t('multiChannelView.k3wcox005') }}{{ col.activeTasks }} / seq{{ col.seq }}</template>
            <template v-else>{{ $t('multiChannelView.k1bst7s9002') }}</template>
          </span>
        </div>
        <div class="col-body">
          <div
            v-if="col.items.length === 0"
            class="col-empty"
          >
            {{ col.synced ? $t('multiChannelView.k1el0s5k004') : $t('multiChannelView.k1bst7s9002') }}
          </div>
          <div
            v-for="e in col.items"
            :key="`${col.id}-${e.seq}`"
            class="mini-event"
            :class="{ clickable: e.type === 'task.status' }"
            @click="e.type === 'task.status' && emit('openTask', (e.payload as { taskId: string }).taskId)"
          >
            <span class="me-time">{{ formatLocalClock(e.at) }}</span>
            <span class="me-agent">{{ e.agentId?.slice(0, 4) ?? 'sys' }}</span>
            <span class="me-text">{{ summaryOf(e) }}</span>
          </div>
        </div>
      </div>
      <!-- 每列右侧都挂分隔条(含最右列):分隔条统一调节"其左侧列"的宽度,
           尾条即最右列的右缘调节柄 —— 最右列也能拖拽拉宽/收窄 -->
      <workshop-pane-splitter
        :label="$t('multiChannelView.kvfx0mh006', { p0: col.name })"
        @resize="d => resizeCol(col.id, d)"
        @reset="resetCol(col.id)"
      />
    </template>
  </div>
</template>

<style scoped>
.split {
  overscroll-behavior: contain;
  display: flex;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
  overflow-x: auto;
}
.col {
  display: flex;
  flex: 0 0 auto; /* 宽度由拖拽分隔条驱动(inline flexBasis) */
  flex-direction: column;
  min-width: 300px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
}
.col-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}
.col-name { font-size: 13px; font-weight: 700; }
.col-meta {
  flex: 1 1 auto;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--ink-faint);
  text-align: right;
}
.col-body {
  overscroll-behavior: contain;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 11px;
}
.mini-event {
  display: flex;
  gap: 6px;
  padding: 2px 8px;
  line-height: 1.6;
}
.mini-event.clickable { cursor: pointer; }
.mini-event.clickable:hover { background: var(--hover-tint); }
.me-time { flex: 0 0 auto; color: var(--ink-fainter); }
.me-agent { flex: 0 0 auto; color: var(--ink-faint); }
.me-text {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-empty,
.empty {
  padding: 24px 8px;
  font-size: 12px;
  color: var(--ink-faint);
  text-align: center;
}
</style>
