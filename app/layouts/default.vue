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
        '--app-header-h': '64px',
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
        <span class="footer-rule" />
        <span>{{ site.title }}</span>
        <i />
        <span>v{{ site.version }}</span>
        <i />
        <span>mode={{ site.mode }}</span>
        <span class="footer-rule" />
      </a-layout-footer>
    </a-layout>
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
  flex-direction: column;
  min-height: 100vh;
}

.app-content {
  flex: 1;
  margin: 12px 16px 0;
  padding: 2px;
}

/* 页脚:拉丝铭牌(固定高度,供 harness 页计算视口高度) */
.app-footer {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: center;
  height: var(--app-footer-h);
  padding: 0 50px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  text-align: center;
  text-transform: uppercase;
}

.app-footer i {
  width: 3px;
  height: 3px;
  background: var(--accent-vermilion);
  opacity: 0.7;
}

.footer-rule {
  width: 46px;
  height: 1px;
  background: linear-gradient(90deg, transparent, currentcolor);
  opacity: 0.35;
}

.footer-rule:last-child {
  background: linear-gradient(90deg, currentcolor, transparent);
}
</style>
