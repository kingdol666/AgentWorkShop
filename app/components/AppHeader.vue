<script setup lang="ts">
import type { MenuProps, SelectProps } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'

const { t, locale, locales, setLocale } = useI18n()
const store = useAppStore()
const route = useRoute()
const trail = useRouteTrailStore()
const userStore = useUserStore()
const { metaFor } = useRouteMeta()

const localeOptions = computed(() =>
  (locales.value as Array<{ code: string, name: string }>).map(l => ({
    label: l.name,
    value: l.code,
  })),
)

const switchLocale: SelectProps['onChange'] = (value) => {
  if (value != null) {
    setLocale(String(value) as 'zh-CN' | 'en')
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
    class="app-header"
    :style="{
      background: 'var(--app-bg-layout, transparent)',
      borderBottomColor: 'var(--app-border, var(--line))',
    }"
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
                  :aria-label="`关闭 ${metaFor(w.path).title}`"
                  :title="`关闭 ${metaFor(w.path).title}`"
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
          <span class="user-initial aw-avatar">{{ userInitial }}</span>
          <span class="user-meta">
            <span class="user-name">{{ userName }}</span>
            <span class="user-role">{{ userRole }}</span>
          </span>
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
  transform: translateY(1px);
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

/* 标签关闭钮:悬停标签时展开显示(浏览器页签交互);当前页签(朱砂底)用白色保证对比 */
.node-close {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 0;
  height: 16px;
  margin-left: 0;
  overflow: hidden;
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: var(--radius-chip);
  opacity: 0;
  transition: width 0.18s var(--ease-out-quart), margin 0.18s var(--ease-out-quart), opacity 0.18s var(--ease-out-quart), color var(--transition-fast), background var(--transition-fast);
}

.trail-node:hover .node-close {
  width: 16px;
  margin-left: 4px;
  opacity: 1;
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

/* 路由切换进度线:天青→蜜桃粉彩扫过(warm-editorial 光斑声部) */
.plotter-line {
  position: absolute;
  bottom: -1px;
  left: 0;
  width: 100%;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--g-sky) 30%, var(--g-peach));
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
  transition: background var(--transition-fast), color var(--transition-fast);
}

.collapse-btn:hover,
.icon-btn:hover {
  color: var(--ink);
  background: var(--paper-deep);
}

.collapse-btn:active,
.icon-btn:active {
  transform: translateY(1px);
}

.lang-select {
  width: 118px;
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
