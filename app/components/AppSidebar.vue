<script setup lang="ts">
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
}

const menuItems = computed<MenuItem[]>(() => [
  { key: '/', icon: 'i-tabler-layout-dashboard', label: t('menu.dashboard'), motion: 'im-pop' },
  { key: '/workshop', icon: 'i-tabler-box', label: t('menu.workshop'), motion: 'im-pop' },
  { key: '/game', icon: 'i-tabler-device-gamepad-2', label: t('menu.game'), motion: 'im-pop' },
  { key: '/tokens', icon: 'i-tabler-key', label: t('menu.tokens'), motion: 'im-nudge-up' },
  { key: '/users', icon: 'i-tabler-users-group', label: t('menu.users'), motion: 'im-pop' },
  { key: '/monitor', icon: 'i-tabler-cpu', label: t('menu.monitor'), motion: 'im-pulse' },
  { key: '/settings', icon: 'i-tabler-settings', label: t('menu.settings'), motion: 'im-rotate' },
])

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
    <!-- 品牌区:墨方印(serif A + 蜜桃点) -->
    <div class="logo">
      <div class="logo-mark">
        <span class="logo-letter">A</span>
        <span
          class="logo-dot"
          aria-hidden="true"
        />
      </div>
      <transition name="slide-fade">
        <div
          v-show="!store.sidebarCollapsed"
          class="logo-text"
        >
          <span class="logo-title">{{ site.name }}</span>
          <span class="logo-sub">agent workshop</span>
        </div>
      </transition>
    </div>

    <div
      v-show="!store.sidebarCollapsed"
      class="sider-section-label"
    >
      {{ t('menu.system') }}
    </div>

    <nav class="app-menu">
      <button
        v-for="item in menuItems"
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
    </nav>

    <!-- 底部铭牌:版本与运行模式 -->
    <div
      v-show="!store.sidebarCollapsed"
      class="sider-footer"
    >
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
  background: var(--sider-bg);
  border-right: 1px solid var(--line);
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

/* 墨方印:serif A + 蜜桃状态点(open-tag rail brand 声部) */
.logo-mark {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: var(--ink);
  border-radius: var(--radius-panel-sm);
}

.logo-letter {
  font-family: var(--font-display);
  font-size: 19px;
  color: var(--paper);
}

.logo-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 9px;
  height: 9px;
  background: var(--g-peach);
  border: 1.5px solid var(--sider-bg);
  border-radius: 50%;
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  white-space: nowrap;
}

.logo-title {
  font-family: var(--font-display);
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.logo-sub {
  font-family: var(--font-mono);
  font-size: 8.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--sider-ink-faint);
}

.sider-section-label {
  padding: 18px 20px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--sider-ink-faint);
}

.app-menu {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 10px 0;
}

.menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  font-family: var(--font-body);
  font-size: 13.5px;
  font-weight: 500;
  color: var(--sider-ink);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.menu-item:hover {
  color: var(--ink);
  background: var(--paper-deep);
}

.menu-item.active {
  color: var(--ink);
  background: var(--paper-deep);
}

.menu-icon {
  flex: 0 0 20px;
  font-size: 16px;
}

.menu-item .menu-icon {
  color: var(--sider-ink-faint);
}

.menu-item:hover .menu-icon,
.menu-item.active .menu-icon {
  color: var(--ink);
}

.menu-label {
  overflow: hidden;
  padding-left: 10px;
  white-space: nowrap;
  transition: opacity var(--transition-fast);
}

.menu-item.active .menu-label {
  font-weight: 600;
}

.sider-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  padding: 14px 18px 18px;
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
  color: var(--ink-fainter);
}

.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.slide-fade-enter-from,
.slide-fade-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}
</style>
