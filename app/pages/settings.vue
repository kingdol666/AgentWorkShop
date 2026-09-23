<script setup lang="ts">
import AppearancePane from '~/components/settings/AppearancePane.vue'
import RuntimePane from '~/components/settings/RuntimePane.vue'
import SystemPane from '~/components/settings/SystemPane.vue'

const { t } = useI18n()
const site = useSiteConfig()

const activeTab = ref('appearance')

const tabs = computed(() => [
  { key: 'appearance', icon: 'i-tabler-palette', label: t('settings.theme') },
  { key: 'runtime', icon: 'i-tabler-settings', label: t('settings.runtimeTab') },
  { key: 'system', icon: 'i-tabler-server-2', label: t('settings.systemTab') },
])
</script>

<template>
  <div class="settings-page">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          {{ t('menu.system') }} / settings
        </p>
        <h1>{{ t('settings.title') }}</h1>
      </div>
      <span class="aw-stamp">v{{ site.version }}</span>
    </div>

    <a-card
      :bordered="false"
      class="settings-card"
    >
      <div class="settings-layout">
        <!-- 左侧 Tab 导航 -->
        <div class="settings-nav">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="nav-item"
            :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key"
          >
            <span :class="tab.icon" />
            <span>{{ tab.label }}</span>
          </button>
        </div>

        <!-- 右侧内容区 -->
        <div class="settings-body">
          <!-- 外观:主题色 / 深浅 / 语言(全部实时生效并持久化) -->
          <AppearancePane :active-tab="activeTab" />
          <!-- 运行配置:服务端持久化 + live 热重载/restart 重启生效 -->
          <RuntimePane :active-tab="activeTab" />
          <!-- 系统:只读运行参数 -->
          <SystemPane :active-tab="activeTab" />
        </div>
      </div>
    </a-card>
  </div>
</template>

<style scoped>
.settings-page {
  padding: 4px;
}

.settings-card {
  overflow: hidden;
}

.settings-layout {
  display: flex;
  min-height: 420px;
}

/* 左侧导航:8px 圆角条目(active = surface-strong 墨字) */
.settings-nav {
  display: flex;
  flex: 0 0 180px;
  flex-direction: column;
  gap: 2px;
  padding: 14px;
  border-right: 1px solid var(--line);
}

.nav-item {
  display: flex;
  gap: 9px;
  align-items: center;
  width: 100%;
  padding: 8px 10px;
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-faint);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.nav-item:hover {
  color: var(--ink);
  background: var(--paper-deep);
}

.nav-item.active {
  font-weight: 600;
  color: var(--ink);
  background: var(--paper-deep);
}

.settings-body {
  flex: 1;
  min-width: 0;
  padding: 22px 26px;
}

/* ══ 窄屏(≤899px,对齐 useResponsive 的 drawer 档)═══════════════════════
   桌面是"左栏菜单 180px + 右栏内容"的双栏仪表台。窄屏若仍并排,
   内容区只剩 ~170px,描述文字被压成"一次一个字"的竖排长条(375px 实测)。
   窄屏改为:菜单在上,收成一条可横扫的标签带;内容在下,占满整宽。
   注:原先把这段堆叠规则误写在 prefers-reduced-motion 里 ——
   那样只有"减少动效"的用户才看到正确布局,是反的,已移到宽度断点。 */
@media (max-width: 899px) {
  .settings-layout {
    flex-direction: column;
    min-height: 0;
  }

  .settings-nav {
    flex: none;
    flex-direction: row;
    gap: 6px;
    padding: 8px 10px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }

  .settings-nav::-webkit-scrollbar {
    display: none;
  }

  .nav-item {
    flex: none;
    width: auto;
    min-height: 40px;
    padding: 8px 14px;
    white-space: nowrap;
  }

  .settings-body {
    padding: 16px 12px;
  }

  /* 卡片内边距在窄屏收边,把宽度让给内容 */
  .settings-card :deep(.ant-card-body) {
    padding: 12px;
  }
}
</style>
