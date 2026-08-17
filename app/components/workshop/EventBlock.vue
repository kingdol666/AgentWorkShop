<script setup lang="ts">
/**
 * 事件聚合块 — Codex/OpenHands 风格 turn block。
 * 同一 Agent 连续同类事件聚合为一个块:头部(时间 + agent 徽标 + 类别标签 + 合并数)
 * 只渲染一次,内部按行紧凑呈现;长序列(工具链/消息流)可折叠展开。
 * 同 Agent 的 delta 打字机与落定消息合并为同一气泡,不中断分割。
 */
import { computed, ref } from 'vue'
import { useEntitiesStore } from '../../stores/workshop/entities'
import {
  TOOL_META,
  agentHueColor,
  type BlockKind,
  type EventBlock,
} from '../../composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

const entities = useEntitiesStore()
const cid = computed(() => props.block.events[0]?.channelId ?? '')

const agentLabel = computed(() => {
  const id = props.block.agentId
  if (!id) return 'system'
  return entities.agentName(cid.value, id)
})

const time = computed(() => props.block.firstAt.slice(11, 19))

const KIND_LABEL: Record<BlockKind, string> = {
  tool: 'tool',
  status: 'status',
  life: 'state',
  route: 'message',
  stream: 'llm',
  task: 'task',
  artifact: 'artifact',
  member: 'team',
  memory: 'memory',
  error: 'error',
  other: 'event',
}

/** 长序列折叠 */
const expanded = ref(false)
const MAX_ROWS = 4
const count = computed(() => props.block.events.length)
const hasMore = computed(() => count.value > MAX_ROWS)
const visibleRows = computed(() => (expanded.value ? props.block.events : props.block.events.slice(0, MAX_ROWS)))

/** 工具行(agent.status.message 🔧) */
const toolLines = computed(() =>
  props.block.events.map((e) => {
    const text = String((e.payload as { text?: string }).text ?? '')
    const m = text.match(/^🔧\s*(\S+)/)
    const name = m?.[1] ?? 'tool'
    return { seq: e.seq, name, meta: TOOL_META[name] ?? { icon: 'i-tabler-tool', kind: 'native' as const } }
  }),
)

/** 中间状态文本行 */
const statusLines = computed(() =>
  props.block.events.map(e => String((e.payload as { text?: string }).text ?? '')),
)

/** 生命周期(取块内最新状态) */
const life = computed(() => {
  const last = props.block.events[props.block.events.length - 1]
  if (!last || last.type !== 'agent.status') return null
  const p = last.payload as { agentId: string, state: string, currentTaskId?: string | null, queued?: number, completed?: number }
  return {
    state: p.state,
    currentTitle: p.currentTaskId ? entities.taskTitle(cid.value, p.currentTaskId) : '',
    queued: p.queued ?? 0,
    completed: p.completed ?? 0,
    transitions: props.block.events.length,
  }
})

/** 消息路由行(a2a.message) */
const routeLines = computed(() =>
  props.block.events.map((e) => {
    const meta = (e.payload as { metadata?: Record<string, unknown> }).metadata ?? {}
    const fromId = typeof meta['x-aw-from-agent'] === 'string' ? meta['x-aw-from-agent'] as string : ''
    const toId = typeof meta['x-aw-target-agent'] === 'string' ? meta['x-aw-target-agent'] as string : ''
    const priority = meta['x-aw-msg-priority'] === 'immediate' ? 'immediate' : 'task'
    const taskKind = typeof meta['x-aw-task-kind'] === 'string' ? meta['x-aw-task-kind'] as string : ''
    const kind = taskKind === 'assign'
      ? { icon: 'i-tabler-send', label: '任务派发', tone: 'assign' as const }
      : taskKind === 'cancel'
        ? { icon: 'i-tabler-circle-x', label: '取消通知', tone: 'notice' as const }
        : taskKind === 'child-completed'
          ? { icon: 'i-tabler-circle-check', label: '子任务完成', tone: 'notice' as const }
          : priority === 'immediate'
            ? { icon: 'i-tabler-bolt', label: '实时注入', tone: 'immediate' as const }
            : { icon: 'i-tabler-message', label: '协作消息', tone: 'peer' as const }
    const parts = (e.payload as { parts?: Array<{ text?: string }> }).parts ?? []
    const text = parts.map(p => p.text ?? '').join('\n').trim()
    return {
      seq: e.seq,
      kind,
      from: fromId ? entities.agentName(cid.value, fromId) : 'system',
      to: toId ? entities.agentName(cid.value, toId) : '(广播)',
      text,
    }
  }),
)

/** LLM 流:delta 打字机 + message 落定文本合并,游标跟随最后一段 */
const streamText = computed(() => {
  const parts: string[] = []
  for (const e of props.block.events) {
    if (e.type === 'agent.delta') {
      const d = (e.payload as { delta: string }).delta
      if (d) parts.push(d)
    }
    else if (e.type === 'agent.message') {
      const t = ((e.payload as { parts?: Array<{ text?: string }> }).parts ?? []).map(p => p.text ?? '').join('\n').trim()
      if (t) parts.push(t)
    }
  }
  return parts.join('\n')
})
const streaming = computed(() => props.block.events[props.block.events.length - 1]?.type === 'agent.delta')

/** 任务块:状态链(去重连续)+ 最终进度 */
const taskStates = computed(() => {
  const states: string[] = []
  for (const e of props.block.events) {
    if (e.type !== 'task.status') continue
    const s = String((e.payload as { state: string }).state)
    if (states[states.length - 1] !== s) states.push(s)
  }
  return states
})
const taskTitle = computed(() => {
  const ev = props.block.events.find(e => e.type === 'task.status' || e.type === 'task.progress')
  const tid = ev ? String((ev.payload as { taskId?: string }).taskId ?? '') : ''
  return entities.taskTitle(cid.value, tid)
})
const taskAssignee = computed(() => {
  const ev = props.block.events.find(e => e.type === 'task.status' && (e.payload as { assigneeId?: string }).assigneeId)
  return ev ? entities.agentName(cid.value, (ev.payload as { assigneeId?: string }).assigneeId) : ''
})
const taskProgress = computed(() => {
  let pct = 0
  for (const e of props.block.events) {
    if (e.type === 'task.progress') pct = (e.payload as { progress: number }).progress
  }
  return pct
})
const hasProgress = computed(() => props.block.events.some(e => e.type === 'task.progress'))

const stateColor: Record<string, string> = {
  SUBMITTED: 'default',
  ASSIGNED: 'processing',
  WORKING: 'processing',
  WAITING: 'warning',
  COMPLETED: 'success',
  FAILED: 'error',
  CANCELED: 'default',
}

/** artifact 交付物 */
const artifacts = computed(() =>
  props.block.events
    .filter(e => e.type === 'a2a.artifact')
    .map(e => (e.payload as { taskId?: string, artifact: { artifactId: string, name?: string, parts: Array<{ text?: string }> } }).artifact),
)

/** 团队成员变更行 */
const memberLines = computed(() =>
  props.block.events.map((e) => {
    const p = e.payload as { op: 'added' | 'updated' | 'removed', name: string, role: string, harness: string, enabled?: number, by: string, reason?: string }
    const who = p.by === 'user' ? '用户' : `lead ${entities.agentName(cid.value, p.by.replace(/^lead:/, ''))}`
    const member = `${p.name}(${p.role}/${p.harness})`
    const verbs: Record<typeof p.op, string> = {
      added: `新增成员 ${member}`,
      updated: p.enabled === 0 ? `禁用成员 ${member}` : `更新成员 ${member}`,
      removed: `移除成员 ${member}`,
    }
    return { seq: e.seq, text: `${who}${verbs[p.op]}${p.reason ? `,理由:${p.reason}` : ''}` }
  }),
)

/** 记忆沉淀行 */
const memoryLines = computed(() =>
  props.block.events.map(e => ({
    seq: e.seq,
    scope: String((e.payload as { scope: string }).scope),
    title: String((e.payload as { title: string }).title),
  })),
)

/** 错误行 */
const errorLines = computed(() =>
  props.block.events.map(e => ({
    seq: e.seq,
    text: `${String((e.payload as { code: string }).code)}:${String((e.payload as { message: string }).message)}`,
  })),
)
</script>

<template>
  <div
    class="event-block"
    :data-kind="block.kind"
  >
    <!-- 块头部:时间 + agent 徽标 + 类别 + 合并粒度 -->
    <div class="block-head">
      <span class="time">{{ time }}</span>
      <span
        class="agent-chip"
        :style="{ background: agentHueColor(block.agentId) }"
      >{{ agentLabel }}</span>
      <span class="kind">{{ KIND_LABEL[block.kind] }}</span>
      <span
        v-if="count > 1"
        class="merged"
      >×{{ count }}</span>
      <button
        v-if="hasMore"
        class="expand-btn"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : `全部 ${count} 项` }}
      </button>
    </div>

    <!-- 工具链:同 agent 连续工具调用聚合,长链折叠 -->
    <div
      v-if="block.kind === 'tool'"
      class="tools"
    >
      <div
        v-for="t in (expanded ? toolLines : toolLines.slice(0, MAX_ROWS))"
        :key="t.seq"
        class="tool-line"
        :class="t.meta.kind"
      >
        <span
          class="tool-icon"
          :class="t.meta.icon"
        />
        <span class="tool-name">{{ t.name }}</span>
        <span
          v-if="t.meta.kind === 'host'"
          class="tool-kind"
        >harness</span>
      </div>
    </div>

    <!-- 中间状态文本 -->
    <div
      v-else-if="block.kind === 'status'"
      class="statuses"
    >
      <div
        v-for="(e, i) in visibleRows"
        :key="e.seq"
        class="status-line"
      >
        <span class="st-dot" />
        <span class="status-text">{{ statusLines[i] }}</span>
      </div>
    </div>

    <!-- 生命周期:合并后只显示最新状态 -->
    <div
      v-else-if="block.kind === 'life' && life"
      class="life-line"
      :data-state="life.state"
    >
      <span class="life-dot" />
      <span class="life-state">{{ life.state }}</span>
      <span
        v-if="life.currentTitle"
        class="life-task"
      >「{{ life.currentTitle.slice(0, 24) }}」</span>
      <span class="life-meta">Q{{ life.queued }} · ✓{{ life.completed }}</span>
      <span
        v-if="life.transitions > 1"
        class="life-count"
      >{{ life.transitions }} 次状态</span>
    </div>

    <!-- 消息路由:同 agent 连续投递聚合 -->
    <div
      v-else-if="block.kind === 'route'"
      class="routes"
    >
      <div
        v-for="r in routeLines.slice(0, expanded ? undefined : MAX_ROWS)"
        :key="r.seq"
        class="route-line"
      >
        <span
          class="route-badge"
          :data-tone="r.kind.tone"
        >
          <span :class="r.kind.icon" />
          {{ r.kind.label }}
        </span>
        <span class="route-path">{{ r.from }} → {{ r.to }}</span>
        <span class="route-text">{{ r.text.slice(0, 80) }}{{ r.text.length > 80 ? '…' : '' }}</span>
      </div>
    </div>

    <!-- LLM 输出气泡:delta + message 同源不割裂 -->
    <div
      v-else-if="block.kind === 'stream'"
      class="bubble"
    >
      <pre class="msg-text">{{ streamText }}<span
        v-if="streaming"
        class="cursor"
      >▋</span></pre>
    </div>

    <!-- 任务:状态链 + assignee + 进度 -->
    <div
      v-else-if="block.kind === 'task'"
      class="task-line"
    >
      <a-tag
        v-for="s in taskStates"
        :key="s"
        :color="stateColor[s] ?? 'default'"
        class="state-tag"
      >
        {{ s }}
      </a-tag>
      <span class="task-title">{{ taskTitle }}</span>
      <span
        v-if="taskAssignee"
        class="assignee"
      >→ {{ taskAssignee }}</span>
      <a-progress
        v-if="hasProgress"
        :percent="taskProgress"
        size="small"
        class="progress"
        :show-info="true"
      />
    </div>

    <!-- 交付物 -->
    <div
      v-else-if="block.kind === 'artifact'"
      class="artifacts"
    >
      <workshop-artifact-card
        v-for="(a, i) in artifacts"
        :key="i"
        :artifact="a"
      />
    </div>

    <!-- 团队成员变更 -->
    <div
      v-else-if="block.kind === 'member'"
      class="meta-lines"
    >
      <div
        v-for="m in memberLines.slice(0, expanded ? undefined : MAX_ROWS)"
        :key="m.seq"
        class="member-line"
      >
        <span class="tag i-tabler-users" />
        <span class="line-text">{{ m.text }}</span>
      </div>
    </div>

    <!-- 记忆沉淀 -->
    <div
      v-else-if="block.kind === 'memory'"
      class="meta-lines"
    >
      <div
        v-for="m in memoryLines.slice(0, expanded ? undefined : MAX_ROWS)"
        :key="m.seq"
        class="memory-line"
      >
        <span class="tag i-tabler-bookmark" />
        <span
          class="mem-scope"
          :data-scope="m.scope"
        >{{ m.scope }}</span>
        <span class="line-text">{{ m.title }}</span>
      </div>
    </div>

    <!-- 错误 -->
    <div
      v-else-if="block.kind === 'error'"
      class="meta-lines"
    >
      <div
        v-for="er in errorLines.slice(0, expanded ? undefined : MAX_ROWS)"
        :key="er.seq"
        class="error-line"
      >
        <span class="tag i-tabler-alert-triangle" />
        <span class="line-text">{{ er.text }}</span>
      </div>
    </div>

    <!-- 其它类型:原样展示类型名 -->
    <div
      v-else
      class="other-line"
    >
      <span
        v-for="e in visibleRows"
        :key="e.seq"
        class="other-type"
      >{{ e.type }}</span>
    </div>
  </div>
</template>

<style scoped>
.event-block {
  position: relative;
  padding: 5px 8px 5px 0;
  margin: 0 8px 2px 6px;
  border-left: 2px solid color-mix(in srgb, var(--ink) 9%, transparent);
  transition: border-color 0.15s ease, background 0.15s ease;
}

.event-block:hover {
  border-left-color: color-mix(in srgb, var(--accent-cobalt) 45%, transparent);
  background: color-mix(in srgb, var(--accent-cobalt) 2.5%, transparent);
}

/* ---- 头部 ---- */
.block-head {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 20px;
  padding-bottom: 1px;
}

.time {
  flex: 0 0 auto;
  width: 58px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-faint);
}

.agent-chip {
  flex: 0 0 auto;
  padding: 1px 7px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  color: #fff;
  border-radius: 2px;
  letter-spacing: 0.02em;
}

.kind {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-faint);
}

.merged {
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--accent-vermilion);
  border: 1px solid color-mix(in srgb, var(--accent-vermilion) 40%, transparent);
  border-radius: 2px;
}

.expand-btn {
  margin-left: auto;
  padding: 0 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--accent-cobalt);
  cursor: pointer;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--accent-cobalt) 35%, transparent);
  border-radius: 2px;
}

.expand-btn:hover {
  background: color-mix(in srgb, var(--accent-cobalt) 8%, transparent);
}

/* ---- 工具链 ---- */
.tool-line {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 1px 0 1px 66px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 19px;
}

.tool-icon {
  font-size: 12px;
  opacity: 0.75;
}

.tool-line.host .tool-icon {
  color: var(--accent-violet);
}

.tool-line.host .tool-name {
  color: var(--accent-violet);
}

.tool-kind {
  padding: 0 5px;
  font-size: 8.5px;
  letter-spacing: 0.1em;
  color: var(--accent-violet);
  background: color-mix(in srgb, var(--accent-violet) 14%, transparent);
  border-radius: 2px;
}

/* ---- 中间状态 ---- */
.status-line {
  display: flex;
  gap: 7px;
  align-items: baseline;
  padding: 1px 0 1px 66px;
  font-size: 12px;
  line-height: 19px;
  color: var(--ink-soft);
}

.st-dot {
  flex: 0 0 auto;
  width: 4px;
  height: 4px;
  background: var(--ink-faint);
  transform: translateY(-1px);
}

.status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 生命周期 ---- */
.life-line {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 1px 0 1px 66px;
  font-family: var(--font-mono);
  font-size: 11px;
  opacity: 0.85;
}

.life-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line-strong);
}

.life-line[data-state='busy'] .life-dot { background: var(--accent-cobalt); }
.life-line[data-state='idle'] .life-dot { background: var(--accent-moss); }
.life-line[data-state='stopped'] .life-dot { background: var(--line-strong); }

.life-state {
  font-weight: 500;
  text-transform: uppercase;
  font-size: 9.5px;
  letter-spacing: 0.1em;
}

.life-task {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
}

.life-meta {
  font-size: 10px;
  opacity: 0.6;
}

.life-count {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--ink-faint);
}

/* ---- 路由消息 ---- */
.route-line {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 1px 0 1px 66px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 19px;
}

.route-badge {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  flex: 0 0 auto;
  padding: 0 6px;
  font-size: 9.5px;
  border-radius: 2px;
}

.route-badge[data-tone='assign'] { color: var(--accent-cobalt); background: color-mix(in srgb, var(--accent-cobalt) 12%, transparent); }
.route-badge[data-tone='immediate'] { color: var(--accent-amber); background: color-mix(in srgb, var(--accent-amber) 15%, transparent); }
.route-badge[data-tone='notice'] { color: var(--accent-moss); background: color-mix(in srgb, var(--accent-moss) 12%, transparent); }
.route-badge[data-tone='peer'] { color: var(--accent-violet); background: color-mix(in srgb, var(--accent-violet) 14%, transparent); }

.route-path {
  flex: 0 0 auto;
  opacity: 0.6;
}

.route-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

/* ---- LLM 气泡 ---- */
.bubble {
  padding: 3px 0 3px 66px;
}

.msg-text {
  margin: 0;
  padding: 8px 12px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-left: 2px solid var(--accent-cobalt);
  border-radius: 2px;
}

.cursor {
  color: var(--accent-moss);
  animation: blink 0.9s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

/* ---- 任务 ---- */
.task-line {
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
  padding: 2px 0 2px 66px;
  font-size: 12px;
}

.state-tag {
  margin: 0 !important;
}

.task-title {
  font-weight: 600;
}

.assignee {
  font-family: var(--font-mono);
  font-size: 10.5px;
  opacity: 0.6;
}

.progress {
  flex: 0 0 180px;
  margin: 0 !important;
}

/* ---- 交付物 ---- */
.artifacts {
  padding: 2px 0 2px 66px;
}

.artifacts :deep(.artifact-card) {
  margin-top: 4px;
}

/* ---- 元信息行(成员/记忆/错误) ---- */
.meta-lines {
  padding: 1px 0 1px 66px;
}

.member-line,
.memory-line,
.error-line {
  display: flex;
  gap: 7px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 19px;
}

.tag {
  font-size: 12px;
  opacity: 0.65;
}

.mem-scope {
  padding: 0 5px;
  font-size: 8.5px;
  letter-spacing: 0.08em;
  border-radius: 2px;
}

.mem-scope[data-scope='shared'] { color: var(--accent-violet); background: color-mix(in srgb, var(--accent-violet) 14%, transparent); }
.mem-scope[data-scope='private'] { color: var(--accent-cobalt); background: color-mix(in srgb, var(--accent-cobalt) 12%, transparent); }

.error-line {
  color: var(--accent-vermilion);
}

.line-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 其它 ---- */
.other-line {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 1px 0 1px 66px;
}

.other-type {
  font-family: var(--font-mono);
  font-size: 10px;
  opacity: 0.5;
}
</style>
