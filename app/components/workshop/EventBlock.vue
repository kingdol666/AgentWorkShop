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

const props = defineProps<{ block: EventBlock }>()

const entities = useEntitiesStore()
const cid = computed(() => props.block.events[0]?.channelId ?? '')

const time = computed(() => props.block.firstAt.slice(11, 19))
const agentLabel = computed(() => {
  const id = props.block.agentId
  if (!id) return 'system'
  return entities.agentName(cid.value, id)
})
const agentColor = computed(() => agentHueColor(props.block.agentId))

const meta = computed(() => KIND_META[props.block.kind])

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
    :data-kind="block.kind"
    :data-settled="block.settled ? 'true' : 'false'"
    :data-covered="block.coveredBy ? 'true' : 'false'"
  >
    <header class="block-head">
      <span
        class="agent-dot"
        :style="{ background: agentColor }"
        :title="block.agentId ?? 'system'"
      />
      <span class="agent-name">{{ agentLabel }}</span>
      <span class="kind">{{ meta.label }}</span>
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
.agent-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  margin-left: 6px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 6%, transparent);
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
  border-radius: 2px;
}
.merged {
  padding: 0 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-radius: 2px;
}
.time { flex: 0 0 auto; width: 50px; text-align: right; }
</style>
