<script setup lang="ts">
/**
 * 裸控制台布局(ChatGPT 式应用框):无全局侧栏/页头/页脚,页面自持整幅视口。
 *
 * 消费方:/workshop/w/:wsId 与 /projects 两页(2026-11-07 控制台 ChatGPT 化改版,
 * 设计规格见 docs/plans/2026-11-07-chatgpt-console-design.md)。
 *
 * 布局层调用 useResponsive:视口档位镜像到 <html data-vp-tier> 是全站 E2E/
 * 视觉走查的就绪判据(gotoReady 等它),不能依赖每个页面自己记得调用。
 *
 * 仍保留全局登录对话框:会话中途 401/手动登出时,authUi.openLogin 的入口
 * 不依赖 default 布局 —— 少了它,裸布局里的登录态修复会静默失效。
 */
useResponsive()
</script>

<template>
  <div class="console-layout">
    <a
      class="console-skip-link"
      href="#console-main"
    >跳到主要内容</a>
    <main
      id="console-main"
      class="console-main"
      tabindex="-1"
    >
      <slot />
    </main>
    <!-- 全局登录对话框(与 default 布局同一实例;组件经目录前缀自动导入,勿显式 import) -->
    <AppHeaderLoginModal />
  </div>
</template>

<style scoped>
.console-layout {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
  background: var(--chat-canvas);
}

/* display:contents:保留 main 语义,但不额外生成盒子,页面自持整幅视口 */
.console-main {
  display: contents;
}

.console-skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 1000;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--on-accent);
  background: var(--accent);
  border-radius: 8px;
  transform: translateY(-160%);
  transition: transform var(--transition-fast);
}

.console-skip-link:focus-visible {
  transform: translateY(0);
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
</style>
