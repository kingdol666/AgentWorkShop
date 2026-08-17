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

// 面包屑:路由 → 标题(等宽大写铭牌)
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
      background: 'var(--app-bg-layout, transparent)',
      borderBottomColor: 'var(--app-border, #d3ccb8)',
    }"
  >
    <!-- 左侧:折叠 + 面包屑铭牌 -->
    <div class="header-left">
      <button
        class="collapse-btn"
        :aria-label="store.sidebarCollapsed ? t('header.expand') : t('header.collapse')"
        @click="store.toggleSidebar()"
      >
        <span class="i-tabler-menu-2" />
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
  </a-layout-header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 60px;
  padding: 0 24px 0 10px;
  border-bottom: 1px solid;
  backdrop-filter: blur(6px);
  transition: background 0.3s ease, border-color 0.3s ease;
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 方角描边按钮(制图工具感),悬停显钴蓝 */
.collapse-btn,
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  font-size: 16px;
  color: var(--app-text, var(--ink));
  cursor: pointer;
  background: var(--app-bg-container, transparent);
  border: 1px solid var(--app-border, var(--line));
  border-radius: 2px;
  box-shadow: 2px 2px 0 var(--app-bg-layout, transparent);
  transition: all 0.16s ease;
}

.collapse-btn:hover,
.icon-btn:hover {
  color: var(--accent-cobalt);
  border-color: var(--accent-cobalt);
  transform: translate(-1px, -1px);
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--accent-cobalt) 14%, transparent);
}

.collapse-btn:active,
.icon-btn:active {
  transform: translate(1px, 1px);
  box-shadow: 0 0 0 transparent;
}

.breadcrumb {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

:deep(.breadcrumb .ant-breadcrumb-separator) {
  font-family: var(--font-mono);
  color: var(--ink-faint);
}

.lang-select {
  width: 120px;
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
  border-color: var(--app-border, var(--line));
  background: var(--app-bg-container, transparent);
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
  border-radius: 2px;
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
</style>
