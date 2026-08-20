<script setup lang="ts">
import type { MenuProps } from 'ant-design-vue'

const { t } = useI18n()
const route = useRoute()
const site = useSiteConfig()
const store = useAppStore()

interface MenuItem {
  key: string
  icon: string
  label: string
}

const menuItems = computed<MenuItem[]>(() => [
  { key: '/', icon: 'i-tabler-layout-dashboard', label: t('menu.dashboard') },
  { key: '/workshop', icon: 'i-tabler-box', label: t('menu.workshop') },
  { key: '/game', icon: 'i-tabler-device-gamepad-2', label: t('menu.game') },
  { key: '/tokens', icon: 'i-tabler-key', label: t('menu.tokens') },
  { key: '/users', icon: 'i-tabler-users-group', label: t('menu.users') },
  { key: '/monitor', icon: 'i-tabler-cpu', label: t('menu.monitor') },
  { key: '/settings', icon: 'i-tabler-settings', label: t('menu.settings') },
])

// 当前路由高亮对应菜单项
const selectedKeys = computed(() => [route.path])

const onMenuClick: MenuProps['onClick'] = ({ key }) => {
  if (String(key) !== route.path) {
    navigateTo(String(key))
  }
}

const indexOf = (i: number) => String(i + 1).padStart(2, '0')
</script>

<template>
  <a-layout-sider
    v-model:collapsed="store.sidebarCollapsed"
    :trigger="null"
    collapsible
    breakpoint="lg"
    :width="224"
    :collapsed-width="64"
    class="app-sider"
  >
    <!-- Logo 区:制图室铭牌 -->
    <div class="logo">
      <div class="logo-mark">
        <span>A</span>
        <i>.</i>
      </div>
      <transition name="slide-fade">
        <div
          v-show="!store.sidebarCollapsed"
          class="logo-text"
        >
          <span class="logo-title">{{ site.name }}</span>
          <span class="logo-sub">software workbench</span>
        </div>
      </transition>
    </div>

    <div
      v-show="!store.sidebarCollapsed"
      class="sider-section-label"
    >
      {{ t('menu.system') }}
    </div>

    <a-menu
      theme="light"
      mode="inline"
      :selected-keys="selectedKeys"
      class="app-menu"
      @click="onMenuClick"
    >
      <a-menu-item
        v-for="(item, i) in menuItems"
        :key="item.key"
      >
        <template #icon>
          <span
            class="menu-icon"
            :class="item.icon"
          />
        </template>
        <span class="menu-label">{{ item.label }}</span>
        <span class="menu-index">{{ indexOf(i) }}</span>
      </a-menu-item>
    </a-menu>

    <!-- 底部铭牌:版本与状态 -->
    <div
      v-show="!store.sidebarCollapsed"
      class="sider-footer"
    >
      <div class="footer-rule" />
      <div class="footer-line">
        <span>build v{{ site.version }}</span>
        <span class="footer-dot" />
        <span>mode {{ site.mode }}</span>
      </div>
      <div class="footer-note">
        draft · measure · ship
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
  border-right: 1px solid var(--divider-hair);
  z-index: 20;
}

.app-sider::-webkit-scrollbar {
  width: 0;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 56px;
  padding: 0 16px;
  overflow: hidden;
  border-bottom: 1px solid var(--divider-hair);
}

/* 铭牌:黑方印 + 白衬线 A(koda 黑主色标识) */
.logo-mark {
  display: flex;
  flex: 0 0 auto;
  align-items: baseline;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding-top: 6px;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  font-style: italic;
  line-height: 1;
  color: var(--paper-raised);
  background: var(--accent-cobalt);
  border-radius: var(--radius-chip, 8px);
}

.logo-mark i {
  font-size: 11px;
  font-style: normal;
  color: var(--paper-raised);
  opacity: 0.55;
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  white-space: nowrap;
}

.logo-title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 590;
  letter-spacing: -0.02em;
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
  padding: 18px 22px 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--sider-ink-faint);
}

.app-menu {
  padding: 4px 10px 0;
  background: transparent;
  border-inline-end: none !important;
}

:deep(.app-menu .ant-menu-item) {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 34px;
  margin: 1px 0;
  line-height: 34px;
  border-inline-end: none !important;
  border-radius: var(--radius-panel-sm, 10px);
}

:deep(.app-menu .ant-menu-item .ant-menu-title-content) {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: space-between;
}

.menu-icon {
  font-size: 16px;
  opacity: 0.9;
}

.menu-label {
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.02em;
}

.menu-index {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  opacity: 0.38;
}

/* 选中项:panel-strong 圆角块 + 黑图标(koda is-active) */
:deep(.app-menu .ant-menu-item-selected) {
  background: var(--paper-tint) !important;
  box-shadow: none !important;
}

:deep(.app-menu .ant-menu-item-selected .menu-icon) {
  color: var(--ink);
}

:deep(.app-menu .ant-menu-item:hover) {
  background: var(--hover-tint) !important;
}

.sider-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  padding: 14px 18px 18px;
}

.footer-rule {
  height: 1px;
  margin-bottom: 10px;
  background: var(--divider-hair);
}

.footer-line {
  display: flex;
  gap: 8px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--sider-ink-faint);
}

.footer-dot {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: var(--tone-success-dot);
}

.footer-note {
  margin-top: 5px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--sider-ink-faint);
  opacity: 0.7;
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
