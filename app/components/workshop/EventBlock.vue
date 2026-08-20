<script setup lang="ts">
/**
 * 事件聚合块 — Codex 式壳层分发器。
 * 头部:agent 色点 + 名字 + 类别小标居左;合并粒度/去重/时间右对齐(暗色)。
 * 各行渲染按 kind 分发到隔离组件(stream/tool/status/life/route/task/artifact/…)——
 * 不同事件块互不耦合,流式更新只触发命中 kind 的组件。
 */
import { computed } from 'vue'
import type { Component } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { KIND_META, agentHueColor, type EventBlock } from '@/app/composables/workshop/useEventBlocks'
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

const props = defineProps<{ block: EventBlock, turnStart?: boolean }>()

const entities = useEntitiesStore()
const cid = computed(() => props.block.events[0]?.channelId ?? '')

const time = computed(() => props.block.firstAt.slice(11, 19))
const agentLabel = computed(() => {
  const id = props.block.agentId
  if (!id) return 'system'
  return entities.agentName(cid.value, id)
})
const agentColor = computed(() => agentHueColor(props.block.agentId))
/** 头像章首字母(名字或 id 首字符;system 用 ✳) */
const agentInitial = computed(() => {
  const id = props.block.agentId
  if (!id) return '✳'
  const name = entities.agentName(cid.value, id)
  return (name || id).charAt(0).toUpperCase()
})

const meta = computed(() => KIND_META[props.block.kind])

/** kind → tone 色点(koda tone 系统) */
const KIND_TONE: Record<string, string> = {
  stream: 'var(--tone-info-dot)',
  tool: 'var(--tone-neutral-dot)',
  status: 'var(--tone-neutral-dot)',
  life: 'var(--tone-success-dot)',
  route: 'var(--tone-info-dot)',
  task: 'var(--tone-info-dot)',
  artifact: 'var(--tone-success-dot)',
  member: 'var(--tone-retry-dot)',
  memory: 'var(--tone-warning-dot)',
  error: 'var(--tone-danger-dot)',
  other: 'var(--tone-neutral-dot)',
}
const kindTone = computed(() => KIND_TONE[props.block.kind] ?? 'var(--tone-neutral-dot)')

/** 消费完整性观测:块首事件 seq + 块内事件数(浏览器测试对账用) */
const firstSeq = computed(() => props.block.events[0]?.seq ?? 0)

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
    :class="{ 'turn-start': turnStart }"
    :data-kind="block.kind"
    :data-settled="block.settled ? 'true' : 'false'"
    :data-covered="block.coveredBy ? 'true' : 'false'"
    :data-seq="firstSeq"
    :data-events="block.events.length"
    :data-folded="block.folded"
  >
    <header class="block-head">
      <span
        class="agent-avatar"
        :style="{ background: agentColor }"
        :title="agentLabel"
      >{{ agentInitial }}</span>
      <span class="agent-name">{{ agentLabel }}</span>
      <span class="kind">
        <span
          class="kind-dot"
          :style="{ background: kindTone }"
        />{{ meta.label }}
      </span>
      <span class="head-right">
        <span
          v-if="block.folded > 0"
          class="folded"
          title="与 delta 增量重复的内容已合并为一段"
        >去重 {{ block.folded }}</span>
        <span
          v-if="block.events.length > 1"
          class="merged"
        >×{{ block.events.length }}</span>
        <span class="time">{{ time }}</span>
      </span>
    </header>

    <component
      :is="body"
      :block="block"
    />
  </section>
</template>

<style scoped>
.event-block {
  position: relative;
  padding: 4px 8px 4px 0;
  margin: 0 8px 3px 6px;
  border-left: 2px solid color-mix(in srgb, var(--ink) 9%, transparent);
  transition: border-color 0.15s ease, background 0.15s ease;
  animation: block-in 0.22s cubic-bezier(0.2, 0.6, 0.3, 1);
}

/* turn 边界:不同 agent 的新回合开始 → 加大间距 + 顶部 hairline(现代 harness 会话分节感) */
.event-block.turn-start {
  margin-top: 12px;
  border-top: 1px solid var(--divider-hair);
  padding-top: 7px;
}
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
.event-block:hover {
  border-left-color: color-mix(in srgb, var(--accent-cobalt) 55%, transparent);
  background: color-mix(in srgb, var(--accent-cobalt) 3%, transparent);
}
.event-block[data-kind='stream']:not([data-settled='true']) {
  border-left-color: color-mix(in srgb, var(--accent-cobalt) 35%, transparent);
}
.event-block[data-kind='error'] { border-left-color: var(--accent-vermilion, #ff4d4f); }
.event-block[data-covered='true'] { opacity: 0.72; }

.block-head {
  display: flex;
  gap: 6px;
  align-items: center;
  min-height: 18px;
  padding-bottom: 1px;
  font-family: var(--font-mono);
}
.agent-avatar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 5px;
  font-family: var(--font-display);
  font-size: 9.5px;
  font-weight: 650;
  color: var(--paper-raised);
  border-radius: 50%;
}

.kind-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 4px;
  vertical-align: 1px;
  border-radius: 50%;
}
.agent-name {
  overflow: hidden;
  max-width: 160px;
  font-size: 10.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kind {
  font-size: 9px;
  letter-spacing: 0.14em;
  color: var(--ink-faint);
}
.head-right {
  display: flex;
  flex: 1 1 auto;
  gap: 6px;
  align-items: center;
  justify-content: flex-end;
  font-size: 9.5px;
  color: var(--ink-faint);
}
.folded {
  padding: 0 4px;
  color: var(--accent-moss);
  background: color-mix(in srgb, var(--accent-moss) 12%, transparent);
  border-radius: var(--radius-chip, 8px);
}
.merged {
  padding: 0 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-radius: var(--radius-chip, 8px);
}
.time { flex: 0 0 auto; width: 50px; text-align: right; }
</style>
