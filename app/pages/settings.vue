<script setup lang="ts">
import { message } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'

const { t, locale, locales, setLocale } = useI18n()
const store = useAppStore()
const site = useSiteConfig()
const config = useRuntimeConfig().public
const userStore = useUserStore()

const activeTab = ref('appearance')

/** 强调色预设(控制室低饱和族;默认 = 品牌绿,跟随 config.yml) */
const defaultAccent = String(config.primaryColor)
const colorPresets = [
  { value: defaultAccent, label: t('settings.accentInk') },
  { value: '#c9963f', label: t('settings.accentStone') },
  { value: '#44615a', label: t('settings.accentMoss') },
  { value: '#3f6094', label: t('settings.accentSlate') },
  { value: '#6b5aa0', label: t('settings.accentPlum') },
  { value: '#9c5744', label: t('settings.accentClay') },
]

const currentAccent = computed(() => store.accent ?? defaultAccent)

function pickAccent(c: string) {
  store.setAccent(c === defaultAccent ? null : c)
  message.success(t('settings.accentApplied'))
}

/** 恢复默认(品牌绿,跟随 config.yml) */
function resetAccent() {
  store.setAccent(null)
  message.success(t('settings.accentReset'))
}

const localeOptions = computed(() =>
  (locales.value as Array<{ code: string, name: string }>).map(l => ({
    label: l.name,
    value: l.code,
  })),
)

const switchLocale = (value: unknown) => {
  if (value != null) {
    // 持久化 + 强刷:与 AppHeader 同策略(setup 期词条需重载整体切换)
    localStorage.setItem('aw.locale', String(value))
    setLocale(String(value) as 'zh-CN' | 'en')
    window.location.reload()
  }
}

/** 系统态概览(只读,同源 config.yml) */
const systemRows = computed(() => [
  { label: t('home.fields.name'), value: site.name },
  { label: t('home.fields.version'), value: `v${site.version}` },
  { label: t('home.fields.mode'), value: site.mode },
  { label: t('home.fields.apiBase'), value: `${site.apiBase} (${config.apiTimeout}ms)` },
  { label: t('home.fields.primary'), value: defaultAccent },
  { label: 'i18n', value: locale.value },
])

const tabs = computed(() => [
  { key: 'appearance', icon: 'i-tabler-palette', label: t('settings.theme') },
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
          <div v-show="activeTab === 'appearance'">
            <h3 class="section-title">
              {{ t('settings.theme') }}
            </h3>
            <p class="section-desc">
              {{ t('settings.appearanceDesc') }}
            </p>

            <div class="set-row">
              <div class="set-text">
                <div class="set-title">
                  {{ t('settings.primaryColor') }}
                </div>
                <div class="set-sub">
                  {{ t('settings.accentDesc') }}
                </div>
              </div>
            </div>
            <div class="color-swatches">
              <button
                v-for="c in colorPresets"
                :key="c.value"
                class="swatch"
                :class="{ on: currentAccent.toLowerCase() === c.value.toLowerCase() }"
                :style="{ '--sw': c.value }"
                :title="c.label"
                @click="pickAccent(c.value)"
              >
                <span class="swatch-dot" />
                <span class="swatch-label">{{ c.label }}</span>
                <span
                  v-if="currentAccent.toLowerCase() === c.value.toLowerCase()"
                  class="i-tabler-check swatch-check"
                />
              </button>
            </div>
            <button
              class="aw-pill outline reset-btn"
              @click="resetAccent"
            >
              <span class="i-tabler-rotate" />
              {{ t('settings.accentResetAction') }}
            </button>

            <div class="toggle-row">
              <div class="set-text">
                <div class="set-title">
                  {{ store.isDark ? t('common.dark') : t('common.light') }}
                </div>
                <div class="set-sub">
                  {{ t('settings.darkDesc') }}
                </div>
              </div>
              <button
                class="switch"
                :class="{ on: store.isDark }"
                role="switch"
                :aria-checked="store.isDark"
                @click="store.toggleDark()"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="toggle-row">
              <div class="set-text">
                <div class="set-title">
                  {{ t('header.language') }}
                </div>
                <div class="set-sub">
                  {{ t('settings.languageDesc') }}
                </div>
              </div>
              <a-select
                :value="locale"
                :options="localeOptions"
                style="width: 140px"
                @change="switchLocale"
              />
            </div>
          </div>

          <!-- 系统:只读运行参数 -->
          <div v-show="activeTab === 'system'">
            <h3 class="section-title">
              {{ t('settings.systemTab') }}
            </h3>
            <p class="section-desc">
              {{ t('settings.systemDesc') }}
            </p>
            <a-descriptions
              bordered
              :column="1"
              size="small"
            >
              <a-descriptions-item
                v-for="row in systemRows"
                :key="row.label"
                :label="row.label"
              >
                <span class="aw-mono">{{ row.value }}</span>
              </a-descriptions-item>
            </a-descriptions>
            <p class="identity-note">
              {{ userStore.isLoggedIn
                ? `${t('settings.identity')}: ${userStore.user?.name} (${userStore.user?.role})`
                : t('settings.identityGuest') }}
            </p>
          </div>
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

.section-title {
  margin: 0 0 4px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.section-desc {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-faint);
}

/* 色板:粉彩圆点 + 名称;选中 = 墨描边 */
.color-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 12px 0 4px;
}

.swatch {
  position: relative;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  padding: 8px 14px;
  font-family: var(--font-body);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.swatch:hover {
  background: var(--paper-deep);
}

.swatch.on {
  color: var(--ink);
  border-color: var(--ink);
}

.swatch-dot {
  width: 14px;
  height: 14px;
  background: var(--sw);
  border: 1px solid rgb(0 0 0 / 8%);
  border-radius: 50%;
}

.swatch-check {
  font-size: 13px;
  color: var(--ink);
}

.reset-btn {
  margin: 10px 0 4px;
}

/* 开关行(设置页 toggle row) */
.toggle-row,
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 0;
  border-bottom: 1px solid var(--line);
}

.set-text {
  min-width: 0;
}

.set-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink-soft);
}

.set-sub {
  max-width: 52ch;
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-faint);
}

/* 药丸开关(ink on 态) */
.switch {
  position: relative;
  flex: none;
  width: 42px;
  height: 25px;
  padding: 0;
  cursor: pointer;
  background: var(--line-strong);
  border: 0;
  border-radius: var(--radius-pill);
  transition: background 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

.switch .knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 19px;
  height: 19px;
  background: var(--paper-raised);
  border-radius: 50%;
  box-shadow: 0 1px 2px rgb(12 10 9 / 25%);
  transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

.switch.on {
  background: var(--accent);
}

.switch.on .knob {
  transform: translateX(17px);
}

@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch .knob {
    transition: none;
  }
}

.identity-note {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--ink-faint);
}

@media (max-width: 768px) {
  .settings-layout { flex-direction: column; }
  .settings-nav {
    flex-direction: row;
    flex: none;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
}
</style>
