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

// 订阅所有挂载 channel(挂载后、快照到达前 TownView 显示加载态)。
// 按差集增删:页面存活期间频道被卸载必须退订 —— 此前只增不退,旧频道帧持续推送(泄漏修复 2026-11-06)
const subscribedIds = new Set<string>()
watch(
  () => allChannelIds.value.join(','),
  () => {
    const wanted = new Set(allChannelIds.value)
    for (const cid of wanted) {
      if (!subscribedIds.has(cid)) {
        subscribe(cid)
        subscribedIds.add(cid)
      }
    }
    for (const cid of [...subscribedIds]) {
      if (!wanted.has(cid)) {
        unsubscribe(cid)
        subscribedIds.delete(cid)
      }
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  for (const cid of subscribedIds) unsubscribe(cid)
  subscribedIds.clear()
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
    <!-- 路由负责加载/空态；3D 进入后由 TownView 接管场景与导航。 -->
    <main
      v-if="!authReady || !hasChannels || !focusedChannelId"
      class="town-state"
    >
      <header class="town-state-header">
        <AppBackToMain v-if="!authReady || !hasChannels || !focusedChannelId" />
        <span>{{ $t('menu.town') }}</span>
      </header>
      <section
        v-if="authReady && !hasChannels"
        data-hud="town-empty"
        class="town-state-card"
      >
        <span
          class="town-state-icon i-tabler-map-2"
          aria-hidden="true"
        />
        <h1>{{ $t('town.k1wm8wtr001') }}</h1>
        <p>
          {{ $t('town.k47e4s002') }} <b>Agent {{ $t('town.k3n4mae005') }}</b> {{ $t('town.k17rerba003') }}
        </p>
        <NuxtLink
          class="pill-btn"
          to="/workshop"
        >{{ $t('menu.workshop') }}</NuxtLink>
      </section>
      <div
        v-else
        data-hud="town-loading"
        class="town-state-card"
        role="status"
      >
        <span
          class="town-state-icon town-loading-icon i-tabler-loader-2"
          aria-hidden="true"
        />
        <p>{{ $t('town.k1uc5mup004') }}</p>
      </div>
    </main>
    <template v-else>
      <AppBackToMain
        v-if="!authReady"
        class="town-scene-back"
      />
      <workshop-town-view
        :channel-id="focusedChannelId"
        :all-channels="true"
      />
    </template>
  </div>
</template>

<style scoped>
.town-page {
  position: relative;
  width: 100%;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
  background: var(--paper) url('/scene/background/cyber-town-background.svg') center / cover no-repeat;
}
.town-state {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: 100%;
  padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
    max(32px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  overflow: auto;
  background: var(--frost-bg);
}
.town-state-header { display: flex; gap: 12px; align-items: center; color: var(--ink); font-weight: 600; }
.town-scene-back {
  position: absolute;
  top: max(16px, env(safe-area-inset-top));
  left: max(16px, env(safe-area-inset-left));
  z-index: 30;
  color: var(--ink);
}
.town-state-card {
  box-sizing: border-box;
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  width: min(100%, 30rem);
  margin: auto;
  padding: clamp(16px, 4vw, 28px);
  text-align: center;
  overflow-wrap: anywhere;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.town-state-icon { color: var(--accent); font-size: 28px; }
.town-state-card h1 { margin: 0; color: var(--ink); font-size: 18px; font-weight: 600; }
.town-state-card p { margin: 0; color: var(--ink-soft); font-size: 13px; line-height: 1.5; }
@media (prefers-reduced-motion: no-preference) {
  .town-loading-icon { animation: town-shell-spin 1.2s linear infinite; }
}
@keyframes town-shell-spin { to { transform: rotate(360deg); } }
</style>
