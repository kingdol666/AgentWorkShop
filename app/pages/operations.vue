<template>
  <div class="page">
    <!-- 页头(aw-page-head 规范)+ WS 实时轨计数 -->
    <OperationsPageHead :recent-count="opsLog.recent.length" />

    <!-- 筛选:产线 / 分类 / 来源 / 关键词 -->
    <OperationsFilterCard
      v-model:line-id="feed.q.lineId"
      v-model:kind="feed.q.kind"
      v-model:actor-kind="feed.q.actorKind"
      v-model:text="feed.q.text"
      :has-filter="feed.hasFilter.value"
      :loading="opsLog.loading.list"
      @query="feed.doQuery"
      @reset="feed.resetFilters"
    />

    <!-- 统一操作流水:REST 快照为底 + WS 实时帧合并(全产线操作一屏) -->
    <OperationsTimeline
      :rows="feed.rows.value"
      :loading="opsLog.loading.list"
      :error="opsLog.error.list"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 产线操作页 —— 单页集中渲染所有对产线的操作(写控下发/配方批次/数采告警/建模/回退/Agent 动作)。
 *
 * 与 /logs(审计表格)的分工:本页是"操作流水"视角 —— 统一时间线 + 分类统计 +
 * 写控结构化变更(prev→next diff),WS 实时帧直接前插;权威查询仍走同一张 audit_log。
 * 数据面在 composables/useOperationsFeed,展示在 components/operations/*
 * (app/pages 下任何 .vue 都会成为路由,页面私有子组件不放这里)。
 */
import { onMounted } from 'vue'
import { useOpsLog } from '@/app/composables/workshop/useOpsLog'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useOperationsFeed } from './operations/composables/useOperationsFeed'
import OperationsPageHead from '~/components/operations/OperationsPageHead.vue'
import OperationsFilterCard from '~/components/operations/OperationsFilterCard.vue'
import OperationsTimeline from '~/components/operations/OperationsTimeline.vue'

const opsLog = useOpsLog()
const ws = useWorkshopWs()
const feed = useOperationsFeed()

onMounted(() => {
  ws.ensureConnected()
  opsLog.ensureLive()
  void feed.doQuery()
})
</script>

<script lang="ts">
export default { name: 'OperationsPage' }
</script>

<style scoped>
.page { display: flex; flex-direction: column; gap: 12px; }
</style>
