<script setup lang="ts">
import { theme } from 'ant-design-vue'

// 响应式 token:随 ConfigProvider 算法(亮/暗)自动切换,注入 CSS 变量供布局子组件消费
const { token } = theme.useToken()
const site = useSiteConfig()
</script>

<template>
  <a-layout class="app-layout">
    <AppSidebar />

    <a-layout
      class="app-main"
      :style="{
        'background': 'transparent',
        '--app-bg-container': token?.colorBgContainer,
        '--app-bg-layout': token?.colorBgLayout,
        '--app-text': token?.colorText,
        '--app-text-secondary': token?.colorTextSecondary,
        '--app-border': token?.colorBorderSecondary,
        '--app-fill': token?.colorFillQuaternary,
        '--app-header-h': '56px',
        '--app-footer-h': '46px',
      }"
    >
      <AppHeader />

      <a-layout-content class="app-content">
        <slot />
      </a-layout-content>

      <a-layout-footer
        class="app-footer"
        :style="{ color: token?.colorTextSecondary }"
      >
        <span class="footer-title aw-serif-accent">{{ site.title }}</span>
        <span class="sep">/</span>
        <span>v{{ site.version }}</span>
        <span class="sep">/</span>
        <span>mode={{ site.mode }}</span>
      </a-layout-footer>
    </a-layout>

    <!-- 全局噪点:抵消数字平面冷感(固定覆盖,不挡交互) -->
    <span
      class="aw-noise"
      aria-hidden="true"
    />
  </a-layout>
</template>

<style scoped>
.app-layout {
  min-height: 100vh;
  background: transparent;
}

.app-main {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-direction: column;
  min-height: 100vh;
}

.app-content {
  flex: 1;
  margin: 12px 16px 0;
  padding: 2px;
}

/* 页脚:mono 铭牌行(固定高度,供 harness 页计算视口高度);玻璃收边 */
.app-footer {
  background: linear-gradient(0deg, var(--frost-bg), color-mix(in srgb, var(--frost-bg) 60%, transparent));
  backdrop-filter: var(--aurora-blur);
  -webkit-backdrop-filter: var(--aurora-blur);
  border-top: 1px solid var(--glass-line);
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: center;
  height: var(--app-footer-h);
  padding: 0 50px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-align: center;
}

.app-footer .sep {
  color: var(--ink-fainter);
}

.footer-title {
  font-size: 13px;
}
</style>
