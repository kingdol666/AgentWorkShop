<script setup lang="ts">
/**
 * 事件聚合块 — open-tag 聊天行声部(.msg 网格:头像列 + 内容列):
 *  - 头部:26px 头像 + 名字 + 类别小标 + 计数/时间;正文落在内容列(块体组件复用);
 *  - 连续同发送者块 compact 分组:隐藏头像与名字(Slack 消息分组),保留左列对齐;
 *  - 悬停工具条(open-tag msg-toolbar):流/消息块可复制全文 / 引用到输入框(经 Composer 总线);
 *  - 各行渲染按 kind 分发到隔离组件 —— 流式更新只触发命中 kind 的组件。
 *
 * 本壳层只做编排:派生状态在 useEventBlockView,头像列/头部行在 blocks/ 子组件,
 * 正文按 kind 分发到 Cluster* 块体;对外 props 与 DOM 数据属性(浏览器测试对账用)不变。
 */
import { computed } from 'vue'
import type { Component } from 'vue'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'
import { useEventBlockView } from '@/app/composables/workshop/useEventBlockView'
import EventBlockAvatar from '@/app/components/workshop/blocks/EventBlockAvatar.vue'
import EventBlockHead from '@/app/components/workshop/blocks/EventBlockHead.vue'
import ClusterStream from '@/app/components/workshop/blocks/ClusterStream.vue'
import ClusterTool from '@/app/components/workshop/blocks/ClusterTool.vue'
import ClusterStatus from '@/app/components/workshop/blocks/ClusterStatus.vue'
import ClusterLife from '@/app/components/workshop/blocks/ClusterLife.vue'
import ClusterRoute from '@/app/components/workshop/blocks/ClusterRoute.vue'
import ClusterTask from '@/app/components/workshop/blocks/ClusterTask.vue'
import ClusterArtifact from '@/app/components/workshop/blocks/ClusterArtifact.vue'
import ClusterMember from '@/app/components/workshop/blocks/ClusterMember.vue'
import ClusterMemory from '@/app/components/workshop/blocks/ClusterMemory.vue'
import ClusterError from '@/app/components/workshop/blocks/ClusterError.vue'
import ClusterOther from '@/app/components/workshop/blocks/ClusterOther.vue'

const props = defineProps<{
  block: EventBlock
  turnStart?: boolean
  /** 连续同发送者紧凑分组(隐藏头像/名字,Slack 式) */
  compact?: boolean
  /** 进场编排(open-tag motion):实时新块带 60ms burst stagger;历史/重建块直接显示 */
  enterStage?: { enter: boolean, delay: number }
}>()

/** 壳层自身要用的派生值(档位/首帧 seq/紧凑态时间);子组件各自取所需 */
const { time, tier, firstSeq } = useEventBlockView(() => props.block)

const KIND_COMPONENT: Record<string, Component> = {
  stream: ClusterStream,
  tool: ClusterTool,
  status: ClusterStatus,
  life: ClusterLife,
  route: ClusterRoute,
  task: ClusterTask,
  artifact: ClusterArtifact,
  member: ClusterMember,
  memory: ClusterMemory,
  error: ClusterError,
  other: ClusterOther,
}
const body = computed(() => KIND_COMPONENT[props.block.kind] ?? ClusterOther)
</script>

<template>
  <section
    class="event-block"
    :class="{ 'turn-start': turnStart, compact, 'enter': enterStage?.enter }"
    :style="enterStage?.enter ? { '--d': `${enterStage.delay}ms` } : undefined"
    :data-kind="block.kind"
    :data-tier="tier"
    :data-settled="block.settled ? 'true' : 'false'"
    :data-covered="block.coveredBy ? 'true' : 'false'"
    :data-seq="firstSeq"
    :data-events="block.events.length"
    :data-folded="block.folded"
  >
    <EventBlockAvatar :block="block" />

    <div class="eb-main">
      <EventBlockHead
        :block="block"
        :compact="compact"
      />

      <!-- 紧凑态副作用:紧凑态隐藏头部后,悬停显示抹去的时间(chat 侧厢时间轴) -->
      <span
        v-if="compact"
        class="ghost-time"
      >{{ time.slice(0, 5) }}</span>

      <component
        :is="body"
        :block="block"
        class="eb-body"
      />
    </div>
  </section>
</template>

<style scoped>
/* Slack 聊天行:行跨度经头像列成组;默认无左缘,仅终局/注意级/流式/错误插色缘 */
.event-block {
  position: relative;
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  column-gap: 11px;
  padding: 5px 10px 4px 12px;
  margin: 0;
  transition: background 0.15s ease;
}

.event-block:hover {
  background: var(--hover-tint);
  border-radius: 4px;
}

/* 进场编排(open-tag motion charter):仅实时新块,60ms burst stagger;
 * 历史/过滤重建直接显示(reduced-motion 直显) */
.event-block.enter {
  animation: block-in 0.32s var(--ease-out-quart) backwards;
  animation-delay: var(--d, 0ms);
}
@media (prefers-reduced-motion: reduce) {
  .event-block.enter { animation: none; }
}

/* turn 边界:不同 agent 的新回合 → 加大间距 + 顶部 hairline(角色回合切换) */
.event-block.turn-start {
  margin-top: 13px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
}
.event-block.turn-start.compact {
  margin-top: 0;
  padding-top: 5px;
  border-top: 0;
}

.event-block[data-kind='stream']:not([data-settled='true']) {
  background: color-mix(in srgb, var(--ink) 2.5%, transparent);
  border-radius: 4px;
}
/* 仅注意/错误级接入色缘(兑色低饱和度;终局不加彩色缘,靠名字加粗表意) */
.event-block[data-tier='attention'] {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--tone-warning-dot) 55%, transparent);
}
.event-block[data-kind='error'] {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--tone-danger-dot) 70%, transparent);
}
.event-block[data-covered='true'] { opacity: 0.72; }

/* 终局档名字加重:`.agent-name` 现在住在头部子组件里(非子组件根),
   故用 :deep() 保留原来「块级档位 → 名字」的跨层选择器语义 */
.event-block[data-tier='terminal'] :deep(.agent-name) { font-weight: 700; }
.event-block[data-tier='silent'] { opacity: 0.88; }
.event-block[data-tier='silent']:hover { opacity: 1; }

@keyframes block-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 紧凑分组:隐藏头像与头部,保留列对齐(Slack 连续消息;ghost 时间月台悬浮显) */
.event-block.compact .agent-avatar {
  visibility: hidden;
  height: 0;
  margin-top: 0;
}
.event-block.compact {
  padding-top: 2px;
  padding-bottom: 2px;
}
.event-block.compact + .event-block.compact {
  margin-top: -2px;
}

.eb-main {
  min-width: 0;
}

/* 紧凑态月台时间:悬停行时右侧浮现(Slack 紧凑组的时间轴补偿;仅住行头) */
.ghost-time {
  position: absolute;
  top: 3px;
  right: 10px;
  z-index: 2;
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
  pointer-events: none;
  opacity: 0;
  background: var(--paper-raised);
  border-radius: var(--radius-chip);
  transition: opacity var(--transition-fast);
}
.event-block.compact:hover .ghost-time {
  opacity: 1;
}

/* 悬停工具条:整块悬停浮出(工具条住在头部子组件里,故 :deep() 下探;
   规则体与拆分前逐字一致 —— 触发条件是块级 hover,不是头部 hover) */
.event-block:hover :deep(.eb-toolbar) {
  opacity: 1;
  pointer-events: auto;
}

/* 块体组件统一缩进归零(布局由本壳层的头像列接管;子组件自带 padding-left 归拢到内容列起点) */
.eb-body {
  padding-left: 2px !important;
  margin-top: 1px;
}
</style>
