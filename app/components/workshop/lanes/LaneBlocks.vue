<script setup lang="ts">
/**
 * Lane 聚合块列 — Agent lanes 的列体。
 *
 * 每个成员 lane 一个实例,内部独占一个 BlockClusterer(经 useClusteredBlocks):
 *  - 相同类型连续事件合并进同一个块组件(工具串/状态串/流式气泡),
 *    实时与历史(刷新回填)走同一聚类路径,行为完全一致;
 *  - raw 源:ring 原始 items + 本 lane 的 agentId 谓词 —— 不受时间线
 *    filter/focus 影响(Inspector 聚焦别的 agent 时本列不清空);
 *  - 重复消费防线与时间线共享(events store consumed seq + 聚类器头部
 *    seq 重建),历史回填与实时增量互不冲突。
 */
import { useClusteredBlocks } from '@/app/composables/workshop/useClusteredBlocks'
import type { AepEnvelope } from '#shared/workshop-protocol'

const props = defineProps<{
  channelId: string
  agentId: string
}>()

const { blocks } = useClusteredBlocks(
  () => props.channelId,
  {
    predicate: (e: AepEnvelope) => e.agentId === props.agentId,
    resetKey: () => props.agentId,
    raw: true,
  },
)
</script>

<template>
  <div
    v-if="blocks.length === 0"
    class="lane-empty"
  >
    暂无事件
  </div>
  <workshop-event-block
    v-for="b in blocks"
    :key="b.id"
    :block="b"
  />
</template>

<style scoped>
.lane-empty {
  padding: 28px 8px;
  font-size: 11.5px;
  color: var(--ink-fainter);
  text-align: center;
}
</style>
