<script setup lang="ts">
/**
 * 事件聚合块 — 壳层分发器。
 * 头部(时间 + agent 徽标 + 类别 + 合并粒度)统一由本壳渲染;
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
      <span class="time">{{ time }}</span>
      <span
        class="agent-chip"
        :style="{ background: agentHueColor(block.agentId) }"
      >{{ agentLabel }}</span>
      <span class="kind">{{ meta.label }}</span>
      <span
        v-if="block.events.length > 1"
        class="merged"
      >×{{ block.events.length }}</span>
      <span
        v-if="block.folded > 0"
        class="folded"
        title="与 delta 增量重复的内容已合并为一段"
      >去重 {{ block.folded }}</span>
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
  padding: 5px 8px 5px 0;
  margin: 0 8px 2px 6px;
  border-left: 2px solid color-mix(in srgb, var(--ink) 9%, transparent);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.event-block:hover {
  border-left-color: color-mix(in srgb, var(--accent-cobalt) 45%, transparent);
  background: color-mix(in srgb, var(--accent-cobalt) 2.5%, transparent);
}
.event-block[data-kind='stream']:not([data-settled='true']) {
  border-left-color: color-mix(in srgb, var(--accent-cobalt) 35%, transparent);
}
.event-block[data-kind='error'] { border-left-color: var(--accent-vermilion, #ff4d4f); }
.event-block[data-covered='true'] { opacity: 0.72; }

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
.folded {
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--accent-moss, #52c41a);
  border: 1px solid color-mix(in srgb, var(--accent-moss, #52c41a) 40%, transparent);
  border-radius: 2px;
}
</style>
