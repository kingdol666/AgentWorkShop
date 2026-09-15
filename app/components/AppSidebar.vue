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
      { key: '/town', icon: 'i-tabler-map-2', label: t('menu.town'), motion: 'im-pop' },
      { key: '/daq', icon: 'i-tabler-activity', label: t('menu.daq'), motion: 'im-pop' },
      { key: '/dcw', icon: 'i-tabler-settings-automation', label: t('menu.dcw'), motion: 'im-pop' },
      { key: '/aml', icon: 'i-tabler-flask', label: t('menu.aml'), motion: 'im-pop' },
    ],
  },
  {
    id: 'ops',
    label: t('menu.groups.ops'),
    items: [
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

const isActive = (key: string): boolean =>
  key === '/' ? route.path === '/' : route.path.startsWith(key)

const go = (key: string) => {
  // 抽屉是浮层:点完必须收起来,否则用户看到的是"导航没反应"(内容被浮层盖着)
  if (isDrawer.value) store.closeMobileNav()
  if (!isActive(key)) navigateTo(key)
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

/** 抽屉展开时锁画布滚动(否则背景跟着手指跑,浮层失去"压在台面上"的物理感) */
watch(drawerOpen, (open) => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = open ? 'hidden' : ''
})

/** Esc 关闭:仅抽屉形态接管,桌面侧栏不受影响 */
const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && drawerOpen.value) store.closeMobileNav()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (typeof document !== 'undefined') document.body.style.overflow = ''
})
</script>

<template>
  <a-layout-sider
    :collapsed="effectiveCollapsed"
    :trigger="null"
    collapsible
    :width="228"
    :collapsed-width="64"
    class="app-sider"
    :data-nav-mode="navMode"
    :aria-hidden="isDrawer && !drawerOpen ? 'true' : undefined"
  >
    <!-- 品牌区:AwLogo 六边形标志(绿→青渐变 + 孪生虚影 + 三节点互连,与 favicon 同源) -->
    <div class="logo">
      <div
        class="logo-mark"
        aria-hidden="true"
      >
        <AwLogo :size="30" />
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

    <nav class="app-menu">
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
        <button
          v-for="item in group.items"
          :key="item.key"
          type="button"
          class="menu-item im"
          :class="{ active: isActive(item.key) }"
          :title="!showLabels ? item.label : undefined"
          @click="go(item.key)"
        >
          <span
            class="menu-icon"
            :class="[item.icon, item.motion]"
          />
          <span
            v-show="showLabels"
            class="menu-label"
          >{{ item.label }}</span>
        </button>
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
  height: 100vh;
  overflow: hidden auto;
  /* v4 壳层材质:最透的一档 + 强振动(能看见背后的极光在缓慢流动) */
  background: var(--mat-chrome-bg);
  backdrop-filter: var(--vibrancy-chrome);
  border-right: 1px solid var(--glass-line);
  box-shadow: var(--glass-specular);
  z-index: 20;
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

/* 品牌标志:AwLogo SVG 直渲染(渐变六边形自带描边),微辉光点缀 */
.logo-mark {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 36px;
  filter: drop-shadow(0 0 6px rgb(53 224 160 / 26%));
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  white-space: nowrap;
}

.logo-title {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink);
}

.logo-sub {
  font-family: var(--font-mono);
  /* 8.5px 在这块铭牌上连"看得见"都勉强(实测全站每页稳定被判为不可读);
     9.5px 是这套 mono 铭牌的下限,字距同步收一点以保持行长。 */
  font-size: 9.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--sider-ink-faint);
}

/* ---------- 分组导航 ---------- */
.app-menu {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 10px 0;
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
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
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
  min-height: 34px;
  padding: 0 10px;
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 500;
  color: var(--sider-ink);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast),
    padding-left var(--transition-fast),
    transform var(--transition-fast);
}

@media (hover: hover) and (pointer: fine) {
  .menu-item:hover {
    padding-left: 13px;
    color: var(--ink);
    background: var(--paper-deep);
  }
}

.menu-item:active {
  transform: scale(0.985);
}

/* 当前页:控制室绿洗 + 左缘品牌绿标记(导航定位态,替代旧墨色药丸) */
.menu-item.active {
  font-weight: 600;
  color: var(--accent-strong);
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}

.menu-item.active:hover {
  padding-left: 10px;
  background: var(--tone-success-bg);
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
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  padding: 0 18px 18px;
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
  font-size: 10px;
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
