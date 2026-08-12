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
  { key: '/users', icon: 'i-tabler-users-group', label: t('menu.users') },
  { key: '/settings', icon: 'i-tabler-settings', label: t('menu.settings') },
])

// 当前路由高亮对应菜单项
const selectedKeys = computed(() => [route.path])

const onMenuClick: MenuProps['onClick'] = ({ key }) => {
  if (String(key) !== route.path) {
    navigateTo(String(key))
  }
}
</script>

<template>
  <a-layout-sider
    v-model:collapsed="store.sidebarCollapsed"
    :trigger="null"
    collapsible
    breakpoint="lg"
    :width="232"
    :collapsed-width="72"
    class="app-sider"
  >
    <!-- Logo 区 -->
    <div class="logo">
      <div class="logo-mark">
        <span class="i-tabler-bolt" />
      </div>
      <transition name="slide-fade">
        <div
          v-show="!store.sidebarCollapsed"
          class="logo-text"
        >
          <span class="logo-title">{{ site.name }}</span>
          <span class="logo-sub">{{ t('menu.system') }}</span>
        </div>
      </transition>
    </div>

    <a-menu
      theme="dark"
      mode="inline"
      :selected-keys="selectedKeys"
      class="app-menu"
      @click="onMenuClick"
    >
      <a-menu-item
        v-for="item in menuItems"
        :key="item.key"
      >
        <template #icon>
          <span
            class="menu-icon"
            :class="item.icon"
          />
        </template>
        <span>{{ item.label }}</span>
      </a-menu-item>
    </a-menu>

    <!-- 底部版本信息 -->
    <div
      v-show="!store.sidebarCollapsed"
      class="sider-footer"
    >
      <span class="i-tabler-info-circle" />
      <span>v{{ site.version }}</span>
    </div>
  </a-layout-sider>
</template>

<style scoped>
.app-sider {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: hidden auto;
  background: #001529;
  box-shadow: 2px 0 8px rgb(0 0 0 / 15%);
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
  padding: 0 20px;
  overflow: hidden;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
}

.logo-mark {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 20px;
  color: #fff;
  background: linear-gradient(135deg, var(--color-primary), #69b1ff);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgb(22 119 255 / 40%);
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  white-space: nowrap;
}

.logo-title {
  font-size: 16px;
  font-weight: 700;
  color: #fff;
}

.logo-sub {
  font-size: 11px;
  color: rgb(255 255 255 / 45%);
}

.app-menu {
  padding: 12px 12px 0;
  background: transparent;
}

:deep(.app-menu .ant-menu-item) {
  display: flex;
  align-items: center;
  height: 44px;
  margin: 4px 0;
  font-weight: 500;
  border-radius: 8px;
}

:deep(.app-menu .ant-menu-item-selected) {
  background: linear-gradient(90deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 70%, transparent)) !important;
  box-shadow: 0 2px 8px rgb(22 119 255 / 35%);
}

.menu-icon {
  font-size: 18px;
}

.sider-footer {
  position: absolute;
  bottom: 16px;
  left: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0 24px;
  font-size: 12px;
  color: rgb(255 255 255 / 35%);
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
