<script setup lang="ts">
/**
 * 事件块头部行 — 名字 / 身份字幕 / 注意力小标 / 计数与时间 + 悬停工具条(复制全文/引用)。
 * 由 EventBlock.vue 拆出:标记、指令与 scoped 规则逐行搬运;派生状态取自 useEventBlockView。
 * 紧凑分组下 `v-show="!compact"` 保留 DOM(壳层的紧凑态悬停时间轴依赖行高不变)。
 */
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'
import { useEventBlockView } from '@/app/composables/workshop/useEventBlockView'

const props = defineProps<{
  block: EventBlock
  /** 连续同发送者紧凑分组(隐藏头像/名字,Slack 式) */
  compact?: boolean
}>()

const {
  humanLabel,
  agentLabel,
  roleLabel,
  tier,
  runningNow,
  meta,
  time,
  toolbarText,
  copied,
  copyAll,
  quoteToComposer,
} = useEventBlockView(() => props.block)
</script>

<template>
  <header
    v-show="!compact"
    class="block-head"
  >
    <span class="agent-name">{{ humanLabel ?? agentLabel }}</span>
    <span
      v-if="roleLabel"
      class="role-label"
    >{{ roleLabel }}</span>
    <span
      v-if="tier === 'attention'"
      class="tier-attention"
      :title="$t('eventBlock.kc918hn001')"
    ><span class="i-tabler-alert-circle" />{{ $t('eventBlock.k3wmcv4004') }}</span>
    <span class="head-right">
      <!-- 流式运行指示(open-tag msg-agent-state):当前 agent 正在产出 -->
      <span
        v-if="runningNow"
        class="running-chip"
      ><span class="running-dot" />{{ $t('eventBlock.k3vp67i005') }}</span>
      <span
        v-if="block.folded > 0"
        class="folded"
        :title="$t('eventBlock.kcugdph002')"
      >{{ $t('eventBlock.k3xk4t006') }} {{ block.folded }}</span>
      <span
        v-if="block.events.length > 1"
        class="merged"
      >×{{ block.events.length }}</span>
      <span class="kind-chip">{{ meta.label }}</span>
      <span class="time">{{ time }}</span>
    </span>
    <!-- 悬停工具条:复制全文 / 引用到输入框(open-tag msg-toolbar) -->
    <span
      v-if="toolbarText"
      class="eb-toolbar"
    >
      <button
        type="button"
        class="eb-tool"
        :title="copied ? $t('eventBlock.copied') : $t('eventBlock.copyAll')"
        @click="copyAll"
      >
        <span :class="copied ? 'i-tabler-check' : 'i-tabler-copy'" />
      </button>
      <button
        type="button"
        class="eb-tool"
        :title="$t('eventBlock.kknq700003')"
        @click="quoteToComposer"
      >
        <span class="i-tabler-quote" />
      </button>
    </span>
  </header>
</template>

<style scoped>
.block-head {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 20px;
  padding-bottom: 1px;
  font-family: var(--font-body);
}

.agent-name {
  overflow: hidden;
  max-width: 220px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 身份字幕(open-tag msg-role):lead/worker · harness,灰调不与之争关注 */
.role-label {
  overflow: hidden;
  font-family: var(--font-body);
  font-size: 10.5px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tier-attention {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  padding: 0 5px;
  font-size: 10px;
  color: var(--tone-warning-dot);
  background: color-mix(in srgb, var(--tone-warning-dot) 13%, transparent);
  border-radius: var(--radius-chip);
}

/* 类别小标:中性等宽纯文本(无边框/无彩色点 —— 类别是元语不是状态,
   彩色语义只留给 attention/error 边缘) */
.kind-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  line-height: 14px;
  color: var(--ink-faint);
}
.head-right {
  display: flex;
  flex: 1 1 auto;
  gap: 6px;
  align-items: center;
  justify-content: flex-end;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
}
.folded {
  padding: 0 4px;
  color: var(--ink-faint);
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-radius: var(--radius-chip);
}
.merged {
  padding: 0 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-radius: var(--radius-chip);
}
.time {
  flex: 0 0 auto;
  width: 60px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* 流式运行指示(open-tag msg-agent-state):暖橙呼吸点 + 词 */
.running-chip {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  color: var(--ink-faint);
}
.running-chip .running-dot {
  width: 6px;
  height: 6px;
  background: var(--tone-live-dot);
  border-radius: 50%;
  animation: av-breathe 1.9s ease-in-out infinite;
}
/* 有意重复:av-breathe 与头像状态 pip(EventBlockAvatar.vue)共用,scoped 编译会按组件
   重写 keyframes 名,跨组件引用会失效 —— 故两处各自逐字保留同一份定义 */
@keyframes av-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .running-chip .running-dot { animation: none; opacity: 0.9; }
}

/* 悬停工具条:头部右侧浮出(复制/引用) */
.eb-toolbar {
  position: absolute;
  top: -4px;
  right: 56px;
  z-index: 5;
  display: inline-flex;
  gap: 2px;
  padding: 1px;
  opacity: 0;
  pointer-events: none;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  transition: opacity var(--transition-fast);
}
.eb-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
  transition: color var(--transition-fast), background var(--transition-fast);
}
.eb-tool:hover {
  color: var(--ink);
  background: var(--paper-deep);
}
</style>
