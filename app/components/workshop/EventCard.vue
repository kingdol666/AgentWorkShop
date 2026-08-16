<script setup lang="ts">
/**
 * AEP 事件卡(时间线渲染单元):按 type 分发为
 * 消息气泡(agent.message)/ 状态行(agent.status.message/agent.status)/
 * 任务行(task.status/task.progress)/ 消息投递(a2a.message)/ 记忆行(memory.saved)/ 错误卡。
 * Zcode 风格:紧凑行、等宽时间、agent 徽标着色(按 id 稳定取色)。
 */
import type { AepEnvelope } from '#shared/workshop-protocol'

const props = defineProps<{ event: AepEnvelope }>()

const time = computed(() => props.event.at.slice(11, 19))

/** agent 稳定配色(id hash → hue;lead 固定紫) */
const agentColor = computed(() => {
  const id = props.event.agentId ?? ''
  if (!id) return '#8c8c8c'
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h}, 65%, 55%)`
})

const agentLabel = computed(() => props.event.agentId?.slice(0, 8) ?? 'system')

const partsText = (parts: Array<{ text?: string }> | undefined): string =>
  (parts ?? []).map(p => p.text ?? '').join('\n').trim()

const msgText = computed(() => {
  if (props.event.type === 'agent.message') return partsText((props.event.payload as { parts?: Array<{ text?: string }> }).parts)
  if (props.event.type === 'a2a.message') return partsText((props.event.payload as { parts?: Array<{ text?: string }> }).parts)
  return ''
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

    <!-- harness 消息气泡 -->
    <div
      v-if="event.type === 'agent.message'"
      class="body bubble"
    >
      <pre class="msg-text">{{ msgText }}</pre>
    </div>

    <!-- channel 消息投递(assign/peer/inject) -->
    <div
      v-else-if="event.type === 'a2a.message'"
      class="body route"
    >
      <span class="tag">📨</span>
      <span class="route-text">{{ msgText.slice(0, 120) }}{{ msgText.length > 120 ? '…' : '' }}</span>
    </div>

    <!-- 工具/中间状态行 -->
    <div
      v-else-if="event.type === 'agent.status.message'"
      class="body status-line"
    >
      <span class="status-text">{{ (event.payload as { text: string }).text }}</span>
    </div>

    <!-- 任务状态迁移 -->
    <div
      v-else-if="event.type === 'task.status'"
      class="body task-line"
    >
      <a-tag
        :color="stateColor[(event.payload as { state: string }).state] ?? 'default'"
        class="state-tag"
      >
        {{ (event.payload as { state: string }).state }}
      </a-tag>
      <span class="task-id">{{ (event.payload as { taskId: string }).taskId.slice(0, 8) }}</span>
      <span
        v-if="(event.payload as { assigneeId?: string }).assigneeId"
        class="assignee"
      >→ {{ (event.payload as { assigneeId?: string }).assigneeId!.slice(0, 8) }}</span>
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

    <!-- 记忆写入 -->
    <div
      v-else-if="event.type === 'memory.saved'"
      class="body memory-line"
    >
      <span class="tag">🧠</span>
      <span class="mem-text">记忆沉淀[{{ (event.payload as { scope: string }).scope }}]:{{ (event.payload as { title: string }).title }}</span>
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
}
.time { flex: 0 0 auto; opacity: 0.45; }
.agent-chip {
  flex: 0 0 auto;
  padding: 0 5px;
  font-size: 10px;
  color: #fff;
  border-radius: 4px;
}
.body { flex: 1 1 auto; min-width: 0; }
.bubble {
  padding: 4px 8px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  border-left: 2px solid var(--color-primary);
  border-radius: 4px;
}
.msg-text {
  margin: 0;
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.route,
.memory-line { opacity: 0.8; }
.tag { margin-right: 4px; }
.route-text,
.mem-text,
.err-text { word-break: break-all; }
.status-line { opacity: 0.65; }
.task-line { display: flex; gap: 6px; align-items: center; }
.state-tag { margin-inline-end: 0; font-family: inherit; }
.task-id,
.assignee { opacity: 0.7; }
.progress { max-width: 240px; margin: 0; }
.error { color: #ff7875; }
</style>
