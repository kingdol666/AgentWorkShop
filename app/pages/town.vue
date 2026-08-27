<script setup lang="ts">
/**
 * /town —— AgentWorkShop 数字孪生空间(独立全屏页面)
 *
 * 全频道汇聚一镇:加载所有 workspaces 下已挂载的 channel,订阅其实时事件流,
 * 交给 <workshop-town-view>(TownScene3D)把所有 Agent/设备铺到同一个 3D 孪生空间。
 * - 复用全局 WS 单例 useWorkshopWs(任意页面 subscribe 即拿实时流);
 * - snapshot 一次性填充 entities.channels/agents/tasks;
 * - TownScene3D 的 buildBlocks 遍历 entities.channels,天然铺全频道。
 */
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useUserStore } from '@/app/stores/workshop/user'

definePageMeta({ layout: 'town', title: 'Digital Twin' })

const userStore = useUserStore()
const entities = useEntitiesStore()
const wsStore = useWorkspacesStore()
const { subscribe, unsubscribe } = useWorkshopWs()

// 认证 gate + workspace 加载
const authReady = ref(false)
onMounted(() => {
  if (!userStore.isLoggedIn) {
    navigateTo('/workshop')
    return
  }
  authReady.value = true
  void wsStore.load()
})

// 收集所有已挂载 channel 的 id
const allChannelIds = computed<string[]>(() => {
  const ids: string[] = []
  for (const ws of wsStore.workspaces) {
    for (const cid of ws.channelIds ?? []) {
      if (!ids.includes(cid)) ids.push(cid)
    }
  }
  return ids
})

// 订阅所有挂载 channel(挂载后、快照到达前 TownView 显示加载态)
watch(
  () => allChannelIds.value.join(','),
  () => {
    for (const cid of allChannelIds.value) subscribe(cid)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  for (const cid of allChannelIds.value) unsubscribe(cid)
})

// 聚焦频道(供 TownView focusChannel;取第一个已加载频道)
const focusedChannelId = computed(() => {
  const first = allChannelIds.value[0]
  if (first && entities.channels[first]) return first
  for (const ws of wsStore.workspaces) {
    for (const cid of ws.channelIds ?? []) {
      if (entities.channels[cid]) return cid
    }
  }
  return allChannelIds.value[0] ?? undefined
})

const hasChannels = computed(() => allChannelIds.value.length > 0)
</script>

<template>
  <div class="town-page">
    <!-- 无频道:诚实空态 -->
    <div
      v-if="authReady && !hasChannels"
      data-hud="town-empty"
      class="pane-empty"
    >
      <span class="pe-icon i-tabler-map-2" />
      <div class="pe-title">
        还没有挂载任何 Channel
      </div>
      <div class="pe-sub">
        请到 <b>Agent 工作台</b> 创建/挂载频道后,再回到 AgentWorkShop 孪生空间。
      </div>
    </div>
    <!-- 孪生空间(复用 TownView:内部自建 2D/3D 场景 + 全频道铺放 + 模型库/数字孪生/缩放) -->
    <workshop-town-view
      v-else-if="focusedChannelId"
      :channel-id="focusedChannelId"
      :all-channels="true"
    />
    <!-- 加载态 -->
    <div
      v-else
      data-hud="town-loading"
      class="pane-loading"
    >
      正在接入 AgentWorkShop 孪生空间(订阅实时事件流)…
    </div>
  </div>
</template>

<style scoped>
.town-page {
  /* 独立全屏布局(town.vue):占据整个视口,无侧栏/顶栏/页脚的穿插 */
  width: 100vw;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
  /* 赛博小镇背景贴图(3D 场景地面同源;低对比,不影响前景) */
  background: var(--paper) url('/scene/background/cyber-town-background.svg') center / cover no-repeat fixed;
}
.pane-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--ink-faint);
  background: var(--frost-bg);
  backdrop-filter: var(--frost-blur);
  -webkit-backdrop-filter: var(--frost-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
}
.pe-icon { font-size: 30px; opacity: 0.6; }
.pe-title { font-size: 14px; font-weight: 600; color: var(--ink-soft); }
.pe-sub { font-size: 12px; color: var(--ink-faint); }
.pane-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--ink-faint);
  background: var(--frost-bg);
  backdrop-filter: var(--frost-blur);
  -webkit-backdrop-filter: var(--frost-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
}
</style>
