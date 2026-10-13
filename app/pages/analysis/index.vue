<template>
  <div class="page">
    <!-- 页头(aw-page-head 规范)+ 实时轨计数 -->
    <AnalysisPageHead :live-count="feed.liveCount.value" />

    <!-- 筛选:产线 / 类别 / 时间窗 / 关键词 -->
    <AnalysisFilterCard
      v-model:line-id="feed.q.lineId"
      v-model:category="feed.q.category"
      v-model:preset="feed.q.preset"
      v-model:text="feed.q.text"
      :has-filter="feed.hasFilter.value"
      :loading="feed.loading.value"
      @query="feed.doQuery"
      @reset="feed.resetFilters"
    />

    <!-- 分析报告台账:REST 快照为底,analysis 留痕 WS 帧去抖刷新;admin 可删(清污数据) -->
    <AnalysisTable
      v-model:expanded-id="expandedId"
      :rows="feed.rows.value"
      :loading="feed.loading.value"
      :error="feed.error.value"
      :admin="userStore.isAdmin"
      @toggle="toggleRow"
      @remove="removeReport"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 数据分析页 —— Agent Channel 分析产出的持久留痕台账(append-only)。
 *
 * 数据权威在 server analysis_reports 表:GET /api/workshop/analysis 按维度查询;
 * 实时面是 TownBus 旁路的 ops.log 帧(kind='analysis',analysis_save 的 recordOps 广播),
 * 收到帧后去抖拉快照。留痕由 Agent 经 analysis_save 原生工具写入,页面纯只读
 * (清污数据走 admin 的 DELETE /api/workshop/analysis/:id)。
 * 数据面在 composables/useAnalysisFeed,展示在 components/analysis/*
 * (app/pages 下任何 .vue 都会成为路由,页面私有子组件不放这里)。
 */
import { onMounted, ref } from 'vue'
import { useUserStore } from '~/stores/workshop/user'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { apiFetch } from '@/app/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'
import { useAnalysisFeed } from './composables/useAnalysisFeed'
import type { AnalysisReportView } from './types'
import AnalysisPageHead from '~/components/analysis/AnalysisPageHead.vue'
import AnalysisFilterCard from '~/components/analysis/AnalysisFilterCard.vue'
import AnalysisTable from '~/components/analysis/AnalysisTable.vue'

const ws = useWorkshopWs()
const feed = useAnalysisFeed()
const userStore = useUserStore()
const expandedId = ref('')

function toggleRow(row: AnalysisReportView): void {
  expandedId.value = expandedId.value === row.id ? '' : row.id
}

/** 管理面删除(仅 admin;REST 侧 requireRole 兜底) */
const removing = ref(false)
async function removeReport(row: AnalysisReportView): Promise<void> {
  if (removing.value) return
  removing.value = true
  try {
    await apiFetch({ base: '/api/workshop/analysis', path: `/${row.id}`, init: { method: 'DELETE' } })
    if (expandedId.value === row.id) expandedId.value = ''
    await feed.doQuery()
  }
  catch (err) {
    feed.error.value = apiErrorMessage(err)
  }
  finally {
    removing.value = false
  }
}

onMounted(() => {
  ws.ensureConnected()
  void feed.doQuery()
})
</script>

<script lang="ts">
export default { name: 'AnalysisPage' }
</script>

<style scoped>
.page { display: flex; flex-direction: column; gap: 12px; }
</style>
