<script setup lang="ts">
import { theme } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import enUS from 'ant-design-vue/es/locale/en_US'

const { locale } = useI18n()
const store = useAppStore()
const config = useRuntimeConfig().public

const antdLocale = computed(() => (locale.value.startsWith('en') ? enUS : zhCN))

/**
 * 制图台主题:亮 = 牛皮纸制图室;暗 = 夜间蓝图。
 * antd 全组件 token 由此驱动,细节覆盖见 main.css。
 */
const themeConfig = computed(() => {
  const dark = store.isDark
  const paper = dark ? '#0f151b' : '#ece8dc' // colorBgLayout
  const raised = dark ? '#1a222c' : '#f8f6ee' // colorBgContainer
  const elevated = dark ? '#1e2833' : '#fcfaf3' // 弹层
  const inkText = dark ? '#e6e1d3' : '#1b2733'
  const inkSoft = dark ? 'rgba(230, 225, 211, 0.66)' : 'rgba(27, 39, 51, 0.68)'
  const borderLine = dark ? '#2a3644' : '#d3ccb8'
  const borderSoft = dark ? '#1f2934' : '#e2dccb'
  const fillDeep = dark ? '#141c24' : '#e3dcca'
  const fillFaint = dark ? 'rgba(126, 166, 255, 0.06)' : 'rgba(27, 39, 51, 0.045)'

  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: config.primaryColor as string,
      colorInfo: config.primaryColor as string,
      colorLink: config.primaryColor as string,
      borderRadius: 2,
      fontFamily: '\'IBM Plex Sans\', \'PingFang SC\', \'Microsoft YaHei\', \'Segoe UI\', sans-serif',
      colorBgLayout: paper,
      colorBgContainer: raised,
      colorBgElevated: elevated,
      colorText: inkText,
      colorTextSecondary: inkSoft,
      colorTextPlaceholder: dark ? 'rgba(230, 225, 211, 0.3)' : 'rgba(27, 39, 51, 0.35)',
      colorBorder: borderLine,
      colorBorderSecondary: borderSoft,
      colorFillQuaternary: fillFaint,
      colorSplit: borderLine,
      controlOutline: 'rgba(46, 81, 200, 0.15)',
      lineWidth: 1,
    },
    components: {
      Card: {
        headerBg: 'transparent',
        headerFontSize: 15,
      },
      Button: {
        primaryShadow: dark ? '2px 2px 0 rgba(0, 0, 0, 0.45)' : '2px 2px 0 rgba(27, 39, 51, 0.35)',
        fontWeight: 500,
      },
      Table: {
        headerBg: fillDeep,
        headerColor: inkText,
        headerSplitColor: 'transparent',
        rowHoverBg: dark ? 'rgba(59, 98, 226, 0.1)' : 'rgba(46, 81, 200, 0.05)',
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
