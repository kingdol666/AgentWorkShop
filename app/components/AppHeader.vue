<script setup lang="ts">
import type { MenuProps, SelectProps } from 'ant-design-vue'

const { t, locale, locales, setLocale } = useI18n()
const store = useAppStore()
const route = useRoute()

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

// 面包屑：根据路由匹配标题
const breadcrumbItems = computed(() => {
  const map: Record<string, string> = {
    '/': t('menu.dashboard'),
    '/users': t('menu.users'),
    '/settings': t('menu.settings'),
  }
  return [t('menu.system'), map[route.path] ?? '']
})

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
      background: 'var(--app-bg-container, #fff)',
      borderBottomColor: 'var(--app-border, #f0f0f0)',
    }"
  >
    <!-- 左侧：折叠按钮 + 面包屑 -->
    <div class="header-left">
      <button
        class="collapse-btn"
        :aria-label="store.sidebarCollapsed ? t('header.expand') : t('header.collapse')"
        @click="store.toggleSidebar()"
      >
        <span
          class="i-tabler-menu-2"
          :class="{ 'i-tabler-menu-2': !store.sidebarCollapsed, 'rotate-icon': store.sidebarCollapsed }"
        />
      </button>

      <a-breadcrumb class="breadcrumb">
        <a-breadcrumb-item
          v-for="item in breadcrumbItems"
          :key="item"
        >
          {{ item }}
        </a-breadcrumb-item>
      </a-breadcrumb>
    </div>

    <!-- 右侧：功能集群 -->
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
          <a-avatar
            :size="32"
            style="background-color: var(--color-primary)"
          >
            A
          </a-avatar>
          <span class="user-name">Admin</span>
          <span class="i-tabler-chevron-down text-xs opacity-50" />
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
  </a-layout-header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 64px;
  padding: 0 20px 0 12px;
  border-bottom: 1px solid;
  box-shadow: 0 1px 4px rgb(0 21 41 / 8%);
  backdrop-filter: blur(8px);
  transition: background 0.3s ease, border-color 0.3s ease;
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.collapse-btn,
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  font-size: 18px;
  color: var(--app-text, #333);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.collapse-btn:hover,
.icon-btn:hover {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.rotate-icon {
  transform: rotate(90deg);
  transition: transform 0.3s ease;
}

.breadcrumb {
  font-size: 14px;
}

.lang-select {
  width: 130px;
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 10px 0 6px;
  cursor: pointer;
  border-radius: 20px;
  transition: background 0.2s ease;
}

.user-chip:hover {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}

.user-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--app-text, #333);
}

.hidden {
  display: none;
}
</style>
