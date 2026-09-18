<script setup lang="ts">
import { theme } from 'ant-design-vue'

// 响应式 token:随 ConfigProvider 算法(亮/暗)自动切换,注入 CSS 变量供布局子组件消费
const { token } = theme.useToken()
const site = useSiteConfig()

// 注:模板里的 <a-layout> 显式带 has-sider。antd 默认靠运行时探测子 Sider 来加
// .ant-layout-has-sider,而服务端没有 mount 阶段 → SSR 输出不含该类、客户端水合后才补上,
// 既是 hydration mismatch,也是首帧到水合之间的布局跳变(该类决定 flex-direction)。
// 显式声明后两侧类名一致,警告与跳变同时消失。
</script>

<template>
  <a-layout
    class="app-layout"
    has-sider
  >
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
        <span>mode={{ site.mode }}</span>
        <!-- 右下角:版本 + 开源地址 + 文档(弱化铭牌,hover 才现交互态) -->
        <span class="footer-corner">
          <span>v{{ site.version }}</span>
          <span class="sep">·</span>
          <a
            class="footer-link"
            href="https://github.com/kingdol666/AgentWorkShop"
            target="_blank"
            rel="noopener"
          >GitHub</a>
          <span class="sep">·</span>
          <a
            class="footer-link"
            href="https://kingdol666.github.io/AgentWorkShop/"
            target="_blank"
            rel="noopener"
          >Docs</a>
        </span>
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
/* ⚠️ 布局骨架**自持**:不依赖 antd cssinjs 的注入时机。
 * 实测复现:某些进入路径下 .app-layout 拿不到 .ant-layout 的 `display:flex`
 * (计算值 display:block),于是 aside(position:sticky; height:100vh)与 .app-main
 * 变成块级上下堆叠 —— 内容被推到 y=1050(整整一个视口之下),整页"掉到折叠线以下"。
 * 这与项目已记录的"主题不一致导致 cssinjs 不重注入"是同一类问题。
 * 骨架的 display/flex-direction 是**结构性**的,不该由运行时样式注入决定成败;
 * 在这里显式声明后,即使 antd 样式迟到/缺失,页面结构也始终正确。
 * (特异度 .app-layout[data-v-*] = 0,2,0 > .ant-layout = 0,1,0,稳定胜出) */
.app-layout {
  display: flex;
  flex-direction: row;
  min-height: 100vh;
  background: transparent;
}

.app-main {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 100vh;
}

.app-content {
  flex: 1;
  margin: 12px 16px 0;
  padding: 2px;
}

/* 页脚:mono 铭牌行(固定高度,供 harness 页计算视口高度);壳层玻璃收边 */
.app-footer {
  position: relative;
  background: var(--mat-chrome-bg);
  backdrop-filter: var(--vibrancy-chrome);
  border-top: 1px solid var(--glass-line);
  box-shadow: var(--glass-specular);
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
  color: var(--ink-faint);
}

.footer-title {
  font-size: 13px;
}

/* 右下角铭牌:版本/开源地址/文档 —— 与中央铭牌同色系弱化,hover 才亮起,不抢视觉 */
.footer-corner {
  position: absolute;
  right: 24px;
  bottom: 0;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  height: 100%;
  color: var(--ink-faint);
  font-size: 10px;
  letter-spacing: 0.06em;
}

.footer-corner .footer-link {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: color 0.15s ease, border-color 0.15s ease;
}

.footer-corner .footer-link:hover {
  color: inherit;
  opacity: 0.85;
  border-bottom-color: currentColor;
}
</style>
