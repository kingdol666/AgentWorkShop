<script setup lang="ts">
import { message } from 'ant-design-vue'

const { t } = useI18n()
const store = useAppStore()
const site = useSiteConfig()

const activeTab = ref('basic')

// 基本设置
const basicForm = reactive({
  name: site.name,
  description: site.description || '',
})

// 主题设置
const colorPresets = ['#1677ff', '#722ed1', '#52c41a', '#fa8c16', '#eb2f96', '#13c2c2']
const themeForm = reactive({
  primaryColor: '#1677ff',
})

function pickColor(c: string) {
  themeForm.primaryColor = c
}

// 通知设置
const notifyForm = reactive({
  email: true,
  sms: false,
  push: true,
})

function handleSave() {
  message.success(t('settings.saveSuccess'))
}

const tabs = computed(() => [
  { key: 'basic', icon: 'i-tabler-settings', label: t('settings.basic') },
  { key: 'theme', icon: 'i-tabler-palette', label: t('settings.theme') },
  { key: 'notification', icon: 'i-tabler-bell', label: t('settings.notification') },
])
</script>

<template>
  <div class="page-wrap">
    <div class="page-head">
      <h2 class="page-title">
        {{ t('settings.title') }}
      </h2>
      <p class="page-sub">
        {{ t('settings.subtitle') }}
      </p>
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

        <!-- 右侧表单区 -->
        <div class="settings-body">
          <!-- 基本设置 -->
          <div v-show="activeTab === 'basic'">
            <h3 class="section-title">
              {{ t('settings.basic') }}
            </h3>
            <p class="section-desc">
              {{ t('settings.basicDesc') }}
            </p>
            <a-form
              layout="vertical"
              class="settings-form"
            >
              <a-form-item :label="t('settings.appName')">
                <a-input
                  v-model:value="basicForm.name"
                  size="large"
                />
              </a-form-item>
              <a-form-item :label="t('settings.appDesc')">
                <a-textarea
                  v-model:value="basicForm.description"
                  :rows="4"
                  :maxlength="200"
                  show-count
                />
              </a-form-item>
            </a-form>
          </div>

          <!-- 主题设置 -->
          <div v-show="activeTab === 'theme'">
            <h3 class="section-title">
              {{ t('settings.theme') }}
            </h3>
            <p class="section-desc">
              {{ t('settings.themeDesc') }}
            </p>
            <a-form
              layout="vertical"
              class="settings-form"
            >
              <a-form-item :label="t('settings.primaryColor')">
                <div class="color-swatches">
                  <button
                    v-for="c in colorPresets"
                    :key="c"
                    class="swatch"
                    :class="{ selected: themeForm.primaryColor === c }"
                    :style="{ background: c }"
                    @click="pickColor(c)"
                  >
                    <span
                      v-if="themeForm.primaryColor === c"
                      class="i-tabler-check"
                    />
                  </button>
                </div>
              </a-form-item>
              <a-form-item :label="t('settings.themeMode')">
                <a-segmented
                  :value="store.isDark ? 'dark' : 'light'"
                  :options="[
                    { label: t('common.light'), value: 'light' },
                    { label: t('common.dark'), value: 'dark' },
                  ]"
                  @change="store.toggleDark()"
                />
              </a-form-item>
            </a-form>
          </div>

          <!-- 通知设置 -->
          <div v-show="activeTab === 'notification'">
            <h3 class="section-title">
              {{ t('settings.notification') }}
            </h3>
            <p class="section-desc">
              {{ t('settings.notificationDesc') }}
            </p>
            <div class="notify-list">
              <div class="notify-item">
                <div>
                  <div class="notify-label">
                    <span class="i-tabler-mail" /> {{ t('settings.emailNotify') }}
                  </div>
                  <div class="notify-desc">
                    {{ t('settings.emailNotifyDesc') }}
                  </div>
                </div>
                <a-switch v-model:checked="notifyForm.email" />
              </div>
              <div class="notify-item">
                <div>
                  <div class="notify-label">
                    <span class="i-tabler-message" /> {{ t('settings.smsNotify') }}
                  </div>
                  <div class="notify-desc">
                    {{ t('settings.smsNotifyDesc') }}
                  </div>
                </div>
                <a-switch v-model:checked="notifyForm.sms" />
              </div>
              <div class="notify-item">
                <div>
                  <div class="notify-label">
                    <span class="i-tabler-bell-ringing" /> {{ t('settings.pushNotify') }}
                  </div>
                  <div class="notify-desc">
                    {{ t('settings.pushNotifyDesc') }}
                  </div>
                </div>
                <a-switch v-model:checked="notifyForm.push" />
              </div>
            </div>
          </div>

          <div class="form-actions">
            <a-button
              type="primary"
              size="large"
              @click="handleSave"
            >
              {{ t('common.save') }}
            </a-button>
            <a-button size="large">
              {{ t('common.cancel') }}
            </a-button>
          </div>
        </div>
      </div>
    </a-card>
  </div>
</template>

<style scoped>
.page-wrap {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--app-text, #1f1f1f);
}

.page-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--app-text-secondary, #999);
}

.settings-card {
  overflow: hidden;
  border-radius: 12px;
  box-shadow: 0 1px 8px rgb(0 0 0 / 4%);
}

.settings-layout {
  display: flex;
  gap: 32px;
  min-height: 420px;
}

.settings-nav {
  display: flex;
  flex: 0 0 180px;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background: var(--app-fill, #fafafa);
  border-radius: 10px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 42px;
  padding: 0 14px;
  font-size: 14px;
  font-weight: 500;
  color: var(--app-text-secondary, #666);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.nav-item:hover {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}

.nav-item.active {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.settings-body {
  flex: 1;
  min-width: 0;
}

.section-title {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
  color: var(--app-text, #1f1f1f);
}

.section-desc {
  margin: 0 0 20px;
  font-size: 13px;
  color: var(--app-text-secondary, #999);
}

.settings-form {
  max-width: 460px;
}

.color-swatches {
  display: flex;
  gap: 12px;
}

.swatch {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  font-size: 16px;
  color: #fff;
  cursor: pointer;
  border: 2px solid transparent;
  border-radius: 50%;
  transition: all 0.2s ease;
}

.swatch:hover {
  transform: scale(1.12);
}

.swatch.selected {
  border-color: var(--app-text, #333);
  box-shadow: 0 0 0 2px #fff inset;
}

.notify-list {
  display: flex;
  flex-direction: column;
  max-width: 520px;
}

.notify-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid var(--app-border, #f0f0f0);
}

.notify-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--app-text, #1f1f1f);
}

.notify-desc {
  margin-top: 2px;
  font-size: 12px;
  color: var(--app-text-secondary, #999);
}

.form-actions {
  display: flex;
  gap: 12px;
  margin-top: 32px;
}

@media (max-width: 768px) {
  .settings-layout {
    flex-direction: column;
  }

  .settings-nav {
    flex: none;
    flex-direction: row;
    overflow-x: auto;
  }
}
</style>
