<script setup lang="ts">
/**
 * 运行时资源监控页 —— 系统/运维视角。
 * 监控已装配的 ChannelRuntime / AgentRuntime 与全部已启动的 harness 进程(含孤儿),
 * 支持终止进程(终止后对应 AgentRuntime 随之 stop/卸载),防止进程持续运行找不到归属造成资源浪费。
 * 数据源:GET /api/system/monitor(用户 token);终止:POST /api/system/monitor/terminate。
 */
import { message } from 'ant-design-vue'
import { useUserStore } from '../stores/workshop/user'

definePageMeta({ layout: 'default' })

/** 与 server/runtime/manager.ts RuntimeMonitorSnapshot 对齐 */
interface ProcessInfo { pid: number, alive: boolean, command: string }
interface ChannelView {
  channelId: string
  wiredAgentCount: number
  memberCount: number
  hasScheduler: boolean
  leadAgentId: string | null
}
interface AgentView {
  channelId: string
  agentId: string
  name: string
  role: 'lead' | 'worker'
  harness: string
  state: 'idle' | 'busy' | 'stopped'
  currentTaskId: string | null
  queuedCount: number
  completedCount: number
  process: ProcessInfo | null
}
interface ProcessView {
  pid: number
  harness: string
  command: string
  args: string[]
  agentId: string | null
  channelId: string | null
  name: string | null
  role: 'lead' | 'worker' | null
  startedAt: number
  alive: boolean
  exitCode: number | null
  bound: boolean
}
interface MonitorSnapshot {
  generatedAt: string
  serverPid: number
  uptimeMs: number
  channels: ChannelView[]
  agents: AgentView[]
  processes: ProcessView[]
  counts: { channels: number, agents: number, processes: number, aliveProcesses: number, orphanProcesses: number }
}
interface ApiEnvelope<T> { code: number | string, message: string, data: T | null }

const { t } = useI18n()
const userStore = useUserStore()

const snapshot = ref<MonitorSnapshot | null>(null)
const loading = ref(false)
const autoRefresh = ref(true)
const lastUpdated = ref('')

const poll = async (): Promise<void> => {
  if (!userStore.token) return
  loading.value = true
  try {
    const res = await $fetch<ApiEnvelope<MonitorSnapshot>>('/api/system/monitor', {
      headers: { authorization: `Bearer ${userStore.token}` },
    })
    snapshot.value = res.data
    lastUpdated.value = new Date().toLocaleTimeString()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : t('monitor.loadFailed'))
  }
  finally {
    loading.value = false
  }
}

// 自动刷新(默认 5s;仅在已登录且有 token 时轮询)
let timer: ReturnType<typeof setInterval> | null = null
const applyTimer = (): void => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (autoRefresh.value && userStore.token) {
    timer = setInterval(() => void poll(), 5000)
  }
}
watch(autoRefresh, () => applyTimer())
watch(() => userStore.token, () => {
  if (userStore.token) void poll()
  else snapshot.value = null
  applyTimer()
})

onMounted(() => {
  if (userStore.token) void poll()
  applyTimer()
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

// ===== 终止动作 =====
const terminating = ref(false)
const doTerminateAgent = async (a: AgentView): Promise<void> => {
  terminating.value = true
  try {
    const res = await $fetch<ApiEnvelope<{ agentId: string, stopped: boolean }>>('/api/system/monitor/terminate', {
      method: 'POST',
      headers: { authorization: `Bearer ${userStore.token}` },
      body: { channelId: a.channelId, agentId: a.agentId },
    })
    message.success(res.code === 0 ? `${a.name} ${t('monitor.terminated')}` : (res.message ?? t('monitor.failed')))
    await poll()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : t('monitor.failed'))
  }
  finally {
    terminating.value = false
  }
}

const doTerminatePid = async (p: ProcessView): Promise<void> => {
  terminating.value = true
  try {
    const res = await $fetch<ApiEnvelope<{ pid: number, killed: boolean }>>('/api/system/monitor/terminate', {
      method: 'POST',
      headers: { authorization: `Bearer ${userStore.token}` },
      body: { pid: p.pid },
    })
    message.success(res.code === 0 ? `PID ${p.pid} ${t('monitor.terminated')}` : (res.message ?? t('monitor.failed')))
    await poll()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : t('monitor.failed'))
  }
  finally {
    terminating.value = false
  }
}

// ===== 展示辅助 =====
const shortId = (id: string | null | undefined): string => (id && id.length > 8 ? `${id.slice(0, 8)}…` : (id ?? '-'))
const stateColor: Record<string, string> = { idle: 'success', busy: 'processing', stopped: 'error' }
const stateText: Record<string, string> = {
  idle: t('monitor.stateIdle'),
  busy: t('monitor.stateBusy'),
  stopped: t('monitor.stateStopped'),
}
const uptimeText = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`
}
const startedAtText = (ts: number): string => new Date(ts).toLocaleTimeString()

// ===== 表格列 =====
const channelColumns = [
  { title: t('monitor.chChannel'), dataIndex: 'channelId', key: 'channelId' },
  { title: t('monitor.members'), dataIndex: 'memberCount', key: 'memberCount', width: 120 },
  { title: t('monitor.wired'), dataIndex: 'wiredAgentCount', key: 'wiredAgentCount', width: 100 },
  { title: t('monitor.scheduler'), dataIndex: 'hasScheduler', key: 'hasScheduler', width: 120 },
  { title: t('monitor.lead'), dataIndex: 'leadAgentId', key: 'leadAgentId' },
]
const agentColumns = [
  { title: t('monitor.name'), dataIndex: 'name', key: 'name' },
  { title: t('monitor.role'), dataIndex: 'role', key: 'role', width: 90 },
  { title: t('monitor.harness'), dataIndex: 'harness', key: 'harness', width: 90 },
  { title: t('monitor.state'), dataIndex: 'state', key: 'state', width: 110 },
  { title: t('monitor.currentTask'), dataIndex: 'currentTaskId', key: 'currentTaskId' },
  { title: t('monitor.queue'), dataIndex: 'queuedCount', key: 'queuedCount', width: 90 },
  { title: 'PID', dataIndex: 'process', key: 'pid', width: 130 },
  { title: t('monitor.channel'), dataIndex: 'channelId', key: 'channelId', width: 130 },
  { title: t('monitor.actions'), key: 'actions', width: 130, fixed: 'right' as const },
]
const processColumns = [
  { title: 'PID', dataIndex: 'pid', key: 'pid', width: 100 },
  { title: t('monitor.binding'), dataIndex: 'bound', key: 'bound', width: 100 },
  { title: t('monitor.agent'), dataIndex: 'name', key: 'name' },
  { title: t('monitor.role'), dataIndex: 'role', key: 'role', width: 90 },
  { title: t('monitor.command'), dataIndex: 'command', key: 'command' },
  { title: t('monitor.startedAt'), dataIndex: 'startedAt', key: 'startedAt', width: 110 },
  { title: t('monitor.state'), dataIndex: 'alive', key: 'alive', width: 100 },
  { title: t('monitor.actions'), key: 'actions', width: 110, fixed: 'right' as const },
]
</script>

<template>
  <div class="monitor">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          {{ t('menu.system') }} / runtime ledger
        </p>
        <h1>{{ t('monitor.title') }}</h1>
      </div>
      <div class="head-right">
        <a-switch
          v-model:checked="autoRefresh"
          size="small"
        />
        <span class="aw-kicker">{{ t('monitor.autoRefresh') }}</span>
        <a-button
          size="small"
          :loading="loading"
          @click="poll"
        >
          <template #icon>
            <span class="i-tabler-refresh" />
          </template>
          {{ t('monitor.refresh') }}
        </a-button>
      </div>
    </div>

    <!-- 未登录门 -->
    <a-card
      v-if="!userStore.token"
      class="aw-panel"
    >
      <a-result :title="t('monitor.needLogin')">
        <template #extra>
          <a-button
            type="primary"
            @click="navigateTo('/workshop')"
          >
            {{ t('monitor.goLogin') }}
          </a-button>
        </template>
      </a-result>
    </a-card>

    <template v-else>
      <!-- 概要统计 -->
      <a-row
        :gutter="[16, 16]"
        class="summary"
      >
        <a-col
          :xs="12"
          :md="6"
        >
          <a-card class="aw-panel stat">
            <p class="stat-label">
              {{ t('monitor.channels') }}
            </p>
            <p class="stat-value aw-mono">
              {{ snapshot?.counts.channels ?? '–' }}
            </p>
          </a-card>
        </a-col>
        <a-col
          :xs="12"
          :md="6"
        >
          <a-card class="aw-panel stat">
            <p class="stat-label">
              {{ t('monitor.agents') }}
            </p>
            <p class="stat-value aw-mono">
              {{ snapshot?.counts.agents ?? '–' }}
            </p>
          </a-card>
        </a-col>
        <a-col
          :xs="12"
          :md="6"
        >
          <a-card class="aw-panel stat">
            <p class="stat-label">
              {{ t('monitor.aliveProcesses') }}
            </p>
            <p class="stat-value aw-mono">
              {{ snapshot?.counts.aliveProcesses ?? '–' }}
              <span
                v-if="(snapshot?.counts.orphanProcesses ?? 0) > 0"
                class="orphan-badge"
              >
                +{{ snapshot?.counts.orphanProcesses }} {{ t('monitor.orphan') }}
              </span>
            </p>
          </a-card>
        </a-col>
        <a-col
          :xs="12"
          :md="6"
        >
          <a-card class="aw-panel stat">
            <p class="stat-label">
              {{ t('monitor.server') }}
            </p>
            <p class="stat-value aw-mono small">
              PID {{ snapshot?.serverPid ?? '–' }} · {{ snapshot ? uptimeText(snapshot.uptimeMs) : '' }}
            </p>
            <p class="stat-updated">
              {{ lastUpdated }} · {{ t('monitor.updated') }} {{ snapshot?.generatedAt ?? '' }}
            </p>
          </a-card>
        </a-col>
      </a-row>

      <!-- ChannelRuntime 表 -->
      <a-card
        class="aw-panel"
        :title="t('monitor.channelRuntimes')"
      >
        <template #extra>
          <span class="aw-kicker">{{ snapshot?.channels.length ?? 0 }} wired</span>
        </template>
        <a-table
          :columns="channelColumns"
          :data-source="snapshot?.channels ?? []"
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

      <!-- AgentRuntime 表 -->
      <a-card
        class="aw-panel"
        :title="t('monitor.agentRuntimes')"
      >
        <template #extra>
          <span class="aw-kicker">{{ snapshot?.agents.length ?? 0 }} wired</span>
        </template>
        <a-table
          :columns="agentColumns"
          :data-source="snapshot?.agents ?? []"
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
                class="aw-kicker"
              >in-proc</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-popconfirm
                :title="`${t('monitor.terminateConfirm')}(${record.name})`"
                :ok-text="t('common.confirm')"
                :cancel-text="t('common.cancel')"
                @confirm="doTerminateAgent(record as AgentView)"
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
            </template>
          </template>
        </a-table>
      </a-card>

      <!-- harness 进程表 -->
      <a-card
        class="aw-panel"
        :title="t('monitor.harnessProcesses')"
      >
        <template #extra>
          <span class="aw-kicker">
            {{ snapshot?.processes.length ?? 0 }} spawned ·
            {{ snapshot?.counts.orphanProcesses ?? 0 }} orphan
          </span>
        </template>
        <a-table
          :columns="processColumns"
          :data-source="snapshot?.processes ?? []"
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
                class="aw-kicker agent-sub"
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
              <a-popconfirm
                :title="t('monitor.terminatePidConfirm')"
                :ok-text="t('common.confirm')"
                :cancel-text="t('common.cancel')"
                @confirm="doTerminatePid(record as ProcessView)"
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
            </template>
          </template>
        </a-table>
      </a-card>
    </template>
  </div>
</template>

<style scoped>
.monitor {
  padding: 4px;
}

.head-right {
  display: flex;
  gap: 10px;
  align-items: center;
}

.summary {
  margin-bottom: 16px;
}

.stat {
  height: 100%;
}

.stat-label {
  margin: 0 0 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-soft, rgba(120, 112, 96, 0.8));
}

.stat-value {
  margin: 0;
  font-size: 30px;
  font-weight: 590;
  line-height: 1.1;
}

.stat-value.small {
  font-size: 17px;
}

.stat-updated {
  margin: 6px 0 0;
  font-size: 11px;
  opacity: 0.6;
}

.orphan-badge {
  margin-left: 6px;
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: #fa8c16;
  background: rgb(250 140 22 / 12%);
  border-radius: 2px;
}

.agent-sub {
  display: block;
  margin-top: 2px;
}

.small {
  font-size: 12px;
}

.aw-panel + .aw-panel {
  margin-top: 16px;
}
</style>
