<script setup lang="ts">
import type { MenuProps, SelectProps } from 'ant-design-vue'

const { t, locale, locales, setLocale } = useI18n()
const store = useAppStore()
const route = useRoute()
const trail = useRouteTrailStore()
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

// ── 航迹导航:路由变化 → 记录航点;切换时绘图仪进度线扫过 ──
const hydrated = ref(false)
const plotting = ref(false)
let plotTimer: ReturnType<typeof setTimeout> | null = null

watch(() => route.path, (path) => {
  trail.visit(path)
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

const waypointIndex = (i: number) => String(i + 1).padStart(2, '0')

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

const avatarItems = [
  { key: 'profile', icon: 'i-tabler-user', label: t('header.profile') },
  { key: 'settings', icon: 'i-tabler-adjustments', label: t('menu.settings') },
  { type: 'divider' as const },
  { key: 'logout', icon: 'i-tabler-logout', label: t('header.logout'), danger: true },
]

const onAvatarMenu: MenuProps['onClick'] = ({ key }) => {
  if (key === 'settings') {
    navigateTo('/settings')
  }
}
</script>

<template>
  <a-layout-header
    class="app-header"
    :style="{
      background: 'var(--app-bg-layout, transparent)',
      borderBottomColor: 'var(--app-border, #d3ccb8)',
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
              <button
                class="trail-node"
                :class="{ active: w.path === route.path }"
                :title="`${waypointIndex(i)} · ${metaFor(w.path).title}`"
                @click="go(w.path)"
              >
                <span class="node-index">{{ waypointIndex(i) }}</span>
                <span
                  class="node-icon"
                  :class="metaFor(w.path).icon"
                />
                <span class="node-title">{{ metaFor(w.path).title }}</span>
                <span
                  v-if="w.path === route.path"
                  class="node-here"
                  aria-hidden="true"
                />
              </button>
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
          <span class="user-initial">A</span>
          <span class="user-meta">
            <span class="user-name">Admin</span>
            <span class="user-role">operator</span>
          </span>
        </div>
        <template #overlay>
          <a-menu @click="onAvatarMenu">
            <a-menu-item
              v-for="item in avatarItems"
              :key="item.key ?? 'divider'"
              :divider="item.type === 'divider'"
              :danger="item.danger"
            >
              <span
                v-if="item.icon"
                :class="item.icon"
                class="mr-2"
              />
              {{ item.label }}
            </a-menu-item>
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

/* 航点间点线:图纸坐标连线 */
.trail-link {
  flex: 0 0 auto;
  width: 16px;
  height: 0;
  border-top: 1px dashed var(--line-strong);
}

/* 航点票券:方角描边,悬停抬升,当前页钴蓝填充 + 朱红"在此"角标 */
.trail-node {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  gap: 6px;
  align-items: center;
  height: 32px;
  padding: 0 10px 0 8px;
  font-family: var(--font-mono);
  color: var(--app-text, var(--ink-soft));
  cursor: pointer;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip, 8px);
  transition: background var(--transition-fast, 0.12s ease), color var(--transition-fast, 0.12s ease);
}

.trail-node:hover {
  color: var(--ink);
  background: var(--paper-tint);
}

.trail-node:active {
  background: var(--paper-tint);
}

.trail-node:focus-visible {
  outline: 2px solid var(--accent-cobalt);
  outline-offset: 2px;
}

.trail-node.active {
  color: var(--paper);
  background: var(--accent-cobalt);
  border-color: var(--accent-cobalt);
}

.node-index {
  font-size: 9px;
  letter-spacing: 0.08em;
  opacity: 0.55;
}

.node-icon {
  font-size: 13px;
}

.node-title {
  max-width: 132px;
  overflow: hidden;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-overflow: ellipsis;
  text-transform: uppercase;
}

/* 当前页右上角朱红三角:图纸"you are here"记号(内嵌定位,避免被轨 clip) */
.node-here {
  position: absolute;
  top: 0;
  right: 0;
  width: 0;
  height: 0;
  border-top: 7px solid var(--paper-raised);
  border-bottom: 7px solid transparent;
  border-left: 7px solid transparent;
  opacity: 0.85;
}

/* 盖章进场:微缩放 + 轻微落章偏转 */
.stamp-enter-active {
  transition: all 0.22s cubic-bezier(0.2, 1.4, 0.4, 1);
}

.stamp-enter-from {
  opacity: 0;
  transform: scale(0.82) rotate(-2deg);
}

.stamp-leave-active {
  position: absolute;
  transition: all 0.14s ease;
}

.stamp-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

.stamp-move {
  transition: transform 0.22s ease;
}

/* 绘图仪进度线 */
.plotter-line {
  position: absolute;
  bottom: -1px;
  left: 0;
  width: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--accent-cobalt) 30%, var(--accent-cobalt));
  opacity: 0;
  pointer-events: none;
}

.plotter-line.run {
  animation: plot-sweep 0.6s cubic-bezier(0.3, 0.8, 0.4, 1) forwards;
}

@keyframes plot-sweep {
  0% {
    width: 0;
    opacity: 0.9;
  }

  70% {
    opacity: 0.9;
  }

  100% {
    width: 100%;
    opacity: 0;
  }
}

/* 方角描边按钮(制图工具感),悬停显钴蓝 */
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
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm, 10px);
  transition: background var(--transition-fast, 0.12s ease), color var(--transition-fast, 0.12s ease);
}

.collapse-btn:hover,
.icon-btn:hover {
  color: var(--accent-cobalt);
  border-color: var(--accent-cobalt);
  transform: translate(-1px, -1px);
}

.collapse-btn:active,
.icon-btn:active {
  transform: translate(1px, 1px);
  box-shadow: 0 0 0 transparent;
}

.lang-select {
  width: 118px;
}

/* 操作者徽记:方印 + 双行铭牌 */
.user-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 42px;
  margin-left: 4px;
  padding: 0 12px 0 8px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.16s ease;
}

.user-chip:hover {
  border-color: var(--line);
  background: var(--hover-tint);
}

.user-initial {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-family: var(--font-display);
  font-size: 14px;
  font-style: italic;
  color: var(--paper);
  background: var(--accent-cobalt);
  border-radius: var(--radius-chip, 8px);
  box-shadow: 1.5px 1.5px 0 rgb(27 39 51 / 30%);
}

.user-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.user-name {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--app-text, var(--ink));
  letter-spacing: 0.03em;
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
