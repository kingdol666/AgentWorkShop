<script setup lang="ts">
import { useUserStore } from '~/stores/workshop/user'

const userStore = useUserStore()
const { t } = useI18n()
const route = useRoute()
const site = useSiteConfig()
const store = useAppStore()

interface MenuItem {
  key: string
  icon: string
  label: string
  /** 图标微动效类(im-*) */
  motion?: string
  /** 仅 admin 可见(权限管理) */
  adminOnly?: boolean
}

interface MenuGroup {
  id: string
  label: string
  items: MenuItem[]
}

/**
 * 是否已完成客户端水合。
 * 服务端拿不到会话(cookie 里的 workshop.user 只在浏览器可读),
 * 任何"按身份增删 DOM"的渲染都必须由它门控,否则 SSR 与客户端首帧结构不一致。
 */
const navHydrated = ref(false)

/**
 * 导航信息架构:12 个平铺条目 → 三组语义分区(控制台 / 运维 / 系统)。
 * 分组的价值不在多一层容器,而在"扫视成本":同组内的入口是同一件事的不同面,
 * 组与组之间才是真正的语境切换。空组自动折叠,权限过滤后不残留空标题。
 */
const menuGroups = computed<MenuGroup[]>(() => [
  {
    id: 'console',
    label: t('menu.groups.console'),
    items: [
      { key: '/', icon: 'i-tabler-layout-dashboard', label: t('menu.dashboard'), motion: 'im-pop' },
      { key: '/workshop', icon: 'i-tabler-box', label: t('menu.workshop'), motion: 'im-pop' },
      // 项目中心：Project 层入口（工作台管"频道会话"，项目中心管"目标→交付→验收"）
      { key: '/projects', icon: 'i-tabler-briefcase', label: t('menu.projects'), motion: 'im-pop' },
      { key: '/town', icon: 'i-tabler-map-2', label: t('menu.town'), motion: 'im-pop' },
      { key: '/daq', icon: 'i-tabler-activity', label: t('menu.daq'), motion: 'im-pop' },
      { key: '/dcw', icon: 'i-tabler-settings-automation', label: t('menu.dcw'), motion: 'im-pop' },
      { key: '/data', icon: 'i-tabler-database-export', label: t('menu.dataManagement'), motion: 'im-pop' },
      { key: '/studio', icon: 'i-tabler-chart-dots', label: t('menu.studio'), motion: 'im-pop' },
      { key: '/aml', icon: 'i-tabler-flask', label: t('menu.aml'), motion: 'im-pop' },
      { key: '/optimizer', icon: 'i-tabler-math-function', label: t('menu.optimizer'), motion: 'im-pop' },
      { key: '/ontology', icon: 'i-tabler-sitemap', label: t('menu.ontology'), motion: 'im-pop' },
      { key: '/memory', icon: 'i-tabler-brain', label: t('menu.memory'), motion: 'im-pop' },
    ],
  },
  {
    id: 'ops',
    label: t('menu.groups.ops'),
    items: [
      { key: '/operations', icon: 'i-tabler-broadcast', label: t('menu.operations'), motion: 'im-pop' },
      { key: '/analysis', icon: 'i-tabler-report-analytics', label: t('menu.analysis'), motion: 'im-pop' },
      { key: '/monitor', icon: 'i-tabler-cpu', label: t('menu.monitor'), motion: 'im-pulse' },
      { key: '/logs', icon: 'i-tabler-list-details', label: t('menu.logs'), motion: 'im-pop' },
    ],
  },
  {
    id: 'system',
    label: t('menu.groups.system'),
    items: [
      { key: '/tokens', icon: 'i-tabler-key', label: t('menu.tokens'), motion: 'im-nudge-up' },
      { key: '/users', icon: 'i-tabler-users-group', label: t('menu.users'), motion: 'im-pop' },
      { key: '/permissions', icon: 'i-tabler-shield-lock', label: t('menu.permissions'), motion: 'im-pop', adminOnly: true },
      { key: '/plugins', icon: 'i-tabler-puzzle', label: t('menu.plugins'), motion: 'im-pop' },
      { key: '/tools', icon: 'i-tabler-tools', label: t('menu.tools'), motion: 'im-pop', adminOnly: true },
      { key: '/settings', icon: 'i-tabler-settings', label: t('menu.settings'), motion: 'im-rotate' },
    ],
  },
]
  /* ⚠️ admin-only 条目必须等挂载后再放行:服务端没有会话(读不到 cookie 里的
   * workshop.user),SSR 会少渲染「权限管理」这一条 → 客户端多一条 →
   * 实测触发 Hydration 链式 mismatch(插件管理/系统设置的图标与文案整体错位一格)。
   * 用 navHydrated 门控后,服务端与客户端首帧的 v-for 长度一致,水合干净。 */
  .map(g => ({ ...g, items: g.items.filter(m => !m.adminOnly || (navHydrated.value && userStore.isAdmin)) }))
  .filter(g => g.items.length > 0))

const isCurrent = (key: string): boolean => route.path === key

const isActive = (key: string): boolean =>
  isCurrent(key) || (key !== '/' && route.path.startsWith(`${key}/`))

function onMenuClick(event: MouseEvent) {
  // Modified clicks are opening another tab, not leaving the current workspace.
  if (isDrawer.value && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    store.closeMobileNav()
  }
}

/* ── 响应式形态 ──────────────────────────────────────────────────────────
 * 同一份导航有三种形态,由视口决定,不新增组件(避免三份 IA 各自漂移):
 *   ≥1024      三栏仪表台:跟随用户的折叠偏好
 *   900–1023   双栏:强制图标轨 —— 228px 文字轨会把画布压到不可用
 *   <900       抽屉:强制展开(抽屉关着时展开与否无意义),汉堡开合 */
const { isDrawer, isTablet } = useResponsive()

/* 形态属性只在挂载后渲染:SSR 没有视口、一律按桌面档出 HTML,
 * 若首帧就把 data-nav-mode="drawer" 打上去,水合时属性对不上会报 mismatch。
 * 布局本身由 body 类 + CSS 媒体查询兜住,不依赖这个属性。 */
onMounted(() => {
  navHydrated.value = true
})
const navMode = computed(() =>
  navHydrated.value ? (isDrawer.value ? 'drawer' : (isTablet.value ? 'rail' : 'full')) : undefined)

const effectiveCollapsed = computed(() =>
  isDrawer.value ? false : isTablet.value ? true : store.sidebarCollapsed)

const showLabels = computed(() => !effectiveCollapsed.value)

const drawerOpen = computed(() => isDrawer.value && store.mobileNavOpen)

/** 路由变化即收抽屉:抽屉是"去别处"的中转,不是常驻面板 */
watch(() => route.path, () => {
  if (store.mobileNavOpen) store.closeMobileNav()
})

/**
 * 形态镜像到 <body>(nav-drawer / nav-drawer-open)。
 *
 * 为什么不用 :class 直接打在 a-layout-sider 上:实测 antd 的 Sider 不会把
 * 动态 class 落到它渲染的 <aside> 上(静态 class 可以,DOM 里查不到 is-drawer)。
 * 依赖第三方组件的 attr 透传行为来做**结构性**布局是脆的 ——
 * 改为把形态写在 body 上,CSS 由 main.css 的响应式层接管,只依赖自己的状态。
 */
watchEffect(() => {
  if (typeof document === 'undefined') return
  document.body.classList.toggle('nav-drawer', isDrawer.value)
  document.body.classList.toggle('nav-drawer-open', drawerOpen.value)
})

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.body.classList.remove('nav-drawer', 'nav-drawer-open')
})

/** 抽屉关闭时只还原自己的滚动锁，保留原有的轴向值和优先级。 */
const nav = ref<HTMLElement | null>(null)
let releaseScrollLock: (() => void) | undefined
let returnFocus: HTMLElement | null = null
let navToggle: HTMLButtonElement | null = null
let addedControls = false

function lockBodyScroll() {
  const { style } = document.body
  const overflow = ['overflow-x', 'overflow-y'].map(name => ({
    name,
    value: style.getPropertyValue(name),
    priority: style.getPropertyPriority(name),
  }))
  style.setProperty('overflow', 'hidden')
  return () => {
    for (const { name, value, priority } of overflow) {
      if (style.getPropertyValue(name) !== 'hidden' || style.getPropertyPriority(name)) continue
      if (value) style.setProperty(name, value, priority)
      else style.removeProperty(name)
    }
  }
}

watch([navHydrated, drawerOpen], async ([hydrated, open]) => {
  if (!hydrated) return
  if (open) {
    const active = document.activeElement
    returnFocus = active instanceof HTMLElement && active !== document.body && !nav.value?.contains(active)
      ? active
      : navToggle
    releaseScrollLock = lockBodyScroll()
    await nextTick()
    if (drawerOpen.value) nav.value?.querySelector<HTMLElement>('.menu-item')?.focus()
  }
  else {
    releaseScrollLock?.()
    releaseScrollLock = undefined
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    returnFocus = null
  }
})

function onKeydown(e: KeyboardEvent) {
  if (!drawerOpen.value || e.defaultPrevented) return
  if (e.key === 'Escape') {
    e.preventDefault()
    store.closeMobileNav()
  }
  else if (e.key === 'Tab') {
    const buttons = nav.value?.querySelectorAll<HTMLElement>('.menu-item')
    const first = buttons?.[0]
    const last = buttons?.[buttons.length - 1]
    const active = document.activeElement
    if (!nav.value?.contains(active) || active === (e.shiftKey ? first : last)) {
      e.preventDefault()
      ;(e.shiftKey ? last : first)?.focus()
    }
  }
}

onMounted(() => {
  // The existing header trigger lives outside this component.
  navToggle = nav.value?.closest('.app-layout')?.querySelector<HTMLButtonElement>('.app-header .collapse-btn') ?? null
  if (navToggle && !navToggle.hasAttribute('aria-controls')) {
    navToggle.setAttribute('aria-controls', 'app-sidebar')
    addedControls = true
  }
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  releaseScrollLock?.()
  if (addedControls) navToggle?.removeAttribute('aria-controls')
})
</script>

<template>
  <a-layout-sider
    id="app-sidebar"
    :collapsed="effectiveCollapsed"
    :trigger="null"
    collapsible
    :width="228"
    :collapsed-width="64"
    class="app-sider"
    :data-nav-mode="navMode"
    :inert="navHydrated && isDrawer && !drawerOpen"
    :aria-hidden="navHydrated && isDrawer && !drawerOpen ? 'true' : undefined"
  >
    <!-- 品牌区:AwLogo 门架 A 字标(单一实心剪影,currentColor 随主题;与 favicon/桌面图标同源) -->
    <div
      class="logo"
      data-aw-shell-brand
    >
      <div
        class="logo-mark"
        aria-hidden="true"
      >
        <AwLogo :size="26" />
      </div>
      <transition name="slide-fade">
        <div
          v-show="showLabels"
          class="logo-text"
        >
          <span class="logo-title">{{ site.name }}</span>
          <span class="logo-sub">digital twin</span>
        </div>
      </transition>
    </div>

    <nav
      class="app-menu"
      :aria-label="t('header.openNav')"
    >
      <div
        v-for="group in menuGroups"
        :key="group.id"
        class="menu-group"
      >
        <!-- 分组标:mono 微字 + 收尾 hairline(仪器命名牌 + 刻度线的同一语言) -->
        <div
          v-show="showLabels"
          class="menu-group-label"
        >
          <span class="menu-group-text">{{ group.label }}</span>
          <span
            class="menu-group-rule"
            aria-hidden="true"
          />
        </div>
        <div
          v-show="!showLabels"
          class="menu-group-sep"
          aria-hidden="true"
        />
        <NuxtLink
          v-for="item in group.items"
          :key="item.key"
          :to="item.key"
          class="menu-item im"
          :class="{ active: isActive(item.key) }"
          :aria-current="isCurrent(item.key) ? 'page' : undefined"
          :aria-label="!showLabels ? item.label : undefined"
          :title="!showLabels ? item.label : undefined"
          @click="onMenuClick"
        >
          <span
            class="menu-icon"
            :class="[item.icon, item.motion]"
            aria-hidden="true"
          />
          <span
            v-show="showLabels"
            class="menu-label"
          >{{ item.label }}</span>
        </NuxtLink>
      </div>
    </nav>

    <!-- 底部铭牌:版本与运行模式(上缘刻度收边,与画布分节同语言) -->
    <div
      v-show="showLabels"
      class="sider-footer"
    >
      <div class="footer-rule" />
      <div class="footer-line">
        <span>v{{ site.version }}</span>
        <span class="sep">/</span>
        <span>{{ site.mode }}</span>
      </div>
    </div>
  </a-layout-sider>

  <!-- 抽屉遮罩:点空白处关闭(与 esc-close 的 @click.self 契约一致) -->
  <div
    v-if="drawerOpen"
    class="nav-scrim"
    aria-hidden="true"
    @click="store.closeMobileNav()"
  />
</template>

<style scoped>
.app-sider {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  /* 壳层 chrome:高不透明 surface,保证导航文字对比 */
  background: var(--mat-chrome-bg);
  backdrop-filter: var(--vibrancy-chrome);
  border-right: 1px solid var(--line);
  z-index: 20;
}

/* antd Sider 的真实子容器:flex 必须落在这一层,否则 .app-menu 的 flex:1
 * 不生效,内容会被 .app-sider 直接裁掉(实测「工具管理」不可达)。 */
.app-sider :deep(.ant-layout-sider-children) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 只有导航主体滚动:品牌与底部铭牌固定,900px 视口也能滚到「工具管理」 */
.app-sider .logo,
.app-sider .sider-footer {
  flex: 0 0 auto;
}

.app-sider::-webkit-scrollbar {
  width: 0;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 58px;
  padding: 0 16px;
  overflow: hidden;
  border-bottom: 1px solid var(--line);
}

/* 品牌标志:门架 A 字标直接以 currentColor 渲染(亮阶墨色/暗阶纸白),不加辉光——
 * 品牌时刻靠字形与留白,不靠发光装饰。 */
.logo-mark {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  color: var(--ink);
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  white-space: nowrap;
}

.logo-title {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.075em;
  text-transform: uppercase;
  color: var(--ink);
}

.logo-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--sider-ink-faint);
}

/* ---------- 分组导航 ---------- */
.app-menu {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 16px 10px 24px;
  overflow: hidden auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.menu-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 分组标:11px 微字 + 右侧收尾刻度线;缩进与条目文字对齐 */
.menu-group-label {
  display: flex;
  gap: 8px;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  margin-bottom: 3px;
}

.menu-group-text {
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--sider-ink-faint);
}

.menu-group-rule {
  flex: 1 1 auto;
  height: 1px;
  background: linear-gradient(90deg, var(--divider-hair), transparent);
}

/* 折叠态:用一道短刻度代替文字分组标(保留分区语义) */
.menu-group-sep {
  width: 18px;
  height: 1px;
  margin: 6px 0 6px 13px;
  background: var(--line-strong);
}

.menu-item {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 500;
  color: var(--sider-ink);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-control);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast),
    transform var(--transition-fast);
}

@media (hover: hover) and (pointer: fine) {
  .menu-item:hover {
    color: var(--ink);
    background: var(--paper-deep);
  }
}

.menu-item:active {
  transform: scale(0.985);
}

/* 当前页:信号绿洗 + 3px 左缘导轨(导航定位态) */
.menu-item.active {
  font-weight: 600;
  color: var(--accent-strong);
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}

.menu-item.active:hover {
  background: var(--accent-soft);
}

.menu-icon {
  flex: 0 0 20px;
  font-size: 16px;
}

.menu-item .menu-icon {
  color: var(--sider-ink-faint);
  transition: color var(--transition-fast);
}

.menu-item:hover .menu-icon {
  color: var(--ink);
}

/* 当前页图标:品牌绿 */
.menu-item.active .menu-icon {
  color: var(--accent-strong);
}

.menu-label {
  overflow: hidden;
  padding-left: 10px;
  white-space: nowrap;
  text-overflow: ellipsis;
  transition: opacity var(--transition-fast);
}

.sider-footer {
  position: static;
  flex: 0 0 auto;
  width: 100%;
  padding: 8px 18px 14px;
  background: linear-gradient(180deg, transparent, var(--frost-bg) 42%);
}

/* 底部收边刻度:把侧栏内容与铭牌分开(与画布分节同语言) */
.footer-rule {
  height: 1px;
  margin-bottom: 12px;
  background:
    repeating-linear-gradient(90deg, var(--tick-c-fine) 0 1px, transparent 1px 9px),
    var(--divider-hair);
  opacity: 0.9;
}

.footer-line {
  display: flex;
  gap: 8px;
  align-items: center;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--sider-ink-faint);
}

.footer-line .sep {
  color: var(--ink-faint);
}

.slide-fade-enter-active,
.slide-fade-leave-active {
  transition:
    opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.slide-fade-enter-from,
.slide-fade-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}

/* 抽屉形态的定位/位移样式在 main.css 响应式层(body.nav-drawer)—— 见那里的说明。 */

.nav-scrim {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgb(6 12 20 / 58%);
  backdrop-filter: blur(2px);
  animation: nav-scrim-in 0.2s ease both;
}

@keyframes nav-scrim-in {
  from { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .nav-scrim { animation: none; }
}
</style>
