<script setup lang="ts">
import { useUserStore } from '@/app/stores/workshop/user'

defineProps<{ activeTab: string }>()

const { t, locale } = useI18n()
const site = useSiteConfig()
const config = useRuntimeConfig().public
const userStore = useUserStore()

const defaultAccent = String(config.primaryColor)

/** 系统态概览(只读,同源 config.yml) */
const systemRows = computed(() => [
  { label: t('home.fields.name'), value: site.name },
  { label: t('home.fields.version'), value: `v${site.version}` },
  { label: t('home.fields.mode'), value: site.mode },
  { label: t('home.fields.apiBase'), value: `${site.apiBase} (${config.apiTimeout}ms)` },
  { label: t('home.fields.primary'), value: defaultAccent },
  { label: 'i18n', value: locale.value },
])
</script>

<template>
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

.identity-note {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: var(--ink-faint);
}

@media (max-width: 899px) {
  /* 正文说明文字窄屏抬到 13px 地板 */
  .section-desc,
  .identity-note {
    font-size: 13px;
  }
}
</style>
