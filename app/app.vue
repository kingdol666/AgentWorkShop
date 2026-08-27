<script setup lang="ts">
import { theme } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import enUS from 'ant-design-vue/es/locale/en_US'

const { locale } = useI18n()
const store = useAppStore()
const config = useRuntimeConfig().public

const antdLocale = computed(() => (locale.value.startsWith('en') ? enUS : zhCN))

/** 将 hex 向白混合(lighten),供暗色模式强调色提亮 */
function mixWhite(hex: string, ratio: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = Number.parseInt(m[1]!, 16)
  const r = Math.round(((n >> 16) & 255) * (1 - ratio) + 255 * ratio)
  const g = Math.round(((n >> 8) & 255) * (1 - ratio) + 255 * ratio)
  const b = Math.round((n & 255) * (1 - ratio) + 255 * ratio)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** 将 hex 向黑混合(darken),供亮模式把品牌绿压深到实按钮可达对比 */
function mixBlack(hex: string, ratio: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = Number.parseInt(m[1]!, 16)
  const f = 1 - ratio
  const r = Math.round(((n >> 16) & 255) * f)
  const g = Math.round(((n >> 8) & 255) * f)
  const b = Math.round((n & 255) * f)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** 当前强调色:设置页偏好 > config.yml 默认(品牌绿 #35e0a0,与 TownView 控制室同源) */
const accentBase = computed(() => store.accent ?? String(config.primaryColor))

/**
 * Agent Harness · Digital Twin 主题:
 * 暗模式(默认)= 深海军蓝控制室(TownView --hud-* 同源):bg #070b13 / panel #0d1420 /
 *   主操作绿药丸(墨字)/ 数据青信息色 —— 与数字孪生空间同一套视觉语言;
 * 亮模式 = 暖纸白画布 + 品牌绿加深版主 CTA(保对比)。
 * antd 全组件 token 由此驱动,细节覆盖见 main.css。
 */
const themeConfig = computed(() => {
  const dark = store.isDark
  // 暗:品牌绿保持饱和(仅微提亮);亮:压深保证白字对比
  const accent = dark ? mixWhite(accentBase.value, 0.16) : mixBlack(accentBase.value, 0.36)
  const paper = dark ? '#070b13' : '#f5f5f5' // colorBgLayout(canvas)
  const raised = dark ? '#0d1420' : '#ffffff' // colorBgContainer(surface card)
  const elevated = dark ? '#111a2b' : '#ffffff' // 弹层
  const inkText = dark ? '#e8eef8' : '#0c0a09'
  const inkSoft = dark ? 'rgba(184, 199, 216, 0.95)' : '#4e4e4e'
  const borderLine = dark ? '#2c4568' : '#d6d3d1'
  const borderSoft = dark ? '#1d2a42' : '#e7e5e4'
  const fillDeep = dark ? '#0a111d' : '#f0efed'
  const fillFaint = dark ? 'rgba(232, 238, 248, 0.045)' : 'rgba(12, 10, 9, 0.04)'

  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: accent,
      colorInfo: dark ? '#41c8f4' : '#3f6094',
      colorLink: accent,
      borderRadius: 8,
      // 与 main.css --font-body 同源:Geist Variable(实际加载的字体;中文回退系统栈)
      fontFamily: `'Geist Variable', -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif`,
      colorBgLayout: paper,
      colorBgContainer: raised,
      colorBgElevated: elevated,
      colorText: inkText,
      colorTextSecondary: inkSoft,
      colorTextPlaceholder: dark ? 'rgba(95, 110, 132, 0.6)' : 'rgba(119, 113, 105, 0.6)',
      colorBorder: borderLine,
      colorBorderSecondary: borderSoft,
      colorFillQuaternary: fillFaint,
      colorSplit: borderSoft,
      // 实心主按钮文字色:暗色 = 品牌绿亮底配墨字;亮色 = 深绿底配白字
      colorTextLightSolid: dark ? '#08130d' : '#ffffff',
      controlOutline: dark ? 'rgba(53, 224, 160, 0.24)' : 'rgba(53, 224, 160, 0.16)',
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
        rowHoverBg: dark ? 'rgba(232, 238, 248, 0.035)' : 'rgba(12, 10, 9, 0.03)',
      },
      Descriptions: {
        labelBg: fillFaint,
      },
      Modal: {
        titleFontSize: 18,
      },
    },
  }
})

// 强调色注入为 CSS 变量,供自定义样式消费(实时响应设置页换色);
// lang 透传 i18n locale(保持 <html lang> 响应式)
const accentStrong = computed(() =>
  store.isDark ? mixWhite(accentBase.value, 0.3) : mixBlack(accentBase.value, 0.5),
)

useHead({
  htmlAttrs: {
    lang: locale,
    style: computed(() => [
      `--color-primary: ${accentBase.value}`,
      `--accent: ${store.isDark ? mixWhite(accentBase.value, 0.16) : mixBlack(accentBase.value, 0.36)}`,
      `--accent-strong: ${accentStrong.value}`,
      `--on-accent: ${store.isDark ? '#08130d' : '#ffffff'}`,
    ]),
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
