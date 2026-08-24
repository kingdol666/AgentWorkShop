<template>
  <div class="town-layout">
    <slot />
  </div>
</template>

<style scoped>
/* 全屏小镇布局:/town 页面独占整个视口(无侧栏/顶栏/页脚遮挡) */
.town-layout {
  position: fixed;
  inset: 0;
  z-index: 10;
  overflow: hidden;
  background: #0b0f17;
}
</style>
