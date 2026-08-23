<script setup lang="ts">
/**
 * 实时代理活动条(open-tag LiveAgentBar 移植):
 * 固定在会话列表底部的"此刻谁在干活"工作台级脉搏条。
 *  - 汇聚 workspace 内全部挂载 channel 的 busy 成员,最活跃者主显(头像 + 脉冲点 + 任务标题),
 *    其余收进 +N 弹层;
 *  - 全部空闲时显示静默态(idle 一行);
 *  - 点击成员 → emit openAgent({channelId, agentId}),由控制台切到对应 channel 并打开 Agent 抽屉。
 * 数据源:entities store(WS agent.status 增量),无额外请求。
 */
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useEntitiesStore, type AgentView } from '@/app/stores/workshop/entities'
import { agentHueColor } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ wsId: string }>()
const emit = defineEmits<{ (e: 'openAgent', target: { channelId: string, agentId: string }): void }>()

const wsStore = useWorkspacesStore()
const entities = useEntitiesStore()

interface LiveAgent extends AgentView {
  channelId: string
  taskLabel: string
}

const workspace = computed(() => wsStore.workspaces.find(w => w.id === props.wsId))

/** live = busy 态成员(排队计数>0 也算轻度活跃,排后) */
const live = computed<LiveAgent[]>(() => {
  const out: LiveAgent[] = []
  for (const cid of workspace.value?.channelIds ?? []) {
    for (const a of entities.agents[cid] ?? []) {
      if (a.state !== 'busy') continue
      out.push({
        ...a,
        channelId: cid,
        taskLabel: a.currentTaskId
          ? entities.taskTitle(cid, a.currentTaskId)
          : (a.queued ? `队列 ×${a.queued}` : '执行中'),
      })
    }
  }
  return out
})

const popOpen = ref(false)

const initials = (name: string) => name.trim().charAt(0).toUpperCase()

const open = (a: LiveAgent) => {
  popOpen.value = false
  emit('openAgent', { channelId: a.channelId, agentId: a.agentId })
}
</script>

<template>
  <div class="live-bar">
    <!-- 静默态 -->
    <div
      v-if="live.length === 0"
      class="live-idle"
    >
      <span
        class="idle-dot"
        aria-hidden="true"
      />
      <span class="idle-text">全部成员空闲</span>
    </div>

    <!-- 主显:最活跃成员 + 脉冲点 -->
    <template v-else>
      <button
        type="button"
        class="live-main"
        :title="`查看 ${live[0]!.name} 的执行详情`"
        @click="open(live[0]!)"
      >
        <span class="live-ava">
          <span
            class="aw-avatar is-agent live-avatar"
            :style="{ '--av': agentHueColor(live[0]!.agentId) }"
          >{{ initials(live[0]!.name) }}</span>
          <span
            class="live-pip"
            aria-hidden="true"
          />
        </span>
        <span class="live-text">
          <span class="live-name">{{ live[0]!.name }}</span>
          <span class="live-detail">{{ live[0]!.taskLabel }}</span>
        </span>
      </button>
      <button
        v-if="live.length > 1"
        type="button"
        class="live-more"
        aria-haspopup="true"
        :aria-expanded="popOpen"
        :title="`${live.length - 1} 位成员同样在忙`"
        @click="popOpen = !popOpen"
      >
        +{{ live.length - 1 }}
      </button>

      <!-- +N 弹层:其余活跃成员 -->
      <template v-if="popOpen && live.length > 1">
        <div
          class="live-backdrop"
          @click="popOpen = false"
        />
        <div class="live-pop">
          <div class="live-pop-title">
            正在执行 · {{ live.length }}
          </div>
          <button
            v-for="a in live"
            :key="a.agentId"
            type="button"
            class="live-pop-item"
            @click="open(a)"
          >
            <span
              class="aw-avatar is-agent live-avatar-sm"
              :style="{ '--av': agentHueColor(a.agentId) }"
            >{{ initials(a.name) }}</span>
            <span class="live-pop-text">
              <span class="live-pop-name">{{ a.name }}</span>
              <span class="live-pop-detail">{{ a.taskLabel }}</span>
            </span>
            <span
              class="pop-dot"
              aria-hidden="true"
            />
          </button>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* 活动条:hairline 顶线 + 静谧 canvas(open-tag live-bar 声部) */
.live-bar {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
  align-items: center;
  min-height: 50px;
  padding: 7px 8px;
  background: var(--paper);
  border-top: 1px solid var(--line);
}

.live-idle {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-left: 6px;
}

.idle-dot {
  flex: none;
  width: 7px;
  height: 7px;
  background: var(--ink-fainter);
  border-radius: 50%;
}

.idle-text {
  overflow: hidden;
  font-size: 12px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-main {
  display: flex;
  flex: 1;
  gap: 9px;
  align-items: center;
  padding: 4px 6px;
  font-family: var(--font-body);
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition: background var(--transition-fast);
}

.live-main:hover {
  background: var(--paper-deep);
}

.live-ava {
  position: relative;
  flex: none;
  line-height: 0;
}

.live-avatar { width: 22px; height: 22px; font-size: 10px; }
.live-avatar-sm { width: 20px; height: 20px; font-size: 9.5px; }

/* 脉冲点:暖橙呼吸圈(执行中的活动信号) */
.live-pip {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 9px;
  height: 9px;
  background: var(--tone-live-dot);
  border: 1.5px solid var(--paper);
  border-radius: 50%;
}

.live-pip::after {
  content: "";
  position: absolute;
  inset: 0;
  background-color: inherit;
  border-radius: 50%;
  animation: lb-ping 1.9s cubic-bezier(0, 0, 0.2, 1) infinite;
}

.live-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.live-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-detail {
  overflow: hidden;
  font-size: 11px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-more {
  flex: none;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-faint);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.live-more:hover {
  color: var(--ink);
  background: var(--paper-deep);
}

.live-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.live-pop {
  position: absolute;
  right: 8px;
  bottom: calc(100% + 6px);
  left: 8px;
  z-index: 41;
  max-height: 280px;
  padding: 6px;
  overflow: auto;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-panel-sm);
  box-shadow: var(--shadow-float);
}

.live-pop-title {
  padding: 4px 8px 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-faint);
}

.live-pop-item {
  display: flex;
  gap: 9px;
  align-items: center;
  width: 100%;
  padding: 7px 8px;
  font-family: var(--font-body);
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
}

.live-pop-item:hover {
  background: var(--paper-deep);
}

.live-pop-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.live-pop-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-pop-detail {
  overflow: hidden;
  font-size: 11px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pop-dot {
  flex: none;
  width: 8px;
  height: 8px;
  background: var(--tone-live-dot);
  border-radius: 50%;
}

@keyframes lb-ping {
  0% { transform: scale(1); opacity: 0.55; }
  70%, 100% { transform: scale(2.4); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .live-pip::after { animation: none; opacity: 0; }
}
</style>
