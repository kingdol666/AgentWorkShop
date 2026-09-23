<script setup lang="ts">
/**
 * 控制台左栏:Channel 会话列表(可滚动)+ 底部实时代理活动条。
 * 宽度由页面注入(拖拽分隔条住在页面那一层,宽度状态因此不在此组件);
 * 窄屏时本栏退化成覆盖式抽屉(见文末 @media:绝对定位 + pane-in 动画)。
 */
defineProps<{
  wsId: string
  leftWidth: number
  /** 窄屏档(≤1023):宽度不再由拖拽决定,改为抽屉定宽 */
  narrow: boolean
}>()

const emit = defineEmits<{ (e: 'openAgent', target: { channelId: string, agentId: string }): void }>()
</script>

<template>
  <div
    class="left-pane"
    :style="{ flexBasis: narrow ? 'auto' : `${leftWidth}px` }"
  >
    <div class="left-scroll">
      <workshop-channel-session-list :ws-id="wsId" />
    </div>
    <workshop-live-agent-bar
      :ws-id="wsId"
      @open-agent="emit('openAgent', $event)"
    />
  </div>
</template>

<style scoped>
.left-pane {
  display: flex;
  flex: 0 0 auto; /* 宽度由拖拽分隔条驱动(inline flexBasis) */
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--paper);
}
.left-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden auto;
}

/* ══════════════════════════════════════════════════════════════════════════
   窄屏形态 · 左栏部分(≤1023px) —— 完整设计说明见页面
   app/pages/workshop/w/[wsId].vue 的「窄屏形态 · 单通道示波器」样式块:
   会话列表不再占位,收成覆盖式抽屉(点遮罩/Esc/选中频道收起)。
   断点数值与 main.css v5 / useResponsive.ts 一致,不引入新魔数。
   ══════════════════════════════════════════════════════════════════════════ */
@media (max-width: 1023.98px) {
  .left-pane {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 30;
    width: min(86vw, 320px);
    border-right: 1px solid var(--line);
    box-shadow: var(--shadow-float);
    animation: pane-in 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .left-pane {
    animation: none;
  }
}

@keyframes pane-in {
  from {
    opacity: 0.5;
    transform: translateX(-16px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
</style>
