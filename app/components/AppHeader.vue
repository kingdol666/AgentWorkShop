<script setup lang="ts">
import type { MenuProps, SelectProps } from 'ant-design-vue'
import type { AepHitlItem } from '#shared/workshop-protocol'
import { useUserStore } from '@/app/stores/workshop/user'
import { useWsConnectionStore } from '@/app/stores/workshop/connection'
import { useHitlStore } from '@/app/stores/workshop/hitl'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'

const { t, locale, locales, setLocale } = useI18n()
const store = useAppStore()
const route = useRoute()
const trail = useRouteTrailStore()
const userStore = useUserStore()
const { metaFor } = useRouteMeta()

// ── HITL 全局待办(omp ask 对话框 + dcw 审批统一徽标;页头保底建连 ——
//    hitl 全员直推帧只达已连 peer,不建连的页面收不到提醒;快照兜底刷新前待办) ──
const hitl = useHitlStore()
const wsSession = useWorkshopWs()
const ensureHitlLive = () => {
  if (userStore.isLoggedIn) wsSession.ensureConnected()
}
watch(() => userStore.token, (t2) => {
  if (t2) {
    ensureHitlLive()
    void hitl.loadSnapshot()
  }
  else hitl.clear()
}, { immediate: true })
const hitlKindLabel = (kind: AepHitlItem['kind']) =>
  kind === 'omp-dialog' ? t('appHeader.hitlKindOmp') : t('appHeader.hitlKindDcw')
const hitlGo = (item: AepHitlItem) => {
  navigateTo({ path: '/monitor', query: { agentId: item.agentId, channelId: item.channelId } })
}

const localeOptions = computed(() =>
  (locales.value as Array<{ code: string, name: string }>).map(l => ({
    label: l.name,
    value: l.code,
  })),
)

const switchLocale: SelectProps['onChange'] = (value) => {
  if (value != null) {
    // 持久化 + 强刷:setup 期求值的词条(脚本常量)只有重载才能整体切换
    localStorage.setItem('aw.locale', String(value))
    setLocale(String(value) as 'zh-CN' | 'en')
    window.location.reload()
  }
}

// ── 航迹导航:路由变化 → 记录航点;切换时进度线扫过 ──
const hydrated = ref(false)
const plotting = ref(false)
let plotTimer: ReturnType<typeof setTimeout> | null = null

watch(() => route.path, () => {
  trail.visit(route.path)
  plotting.value = false
  requestAnimationFrame(() => {
    plotting.value = true
    if (plotTimer) clearTimeout(plotTimer)
    plotTimer = setTimeout(() => {
      plotting.value = false
    }, 620)
  })
}, { immediate: false })

onMounted(() => {
  hydrated.value = true
  trail.visit(route.path)
})

onBeforeUnmount(() => {
  if (plotTimer) clearTimeout(plotTimer)
})

const go = (path: string) => {
  if (path !== route.path) {
    navigateTo(path)
  }
}

/**
 * 关闭航点标签页:
 * - 非当前页 → 仅从航迹移除;
 * - 当前页 → 先选好跳转目标(优先左侧相邻航点,其次右侧,兜底仪表盘)再移除并跳转,
 *   避免关闭后停留在一个已无标签的路由上(watcher 会在跳转后 visit 目标页,不会回补被关页)。
 */
const closeWaypoint = (path: string) => {
  const idx = trail.remove(path)
  if (path !== route.path) return
  const rest = trail.waypoints
  const target = rest[Math.min(Math.max(idx - 1, 0), Math.max(rest.length - 1, 0))]?.path ?? '/'
  navigateTo(target)
}

const isFullscreen = ref(false)

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen()
    isFullscreen.value = true
  }
  else {
    document.exitFullscreen()
    isFullscreen.value = false
  }
}

// 用户铭牌:真实身份(workshop 用户系统;未登录 = 访客)
const userInitial = computed(() => (userStore.user?.name ?? '?').trim().charAt(0).toUpperCase())
const userName = computed(() => userStore.user?.name ?? t('header.guest'))
const userRole = computed(() => (userStore.isLoggedIn ? userStore.user?.role ?? 'user' : 'anonymous'))

// ── 实时连接状态点(全局 WS 单例的诚实在线指示;断连不假装在线) ──
const conn = useWsConnectionStore()
const wsVisible = computed(() => conn.state !== 'closed' || conn.lastDataAt > 0)
const wsClass = computed(() => {
  if (conn.state === 'open') return conn.pendingReplay ? 'syncing' : 'live'
  if (conn.state === 'connecting') return 'syncing'
  return 'down'
})
const wsLabel = computed(() => {
  if (conn.state === 'open') return conn.pendingReplay ? t('appHeader.kwsdot0002') : t('appHeader.kwsdot0001')
  if (conn.state === 'connecting') return t('appHeader.kwsdot0003')
  return t('appHeader.kwsdot0004')
})

interface AvatarMenuEntry {
  key: string
  label: string
  icon?: string
  danger?: boolean
  divider?: boolean
}

const avatarItems = computed<AvatarMenuEntry[]>(() => {
  const items: AvatarMenuEntry[] = [
    { key: 'tokens', icon: 'i-tabler-key', label: t('menu.tokens') },
    { key: 'settings', icon: 'i-tabler-adjustments', label: t('menu.settings') },
  ]
  if (userStore.isLoggedIn) {
    items.push({ key: 'd-logout', label: '', divider: true })
    items.push({ key: 'logout', icon: 'i-tabler-logout', label: t('header.logout'), danger: true })
  }
  return items
})

const onAvatarMenu: MenuProps['onClick'] = async ({ key }) => {
  if (key === 'settings') {
    navigateTo('/settings')
  }
  else if (key === 'tokens') {
    navigateTo('/tokens')
  }
  else if (key === 'logout') {
    await userStore.logout()
    navigateTo('/workshop')
  }
}
</script>

<template>
  <a-layout-header
    class="app-header app-header-glass"
  >
    <!-- 左侧:折叠 + 航迹标绘轨 -->
    <div class="header-left">
      <button
        class="collapse-btn"
        :aria-label="store.sidebarCollapsed ? t('header.expand') : t('header.collapse')"
        @click="store.toggleSidebar()"
      >
        <span class="i-tabler-menu-2" />
      </button>

      <span class="rail-mark i-tabler-route" />

      <nav
        class="trail"
        :aria-label="t('header.trail')"
      >
        <transition-group
          name="stamp"
          tag="div"
          class="trail-row"
        >
          <template v-if="hydrated">
            <template
              v-for="(w, i) in trail.waypoints"
              :key="w.path"
            >
              <span
                v-if="i > 0"
                :key="`link-${w.path}`"
                class="trail-link"
                aria-hidden="true"
              />
              <div
                class="trail-node"
                :class="{ active: w.path === route.path }"
                role="button"
                tabindex="0"
                :title="metaFor(w.path).title"
                @click="go(w.path)"
                @keydown.enter.prevent="go(w.path)"
              >
                <span
                  class="node-icon"
                  :class="metaFor(w.path).icon"
                />
                <span class="node-title">{{ metaFor(w.path).title }}</span>
                <button
                  class="node-close"
                  :aria-label="$t('appHeader.kzwjv99001', { p0: metaFor(w.path).title })"
                  :title="$t('appHeader.kzwjv99001', { p0: metaFor(w.path).title })"
                  @click.stop="closeWaypoint(w.path)"
                >
                  <span class="i-tabler-x" />
                </button>
              </div>
            </template>
          </template>
        </transition-group>
      </nav>
    </div>

    <!-- 右侧:功能集群 -->
    <div class="header-right">
      <!-- HITL 待办铃标(有待办才出现;点击下拉 → 进入对应 agent 终端处理) -->
      <ClientOnly>
        <a-dropdown
          v-if="hitl.count > 0"
          placement="bottomRight"
        >
          <button
            class="icon-btn hitl-bell"
            :title="t('appHeader.hitlBadge')"
          >
            <span class="i-tabler-bell-ringing" />
            <span class="hitl-count">{{ hitl.count }}</span>
          </button>
          <template #overlay>
            <div class="hitl-menu">
              <div class="hitl-menu-title">
                {{ t('appHeader.hitlBadge') }} · {{ hitl.count }}
              </div>
              <button
                v-for="item in hitl.items"
                :key="`${item.kind}:${item.id}`"
                class="hitl-item"
                @click="hitlGo(item)"
              >
                <span class="hitl-item-top">
                  <span class="hitl-item-agent">{{ item.agentName }}</span>
                  <span class="hitl-item-kind">{{ hitlKindLabel(item.kind) }}</span>
                </span>
                <span class="hitl-item-title">{{ item.title }}</span>
              </button>
            </div>
          </template>
        </a-dropdown>
      </ClientOnly>
      <!-- 实时连接状态点(WS 会话全局单例;未用过 WS 的会话不显示) -->
      <span
        v-if="wsVisible"
        class="ws-dot"
        :class="wsClass"
        :title="wsLabel"
      />
      <a-tooltip :title="t('header.fullscreen')">
        <button
          class="icon-btn"
          @click="toggleFullscreen"
        >
          <span
            class="i-tabler-arrows-maximize"
            :class="{ hidden: isFullscreen }"
          />
          <span
            class="i-tabler-arrows-minimize"
            :class="{ hidden: !isFullscreen }"
          />
        </button>
      </a-tooltip>

      <a-select
        id="hdr-locale"
        :value="locale"
        size="middle"
        :options="localeOptions"
        class="lang-select"
        @change="switchLocale"
      />

      <a-tooltip :title="store.isDark ? t('common.light') : t('common.dark')">
        <button
          class="icon-btn"
          @click="store.toggleDark()"
        >
          <span
            class="i-tabler-sun-high"
            :class="{ hidden: store.isDark }"
          />
          <span
            class="i-tabler-moon-stars"
            :class="{ hidden: !store.isDark }"
          />
        </button>
      </a-tooltip>

      <a-dropdown>
        <div class="user-chip">
          <!-- 用户身份(session 异步解析)仅客户端可知:SSR 渲染中性占位,挂载后填充
               —— 消除 hydration mismatch(unhead dispose 噪音的根因) -->
          <ClientOnly>
            <span class="user-initial aw-avatar">{{ userInitial }}</span>
            <span class="user-meta">
              <span class="user-name">{{ userName }}</span>
              <span class="user-role">{{ userRole }}</span>
            </span>
            <template #fallback>
              <span class="user-initial aw-avatar">·</span>
              <span class="user-meta">
                <span class="user-name">·</span>
                <span class="user-role">·</span>
              </span>
            </template>
          </ClientOnly>
        </div>
        <template #overlay>
          <a-menu @click="onAvatarMenu">
            <template
              v-for="item in avatarItems"
              :key="item.key"
            >
              <a-menu-divider v-if="item.divider" />
              <a-menu-item
                v-else
                :key="item.key"
                :danger="item.danger"
              >
                <span
                  :class="item.icon"
                  class="mr-2"
                />
                {{ item.label }}
              </a-menu-item>
            </template>
          </a-menu>
        </template>
      </a-dropdown>
    </div>

    <!-- 绘图仪进度线:路由切换时自左向右扫过 -->
    <span
      class="plotter-line"
      :class="{ run: plotting }"
      aria-hidden="true"
    />
  </a-layout-header>
</template>

<style scoped>
.app-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--app-header-h, 56px);
  padding: 0 20px 0 10px;
  overflow: hidden;
  border-bottom: 1px solid var(--divider-hair);
  transition: background 0.3s ease, border-color 0.3s ease;
}

/* 顶栏玻璃:透出极光画布;下缘发丝线 + 微暗渐变保对比 */
.app-header-glass {
  position: sticky;
  top: 0;
  z-index: 30;
  background: linear-gradient(180deg, var(--frost-bg), color-mix(in srgb, var(--frost-bg) 72%, transparent));
  backdrop-filter: var(--aurora-blur);
  -webkit-backdrop-filter: var(--aurora-blur);
  border-bottom: 1px solid var(--glass-line);
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* ── 航迹标绘轨 ── */
.rail-mark {
  flex: 0 0 auto;
  font-size: 15px;
  color: var(--ink-faint);
}

.trail {
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(90deg, transparent 0, black 8px, black calc(100% - 18px), transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0, black 8px, black calc(100% - 18px), transparent 100%);
}

.trail::-webkit-scrollbar {
  display: none;
}

.trail-row {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 3px 4px;
  white-space: nowrap;
}

/* 航点间细线:同色系 hairline */
.trail-link {
  flex: 0 0 auto;
  width: 14px;
  height: 1px;
  background: var(--line-strong);
}

/* 航点:chip 圆角描边,悬停抬亮,当前页墨色填充(ink pill) */
.trail-node {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  gap: 6px;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  font-family: var(--font-body);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--app-text, var(--ink-soft));
  cursor: pointer;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.trail-node:hover {
  color: var(--ink);
  background: var(--paper-tint);
  border-color: var(--line-strong);
}

.trail-node:active {
  transform: scale(0.98);
}

.trail-node:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.trail-node.active {
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}

.node-icon {
  font-size: 13px;
}

.node-title {
  max-width: 132px;
  overflow: hidden;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: max-width 0.18s var(--ease-out-quart), margin 0.18s var(--ease-out-quart), opacity 0.18s var(--ease-out-quart);
}

/* 标签关闭钮:槽位常驻(零布局抖动),悬停标签时图标淡入展开(浏览器页签交互);
 * 当前页签(朱砂底)用白色保证对比 */
.node-close {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 4px;
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: var(--radius-chip);
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity 0.18s var(--ease-out-quart),
    transform 0.18s var(--ease-out-quart),
    color var(--transition-fast),
    background var(--transition-fast);
}

.trail-node:hover .node-close,
.trail-node:focus-within .node-close {
  opacity: 1;
  transform: none;
}

.node-close:hover {
  color: var(--ink);
  background: var(--hover-tint);
}

.node-close:active {
  transform: scale(0.9);
}

.trail-node.active .node-close {
  color: color-mix(in srgb, var(--on-accent) 85%, transparent);
}

.trail-node.active .node-close:hover {
  color: var(--on-accent);
  background: color-mix(in srgb, var(--on-accent) 18%, transparent);
}

.node-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* 航点进场:轻抬升淡入 */
.stamp-enter-active {
  transition: opacity 0.22s var(--ease-out-quart), transform 0.22s var(--ease-out-quart);
}

.stamp-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.stamp-leave-active {
  position: absolute;
  transition: opacity 0.14s ease;
}

.stamp-leave-to {
  opacity: 0;
}

.stamp-move {
  transition: transform 0.22s ease;
}

/* 路由切换进度线:墨色细扫过(替换原天青→蜜桃粉彩渐变,色锁:温灰下仅墨色动线) */
.plotter-line {
  position: absolute;
  bottom: -1px;
  left: 0;
  width: 100%;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--ink-fainter) 30%, var(--accent));
  opacity: 0;
  pointer-events: none;
  transform: scaleX(0);
  transform-origin: left center;
}

.plotter-line.run {
  animation: plot-sweep 0.6s cubic-bezier(0.3, 0.8, 0.4, 1) forwards;
}

@keyframes plot-sweep {
  0% {
    transform: scaleX(0);
    opacity: 0.9;
  }

  70% {
    opacity: 0.9;
  }

  100% {
    transform: scaleX(1);
    opacity: 0;
  }
}

/* 幽灵图标钮:无描边,悬停浮 surface(open-tag tp-close 声部) */
.collapse-btn,
.icon-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  font-size: 16px;
  color: var(--app-text, var(--ink-soft));
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.collapse-btn:hover,
.icon-btn:hover {
  color: var(--ink);
  background: var(--paper-deep);
}

.collapse-btn:active,
.icon-btn:active {
  transform: scale(0.94);
}

.lang-select {
  width: 118px;
}

/* 语言选择器:令牌驱动(主题失配时 antd 兜底色会露白,这里显式钉死) */
.lang-select :deep(.ant-select-selector) {
  color: var(--app-text, var(--ink));
  background: transparent !important;
  border-color: var(--app-border, var(--line)) !important;
}

.lang-select :deep(.ant-select-arrow) {
  color: var(--app-text-secondary, var(--ink-faint));
}

/* 操作者铭牌:头像 + 双行 */
.user-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 42px;
  margin-left: 4px;
  padding: 0 12px 0 8px;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  transition: border-color 0.16s ease, background 0.16s ease;
}

.user-chip:hover {
  border-color: var(--line);
  background: var(--hover-tint);
}

.user-initial {
  width: 28px;
  height: 28px;
  font-size: 12px;
}

.user-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.user-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--app-text, var(--ink));
  letter-spacing: 0.01em;
}

.user-role {
  font-family: var(--font-mono);
  font-size: 8.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--app-text-secondary, var(--ink-faint));
}

.hidden {
  display: none;
}

/* 实时连接状态点(诚实在线:open=绿/syncing=琥珀呼吸/closed=红;reduced-motion 全局收敛) */
.ws-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--tone-success-dot);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-success-dot) 55%, transparent);
}
.ws-dot.syncing {
  background: var(--tone-warning-dot);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-warning-dot) 55%, transparent);
  animation: ws-pulse 1.2s ease-in-out infinite;
}
.ws-dot.down {
  background: var(--tone-danger-dot);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-danger-dot) 55%, transparent);
}
@keyframes ws-pulse {
  50% { opacity: 0.45; }
}

/* ── HITL 待办铃标(琥珀警示;角标数字极简,无装饰堆砌) ── */
.hitl-bell {
  position: relative;
  color: var(--tone-warning-dot, #d4a017);
}
.hitl-count {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 15px;
  color: var(--on-accent, #fff);
  text-align: center;
  background: var(--tone-danger-dot, #e05252);
  border-radius: 8px;
}
.hitl-menu {
  min-width: 260px;
  max-width: 340px;
  padding: 6px;
  background: var(--paper, #fff);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm, 10px);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.14);
}
.hitl-menu-title {
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line);
}
.hitl-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  margin-top: 4px;
  padding: 8px 10px;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-panel-sm, 8px);
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.hitl-item:hover {
  background: var(--paper-deep);
  border-color: var(--line);
}
.hitl-item-top {
  display: flex;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
}
.hitl-item-agent {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
}
.hitl-item-kind {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--tone-warning-dot, #d4a017);
}
.hitl-item-title {
  overflow: hidden;
  font-size: 12px;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .plotter-line.run {
    animation: none;
    opacity: 0;
  }

  .stamp-enter-active,
  .stamp-leave-active,
  .stamp-move {
    transition: none;
  }
}
</style>
