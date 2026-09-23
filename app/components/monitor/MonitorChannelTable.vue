<script setup lang="ts">
/**
 * ChannelRuntime 表:已装配的 Channel(成员数 / 已装配 Agent 数 / 调度器 / lead)。
 *
 * 纯呈现:行数据是页面的唯一快照切片,组件不取数、不订阅、不持有状态。
 */
import type { ChannelView } from '@/app/pages/monitor/types'
import { useChannelColumns } from '@/app/pages/monitor/composables/useMonitorColumns'
import { useMonitorFormat } from '@/app/pages/monitor/composables/useMonitorFormat'

defineProps<{
  /** ChannelRuntime 行(页面持有的快照切片) */
  rows: ChannelView[]
  /** 快照加载中 */
  loading: boolean
}>()

const { t } = useI18n()
const { shortId } = useMonitorFormat()
const channelColumns = useChannelColumns()
</script>

<template>
  <!-- ChannelRuntime 表 -->
  <a-card
    class="aw-panel"
    :title="t('monitor.channelRuntimes')"
  >
    <template #extra>
      <span class="aw-mono count-extra">{{ rows.length }} wired</span>
    </template>
    <a-table
      :columns="channelColumns"
      :data-source="rows"
      :pagination="false"
      :loading="loading"
      row-key="channelId"
      size="small"
      :scroll="{ x: 720 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'channelId'">
          <span class="aw-mono">{{ shortId(record.channelId) }}</span>
        </template>
        <template v-else-if="column.key === 'hasScheduler'">
          <a-tag
            v-if="record.hasScheduler"
            color="purple"
          >
            {{ t('monitor.scheduling') }}
          </a-tag>
          <a-tag v-else>
            –
          </a-tag>
        </template>
        <template v-else-if="column.key === 'leadAgentId'">
          <span class="aw-mono">{{ shortId(record.leadAgentId) }}</span>
        </template>
      </template>
    </a-table>
  </a-card>
</template>

<style scoped>
/* 卡片右上角计数:tabular mono 数据(非眉题)。
   同一规则在 MonitorAgentTable / MonitorProcessTable 的 scoped 块里逐字复制
   (样式随标记走,不抽公共 css):有意重复,改一处同步所有副本。 */
.count-extra {
  font-size: 11.5px;
  color: var(--ink-faint);
}

/* 空表占位行:antd 会给固定列单元格加 position: sticky,而 scroll.x=720
   让整行宽 720px —— 在 375px 视口里它就成了"视口外的固定元素"。占位单元格没有
   固定列语义,取消 sticky 即可(有数据时固定列行为不变)。
   同规则在 MonitorAgentTable / MonitorProcessTable 逐字复制:有意重复,改一处同步所有副本。 */
:deep(.ant-table-placeholder > td) {
  position: static !important;
}
</style>
