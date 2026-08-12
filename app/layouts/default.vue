<script setup lang="ts">
import { theme } from 'ant-design-vue'

// 响应式 token：随 ConfigProvider 算法（亮/暗）自动切换。
// 在此处注入为 CSS 变量，供所有布局子组件（AppHeader/页面）消费，
// 避免各组件各自 useToken 带来的 hydration 差异。
const { token } = theme.useToken()
const site = useSiteConfig()
</script>

<template>
  <a-layout class="app-layout">
    <AppSidebar />

    <a-layout
      class="app-main"
      :style="{
        'background': token?.colorBgLayout,
        '--app-bg-container': token?.colorBgContainer,
        '--app-bg-layout': token?.colorBgLayout,
        '--app-text': token?.colorText,
        '--app-text-secondary': token?.colorTextSecondary,
        '--app-border': token?.colorBorderSecondary,
        '--app-fill': token?.colorFillQuaternary,
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
        <span>{{ site.title }} · v{{ site.version }}</span>
        <span class="footer-sep">|</span>
        <span>mode={{ site.mode }}</span>
      </a-layout-footer>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.app-layout {
  min-height: 100vh;
}

.app-main {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  transition: background 0.3s ease;
}

.app-content {
  flex: 1;
  margin: 16px;
  padding: 4px;
}

.app-footer {
  padding: 16px 50px;
  font-size: 13px;
  text-align: center;
  transition: color 0.3s ease;
}

.footer-sep {
  margin: 0 8px;
  opacity: 0.5;
}
</style>
