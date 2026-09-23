<script setup lang="ts">
/**
 * 状态胶囊菜单:fixed 定位于点击点(x/y 已由容器按视口收敛),动作清单由容器按当前任务态派生。
 * 遮罩点击/滚动 = 关闭;动作键原样回抛(容器再分派:cancel/retry 走动作面,detail 开详情)。
 */
import type { TaskBoardMenuAction } from '@/app/composables/workshop/useTaskBoardMenu'

defineProps<{
  x: number
  y: number
  actions: TaskBoardMenuAction[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'action', key: TaskBoardMenuAction['key']): void
}>()
</script>

<template>
  <div
    class="menu-backdrop"
    @click="emit('close')"
    @scroll="emit('close')"
  />
  <div
    class="st-menu"
    :style="{ left: `${x}px`, top: `${y}px` }"
  >
    <button
      v-for="a in actions"
      :key="a.key"
      type="button"
      :class="{ danger: a.danger }"
      @click="emit('action', a.key)"
    >
      <span
        :class="a.key === 'cancel'
          ? 'i-tabler-circle-off'
          : a.key === 'retry' ? 'i-tabler-rotate' : 'i-tabler-external-link'"
      />
      {{ a.label }}
    </button>
  </div>
</template>

<style scoped>
/* 状态菜单的规则从 TaskBoardView.vue 逐字搬来(标记现在归本组件所有,scoped 必须同址)。 */
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.st-menu {
  position: fixed;
  z-index: 61;
  min-width: 128px;
  padding: 4px;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-panel-sm);
  box-shadow: var(--shadow-float);
}
.st-menu button {
  display: flex;
  gap: 7px;
  align-items: center;
  width: 100%;
  padding: 6px 9px;
  font-family: var(--font-body);
  font-size: 12.5px;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
}
.st-menu button:hover { background: var(--paper-deep); color: var(--ink); }
.st-menu button.danger { color: var(--tone-danger-dot); }

/* 窄屏(≤1023.98):完整说明见 TaskBoardView.vue 的同名媒体查询;此处只保留属于本组件标记的规则 */
@media (max-width: 1023.98px) {
  .st-menu button {
    min-height: 44px;
  }
}
</style>
