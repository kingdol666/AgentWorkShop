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
  .map(g => ({ ...g, items: g.items.filter(m => !m.adminOnly || userStore.isAdmin) }))
  .filter(g => g.items.length > 0))

const isActive = (key: string): boolean =>
  key === '/' ? route.path === '/' : route.path.startsWith(key)

const go = (key: string) => {
  if (!isActive(key)) navigateTo(key)
}
</script>

<template>
  <a-layout-sider
    v-model:collapsed="store.sidebarCollapsed"
    :trigger="null"
    collapsible
    breakpoint="lg"
    :width="228"
    :collapsed-width="64"
    class="app-sider"
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
          v-show="!store.sidebarCollapsed"
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
          v-show="!store.sidebarCollapsed"
          class="menu-group-label"
        >
          <span class="menu-group-text">{{ group.label }}</span>
          <span
            class="menu-group-rule"
            aria-hidden="true"
          />
        </div>
        <div
          v-show="store.sidebarCollapsed"
          class="menu-group-sep"
          aria-hidden="true"
        />
        <button
          v-for="item in group.items"
          :key="item.key"
          type="button"
          class="menu-item im"
          :class="{ active: isActive(item.key) }"
          :title="store.sidebarCollapsed ? item.label : undefined"
          @click="go(item.key)"
        >
          <span
            class="menu-icon"
            :class="[item.icon, item.motion]"
          />
          <span
            v-show="!store.sidebarCollapsed"
            class="menu-label"
          >{{ item.label }}</span>
        </button>
      </div>
    </nav>

    <!-- 底部铭牌:版本与运行模式(上缘刻度收边,与画布分节同语言) -->
    <div
      v-show="!store.sidebarCollapsed"
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
  font-size: 8.5px;
  letter-spacing: 0.2em;
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
</style>
