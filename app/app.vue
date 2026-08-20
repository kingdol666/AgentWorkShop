<script setup lang="ts">
import { theme } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import enUS from 'ant-design-vue/es/locale/en_US'

const { locale } = useI18n()
const store = useAppStore()
const config = useRuntimeConfig().public

const antdLocale = computed(() => (locale.value.startsWith('en') ? enUS : zhCN))

/**
 * 暖纸主题(koda 风格):亮 = 暖纸中性 + 纯黑主色;暗 = 真中性灰阶 + 纯白主色。
 * antd 全组件 token 由此驱动,细节覆盖见 main.css。
 */
const themeConfig = computed(() => {
  const dark = store.isDark
  const accent = dark ? '#ffffff' : '#000000'
  const paper = dark ? '#0c0c0c' : '#f9f7f3' // colorBgLayout(canvas)
  const raised = dark ? '#161616' : '#fffdf9' // colorBgContainer(panel)
  const elevated = dark ? '#1c1c1c' : '#fffdf9' // 弹层
  const inkText = dark ? '#f5f5f5' : '#101010'
  const inkSoft = dark ? 'rgba(184, 184, 184, 0.9)' : '#45403b'
  const borderLine = dark ? '#2a2a2a' : '#c5c0b1'
  const borderSoft = dark ? '#1f1f1f' : '#e5e2da'
  const fillDeep = dark ? '#141414' : '#f5f3eb'
  const fillFaint = dark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(16, 16, 16, 0.04)'

  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: accent,
      colorInfo: dark ? '#6f9df2' : '#0a59d2',
      colorLink: accent,
      borderRadius: 10,
      fontFamily: '\'IBM Plex Sans\', \'PingFang SC\', \'Microsoft YaHei\', \'Segoe UI\', sans-serif',
      colorBgLayout: paper,
      colorBgContainer: raised,
      colorBgElevated: elevated,
      colorText: inkText,
      colorTextSecondary: inkSoft,
      colorTextPlaceholder: dark ? 'rgba(154, 154, 154, 0.5)' : 'rgba(97, 91, 84, 0.55)',
      colorBorder: borderLine,
      colorBorderSecondary: borderSoft,
      colorFillQuaternary: fillFaint,
      colorSplit: borderSoft,
      controlOutline: dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.12)',
      lineWidth: 1,
    },
    components: {
      Card: {
        headerBg: 'transparent',
        headerFontSize: 15,
      },
      Button: {
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
        fontWeight: 500,
      },
      Table: {
        headerBg: fillDeep,
        headerColor: inkText,
        headerSplitColor: 'transparent',
        rowHoverBg: dark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(16, 16, 16, 0.035)',
      },
      Descriptions: {
        labelBg: fillFaint,
      },
      Modal: {
        titleFontSize: 17,
      },
    },
  }
})

// 将 config.yml 的主题色注入为 CSS 变量,供 UnoCSS / 自定义样式消费;
// lang 透传 i18n locale(保持 <html lang> 响应式)
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
