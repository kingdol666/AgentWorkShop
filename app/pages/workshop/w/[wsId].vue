<script setup lang="ts">
/**
 * Workspace 主控台(Zcode 风格 Harness):
 * 顶栏(WS 状态 + seq)+ 左栏 Channel 会话 + 中部 Transcript + 右侧 Inspector + 底部 Composer。
 * 挂载 workspace 全部 channel 的 WS 订阅;聚焦 channel 驱动中部/右侧上下文。
 */
import { useWorkspacesStore } from '../../../stores/workshop/workspaces'
import { useEntitiesStore } from '../../../stores/workshop/entities'
import { useWorkshopWs } from '../../../composables/workshop/useWorkshopWs'

definePageMeta({ layout: 'default' })

const route = useRoute()
const wsId = computed(() => String(route.params.wsId))
const wsStore = useWorkspacesStore()
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
      </div>
      <div class="right">
        <span
          class="dot"
          :style="{ background: stateColor }"
        />
        <span class="ws-state">{{ conn.state }}</span>
        <span class="seq">seq {{ lastSeq }}</span>
      </div>
    </div>

    <!-- 主体三栏 -->
    <div class="main">
      <div class="left-pane">
        <workshop-channel-session-list :ws-id="wsId" />
      </div>
      <div class="center-pane">
        <template v-if="channelId">
          <workshop-transcript-timeline :channel-id="channelId" />
        </template>
        <div
          v-else
          class="no-channel"
        >
          左侧挂载或选择一个 Channel 开始
        </div>
      </div>
      <div
        class="right-pane"
        :class="{ empty: !channelId }"
      >
        <workshop-inspector-panel
          v-if="channelId"
          :channel-id="channelId"
        />
      </div>
    </div>

    <!-- Composer -->
    <div
      v-if="channelId"
      class="composer-pane"
    >
      <workshop-composer :channel-id="channelId" />
    </div>
  </div>
</template>

<style scoped>
.harness {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 64px - 48px);
  min-height: 0;
  margin: -16px;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: 13px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent);
}
.left,
.right {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ws-name { font-weight: 700; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.ws-state { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.seq { font-family: ui-monospace, Consolas, monospace; font-size: 11px; opacity: 0.5; }
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
