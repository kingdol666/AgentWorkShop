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
//
// ⚠️ 必须先确认"真的没有会话"再弹回工作台。只判 userStore.isLoggedIn 会与
// session-restore 插件**竞态**:该插件是异步的(拿 cookie 里的 token 换用户信息),
// 而 onMounted 同步就执行了 —— 结果刷新 /town 时已登录用户被误弹回 /workshop,
// 整页 3D 根本加载不出来(实测:E2E 里 /town 在窄屏稳定超时,根因就在这里)。
// 判据改成"token cookie 在不在":cookie 在 → 等服务端会话恢复;cookie 不在 → 立刻回去。
const tokenCookie = useCookie<string | null>('token')
const authReady = ref(false)

/**
 * ⚠️ 加载必须**等会话恢复完成**再发。
 *
 * 这里踩过两次,值得写清楚:
 *  1. 原来在 onMounted 里同步判 isLoggedIn —— session-restore 插件是异步的,
 *     判定早于恢复 → 已登录用户被误弹回 /workshop(整页 3D 加载不出来)。
 *     更糟的是它"看起来通过了":弹到 /workshop 后那边有顶栏,响应式属性照样被写上,
 *     于是自动化验收把 /town 记成"通过",而用户看到的其实是工作台。
 *  2. 改成只看 cookie 就放行也不行:此时 store 里还没有 token,wsStore.load() 的请求
 *     不带 Authorization → 401 → 工作区列表为空 → 页面永远停在
 *     「还没有挂载任何 Channel」的空态(实测 390/1440 都是这个结果)。
 *
 * 正确顺序:等 isLoggedIn 为真(会话恢复成功)再 load;只有连 cookie 都没有、
 * 或者 token 被插件判废清掉时,才回工作台。
 */
// 与会话恢复的协作顺序,与 /workshop 总览页**完全一致**
// (refresh → 再 load)。少一步 refresh 时,首次硬导航到 /town 会因为
// 会话尚未落定而拿到空工作区列表,页面永远停在加载态(实测)。
watch(() => userStore.isLoggedIn, async (ok) => {
  if (!ok) {
    authReady.value = false
    return
  }
  // immediate 会在 SSR 期间也跑一次;服务端既没有 localStorage(load 会写本地态),
  // 也不需要加载用户工作区 —— store 侧已加守卫,这里再显式挡一道。
  if (!import.meta.client) return
  await userStore.refresh()
  if (!userStore.isLoggedIn) return
  try {
    await wsStore.load()
    authReady.value = true
  }
  catch {
    // 客户端可重试;服务端静默(message 依赖 DOM)
  }
}, { immediate: true })

onMounted(() => {
  if (!userStore.isLoggedIn && !tokenCookie.value) navigateTo('/workshop')
})

// 会话恢复失败(token 已失效被插件清掉)时,才是真的未登录 —— 这时再回去
watch(tokenCookie, (v) => {
  if (!v && !userStore.isLoggedIn) navigateTo('/workshop')
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
        {{ $t('town.k1wm8wtr001') }}
      </div>
      <div class="pe-sub">
        {{ $t('town.k47e4s002') }} <b>Agent {{ $t('town.k3n4mae005') }}</b> {{ $t('town.k17rerba003') }}
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
      {{ $t('town.k1uc5mup004') }}
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
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
}
</style>
