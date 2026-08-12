<script setup lang="ts">
import { theme } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import enUS from 'ant-design-vue/es/locale/en_US'

const { locale } = useI18n()
const store = useAppStore()
const config = useRuntimeConfig().public

const antdLocale = computed(() => (locale.value.startsWith('en') ? enUS : zhCN))

const themeConfig = computed(() => ({
  algorithm: store.isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: { colorPrimary: config.primaryColor as string },
}))

// 将 config.yml 的主题色注入为 CSS 变量，供 UnoCSS / 自定义样式消费；
// lang 透传 i18n locale（保持 <html lang> 响应式）
useHead({
  htmlAttrs: {
    lang: locale,
    style: `--color-primary: ${config.primaryColor}`,
  },
})
</script>

<template>
  <a-config-provider
    :locale="antdLocale"
    :theme="themeConfig"
  >
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </a-config-provider>
</template>
