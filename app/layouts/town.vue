<script setup lang="ts">
/**
 * 全屏小镇布局:/town 独占视口(无侧栏/顶栏/页脚)。
 *
 * 这里**必须**调用 useResponsive():<html data-vp-tier> 的档位镜像由该 composable 写入,
 * 而此前只有 AppHeader/AppSidebar 会调用它 —— 本布局两者都没有,/town 于是永不写档位:
 *  · 依赖档位的样式/逻辑在 /town 上与其他页不一致;
 *  · 响应式验收(scripts/ui/verify-responsive.mjs)以 vp-tier 为就绪判据,
 *    /town 必然超时,被记成"页面挂了"。
 * 调用代价只是一次 resize 监听(同一全局监听器复用计数)。
 */
import { useResponsive } from '@/app/composables/useResponsive'

useResponsive()
</script>

<template>
  <div class="town-layout">
    <slot />
  </div>
</template>
