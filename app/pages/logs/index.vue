<template>
  <div class="page">
    <!-- 页头(aw-page-head 规范:kicker + 大标题 + 描述)+ 手动记录入口 -->
    <LogsPageHead
      :recent-count="opsLog.recent.length"
      @manual="openManual"
    />

    <!-- 维度筛选:产线 → 产品 → Recipe 级联 + 来源/分类/关键词 -->
    <LogsFilterCard
      v-model:line-id="q.lineId"
      v-model:product-id="q.productId"
      v-model:recipe-id="q.recipeId"
      v-model:actor-kind="q.actorKind"
      v-model:kind="q.kind"
      v-model:text="q.text"
      :has-filter="hasFilter"
      :loading="opsLog.loading.list"
      @query="doQuery"
      @reset="resetFilters"
    />

    <!-- 结果表:时间/来源/操作者/分类/摘要/归属维度/详情 -->
    <LogsEventTable
      :rows="opsLog.results"
      :expanded-id="expandedId"
      :loading="opsLog.loading.list"
      :error="opsLog.error.list"
      @toggle="toggleRow"
    />

    <!-- 人工记录弹窗 -->
    <LogsManualModal
      v-model:open="manualOpen"
      :scope="manualScope"
      :posting="opsLog.loading.posting"
      :error="opsLog.error.post"
      @submit="submitManual"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 审计日志页(audit_log 全操作统一记录) —— 单页三区:页头实况 / 维度筛选 / 结果表 + 人工记录弹窗。
 *
 * 数据权威在 server:GET /api/workshop/ops-logs 按维度查询(产线/产品/Recipe/来源/分类/关键词),
 * POST 手动录入人工事件;WS ops.log 帧只提供实时轨计数(recent),历史完整查询走 REST。
 *
 * 页面只做编排:查询态与展开态在 composables/useLogsQuery,人工记录在 composables/useLogsManual,
 * 级联口径在 composables/useLogsScope,展示格式化在 composables/useLogsFormat;
 * 区块与弹窗在 components/logs/*(页面私有子组件刻意不放 app/pages —— 该目录下任何 .vue 都会被当成路由)。
 */
import { computed, onMounted } from 'vue'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useOpsLog } from '@/app/composables/workshop/useOpsLog'
import { useLogsQuery } from './composables/useLogsQuery'
import { useLogsManual, type LogsManualScope } from './composables/useLogsManual'
import LogsPageHead from '~/components/logs/LogsPageHead.vue'
import LogsFilterCard from '~/components/logs/LogsFilterCard.vue'
import LogsEventTable from '~/components/logs/LogsEventTable.vue'
import LogsManualModal from '~/components/logs/LogsManualModal.vue'

const dcw = useDcwStream()
const ws = useWorkshopWs()
const opsLog = useOpsLog()

const { q, hasFilter, expandedId, doQuery, resetFilters, toggleRow } = useLogsQuery()
// 提交成功 → 立即重查(人工事件与自动操作同一流水,新记录必须马上出现在结果表里)
const { manualOpen, openManual, submitManual } = useLogsManual({ onPosted: doQuery })

/** 人工记录弹窗的归属口径:与筛选区共享同一份维度(草稿初值与级联选项同源) */
const manualScope = computed<LogsManualScope>(() => ({
  lineId: q.lineId,
  productId: q.productId,
  recipeId: q.recipeId,
}))

onMounted(() => {
  ws.ensureConnected()
  opsLog.ensureLive()
  void dcw.load()
  doQuery()
})
</script>

<script lang="ts">
export default { name: 'OpsLogsPage' }
</script>

<style scoped>
.page { display: flex; flex-direction: column; gap: 12px; }
</style>
