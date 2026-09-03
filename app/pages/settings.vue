<script setup lang="ts">
import { message } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import { useRuntimeConfigStore } from '@/app/stores/runtime-config'

const { t, locale, locales, setLocale } = useI18n()
const store = useAppStore()
const site = useSiteConfig()
const config = useRuntimeConfig().public
const userStore = useUserStore()

const activeTab = ref('appearance')

/* ================= 运行配置（服务端持久化 + 热重载） ================= */
const rcStore = useRuntimeConfigStore()
const draft = ref<Record<string, unknown>>({})
const dirtyKeys = ref<Set<string>>(new Set())
const savingRuntime = ref(false)
const runtimeNotice = ref<{ type: 'success' | 'warning' | 'error', text: string } | null>(null)

function syncRuntimeDraft() {
  draft.value = { ...rcStore.effective }
  dirtyKeys.value = new Set()
}
watch(() => rcStore.loaded, (v) => {
  if (v) syncRuntimeDraft()
})
watch(() => rcStore.effective, () => {
  // 外部写入(CLI/其他窗口/文件监听)推来的变化,未编辑时才回填草稿
  if (dirtyKeys.value.size === 0) syncRuntimeDraft()
}, { deep: true })

function markDirty(key: string) {
  dirtyKeys.value.add(key)
  runtimeNotice.value = null
}

async function saveRuntime() {
  if (!dirtyKeys.value.size) return
  savingRuntime.value = true
  runtimeNotice.value = null
  try {
    const patchMap: Record<string, unknown> = {}
    for (const k of dirtyKeys.value) patchMap[k] = draft.value[k]
    const res = await rcStore.patch(patchMap)
    syncRuntimeDraft()
    const restart = res.restartRequired ?? []
    runtimeNotice.value = restart.length
      ? { type: 'warning', text: t('settings.runtime.restartNotice', { keys: restart.join(', ') }) }
      : { type: 'success', text: t('settings.runtime.savedLive') }
  }
  catch (e) {
    runtimeNotice.value = { type: 'error', text: e?.response?.data?.message || e?.message || String(e) }
  }
  finally {
    savingRuntime.value = false
  }
}

async function resetRuntimeKey(key: string) {
  try {
    await rcStore.patch({ [key]: null })
    syncRuntimeDraft()
    runtimeNotice.value = { type: 'success', text: t('settings.runtime.keyReset', { key }) }
  }
  catch (e) {
    runtimeNotice.value = { type: 'error', text: e?.response?.data?.message || e?.message || String(e) }
  }
}

async function resetAllRuntime() {
  try {
    await rcStore.resetAll()
    syncRuntimeDraft()
    runtimeNotice.value = { type: 'success', text: t('settings.runtime.resetAllDone') }
  }
  catch (e) {
    runtimeNotice.value = { type: 'error', text: e?.response?.data?.message || e?.message || String(e) }
  }
}

function groupLabel(group: string): string {
  const known: Record<string, string> = { server: t('settings.runtime.groupServer'), app: t('settings.runtime.groupApp'), api: 'API', theme: t('settings.runtime.groupTheme'), i18n: t('settings.runtime.groupI18n'), security: t('settings.runtime.groupSecurity'), daq: t('settings.runtime.groupDaq'), memory: t('settings.runtime.groupMemory'), omp: t('settings.runtime.groupOmp'), dcw: t('settings.runtime.groupDcw'), workshop: t('settings.runtime.groupWorkshop'), backup: t('settings.runtime.groupBackup'), retention: t('settings.runtime.groupRetention'), log: t('settings.runtime.groupLog') }
  return known[group] ?? group
}
function sourceClass(s: string): string {
  return s === 'runtime' ? 'src-runtime' : s === 'env' ? 'src-env' : 'src-yaml'
}
function itemLabel(item: { label: string, labelKey?: string }): string {
  const k = item.labelKey
  return (k && t(k) !== k) ? t(k) : item.label
}
/* ============================================================= */

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

          <!-- 运行配置:服务端持久化 + live 热重载/restart 重启生效 -->
          <div v-show="activeTab === 'runtime'">
            <h3 class="section-title">
              {{ t('settings.runtimeTab') }}
            </h3>
            <p class="section-desc">
              {{ t('settings.runtime.desc') }}
            </p>

            <a-alert
              v-if="runtimeNotice"
              :type="runtimeNotice.type"
              show-icon
              class="rt-notice"
              :message="runtimeNotice.text"
            />

            <template
              v-for="g in rcStore.groups"
              :key="g.group"
            >
              <h4 class="rt-group-title">
                {{ groupLabel(g.group) }}
              </h4>
              <div
                v-for="item in g.items"
                :key="item.key"
                class="rt-row"
              >
                <div class="rt-main">
                  <div class="rt-title">
                    {{ itemLabel(item) }}
                    <span
                      class="rt-tag"
                      :class="sourceClass(rcStore.sourceOf(item.key))"
                    >{{ rcStore.sourceOf(item.key) }}</span>
                    <span
                      class="rt-tag"
                      :class="item.applies"
                    >{{ item.applies === 'live' ? t('settings.runtime.live') : t('settings.runtime.restart') }}</span>
                  </div>
                  <div class="rt-sub">
                    {{ item.description }}
                  </div>
                </div>
                <div class="rt-ctrl">
                  <a-input-number
                    v-if="item.type === 'number'"
                    v-model:value="draft[item.key]"
                    :min="item.min"
                    :max="item.max"
                    @change="markDirty(item.key)"
                  />
                  <a-switch
                    v-else-if="item.type === 'boolean'"
                    v-model:checked="draft[item.key]"
                    @change="markDirty(item.key)"
                  />
                  <a-select
                    v-else-if="item.type === 'select'"
                    v-model:value="draft[item.key]"
                    style="width: 160px"
                    :options="(item.options ?? []).map(o => ({ label: o, value: o }))"
                    @change="markDirty(item.key)"
                  />
                  <span
                    v-else-if="item.type === 'color'"
                    class="rt-color"
                  >
                    <input
                      type="color"
                      :value="String(draft[item.key] ?? '#35e0a0')"
                      @input="draft[item.key] = ($event.target as HTMLInputElement).value; markDirty(item.key)"
                    >
                    <a-input
                      :value="String(draft[item.key] ?? '')"
                      style="width: 110px"
                      class="aw-mono"
                      @change="draft[item.key] = ($event.target as HTMLInputElement).value; markDirty(item.key)"
                    />
                  </span>
                  <a-input
                    v-else
                    v-model:value="draft[item.key]"
                    style="width: 220px"
                    @change="markDirty(item.key)"
                  />
                  <button
                    class="aw-pill outline rt-reset"
                    :title="t('settings.runtime.resetKey')"
                    @click="resetRuntimeKey(item.key)"
                  >
                    <span class="i-tabler-rotate" />
                  </button>
                </div>
              </div>
            </template>

            <div class="rt-actions">
              <button
                class="aw-pill primary"
                :disabled="!dirtyKeys.size || savingRuntime"
                @click="saveRuntime"
              >
                <span class="i-tabler-device-floppy" />
                {{ savingRuntime ? '…' : t('settings.runtime.save') }}
              </button>
              <button
                class="aw-pill outline"
                @click="resetAllRuntime"
              >
                {{ t('settings.runtime.resetAll') }}
              </button>
              <span class="rt-path aw-mono">{{ rcStore.settingsPath }}</span>
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

/* ============ 运行配置标签 ============ */
.rt-notice {
  margin: 0 0 14px;
}

.rt-group-title {
  margin: 20px 0 2px;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--ink-soft);
}

.rt-group-title:first-of-type {
  margin-top: 4px;
}

.rt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 11px 0;
  border-bottom: 1px solid var(--line);
}

.rt-main {
  min-width: 0;
}

.rt-title {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--ink-soft);
}

.rt-sub {
  max-width: 46ch;
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-faint);
}

.rt-tag {
  padding: 1px 7px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ink-faint);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}

.rt-tag.src-runtime {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.rt-tag.src-env {
  color: #c9963f;
  border-color: rgb(201 150 63 / 45%);
}

.rt-tag.live {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.rt-tag.restart {
  color: #c9963f;
  border-color: rgb(201 150 63 / 45%);
}

.rt-ctrl {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
}

.rt-color {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}

.rt-color input[type='color'] {
  width: 36px;
  height: 32px;
  padding: 2px;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: 6px;
}

.rt-reset {
  padding: 4px 9px;
  font-size: 12px;
}

.rt-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 18px;
}

.rt-path {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink-faint);
}

@media (max-width: 768px) {
  .rt-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  .rt-actions {
    flex-wrap: wrap;
  }
  .rt-path {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-layout { flex-direction: column; }
  .settings-nav {
    flex-direction: row;
    flex: none;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
}
</style>
