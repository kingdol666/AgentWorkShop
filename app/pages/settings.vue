<script setup lang="ts">
import AppearancePane from '~/components/settings/AppearancePane.vue'
import AgentPrefabsPane from '~/components/settings/AgentPrefabsPane.vue'
import McpServersPane from '~/components/settings/McpServersPane.vue'
import RuntimePane from '~/components/settings/RuntimePane.vue'
import SkillsPane from '~/components/settings/SkillsPane.vue'
import SystemPane from '~/components/settings/SystemPane.vue'

const { t } = useI18n()
const site = useSiteConfig()

const { isDrawer } = useResponsive()
const horizontal = ref(false)
onMounted(() => {
  watchEffect(() => {
    horizontal.value = isDrawer.value
  })
})

type SettingsTab = 'appearance' | 'runtime' | 'skills' | 'mcp' | 'prefabs' | 'system'
const activeTab = ref<SettingsTab>('appearance')
const focusedTab = ref<SettingsTab>('appearance')

const tabs = computed(() => [
  { key: 'appearance', icon: 'i-tabler-palette', label: t('settings.theme'), pane: AppearancePane },
  { key: 'runtime', icon: 'i-tabler-settings', label: t('settings.runtimeTab'), pane: RuntimePane },
  { key: 'skills', icon: 'i-tabler-puzzle', label: t('settings.skillsTab'), pane: SkillsPane },
  { key: 'mcp', icon: 'i-tabler-plug', label: t('settings.mcpTab'), pane: McpServersPane },
  { key: 'prefabs', icon: 'i-tabler-box', label: t('settings.prefabsTab'), pane: AgentPrefabsPane },
  { key: 'system', icon: 'i-tabler-server-2', label: t('settings.systemTab'), pane: SystemPane },
] as const)

/** 懒挂载:首次激活才挂载(键盘预览焦点不触发请求),挂后保留状态。 */
const mountedPanes = reactive<Record<SettingsTab, boolean>>({ appearance: true, runtime: false, skills: false, mcp: false, prefabs: false, system: false })
function selectTab(key: SettingsTab) {
  focusedTab.value = key
  activeTab.value = key
  mountedPanes[key] = true
}

function moveTabFocus(event: KeyboardEvent, index: number) {
  const last = tabs.value.length - 1
  const previous = horizontal.value ? 'ArrowLeft' : 'ArrowUp'
  const next = horizontal.value ? 'ArrowRight' : 'ArrowDown'
  let target: number
  if (event.key === previous) target = index === 0 ? last : index - 1
  else if (event.key === next) target = index === last ? 0 : index + 1
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = last
  else return

  const tab = tabs.value[target]
  if (!tab) return
  event.preventDefault()
  document.getElementById(`settings-tab-${tab.key}`)?.focus()
}

function resetTabFocus(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
    focusedTab.value = activeTab.value
  }
}
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
        <div
          class="settings-nav"
          role="tablist"
          :aria-label="t('settings.title')"
          :aria-orientation="horizontal ? 'horizontal' : 'vertical'"
          @focusout="resetTabFocus"
        >
          <button
            v-for="(tab, index) in tabs"
            :id="`settings-tab-${tab.key}`"
            :key="tab.key"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.key"
            :aria-controls="`settings-panel-${tab.key}`"
            :tabindex="focusedTab === tab.key ? 0 : -1"
            class="nav-item"
            :class="{ active: activeTab === tab.key }"
            @focus="focusedTab = tab.key"
            @keydown="moveTabFocus($event, index)"
            @click="selectTab(tab.key)"
          >
            <span
              :class="tab.icon"
              aria-hidden="true"
            />
            <span>{{ tab.label }}</span>
          </button>
        </div>

        <!-- 右侧内容区(保留 ARIA 目标，延迟挂载内容) -->
        <div class="settings-body">
          <div
            v-for="tab in tabs"
            :id="`settings-panel-${tab.key}`"
            :key="tab.key"
            :hidden="activeTab !== tab.key"
            role="tabpanel"
            :aria-labelledby="`settings-tab-${tab.key}`"
            tabindex="0"
          >
            <component
              :is="tab.pane"
              v-if="mountedPanes[tab.key]"
              :active-tab="activeTab"
            />
          </div>
        </div>
      </div>
    </a-card>
  </div>
</template>

<style scoped>
.settings-page {
  max-width: 1180px;
  padding: 4px;
  margin: 0 auto;
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
