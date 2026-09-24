<script setup lang="ts">
/**
 * 运行时资源监控页 —— 系统/运维视角。
 * 监控已装配的 ChannelRuntime / AgentRuntime 与全部已启动的 harness 进程(含孤儿),
 * 支持终止进程(终止后对应 AgentRuntime 随之 stop/卸载),防止进程持续运行找不到归属造成资源浪费。
 * 数据源:GET /api/system/monitor(用户 token);终止:POST /api/system/monitor/terminate。
 *
 * 页面只做编排:轮询 / 5s 自动刷新 / 终止动作在 composables/useMonitorData(副作用只注册一次),
 * 终端面板开关在 composables/useMonitorTerminal,快照与列的类型在 types.ts;
 * 区块与三张表在 components/monitor/*(页面私有子组件刻意不放 app/pages ——
 * 该目录下任何 .vue,含子目录里的,都会被 Nuxt 当成路由)。
 */
import MonitorAgentTable from '../components/monitor/MonitorAgentTable.vue'
import MonitorChannelTable from '../components/monitor/MonitorChannelTable.vue'
import MonitorLoginGate from '../components/monitor/MonitorLoginGate.vue'
import MonitorPageHead from '../components/monitor/MonitorPageHead.vue'
import MonitorProcessTable from '../components/monitor/MonitorProcessTable.vue'
import MonitorStatGrid from '../components/monitor/MonitorStatGrid.vue'
import OmpTerminalPanel from '../components/workshop/terminal/OmpTerminalPanel.vue'
import { useUserStore } from '../stores/workshop/user'
import { useMonitorData } from './monitor/composables/useMonitorData'
import { useMonitorTerminal } from './monitor/composables/useMonitorTerminal'

definePageMeta({ layout: 'default' })

const route = useRoute()
const userStore = useUserStore()

const { terminalOpen, terminalPid, terminalAgentId, terminalChannelId, terminalSubtitle, openTerminal } = useMonitorTerminal()

// 快照是唯一副本:autoRefresh 的 5s 定时器、token 变化的重拉、卸载清理都在 composable 里
// 成对注册(页面不再自行注册任何 setInterval/onUnmounted,避免多份订阅)
const {
  snapshot,
  loading,
  autoRefresh,
  lastUpdated,
  terminating,
  poll,
  doTerminateAgent,
  doTerminatePid,
} = useMonitorData({ onInitialPoll: openFromQuery })

// HITL 徽标跳转定位:?agentId=&channelId= → 自动打开该 agent 的终端面板(omp 未
// spawn 时无进程行,保持关闭;用后即清 query,刷新/再进不重复弹开)
function openFromQuery(): void {
  const agentId = route.query.agentId
  if (typeof agentId !== 'string' || !agentId) return
  const channelId = typeof route.query.channelId === 'string' ? route.query.channelId : ''
  const proc = snapshot.value?.processes.find(p => p.agentId === agentId && (!channelId || p.channelId === channelId))
  // Agent-deep links must work even before the process table observes a PID.
  // OmpTerminalPanel can resolve/retry by agentId+channelId and will attach when
  // the persistent harness becomes visible; requiring a PID made HITL clicks a no-op.
  openTerminal(proc?.pid ?? null, proc?.name ?? agentId, proc?.role ?? 'agent', agentId, channelId || null)
  void navigateTo({ path: '/monitor' }, { replace: true })
}

// HITL can be clicked while already on /monitor. In that case Nuxt updates only
// the query and does not remount the page, so the initial-poll callback is not
// invoked again. Re-poll then resolve the agent/process deep link.
watch(
  () => [route.query.agentId, route.query.channelId],
  async ([agentId]) => {
    if (typeof agentId !== 'string' || !agentId) return
    await poll()
    openFromQuery()
  },
)
</script>

<template>
  <div class="monitor">
    <!-- 页头:标题 + 视图范围徽标 + 自动刷新开关 / 手动刷新 -->
    <MonitorPageHead
      v-model:auto-refresh="autoRefresh"
      :scope="snapshot?.scope"
      :loading="loading"
      @refresh="poll"
    />

    <!-- 未登录门 -->
    <MonitorLoginGate v-if="!userStore.token" />

    <template v-else>
      <!-- 概要统计 -->
      <MonitorStatGrid
        :counts="snapshot?.counts"
        :server-pid="snapshot?.serverPid"
        :uptime-ms="snapshot?.uptimeMs"
        :generated-at="snapshot?.generatedAt"
        :last-updated="lastUpdated"
      />

      <!-- ChannelRuntime 表 -->
      <MonitorChannelTable
        :rows="snapshot?.channels ?? []"
        :loading="loading"
      />

      <!-- AgentRuntime 表 -->
      <MonitorAgentTable
        :rows="snapshot?.agents ?? []"
        :loading="loading"
        :terminating="terminating"
        @open-terminal="openTerminal"
        @terminate="doTerminateAgent"
      />

      <!-- harness 进程表 -->
      <MonitorProcessTable
        :rows="snapshot?.processes ?? []"
        :loading="loading"
        :terminating="terminating"
        :orphan-count="snapshot?.counts.orphanProcesses"
        @open-terminal="openTerminal"
        @terminate="doTerminatePid"
      />

      <!-- harness 原生终端(omp rpc-ui 镜像 · 实时 TUI 渲染 + HITL 控制) -->
      <OmpTerminalPanel
        v-model:open="terminalOpen"
        :pid="terminalPid"
        :agent-id="terminalAgentId"
        :channel-id="terminalChannelId"
        :subtitle="terminalSubtitle"
      />
    </template>
  </div>
</template>

<style scoped>
.monitor {
  padding: 4px;
}

/* 三张表卡片各自是子组件的根元素(.aw-panel),但它们"相邻"这层关系只存在于本页模板
   —— Vue 会把本页 scopeId 打在子组件根元素上,所以 agent / process 两张表之间的
   16px 间距必须留在页面。概要卡之间的同名规则在 MonitorStatGrid 的 scoped 块里:
   有意重复,改一处同步所有副本(样式随标记走,不抽公共 css)。 */
.aw-panel + .aw-panel {
  margin-top: 16px;
}
</style>
