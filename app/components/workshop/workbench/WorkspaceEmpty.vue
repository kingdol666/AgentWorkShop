<script setup lang="ts">
/**
 * workspace 空态:整幅居中构图(跨全部网格列,代替左上角一张小幽灵卡)。
 * 无状态展示件:整块可点,只上报创建意图,弹窗开合由页面持有。
 */
/** 注意:必须把 defineEmits 的返回值赋给 emit —— 模板里的 `emit(...)` 才解析得到(setup 绑定) */
const emit = defineEmits<{
  create: []
}>()
</script>

<template>
  <button
    class="ws-empty"
    @click="emit('create')"
  >
    <span class="i-tabler-layout-2 ws-empty-ico" />
    <span class="aw-empty-title">{{ $t('wsHome.emptyTitle') }}</span>
    <span class="aw-empty-sub">{{ $t('wsHome.emptySub') }}</span>
    <span class="pill-btn ws-empty-cta">
      <span class="i-tabler-plus" />
      {{ $t('wsHome.emptyCta') }}
    </span>
  </button>
</template>

<style scoped>
/* 空态的规则从 app/pages/workshop/index.vue 逐字搬来(scoped 编译成 .x[data-v-<scopeId>],
   样式必须与拥有这些元素的标记同址)。.pill-btn 是 main.css 的全局类,不在此重复声明。 */

/* 空态:整幅居中构图(跨全部网格列,代替左上角一张小幽灵卡) */
.ws-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  min-height: min(480px, calc(100vh - 320px));
  padding: 40px 24px;
  text-align: center;
  cursor: pointer;
  background: transparent;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-panel);
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.ws-empty:hover {
  background: var(--hover-tint);
  border-color: var(--ink-fainter);
}
.ws-empty-ico { font-size: 34px; color: var(--ink-faint); }
.aw-empty-title { font-size: 16px; font-weight: 600; color: var(--ink); }
.aw-empty-sub { max-width: 420px; font-size: 12.5px; line-height: 1.7; color: var(--ink-faint); }
.ws-empty-cta { margin-top: 6px; pointer-events: none; }
</style>
