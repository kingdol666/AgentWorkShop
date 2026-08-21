<script setup lang="ts">
/**
 * @提及悬停信息卡(open-tag agent-hovercard 移植):
 * 悬停时间线里的 .md-mention / .who-pill(均带 data-agent-id)→ 350ms 后浮出
 * 成员信息卡(头像/名字/角色/harness/状态/当前任务)。
 * 纯信息浮层:pointer-events:none,不挡点击(点击仍走打开抽屉)。
 * 文档级 mouseover/mouseout 委托 —— 时间线/lanes 全树生效,单实例挂载。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useEntitiesStore, type AgentView } from '@/app/stores/workshop/entities'

const entities = useEntitiesStore()

interface HoverState {
  x: number
  y: number
  agent: AgentView
  channelId: string
}

const card = ref<HoverState | null>(null)
let showTimer: ReturnType<typeof setTimeout> | null = null

const findAgent = (agentId: string): { agent: AgentView, channelId: string } | null => {
  for (const [cid, list] of Object.entries(entities.agents)) {
    const hit = list.find(a => a.agentId === agentId)
    if (hit) return { agent: hit, channelId: cid }
  }
  return null
}

const mentionEl = (ev: MouseEvent): HTMLElement | null =>
  (ev.target as HTMLElement).closest?.('.md-mention, .who-pill') ?? null

const onOver = (ev: MouseEvent): void => {
  const el = mentionEl(ev)
  if (!el) return
  const agentId = el.dataset.agentId
  if (!agentId) return
  if (showTimer) clearTimeout(showTimer)
  showTimer = setTimeout(() => {
    const hit = findAgent(agentId)
    if (!hit) return
    const x = Math.min(ev.clientX + 14, Math.max(window.innerWidth - 280, 8))
    const y = Math.min(ev.clientY + 16, Math.max(window.innerHeight - 170, 8))
    card.value = { x, y, ...hit }
  }, 350)
}

const onOut = (ev: MouseEvent): void => {
  if (!mentionEl(ev)) return
  if (showTimer) clearTimeout(showTimer)
  card.value = null
}

onMounted(() => {
  document.addEventListener('mouseover', onOver)
  document.addEventListener('mouseout', onOut)
})
onBeforeUnmount(() => {
  if (showTimer) clearTimeout(showTimer)
  document.removeEventListener('mouseover', onOver)
  document.removeEventListener('mouseout', onOut)
})

const stateDot = (s: AgentView['state']): string =>
  s === 'busy' ? 'hsl(46 66% 50%)' : 'var(--ink-fainter)'
</script>

<template>
  <teleport to="body">
    <div
      v-if="card"
      class="mh-card"
      :style="{ left: `${card.x}px`, top: `${card.y}px` }"
    >
      <span class="aw-avatar is-agent mh-ava">{{ card.agent.name.trim().charAt(0).toUpperCase() }}</span>
      <div class="mh-body">
        <div class="mh-name">
          <span
            class="mh-dot"
            :style="{ background: stateDot(card.agent.state) }"
          />
          {{ card.agent.name }}
        </div>
        <div class="mh-role">
          {{ card.agent.role }} / {{ card.agent.harness }} / {{ card.agent.state }}
        </div>
        <div
          v-if="card.agent.currentTaskId"
          class="mh-task"
        >
          执行:{{ entities.taskTitle(card.channelId, card.agent.currentTaskId) }}
        </div>
        <div class="mh-hint">
          点击提及打开执行详情
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.mh-ava {
  width: 34px;
  height: 34px;
  font-size: 14px;
}

.mh-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mh-name {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.mh-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.mh-role {
  font-size: 11.5px;
  color: var(--ink-faint);
}

.mh-task {
  overflow: hidden;
  font-size: 11.5px;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mh-hint {
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--ink-fainter);
}
</style>
