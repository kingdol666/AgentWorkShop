<script setup lang="ts">
/**
 * 独立全屏页面(数字孪生 / 裸控制台)的返回入口。
 *
 * 这些页面不渲染 default 布局,没有侧栏/顶栏导航;没有这个入口时用户会被困在
 * 全屏场景里(桌面端尤其明显:窗口没有浏览器地址栏)。目标固定为主界面 `/`
 * (仪表盘,带完整侧栏导航)。
 *
 * 颜色使用 currentColor 派生,不依赖具体布局的 CSS 变量:town 是深色 HUD,
 * console 跟随聊天区亮/暗主题,两者都能直接复用。
 */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
</script>

<template>
  <NuxtLink
    class="app-back-to-main"
    :class="{ compact }"
    to="/"
    data-testid="back-to-main"
    :aria-label="$t('common.backToMain')"
    :title="$t('common.backToMainTip')"
  >
    <span
      class="i-tabler-arrow-left back-ico"
      aria-hidden="true"
    />
    <span class="back-label">{{ $t('common.backToMain') }}</span>
  </NuxtLink>
</template>

<style scoped>
.app-back-to-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 30px;
  padding: 0 11px 0 9px;
  border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
  border-radius: 999px;
  color: inherit;
  background: color-mix(in srgb, currentColor 8%, transparent);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.02em;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--transition-fast, 120ms ease), border-color var(--transition-fast, 120ms ease);
}

.app-back-to-main:hover {
  background: color-mix(in srgb, currentColor 16%, transparent);
  border-color: color-mix(in srgb, currentColor 38%, transparent);
  color: inherit;
}

.app-back-to-main:focus-visible {
  outline: 2px solid var(--focus-ring, currentColor);
  outline-offset: 2px;
}

.back-ico {
  font-size: 15px;
}

.app-back-to-main.compact {
  padding: 0 9px;
}

.app-back-to-main.compact .back-label {
  display: none;
}

/* 窄屏优先保住场景/内容宽度:只留箭头,aria-label 与 title 仍在 */
@media (max-width: 639px) {
  .back-label {
    display: none;
  }
  .app-back-to-main {
    padding: 0 9px;
  }
}
</style>
