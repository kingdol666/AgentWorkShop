<script setup lang="ts">
import { message } from 'ant-design-vue'

defineProps<{ activeTab: string }>()

const store = useAppStore()
const config = useRuntimeConfig().public
const { t, locale, locales, setLocale } = useI18n()

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
    // cookie 参与 SSR 首帧(locale-cookie.global.ts);localStorage 保留为插件回退
    useCookie('aw.locale', { maxAge: 60 * 60 * 24 * 365 }).value = String(value)
    localStorage.setItem('aw.locale', String(value))
    setLocale(String(value) as 'zh-CN' | 'en')
    window.location.reload()
  }
}
</script>

<template>
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
</template>

<style scoped>
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
  font-size: 13px;
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
  font-size: 13px;
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

@media (max-width: 899px) {
  /* 正文说明文字窄屏抬到 13px 地板 */
  .set-sub,
  .section-desc {
    font-size: 13px;
  }
}
</style>
