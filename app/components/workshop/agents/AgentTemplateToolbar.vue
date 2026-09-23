<script setup lang="ts">
/**
 * 模板库工具栏:可见性筛选(全部/我的/公开/内置;admin 另有"他人私有")+ admin 提示条。
 * 筛选项与计数由页面(useAgentTemplatesCatalog)算好传入 —— 筛选计数只有一份来源,
 * 这里只负责把选中的筛选项 v-model 回页面。
 */
import type { AgentTemplateFilter, AgentTemplateFilterOption } from '@/app/pages/workshop/composables/useAgentTemplatesCatalog'

const filter = defineModel<AgentTemplateFilter>('filter', { required: true })

defineProps<{
  options: AgentTemplateFilterOption[]
  isAdmin: boolean
}>()
</script>

<template>
  <div class="toolbar">
    <a-segmented
      v-model:value="filter"
      size="small"
      :options="options"
    />
    <span
      v-if="isAdmin"
      class="admin-note"
    ><span class="i-tabler-shield-check" /> {{ $t('agents.ka1gpdj011') }}</span>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}
.admin-note {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 11px;
  color: var(--ink-faint);
}

/* ══ 窄屏(v9):筛选条换行 ═════════════════════════════════════════════════
   同一条窄屏规则的另外两半随各自的标记走:页头堆叠在 agents.vue,
   表格横向卷轴 + 首列可读在 AgentTemplateTable.vue。 */
@media (max-width: 900px) {
  .toolbar {
    flex-wrap: wrap;
    gap: 8px;
  }

  .toolbar :deep(.ant-segmented) {
    flex: 1 1 100%;
    min-width: 0;
  }

  .admin-note {
    flex: 1 1 100%;
    min-width: 0;
    font-size: 11.5px;
    line-height: 1.5;
  }
}
</style>
