<script setup lang="ts">
/**
 * AgentRuntime 表:已装配 Agent(角色 / harness / 状态 / 当前任务 / 归属进程)+ 行内动作
 * (打开原生终端镜像、终止该 AgentRuntime)。
 *
 * 纯呈现:快照行、loading、terminating 全部由页面下发;终止请求由页面统一发起,
 * 组件不取数、不订阅、不各自持有 in-flight 状态。
 */
import type { AgentView } from '@/app/pages/monitor/types'
import { useAgentColumns } from '@/app/pages/monitor/composables/useMonitorColumns'
import { useAgentStateLabels, useMonitorFormat } from '@/app/pages/monitor/composables/useMonitorFormat'

defineProps<{
  /** AgentRuntime 行(页面持有的快照切片) */
  rows: AgentView[]
  /** 快照加载中 */
  loading: boolean
  /** 终止请求在途(禁用全部终止按钮,防连点) */
  terminating: boolean
}>()

defineEmits<{
  /** 打开该 Agent 归属进程的原生终端镜像(HITL) */
  openTerminal: [pid: number, name: string | null, role: string | null]
  /** 终止该 AgentRuntime(服务端随之 stop/卸载) */
  terminate: [agent: AgentView]
}>()

const { t } = useI18n()
const { shortId } = useMonitorFormat()
const { stateColor, stateText } = useAgentStateLabels()
const agentColumns = useAgentColumns()
</script>

<template>
  <!-- AgentRuntime 表 -->
  <a-card
    class="aw-panel"
    :title="t('monitor.agentRuntimes')"
  >
    <template #extra>
      <span class="aw-mono count-extra">{{ rows.length }} wired</span>
    </template>
    <a-table
      :columns="agentColumns"
      :data-source="rows"
      :pagination="false"
      :loading="loading"
      row-key="agentId"
      size="small"
      :scroll="{ x: 980 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'role'">
          <a-tag :color="record.role === 'lead' ? 'gold' : 'blue'">
            {{ record.role }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'harness'">
          <a-tag>{{ record.harness }}</a-tag>
        </template>
        <template v-else-if="column.key === 'state'">
          <a-tag :color="stateColor[record.state] ?? 'default'">
            {{ stateText[record.state] ?? record.state }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'currentTaskId'">
          <span class="aw-mono">{{ shortId(record.currentTaskId) }}</span>
        </template>
        <template v-else-if="column.key === 'channelId'">
          <span class="aw-mono">{{ shortId(record.channelId) }}</span>
        </template>
        <template v-else-if="column.key === 'pid'">
          <span v-if="record.process">
            <a-tag
              :color="record.process.alive ? 'success' : 'default'"
              class="aw-mono"
            >
              PID {{ record.process.pid }}
            </a-tag>
          </span>
          <span
            v-else
            class="aw-mono"
          >in-proc</span>
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-space :size="4">
            <a-button
              v-if="record.process?.alive"
              size="small"
              type="primary"
              ghost
              :title="t('monitor.openTerminalHint')"
              @click="$emit('openTerminal', record.process.pid, record.name, record.role)"
            >
              <template #icon>
                <span class="i-tabler-terminal-2" />
              </template>
              {{ t('monitor.openTerminal') }}
            </a-button>
            <a-popconfirm
              :title="`${t('monitor.terminateConfirm')}(${record.name})`"
              :ok-text="t('common.confirm')"
              :cancel-text="t('common.cancel')"
              @confirm="$emit('terminate', record as AgentView)"
            >
              <a-button
                size="small"
                danger
                :disabled="terminating"
              >
                <template #icon>
                  <span class="i-tabler-square-x" />
                </template>
                {{ t('monitor.terminate') }}
              </a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-card>
</template>

<style scoped>
/* 卡片右上角计数:tabular mono 数据(非眉题)。
   同一规则在 MonitorChannelTable / MonitorProcessTable 的 scoped 块里逐字复制
   (样式随标记走,不抽公共 css):有意重复,改一处同步所有副本。 */
.count-extra {
  font-size: 11.5px;
  color: var(--ink-faint);
}

/* 空表占位行:antd 会给固定列单元格加 position: sticky,而 scroll.x=980
   让整行宽 980px —— 在 375px 视口里它就成了"视口外的固定元素"(实测
   td.ant-table-cell 暂无数据 left=47 right=1027)。占位单元格没有固定列语义,
   取消 sticky 即可(有数据时固定列行为不变)。
   同规则在 MonitorChannelTable / MonitorProcessTable 逐字复制:有意重复,改一处同步所有副本。 */
:deep(.ant-table-placeholder > td) {
  position: static !important;
}
</style>
