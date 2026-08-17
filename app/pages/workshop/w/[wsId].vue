<script setup lang="ts">
/**
 * Workspace 主控台(Zcode 风格 Harness):
 * 顶栏(WS 状态 + seq + 视图切换)+ 左栏 Channel 会话 + 中部三视图
 * (时间线 / Agent lanes / 任务板)+ 右侧 Inspector + 底部 Composer +
 * Agent/Task 双抽屉(执行详情)。
 * 挂载 workspace 全部 channel 的 WS 订阅;聚焦 channel 驱动中部/右侧上下文。
 */
import { useWorkspacesStore } from '../../../stores/workshop/workspaces'
import { useEntitiesStore } from '../../../stores/workshop/entities'
import { useWorkshopWs } from '../../../composables/workshop/useWorkshopWs'
import { useUserStore } from '../../../stores/workshop/user'

definePageMeta({ layout: 'default' })

const route = useRoute()
const wsId = computed(() => String(route.params.wsId))
const userStore = useUserStore()
const wsStore = useWorkspacesStore()

// 用户守卫 + workspace 服务端加载
if (!userStore.isLoggedIn) {
  navigateTo('/workshop')
}
if (userStore.isLoggedIn && !wsStore.loaded) {
  wsStore.load().catch(() => {})
}
const entities = useEntitiesStore()
const { subscribe, unsubscribe, conn } = useWorkshopWs()

const workspace = computed(() => wsStore.workspaces.find(w => w.id === wsId.value))
const channelId = computed(() => workspace.value?.activeChannelId ?? workspace.value?.channelIds[0])

// 订阅生命周期:workspace 挂载的 channel 变化 → 增量 sub/unsub
watch(
  () => [wsId.value, workspace.value?.channelIds.join(',') ?? ''],
  () => {
    const mounted = new Set(workspace.value?.channelIds ?? [])
    for (const id of mounted) subscribe(id)
  },
  { immediate: true },
)
watch(
  () => workspace.value?.channelIds.join(',') ?? '',
  (_next, prev) => {
    if (prev === undefined) return
    const mounted = new Set(workspace.value?.channelIds ?? [])
    for (const prevId of prev.split(',').filter(Boolean)) {
      if (!mounted.has(prevId)) unsubscribe(prevId)
    }
  },
)
onBeforeUnmount(() => {
  for (const id of workspace.value?.channelIds ?? []) unsubscribe(id)
})

const stateColor = computed(() =>
  conn.state === 'open' ? '#52c41a' : conn.state === 'connecting' ? '#faad14' : '#ff4d4f',
)
const lastSeq = computed(() => (channelId.value ? conn.cursors[channelId.value] ?? 0 : 0))

// 视图切换(P1 三视图 + P2 多通道同屏)
type CenterView = 'timeline' | 'lanes' | 'board' | 'split'
const view = ref<CenterView>('timeline')
const viewOptions = [
  { value: 'timeline', label: '时间线' },
  { value: 'lanes', label: 'Agent lanes' },
  { value: 'board', label: '任务板' },
  { value: 'split', label: '同屏' },
]

// 侧栏折叠(现代 harness 布局:左会话栏 / 右检查器可按需收起)
const leftOpen = ref(true)
const rightOpen = ref(true)

// 抽屉状态(P1)
const agentDrawerOpen = ref(false)
const agentDrawerId = ref<string | null>(null)
const openAgent = (id: string): void => {
  agentDrawerId.value = id
  agentDrawerOpen.value = true
}
const taskDrawerOpen = ref(false)
const taskDrawerId = ref<string | null>(null)
const openTask = (id: string): void => {
  taskDrawerId.value = id
  taskDrawerOpen.value = true
}

// ⌘K 命令面板 + A2A 调试器(P2)
const paletteOpen = ref(false)
const a2aDebugOpen = ref(false)
const composerBox = ref<HTMLElement | null>(null)
const focusComposer = (): void => {
  composerBox.value?.querySelector('textarea')?.focus()
}

useHead({ title: () => `${workspace.value?.name ?? 'Workspace'} · Agent Harness` })
</script>

<template>
  <div class="harness">
    <!-- 顶栏 -->
    <div class="topbar">
      <div class="left">
        <span class="i-tabler-box" />
        <span class="ws-name">{{ workspace?.name ?? '未知 Workspace' }}</span>
        <a-tag
          v-if="channelId"
          color="blue"
        >
          {{ entities.channels[channelId]?.name ?? channelId.slice(0, 8) }}
        </a-tag>
        <a-segmented
          v-if="channelId"
          v-model:value="view"
          size="small"
          :options="viewOptions"
          class="view-switch"
        />
      </div>
      <div class="right">
        <button
          class="pane-toggle"
          :class="{ off: !leftOpen }"
          title="收起/展开 会话栏"
          @click="leftOpen = !leftOpen"
        >
          <span class="i-tabler-layout-sidebar-left-collapse" />
        </button>
        <button
          class="pane-toggle"
          :class="{ off: !rightOpen }"
          title="收起/展开 检查器"
          @click="rightOpen = !rightOpen"
        >
          <span class="i-tabler-layout-sidebar-right-collapse" />
        </button>
        <a-button
          size="small"
          type="text"
          title="A2A RPC/SSE 调试器"
          @click="a2aDebugOpen = true"
        >
          <span class="i-tabler-terminal-2" />
        </a-button>
        <a-button
          size="small"
          type="text"
          title="命令面板(⌘K)"
          @click="paletteOpen = true"
        >
          <span class="i-tabler-command" />
        </a-button>
        <span
          class="dot"
          :style="{ background: stateColor }"
        />
        <span
          class="ws-state"
          :data-state="conn.state"
        >{{ conn.state }}</span>
        <span class="seq">seq {{ lastSeq }}</span>
      </div>
    </div>

    <!-- 主体三栏(左/右侧栏可折叠) -->
    <div class="main">
      <div
        v-if="leftOpen"
        class="left-pane"
      >
        <workshop-channel-session-list :ws-id="wsId" />
      </div>
      <div class="center-pane">
        <template v-if="channelId">
          <workshop-transcript-timeline
            v-if="view === 'timeline'"
            :channel-id="channelId"
          />
          <workshop-agent-lanes-view
            v-else-if="view === 'lanes'"
            :channel-id="channelId"
          />
          <workshop-task-board-view
            v-else-if="view === 'board'"
            :channel-id="channelId"
            @open-task="openTask"
          />
          <workshop-multi-channel-view
            v-else
            :ws-id="wsId"
            @open-task="openTask"
          />
        </template>
        <div
          v-else
          class="no-channel"
        >
          左侧挂载或选择一个 Channel 开始
        </div>
      </div>
      <div
        v-if="rightOpen"
        class="right-pane"
        :class="{ empty: !channelId }"
      >
        <workshop-inspector-panel
          v-if="channelId"
          :channel-id="channelId"
          @open-agent="openAgent"
          @open-task="openTask"
        />
      </div>
    </div>

    <!-- Composer -->
    <div
      v-if="channelId"
      class="composer-pane"
    >
      <!-- Composer -->
      <div
        v-if="channelId"
        ref="composerBox"
        class="composer-pane"
      >
        <workshop-composer :channel-id="channelId" />
      </div>

      <!-- 抽屉 -->
      <workshop-agent-inspector-drawer
        v-model:open="agentDrawerOpen"
        :channel-id="channelId ?? ''"
        :agent-id="agentDrawerId"
      />
      <workshop-task-inspector-drawer
        v-model:open="taskDrawerOpen"
        :channel-id="channelId ?? ''"
        :task-id="taskDrawerId"
      />
      <workshop-a2a-rpc-debugger
        v-model:open="a2aDebugOpen"
        :channel-id="channelId ?? ''"
      />

      <!-- ⌘K 命令面板 -->
      <workshop-command-palette
        v-model:open="paletteOpen"
        :ws-id="wsId"
        @set-view="view = $event"
        @open-a2a-debug="a2aDebugOpen = true"
        @compose="focusComposer"
      />
    </div>
  </div>
</template>

<style scoped>
.harness {
  display: flex;
  flex-direction: column;
  height: calc(100dvh - var(--app-header-h, 60px) - var(--app-footer-h, 46px) - 16px);
  min-height: 0;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 2px;
  overflow: hidden;
  background: var(--paper-raised);
  box-shadow: var(--shadow-card);
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 13px;
  background: color-mix(in srgb, var(--accent-cobalt) 4%, var(--paper-raised));
  border-bottom: 1px solid var(--line);
}
.left,
.right {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ws-name {
  font-family: var(--font-display);
  font-weight: 590;
  font-size: 15px;
}
.view-switch { margin-left: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.ws-state {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 2px;
}
.ws-state[data-state='open'] { color: var(--accent-moss); border-color: color-mix(in srgb, var(--accent-moss) 45%, transparent); }
.ws-state[data-state='connecting'] { color: var(--accent-amber); border-color: color-mix(in srgb, var(--accent-amber) 45%, transparent); }
.ws-state[data-state='closed'] { color: var(--accent-vermilion); border-color: color-mix(in srgb, var(--accent-vermilion) 45%, transparent); }
.seq { font-family: var(--font-mono); font-size: 10px; opacity: 0.5; }

/* 侧栏折叠开关(制图工具钮) */
.pane-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 14px;
  color: var(--ink-soft);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 2px;
  transition: all 0.15s ease;
}
.pane-toggle:hover {
  color: var(--accent-cobalt);
  border-color: var(--accent-cobalt);
}
.pane-toggle.off {
  opacity: 0.4;
}
.pane-toggle.off:hover {
  opacity: 1;
}
.main {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
.left-pane {
  flex: 0 0 240px;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid color-mix(in srgb, currentColor 8%, transparent);
}
.center-pane {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  overflow: hidden;
}
.center-pane > * {
  min-width: 0;
  max-width: 100%;
}
.no-channel {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  opacity: 0.4;
}
.right-pane {
  flex: 0 0 300px;
  min-height: 0;
  overflow: hidden;
  border-left: 1px solid color-mix(in srgb, currentColor 8%, transparent);
}
.right-pane.empty { opacity: 0.35; }
.composer-pane { flex: 0 0 auto; }
</style>
