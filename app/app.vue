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

/** 当前强调色:设置页偏好 > config.yml 默认(墨色药丸) */
const accentBase = computed(() => store.accent ?? String(config.primaryColor))

/**
 * Warm Editorial 主题:
 * 亮模式 = 暖纸白画布 + 暖石灰阶 + 墨色药丸主 CTA;
 * 暗模式 = canvas-deep 暖黑 + elevated surface,强调色提亮为反转墨药丸(深字浅底)。
 * antd 全组件 token 由此驱动,细节覆盖见 main.css。
 */
const themeConfig = computed(() => {
  const dark = store.isDark
  const accent = dark ? mixWhite(accentBase.value, 0.55) : accentBase.value
  const paper = dark ? '#0c0a09' : '#f5f5f5' // colorBgLayout(canvas)
  const raised = dark ? '#1c1917' : '#ffffff' // colorBgContainer(surface card)
  const elevated = dark ? '#292524' : '#ffffff' // 弹层
  const inkText = dark ? '#f5f5f5' : '#0c0a09'
  const inkSoft = dark ? 'rgba(214, 211, 209, 0.9)' : '#4e4e4e'
  const borderLine = dark ? '#44403c' : '#d6d3d1'
  const borderSoft = dark ? '#292524' : '#e7e5e4'
  const fillDeep = dark ? '#171512' : '#f0efed'
  const fillFaint = dark ? 'rgba(245, 245, 245, 0.05)' : 'rgba(12, 10, 9, 0.04)'

  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: accent,
      colorInfo: dark ? '#92b6ff' : '#3f6094',
      colorLink: accent,
      borderRadius: 8,
      fontFamily: `'Inter Variable', 'Inter', -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif`,
      colorBgLayout: paper,
      colorBgContainer: raised,
      colorBgElevated: elevated,
      colorText: inkText,
      colorTextSecondary: inkSoft,
      colorTextPlaceholder: dark ? 'rgba(168, 162, 158, 0.55)' : 'rgba(119, 113, 105, 0.6)',
      colorBorder: borderLine,
      colorBorderSecondary: borderSoft,
      colorFillQuaternary: fillFaint,
      colorSplit: borderSoft,
      // 暗色主按钮 = 反转墨药丸(浅底深字)
      colorTextLightSolid: dark ? '#0c0a09' : '#ffffff',
      controlOutline: dark ? `rgba(231, 229, 228, 0.22)` : `rgba(41, 37, 36, 0.12)`,
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
        rowHoverBg: dark ? 'rgba(245, 245, 245, 0.03)' : 'rgba(12, 10, 9, 0.03)',
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
  store.isDark ? mixWhite(accentBase.value, 0.7) : shadeDark(accentBase.value),
)

/** 亮模式按压态:向黑加深一档 */
function shadeDark(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = Number.parseInt(m[1]!, 16)
  const mix = (c: number) => Math.round(c * 0.82)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

useHead({
  htmlAttrs: {
    lang: locale,
    style: computed(() => [
      `--color-primary: ${accentBase.value}`,
      `--accent: ${store.isDark ? mixWhite(accentBase.value, 0.55) : accentBase.value}`,
      `--accent-strong: ${accentStrong.value}`,
      `--on-accent: ${store.isDark ? '#0c0a09' : '#ffffff'}`,
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
