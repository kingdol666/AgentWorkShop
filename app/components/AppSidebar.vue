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
      theme="dark"
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
  background:
    linear-gradient(180deg, rgb(255 255 255 / 2.5%), transparent 220px),
    var(--sider-bg);
  border-right: 1px solid rgb(255 255 255 / 5%);
  box-shadow: 2px 0 12px rgb(0 0 0 / 18%);
  z-index: 20;
}

.app-sider::-webkit-scrollbar {
  width: 0;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 64px;
  padding: 0 18px;
  overflow: hidden;
  border-bottom: 1px solid rgb(255 255 255 / 7%);
}

/* 铭牌:图纸白方印 + 衬线大写 A 与朱红句点 */
.logo-mark {
  display: flex;
  flex: 0 0 auto;
  align-items: baseline;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding-top: 7px;
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  font-style: italic;
  line-height: 1;
  color: var(--ink);
  background: #f4efe0;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 2px;
  box-shadow: 2px 2px 0 rgb(0 0 0 / 35%);
}

.logo-mark i {
  font-size: 11px;
  font-style: normal;
  color: var(--accent-vermilion);
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  white-space: nowrap;
}

.logo-title {
  font-family: var(--font-display);
  font-size: 15.5px;
  font-weight: 590;
  letter-spacing: 0.01em;
  color: #f0ebdd;
}

.logo-sub {
  font-family: var(--font-mono);
  font-size: 8.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--sider-ink-faint);
}

.sider-section-label {
  padding: 18px 22px 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.22em;
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
  height: 42px;
  margin: 2px 0;
  line-height: 42px;
  border-inline-end: none !important;
}

:deep(.app-menu .ant-menu-item .ant-menu-title-content) {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: space-between;
}

.menu-icon {
  font-size: 16px;
  opacity: 0.85;
}

.menu-label {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.03em;
}

.menu-index {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  opacity: 0.38;
}

/* 选中项:左缘朱红标尺棱(inset shadow 保证压过 antd 默认选中色) */
:deep(.app-menu .ant-menu-item-selected) {
  position: relative;
  background: rgb(255 255 255 / 8%) !important;
  box-shadow: inset 3px 0 0 var(--accent-vermilion) !important;
}

:deep(.app-menu .ant-menu-item-selected .menu-icon) {
  color: var(--accent-vermilion);
}

:deep(.app-menu .ant-menu-item:hover) {
  transform: translateX(2px);
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
  background: linear-gradient(90deg, rgb(255 255 255 / 18%), transparent);
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
  background: var(--accent-moss);
}

.footer-note {
  margin-top: 5px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--sider-ink-faint);
  opacity: 0.7;
}

.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all 0.2s ease;
}

.slide-fade-enter-from,
.slide-fade-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}
</style>
