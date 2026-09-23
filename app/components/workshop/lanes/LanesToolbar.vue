<script setup lang="ts">
/**
 * 泳道工具条 —— 团队规模摘要(lead/worker 计数)+ 添加成员入口。
 * 纯呈现 + 事件上抛:成员列表由父级(AgentLanesView)从实体 store 派生后传入。
 */
import type { AgentView } from '@/app/stores/workshop/entities'

defineProps<{ agents: AgentView[] }>()

const emit = defineEmits<{ add: [] }>()
</script>

<template>
  <div class="toolbar">
    <div class="team-summary">
      <span class="ts-label">{{ $t('agentLanesView.k3y5ja016') }}</span>
      <span class="ts-count">{{ agents.length }}</span>
      <span class="ts-unit">{{ $t('agentLanesView.k3ll6sa017') }}</span>
      <span class="ts-detail">lead {{ agents.filter(a => a.role === 'lead').length }} · worker {{ agents.filter(a => a.role === 'worker').length }}</span>
    </div>
    <a-button
      size="small"
      type="primary"
      ghost
      @click="emit('add')"
    >
      <span class="i-tabler-user-plus" />
      <span>{{ $t('agentLanesView.k1fmutgo018') }}</span>
    </a-button>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex: 0 0 auto;
  gap: 12px;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 6px;
  background: var(--paper-raised);
  border-bottom: 1px solid var(--line);
}
.team-summary {
  display: flex;
  flex: 1 1 auto;
  gap: 7px;
  min-width: 0;
  align-items: baseline;
}
.ts-label {
  flex: 0 0 auto;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
}
.ts-count {
  flex: 0 0 auto;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
  color: var(--ink);
}
.ts-unit {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--ink-faint);
}
.ts-detail {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 窄屏(≤1023):泳道从"并排仪表"改为"一次一泳道"的横向卡片流 ──
   桌面 min-width 240px 的泳道在 390px 下并排 = 每列都被压到极限;
   改为 88% 宽 + scroll-snap:一屏一路信号,横扫切换成员。 */
@media (max-width: 1023.98px) {
  .toolbar {
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 10px 6px;
  }

  .ts-label,
  .ts-unit,
  .ts-detail {
    font-size: 11.5px;
  }
}
</style>
