<script setup lang="ts">
/**
 * 任务集群 — 同任务状态链(去重连续)+ 最新进度条 + assignee。
 * 状态链为 SUBMITTED → ASSIGNED → WORKING → WAITING → COMPLETED 等。
 */
import { computed } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

const entities = useEntitiesStore()
const cid = computed(() => props.block.events[0]?.channelId ?? '')

const states = computed(() => {
  const out: string[] = []
  for (const e of props.block.events) {
    if (e.type !== 'task.status') continue
    const s = String((e.payload as { state: string }).state)
    if (out[out.length - 1] !== s) out.push(s)
  }
  return out
})
const title = computed(() => {
  const ev = props.block.events.find(e => e.type === 'task.status' || e.type === 'task.progress')
  const tid = ev ? String((ev.payload as { taskId?: string }).taskId ?? '') : ''
  return entities.taskTitle(cid.value, tid)
})
const assignee = computed(() => {
  const ev = props.block.events.find(e => e.type === 'task.status' && (e.payload as { assigneeId?: string }).assigneeId)
  return ev ? entities.agentName(cid.value, (ev.payload as { assigneeId?: string }).assigneeId) : ''
})
const progress = computed(() => {
  let pct = 0
  for (const e of props.block.events) {
    if (e.type === 'task.progress') pct = Math.max(pct, (e.payload as { progress: number }).progress)
  }
  return pct
})
const hasProgress = computed(() => {
  let pct = -1
  for (const e of props.block.events) {
    if (e.type === 'task.progress') pct = Math.max(pct, (e.payload as { progress: number }).progress)
  }
  return pct >= 0
})
/** 状态 → koda tone(bg + dot) */
const STATE_TONE: Record<string, { bg: string, dot: string }> = {
  SUBMITTED: { bg: 'var(--tone-neutral-dot)', dot: 'var(--tone-neutral-dot)' },
  ASSIGNED: { bg: 'var(--tone-info-bg)', dot: 'var(--tone-info-dot)' },
  WORKING: { bg: 'var(--tone-info-bg)', dot: 'var(--tone-info-dot)' },
  WAITING: { bg: 'var(--tone-warning-bg)', dot: 'var(--tone-warning-dot)' },
  COMPLETED: { bg: 'var(--tone-success-bg)', dot: 'var(--tone-success-dot)' },
  FAILED: { bg: 'var(--tone-danger-bg)', dot: 'var(--tone-danger-dot)' },
  CANCELED: { bg: 'var(--tone-neutral-dot)', dot: 'var(--tone-neutral-dot)' },
}
const toneOf = (state: string) => STATE_TONE[state] ?? STATE_TONE.SUBMITTED!

/**
 * 状态人类语言(open-tag State Language 移植):状态不只靠颜色,chip 同时给出
 * 人类短语 + 等宽枚举代码(标识符可读可复制)。关键区分:"COMPLETED = 经 lead
 * 验收的完成"(completion gate)——executor 跑完只是 WORKING→终态迁移,不是完成。
 */
const STATE_LABEL: Record<string, string> = {
  SUBMITTED: '已提交',
  ASSIGNED: '已指派',
  WORKING: '执行中',
  WAITING: '等待合并',
  COMPLETED: '完成·经验收',
  FAILED: '失败·待改派',
  CANCELED: '已取消',
}
const labelOf = (state: string) => STATE_LABEL[state] ?? state
</script>

<template>
  <div class="task-cluster">
    <template
      v-for="(s, i) in states"
      :key="s"
    >
      <span
        v-if="i > 0"
        class="chain-arrow"
      >→</span>
      <span
        class="state-chip"
        :style="{ background: toneOf(s).bg }"
        :data-state="s"
        :title="`状态代码 ${s}`"
      >
        <span
          class="state-dot"
          :style="{ background: toneOf(s).dot }"
        />{{ labelOf(s) }}<span class="state-code">{{ s }}</span>
      </span>
    </template>
    <span class="task-title">{{ title }}</span>
    <span
      v-if="assignee"
      class="task-assignee"
    >→ {{ assignee }}</span>
    <a-progress
      v-if="hasProgress"
      :percent="progress"
      size="small"
      class="progress"
      :show-info="true"
    />
  </div>
</template>

<style scoped>
.task-cluster {
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
  padding: 2px 0 2px 20px;
  font-size: 12px;
}
.state-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 1px 7px;
  font-family: var(--font-body);
  font-size: 10px;
  color: var(--ink);
  border-radius: var(--radius-pill);
}
.state-chip .state-code {
  font-family: var(--font-mono);
  font-size: 8.5px;
  letter-spacing: 0.05em;
  opacity: 0.55;
}

.state-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}
.task-tag { margin: 0 !important; }
.chain-arrow { font-size: 10px; opacity: 0.4; }
.task-title { font-weight: 600; }
.task-assignee { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; opacity: 0.6; }
.progress { flex: 0 0 180px; margin: 0 !important; }
</style>
