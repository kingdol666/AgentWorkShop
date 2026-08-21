<script setup lang="ts">
/**
 * 事件卡(密集行视图,单渲染单元)— 保留给 lanes 等紧凑列。
 * 注意:本卡不自去重;重复内容由调用侧 foldStreamDuplicates 先行摘除。
 */
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { TOOL_META } from '@/app/composables/workshop/useEventBlocks'
import type { AepEnvelope } from '@/shared/workshop-protocol'

const props = defineProps<{ event: AepEnvelope }>()

const entities = useEntitiesStore()
/** 名字/标题解析用的 channelId(信封恒携带) */
const cid = computed(() => props.event.channelId)

const time = computed(() => props.event.at.slice(11, 19))

/** agent 稳定配色(id hash → hue;lead 固定紫) */
const agentColor = computed(() => {
  const id = props.event.agentId ?? ''
  if (!id) return '#8c8c8c'
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h}, 65%, 55%)`
})

const agentLabel = computed(() => {
  const id = props.event.agentId
  if (!id) return 'system'
  return entities.agentName(cid.value, id)
})

const partsText = (parts: Array<{ text?: string }> | undefined): string =>
  (parts ?? []).map(p => p.text ?? '').join('\n').trim()

const msgText = computed(() => {
  if (props.event.type === 'agent.message') return partsText((props.event.payload as { parts?: Array<{ text?: string }> }).parts)
  if (props.event.type === 'a2a.message') return partsText((props.event.payload as { parts?: Array<{ text?: string }> }).parts)
  return ''
})

// ===== 工具调用行(agent.status.message 的 🔧 前缀;TOOL_META 见 useEventBlocks) =====

const toolCall = computed(() => {
  if (props.event.type !== 'agent.status.message') return null
  const text = String((props.event.payload as { text?: string }).text ?? '')
  const m = text.match(/^🔧\s*(\S+)/)
  if (!m) return null
  const name = m[1]!
  return { name, meta: TOOL_META[name] ?? { icon: '⚙', kind: 'native' as const } }
})

// ===== 消息路由行(a2a.message) =====

function routeKindOf(meta: Record<string, unknown>): { icon: string, label: string, tone: 'assign' | 'immediate' | 'peer' | 'notice' } {
  const priority = meta['x-aw-msg-priority'] === 'immediate' ? 'immediate' : 'task'
  const taskKind = typeof meta['x-aw-task-kind'] === 'string' ? meta['x-aw-task-kind'] as string : ''
  return taskKind === 'assign'
    ? { icon: 'i-tabler-send', label: '任务派发', tone: 'assign' }
    : taskKind === 'cancel'
      ? { icon: '🚫', label: '取消通知', tone: 'notice' }
      : taskKind === 'child-completed'
        ? { icon: 'i-tabler-circle-check', label: '子任务完成', tone: 'notice' }
        : priority === 'immediate'
          ? { icon: 'i-tabler-bolt', label: '实时注入', tone: 'immediate' }
          : { icon: 'i-tabler-message', label: '协作消息', tone: 'peer' }
}

const route = computed(() => {
  if (props.event.type !== 'a2a.message') return null
  const meta = (props.event.payload as { metadata?: Record<string, unknown> }).metadata ?? {}
  const fromId = typeof meta['x-aw-from-agent'] === 'string' ? meta['x-aw-from-agent'] as string : ''
  const toId = typeof meta['x-aw-target-agent'] === 'string' ? meta['x-aw-target-agent'] as string : ''
  return {
    kind: routeKindOf(meta),
    from: fromId ? entities.agentName(cid.value, fromId) : 'system',
    to: toId ? entities.agentName(cid.value, toId) : '(广播)',
  }
})

// ===== agent 生命周期行(agent.status) =====

const lifeState = computed(() => {
  if (props.event.type !== 'agent.status') return null
  const p = props.event.payload as { agentId: string, state: 'idle' | 'busy' | 'stopped', currentTaskId?: string | null, queued?: number, completed?: number }
  return {
    state: p.state,
    currentTitle: p.currentTaskId ? entities.taskTitle(cid.value, p.currentTaskId) : '',
    queued: p.queued ?? 0,
    completed: p.completed ?? 0,
  }
})

// ===== 任务行(task.status) =====

const taskLine = computed(() => {
  if (props.event.type !== 'task.status') return null
  const p = props.event.payload as { taskId: string, state: string, assigneeId?: string }
  return {
    state: p.state,
    title: entities.taskTitle(cid.value, p.taskId),
    assignee: p.assigneeId ? entities.agentName(cid.value, p.assigneeId) : '',
  }
})

// ===== 成员变更(agent.member) =====

const memberText = computed(() => {
  if (props.event.type !== 'agent.member') return ''
  const p = props.event.payload as {
    op: 'added' | 'updated' | 'removed'
    agentId: string
    name: string
    role: string
    harness: string
    enabled?: number
    by: string
    reason?: string
  }
  const who = p.by === 'user' ? '用户' : `lead ${entities.agentName(cid.value, p.by.replace(/^lead:/, ''))}`
  const member = `${p.name}(${p.role}/${p.harness})`
  const verbs: Record<typeof p.op, string> = {
    added: `新增成员 ${member}`,
    updated: p.enabled === 0 ? `禁用成员 ${member}` : `更新成员 ${member}`,
    removed: `移除成员 ${member}`,
  }
  const reason = p.reason ? `,理由:${p.reason}` : ''
  return `${who}${verbs[p.op]}${reason}`
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
  <div
    class="event-card"
    :data-type="event.type"
  >
    <span class="time">{{ time }}</span>
    <span
      class="agent-chip"
      :style="{ background: agentColor }"
    >{{ agentLabel }}</span>

    <!-- 工具调用(ZCode 风格:图标 + 工具名;harness 协作工具紫色标记) -->
    <div
      v-if="toolCall"
      class="body tool-line"
      :class="toolCall.meta.kind"
    >
      <span
        class="tool-icon"
        :class="toolCall.meta.icon"
      />
      <span class="tool-name">{{ toolCall.name }}</span>
      <span
        v-if="toolCall.meta.kind === 'host'"
        class="tool-kind"
      >harness</span>
    </div>

    <!-- agent 生命周期(idle/busy/stopped + 队列上下文) -->
    <div
      v-else-if="lifeState"
      class="body life-line"
      :data-state="lifeState.state"
    >
      <span class="life-dot" />
      <span class="life-state">{{ lifeState.state }}</span>
      <span
        v-if="lifeState.currentTitle"
        class="life-task"
      >「{{ lifeState.currentTitle.slice(0, 24) }}」</span>
      <span class="life-meta">队列 {{ lifeState.queued }} · 完成 {{ lifeState.completed }}</span>
    </div>

    <!-- 消息路由(from → to + 类型徽章) -->
    <div
      v-else-if="route"
      class="body route"
    >
      <span
        class="route-badge"
        :data-tone="route && route.kind ? route.kind.tone : 'peer'"
      >{{ route ? route.kind.label : '' }}</span>
      <span class="route-path">{{ route?.from }} → {{ route?.to }}</span>
      <span class="route-text">{{ msgText.slice(0, 100) }}{{ msgText.length > 100 ? '…' : '' }}</span>
    </div>

    <!-- LLM 流式增量(打字机气泡;store 已聚合连续 delta;落定去重见聚类器) -->
    <div
      v-else-if="event.type === 'agent.delta'"
      class="body bubble streaming"
    >
      <pre class="msg-text">{{ (event.payload as { delta: string }).delta }}<span class="cursor">▋</span></pre>
    </div>

    <!-- harness 消息气泡 -->
    <div
      v-else-if="event.type === 'agent.message'"
      class="body bubble"
    >
      <pre class="msg-text">{{ msgText }}</pre>
    </div>

    <!-- 中间状态文本(非工具标记) -->
    <div
      v-else-if="event.type === 'agent.status.message'"
      class="body status-line"
    >
      <span class="status-text">{{ (event.payload as { text: string }).text }}</span>
    </div>

    <!-- 任务状态迁移(标题 + assignee 名) -->
    <div
      v-else-if="taskLine"
      class="body task-line"
    >
      <a-tag
        :color="stateColor[taskLine.state] ?? 'default'"
        class="state-tag"
      >
        {{ taskLine.state }}
      </a-tag>
      <span class="task-title">{{ taskLine.title }}</span>
      <span
        v-if="taskLine.assignee"
        class="assignee"
      >→ {{ taskLine.assignee }}</span>
    </div>

    <!-- 任务进度 -->
    <div
      v-else-if="event.type === 'task.progress'"
      class="body task-line"
    >
      <a-progress
        :percent="(event.payload as { progress: number }).progress"
        size="small"
        class="progress"
        :show-info="true"
      />
    </div>

    <!-- artifact 交付物 -->
    <workshop-artifact-card
      v-else-if="event.type === 'a2a.artifact'"
      :artifact="(event.payload as { taskId?: string, artifact: { artifactId: string, name?: string, parts: Array<{ text?: string }> } }).artifact"
    />

    <!-- 团队成员增/改/删(lead 自主管理或用户 REST) -->
    <div
      v-else-if="event.type === 'agent.member'"
      class="body member-line"
    >
      <span class="tag i-tabler-user" />
      <span class="member-text">{{ memberText }}</span>
    </div>

    <!-- 记忆写入 -->
    <div
      v-else-if="event.type === 'memory.saved'"
      class="body memory-line"
    >
      <span class="tag">🧠</span>
      <span
        class="mem-scope"
        :data-scope="(event.payload as { scope: string }).scope"
      >{{ (event.payload as { scope: string }).scope }}</span>
      <span class="mem-text">{{ (event.payload as { title: string }).title }}</span>
    </div>

    <!-- 错误 -->
    <div
      v-else-if="event.type === 'error'"
      class="body error"
    >
      <span class="tag">✖</span>
      <span class="err-text">{{ (event.payload as { code: string, message: string }).code }}:{{ (event.payload as { code: string, message: string }).message }}</span>
    </div>

    <div
      v-else
      class="body status-line"
    >
      <span class="status-text">{{ event.type }}</span>
    </div>
  </div>
</template>

<style scoped>
.event-card {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 3px 10px;
  font-size: 12px;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  line-height: 1.55;
  border-bottom: 1px solid color-mix(in srgb, currentColor 6%, transparent);
  /* 轻量虚拟化:视口外卡片跳过渲染(万级事件压测关键) */
  content-visibility: auto;
  contain-intrinsic-size: auto 28px;
}
.time { flex: 0 0 auto; opacity: 0.45; }
.agent-chip {
  flex: 0 0 auto;
  max-width: 120px;
  overflow: hidden;
  padding: 0 5px;
  font-size: 10px;
  color: #fff;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 4px;
}
.body { flex: 1 1 auto; min-width: 0; }

/* 工具调用行:harness 协作工具紫标,原生作业工具中性 */
.tool-line {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 0 2px;
  opacity: 0.75;
}
.tool-line.host { opacity: 0.95; }
.tool-line.host .tool-name { color: #9254de; }
.tool-icon { flex: 0 0 auto; font-size: 11px; }
.tool-name { font-weight: 600; }
.tool-kind {
  flex: 0 0 auto;
  padding: 0 4px;
  font-size: 9px;
  color: #9254de;
  background: color-mix(in srgb, #9254de 15%, transparent);
  border-radius: 3px;
}

/* agent 生命周期行 */
.life-line {
  display: flex;
  gap: 6px;
  align-items: center;
  opacity: 0.55;
}
.life-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #8c8c8c;
}
.life-line[data-state='busy'] .life-dot { background: #1677ff; }
.life-line[data-state='busy'] { opacity: 0.8; }
.life-line[data-state='idle'] .life-dot { background: #52c41a; }
.life-state { font-weight: 600; }
.life-task { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.life-meta { flex: 0 0 auto; font-size: 10px; opacity: 0.7; }

/* 消息路由行 */
.route {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.route-badge {
  flex: 0 0 auto;
  padding: 0 5px;
  font-size: 10px;
  border-radius: 3px;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.route-badge[data-tone='assign'] { color: #1677ff; background: color-mix(in srgb, #1677ff 12%, transparent); }
.route-badge[data-tone='immediate'] { color: #fa8c16; background: color-mix(in srgb, #fa8c16 15%, transparent); }
.route-badge[data-tone='notice'] { color: #52c41a; background: color-mix(in srgb, #52c41a 12%, transparent); }
.route-path { flex: 0 0 auto; font-size: 11px; opacity: 0.7; }
.route-text { overflow: hidden; color: inherit; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }

.bubble {
  padding: 4px 8px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  border-left: 2px solid var(--color-primary);
  border-radius: 4px;
}
.bubble.streaming { border-left-color: #52c41a; }
.cursor {
  font-size: 11px;
  color: #52c41a;
  animation: blink 0.9s step-end infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
.msg-text {
  margin: 0;
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.memory-line,
.member-line { opacity: 0.85; }
.member-line { color: #9254de; }
.tag { margin-right: 4px; }
.mem-scope {
  flex: 0 0 auto;
  padding: 0 4px;
  font-size: 9px;
  border-radius: 3px;
}
.mem-scope[data-scope='shared'] { color: #9254de; background: color-mix(in srgb, #9254de 15%, transparent); }
.mem-scope[data-scope='private'] { color: #1677ff; background: color-mix(in srgb, #1677ff 12%, transparent); }
.member-text,
.route-text,
.mem-text,
.err-text { word-break: break-all; }
.status-line { opacity: 0.65; }
.task-line { display: flex; gap: 6px; align-items: center; }
.state-tag { margin-inline-end: 0; font-family: inherit; }
.task-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.assignee { flex: 0 0 auto; opacity: 0.7; }
.progress { max-width: 240px; margin: 0; }
.error { color: #ff7875; }
</style>
