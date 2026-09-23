<script setup lang="ts">
/**
 * 控制台右栏:Inspector(成员/任务/记忆/统计)+ 定高下段的群成员名册。
 * workspace 列表未返回前显示「加载中」的诚实降级态(未加载 ≠ 空,不淡化整栏);
 * 已加载但无频道时整栏淡化,表示这一栏当前确实没有内容。
 */
defineProps<{
  /** 聚焦 channel;undefined = 无挂载频道 */
  channelId?: string
  rightWidth: number
  /** workspace 列表是否已从服务端返回 */
  loaded: boolean
}>()

const emit = defineEmits<{
  (e: 'openAgent' | 'openTask', id: string): void
}>()
</script>

<template>
  <div
    class="right-pane"
    :class="{ empty: loaded && !channelId }"
    :style="{ flexBasis: `${rightWidth}px` }"
  >
    <div
      v-if="channelId"
      class="right-main"
    >
      <workshop-inspector-panel
        :channel-id="channelId"
        @open-agent="emit('openAgent', $event)"
        @open-task="emit('openTask', $event)"
      />
    </div>
    <!-- 加载中/无频道的诚实降级态(workspace 列表未返回前不误判为"空") -->
    <div
      v-else-if="!loaded"
      class="pane-loading"
    >
      {{ $t('wsView.loadingWs') }}
    </div>
    <!-- v17 群成员名册 + 加入/审批 + 群聊设置(权限由服务端能力视图驱动) -->
    <div
      v-if="channelId"
      class="right-chat"
    >
      <workshop-chat-member-panel :channel-id="channelId" />
    </div>
  </div>
</template>

<style scoped>
.right-pane {
  display: flex; /* 上下两区:检查器(可滚动)+ 群成员面板(定高) */
  flex: 0 0 auto; /* 宽度由拖拽分隔条驱动(inline flexBasis) */
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--paper);
}
.right-main {
  flex: 1 1 auto;
  min-height: 0;
}
/* 群成员面板只占右栏下部一段:检查器(Agent/Task 详情)仍是主信息面 */
.right-chat {
  flex: 0 0 auto;
  max-height: 46%;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--line);
}
.right-pane.empty { opacity: 0.35; }
/* workspace 列表加载中的诚实降级态(不算"空",不淡化整栏) */
.pane-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--ink-faint);
}

/* 窄屏形态 · 右栏部分(≤1023px):整栏不出现,只剩降级态跟随全局字号档;
   完整设计说明见页面 app/pages/workshop/w/[wsId].vue 的「窄屏形态 · 单通道示波器」样式块 */
@media (max-width: 1023.98px) {
  .pane-loading {
    font-size: 13px;
  }
}
</style>
