<script setup lang="ts">
/**
 * 事件块头像列 — 26px 头像章(agent 首字母 / human 用户章 / system cpu 图标)+ 状态 pip。
 * 由 EventBlock.vue 拆出:标记与 scoped 规则逐行搬运;派生状态取自 useEventBlockView。
 * 紧凑态隐藏规则(`.event-block.compact .agent-avatar`)住在壳层 —— 状态属于块,不属于头像。
 */
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'
import { useEventBlockView } from '@/app/composables/workshop/useEventBlockView'

const props = defineProps<{ block: EventBlock }>()

const { humanLabel, agentLabel, roleLabel, agentInitial, avColor, agentState, onAvatarClick }
  = useEventBlockView(() => props.block)
</script>

<template>
  <button
    type="button"
    class="agent-avatar"
    :class="{ 'is-agent': !!block.agentId, 'is-human': !!humanLabel, 'clickable': !!block.agentId }"
    :title="humanLabel ?? `${agentLabel}${roleLabel ? ` · ${roleLabel}` : ''}`"
    :style="avColor ? { '--av': avColor } : undefined"
    @click="onAvatarClick"
  >
    <span
      v-if="humanLabel"
      class="i-tabler-user system-icon"
    />
    <span
      v-else-if="!block.agentId"
      class="i-tabler-cpu system-icon"
    />
    <template v-else>
      {{ agentInitial }}
    </template>
    <!-- 状态 pip:busy 呼吸圈 / idle 静点(open-tag av-status) -->
    <span
      v-if="block.agentId && agentState"
      class="av-status"
      :class="agentState"
      :title="agentState === 'busy' ? $t('eventBlock.stBusy') : agentState === 'stopped' ? $t('eventBlock.stStopped') : $t('eventBlock.stIdle')"
    />
  </button>
</template>

<style scoped>
/* 头像列:agent = 身份色(agentId 哈希 → --av,同源色相,白字首字母);
   human/system = surface(open-tag av 尺寸档 36/28) */
.agent-avatar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  min-width: 30px;
  margin-top: 0;
  padding: 0;
  font-family: var(--font-body);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  background: var(--paper-deep);
  border: 0;
  border-radius: 50%;
}
.agent-avatar.clickable {
  cursor: pointer;
  transition: transform var(--transition-fast) var(--im-spring), box-shadow var(--transition-fast);
}
.agent-avatar.clickable:hover {
  transform: scale(1.06);
  box-shadow: 0 0 0 var(--radius-chip) transparent, 0 3px 10px rgb(12 10 9 / 16%);
}
.agent-avatar.is-agent {
  color: var(--on-av);
  background: var(--av, var(--av-fallback));
}
.agent-avatar.is-human {
  color: var(--ink-soft);
  background: var(--paper-deep);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.agent-avatar .system-icon {
  font-size: 15px;
  line-height: 1;
}

/* 状态 pip:头像右下 8px 叠层(open-tag av-status);busy 呼吸,stopped 灰,idle 淡 */
.av-status {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  background: var(--ink-fainter);
  border: 1.5px solid var(--paper-raised);
  border-radius: 50%;
}
.av-status.busy {
  background: var(--tone-live-dot);
  animation: av-breathe 1.9s ease-in-out infinite;
}
.av-status.stopped { background: var(--tone-danger-dot); }
/* 有意重复:av-breathe 与头部运行点(EventBlockHead.vue)共用,scoped 编译会按组件重写
   keyframes 名,跨组件引用会失效 —— 故两处各自逐字保留同一份定义 */
@keyframes av-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .av-status.busy { animation: none; opacity: 0.9; }
}
</style>
