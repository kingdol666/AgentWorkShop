<script setup lang="ts">
/**
 * Agent 模板库:用户级隔离的模板 CRUD + 实例去向(克隆到了哪些 channel)。
 * v10 可见性:private 仅本人;public 全员可读可用(仅属主可改删);内置(锁)任何人不可改删。
 * admin:全量视图(含他人私有),附创建者;可改删任意非内置模板。
 *
 * 本页只做编排:目录/筛选/徽标在 composables/useAgentTemplatesCatalog,
 * harness 注册表与能力矩阵在 composables/useAgentHarnessOptions(派生数据唯一一份,
 * 表格与弹窗都从这里拿),行级写操作在 composables/useAgentTemplateActions,
 * 弹窗开关与 payload 在 composables/useAgentTemplateDialogState,
 * 弹窗表单与提交在 useAgentTemplateForm(由弹窗组件调用,成功后再 emit 回来 reload)。
 * 展示件:components/workshop/agents/**。
 */
import AgentTemplateEditModal from '@/app/components/workshop/agents/AgentTemplateEditModal.vue'
import AgentTemplateTable from '@/app/components/workshop/agents/AgentTemplateTable.vue'
import AgentTemplateToolbar from '@/app/components/workshop/agents/AgentTemplateToolbar.vue'
import { useAgentHarnessOptions } from './composables/useAgentHarnessOptions'
import { useAgentTemplateActions } from './composables/useAgentTemplateActions'
import { useAgentTemplateDialogState } from './composables/useAgentTemplateDialogState'
import { useAgentTemplatesCatalog } from './composables/useAgentTemplatesCatalog'

const { t: tt } = useI18n()

definePageMeta({ layout: 'default' })

const { loading, load, tplName, filter, filterOptions, shown, canWrite, visTag, isAdmin } = useAgentTemplatesCatalog()
const { harnesses, harnessMeta, isUnavailable, harnessOptions, capBadges } = useAgentHarnessOptions()
const { remove, toggleEnabled, toggleVisibility } = useAgentTemplateActions({ reload: load })
const { editOpen, editing, openCreate, openEdit } = useAgentTemplateDialogState()

useHead({ title: () => tt('titles.agents') })
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2>Agent {{ $t('agents.k3pa5h4025') }}</h2>
        <p class="sub">
          {{ $t('agents.k5nsz7y008') }}
        </p>
      </div>
      <a-space>
        <a-button @click="navigateTo('/workshop')">
          {{ $t('agents.krpx6qa009') }}
        </a-button>
        <a-button
          type="primary"
          @click="openCreate"
        >
          {{ $t('agents.k1efixrj010') }}
        </a-button>
      </a-space>
    </div>

    <AgentTemplateToolbar
      v-model:filter="filter"
      :options="filterOptions"
      :is-admin="isAdmin"
    />

    <AgentTemplateTable
      :data-source="shown"
      :loading="loading"
      :tpl-name="tplName"
      :can-write="canWrite"
      :vis-tag="visTag"
      :is-unavailable="isUnavailable"
      :harness-meta="harnessMeta"
      @edit="openEdit"
      @remove="remove"
      @toggle-enabled="toggleEnabled"
      @toggle-visibility="toggleVisibility"
    />

    <AgentTemplateEditModal
      v-model:open="editOpen"
      :editing="editing"
      :harnesses="harnesses"
      :harness-options="harnessOptions"
      :harness-meta="harnessMeta"
      :is-unavailable="isUnavailable"
      :cap-badges="capBadges"
      @saved="load"
    />
  </div>
</template>

<style scoped>
.page { padding: 4px; }
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
h2 { margin: 0 0 4px; }
.sub { margin: 0; font-size: 12px; opacity: 0.55; }

/* ══ 窄屏(v9):页头纵向堆叠 ═══════════════════════════════════════════════
   同一条窄屏规则的另外两半随各自的标记走:筛选条换行在 AgentTemplateToolbar.vue,
   表格横向卷轴 + 首列可读在 AgentTemplateTable.vue。 */
@media (max-width: 900px) {
  .head {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }

  .head > div { min-width: 0; }
  .head h2 { font-size: 21px; line-height: 1.25; }

  .head :deep(.ant-space) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: stretch;
    width: 100%;
  }

  .head :deep(.ant-space-item) { width: 100%; }
  .head :deep(.ant-btn) { width: 100%; min-height: 40px; }
}

@media (max-width: 640px) {
  .page { padding: 0; }
  .head h2 { font-size: 19px; }
  .sub { font-size: 11.5px; line-height: 1.5; }
}
</style>
