<script setup lang="ts">
/**
 * harness 进程表:全部已启动的 harness 进程(含孤儿,即无 AgentRuntime 归属的进程),
 * 行内动作 = 打开终端镜像 / 终止进程(终止后对应 AgentRuntime 随之 stop/卸载)。
 *
 * 纯呈现:行数据、loading、terminating 由页面下发;orphanCount 只用于卡片右上角计数。
 */
import type { ProcessView } from '@/app/pages/monitor/types'
import { useProcessColumns } from '@/app/pages/monitor/composables/useMonitorColumns'
import { useMonitorFormat } from '@/app/pages/monitor/composables/useMonitorFormat'

defineProps<{
  /** harness 进程行(页面持有的快照切片) */
  rows: ProcessView[]
  /** 快照加载中 */
  loading: boolean
  /** 终止请求在途(禁用全部终止按钮,防连点) */
  terminating: boolean
  /** 孤儿进程数(卡片右上角计数;快照未到位时 undefined) */
  orphanCount?: number
}>()

defineEmits<{
  /** 打开该进程的原生终端镜像(HITL) */
  openTerminal: [pid: number, name: string | null, role: string | null]
  /** 终止该 PID */
  terminate: [process: ProcessView]
}>()

const { t } = useI18n()
const { shortId, startedAtText } = useMonitorFormat()
const processColumns = useProcessColumns()
</script>

<template>
  <!-- harness 进程表 -->
  <a-card
    class="aw-panel"
    :title="t('monitor.harnessProcesses')"
  >
    <template #extra>
      <span class="aw-mono count-extra">
        {{ rows.length }} spawned ·
        {{ orphanCount ?? 0 }} orphan
      </span>
    </template>
    <a-table
      :columns="processColumns"
      :data-source="rows"
      :pagination="false"
      :loading="loading"
      row-key="pid"
      size="small"
      :scroll="{ x: 900 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'pid'">
          <span class="aw-mono">{{ record.pid }}</span>
        </template>
        <template v-else-if="column.key === 'bound'">
          <a-tag
            :color="record.bound ? 'success' : 'warning'"
          >
            {{ record.bound ? t('monitor.bound') : t('monitor.orphan') }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'name'">
          <span>{{ record.name ?? '–' }}</span>
          <span
            v-if="record.agentId"
            class="aw-mono agent-sub"
          >
            {{ shortId(record.agentId) }}
          </span>
        </template>
        <template v-else-if="column.key === 'role'">
          <span v-if="record.role">{{ record.role }}</span>
          <span v-else>–</span>
        </template>
        <template v-else-if="column.key === 'command'">
          <span class="aw-mono small">{{ record.command }}</span>
        </template>
        <template v-else-if="column.key === 'startedAt'">
          <span class="aw-mono small">{{ startedAtText(record.startedAt) }}</span>
        </template>
        <template v-else-if="column.key === 'alive'">
          <a-tag :color="record.alive ? 'success' : 'error'">
            {{ record.alive ? t('monitor.alive') : `${t('monitor.exited')} ${record.exitCode ?? ''}` }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-space :size="4">
            <a-button
              v-if="record.terminal"
              size="small"
              type="primary"
              ghost
              :title="t('monitor.openTerminalHint')"
              @click="$emit('openTerminal', record.pid, record.name, record.role)"
            >
              <template #icon>
                <span class="i-tabler-terminal-2" />
              </template>
              {{ t('monitor.openTerminal') }}
            </a-button>
            <a-popconfirm
              :title="t('monitor.terminatePidConfirm')"
              :ok-text="t('common.confirm')"
              :cancel-text="t('common.cancel')"
              @confirm="$emit('terminate', record as ProcessView)"
            >
              <a-button
                size="small"
                danger
                :disabled="terminating || !record.alive"
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
.agent-sub {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--ink-faint);
}

/* 卡片右上角计数:tabular mono 数据(非眉题)。
   同一规则在 MonitorChannelTable / MonitorAgentTable 的 scoped 块里逐字复制
   (样式随标记走,不抽公共 css):有意重复,改一处同步所有副本。 */
.count-extra {
  font-size: 11.5px;
  color: var(--ink-faint);
}

/* 命令 / 启动时刻的等宽小字。
   同一规则在 MonitorStatGrid(概要卡第四张的读数行)里也有一份:有意重复,改一处同步所有副本。 */
.small {
  font-size: 12.5px;
}

/* 空表占位行:antd 会给固定列单元格加 position: sticky,而 scroll.x=900
   让整行宽 900px —— 在 375px 视口里它就成了"视口外的固定元素"。占位单元格没有
   固定列语义,取消 sticky 即可(有数据时固定列行为不变)。
   同规则在 MonitorChannelTable / MonitorAgentTable 逐字复制:有意重复,改一处同步所有副本。 */
:deep(.ant-table-placeholder > td) {
  position: static !important;
}
</style>
