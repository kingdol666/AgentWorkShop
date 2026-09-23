<script setup lang="ts">
/**
 * 未登录闸门:引导回 workshop 登录门。
 *
 * 纯呈现:跳转语句与原页面逐字一致(`navigateTo('/workshop')` 直接落在按钮上),
 * 不做登出/登录收口 —— 身份态由页面(useUserStore)判定后才渲染本组件。
 */
</script>

<template>
  <!-- 未登录:引导回 workshop 登录门 -->
  <div class="auth-gate">
    <a-card class="auth-card">
      <h2>{{ $t('tokens.k1k6z0r8003') }}</h2>
      <p class="sub">
        {{ $t('tokens.k1gjnree004') }}
      </p>
      <a-button
        type="primary"
        block
        @click="navigateTo('/workshop')"
      >
        {{ $t('tokens.k1bhhheq005') }}
      </a-button>
    </a-card>
  </div>
</template>

<style scoped>
.auth-gate {
  display: flex;
  justify-content: center;
  padding-top: 8vh;
}

.auth-card { width: 460px; max-width: 92vw; }
.auth-card h2 { margin: 0 0 8px; font-family: var(--font-display); }

/* 描述行:.sub 在 TokensPageHead.vue(页头描述)另有一份同样的拷贝 ——
   有意重复(scoped 样式不能外移成公共 css),改一处同步两处。 */
.sub { margin: 8px 0 0; font-size: 12.5px; color: var(--ink-faint); }

@media (max-width: 640px) {
  /* 窄屏字号收边:与 TokensPageHead.vue 的同名规则有意重复(同上)。 */
  .sub { font-size: 11.5px; line-height: 1.5; }
}
</style>
