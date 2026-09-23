<script setup lang="ts">
/**
 * 模板库表格:名称(内置种子译名)/ harness 可用性 / 可见性(tag + 行内开关)/ 属主 /
 * 实例数 / 启用 / 操作,展开行列出实例去向(channel)。
 * 无状态展示件:可写判定·可见性徽标·译名·harness 可用性与元信息全部由页面算好传入
 * (useAgentTemplatesCatalog / useAgentHarnessOptions,与拆分前同一份实现,只此一份来源);
 * 行内操作只发事件,由页面统一落到 useAgentTemplateActions / useAgentTemplateDialogState。
 */
import type { AgentTemplateDto, HarnessMetaDto } from '@/app/composables/workshop/useWorkshopApi'
import type { AgentTemplateVisTag } from '@/app/pages/workshop/composables/useAgentTemplatesCatalog'

defineProps<{
  dataSource: AgentTemplateDto[]
  loading: boolean
  tplName: (r: { id: string, name: string }) => string
  canWrite: (t: AgentTemplateDto) => boolean
  visTag: (t: AgentTemplateDto) => AgentTemplateVisTag
  isUnavailable: (id: string) => boolean
  harnessMeta: (id: string) => HarnessMetaDto | undefined
}>()

const emit = defineEmits<{
  edit: [tpl: AgentTemplateDto]
  remove: [tpl: AgentTemplateDto]
  toggleEnabled: [tpl: AgentTemplateDto]
  toggleVisibility: [tpl: AgentTemplateDto, pub: boolean]
}>()

const { t: tt } = useI18n()
</script>

<template>
  <div class="tbl">
    <a-table
      :data-source="dataSource"
      :loading="loading"
      row-key="id"
      size="small"
      :pagination="false"
    >
      <a-table-column
        :title="$t('agents.k3xhia001')"
        data-index="name"
      >
        <template #default="{ record }">
          <span class="tpl-name">
            <span class="i-tabler-user-square" />
            {{ tplName(record) }}
          </span>
        </template>
      </a-table-column>
      <a-table-column
        title="harness"
        data-index="harness"
        :width="120"
      >
        <template #default="{ record }">
          <span
            class="h-cell"
            :class="{ off: isUnavailable(record.harness) }"
            :title="isUnavailable(record.harness) ? (harnessMeta(record.harness)?.error ?? '') : (harnessMeta(record.harness)?.resolvedPath ?? '')"
          >
            <span class="h-dot" />{{ record.harness }}<span
              v-if="isUnavailable(record.harness)"
              class="h-miss"
            >({{ tt('agents.notInstalled') }})</span>
          </span>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('agents.k3lrqn0002')"
        :width="120"
      >
        <template #default="{ record }">
          <a-tag
            :color="visTag(record).color"
            class="vis-tag"
          >
            <span
              v-if="visTag(record).icon"
              :class="visTag(record).icon"
            />{{ visTag(record).text }}
          </a-tag>
          <!-- 开关**不带文字**:左边那枚 tag 已经在说"公开/私有"了。
               两处同时显示同一个词,是同一列里把一条信息讲了两遍(实测桌面版每行都这样)。
               开关只负责"可切换"这个动作,语义由 tag + title 承载。 -->
          <a-switch
            v-if="!record.isBuiltin && canWrite(record)"
            :checked="record.visibility === 'public'"
            size="small"
            :title="record.visibility === 'public' ? $t('agents.toPrivate') : $t('agents.toPublic')"
            @change="(v: unknown) => emit('toggleVisibility', record, v === true)"
          />
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('agents.k3l98u7003')"
        :width="130"
      >
        <template #default="{ record }">
          <span class="owner">{{ record.ownerName ?? record.ownerUserId?.slice(0, 8) ?? '-' }}</span>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('agents.k3mr526004')"
        :width="70"
      >
        <template #default="{ record }">
          {{ record.instances.length }}
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('agents.k3xhfg005')"
        :width="70"
      >
        <template #default="{ record }">
          <a-switch
            :checked="record.enabled === 1"
            size="small"
            :disabled="!canWrite(record)"
            @change="emit('toggleEnabled', record)"
          />
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('agents.k40aa6006')"
        :width="130"
      >
        <template #default="{ record }">
          <a-space size="small">
            <a-button
              size="small"
              type="text"
              :disabled="!canWrite(record)"
              :title="record.isBuiltin ? $t('agents.builtinNoEdit') : !canWrite(record) ? $t('agents.ownerOnlyEdit') : $t('common.edit')"
              @click="emit('edit', record)"
            >
              {{ $t('agents.k45eb0012') }}
            </a-button>
            <a-popconfirm
              :title="$t('agents.keetzvf007')"
              :disabled="!canWrite(record)"
              @confirm="emit('remove', record)"
            >
              <a-button
                size="small"
                type="text"
                danger
                :disabled="!canWrite(record)"
                :title="record.isBuiltin ? $t('agents.builtinNoDelete') : $t('common.delete')"
              >
                {{ $t('agents.k3xakp013') }}
              </a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </a-table-column>
      <template #expandedRowRender="{ record }">
        <div
          v-for="inst in record.instances"
          :key="inst.id"
          class="inst"
        >
          <a-tag :color="inst.role === 'lead' ? 'gold' : 'blue'">
            {{ inst.role }}
          </a-tag>
          <span class="inst-id">{{ inst.id.slice(0, 8) }}</span>
          <span class="inst-ch">channel {{ inst.channelId.slice(0, 8) }}</span>
        </div>
        <div
          v-if="record.instances.length === 0"
          class="empty"
        >
          {{ $t('agents.k1d036zs014') }}
        </div>
      </template>
    </a-table>
  </div>
</template>

<style scoped>
.h-cell {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 12px;
}
.h-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok, #4a6b57);
}
.h-cell.off .h-dot { background: var(--danger, #c25a4e); }
.h-cell.off { opacity: 0.75; }
.h-miss { color: var(--danger, #c25a4e); font-family: var(--font-sans); font-size: 11px; }
.tpl-name {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.vis-tag {
  margin-right: 8px;
}
.owner { font-size: 12px; color: var(--ink-soft); }
.inst {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 2px 0;
  font-size: 12px;
}
.inst-id,
.inst-ch { font-family: var(--font-mono); opacity: 0.6; }
.empty { padding: 6px 0; font-size: 12px; opacity: 0.4; }

/* ══ 窄屏(v9):表格横向卷轴 + 首列可读 ═══════════════════════════════════
   同一条窄屏规则的另外两半随各自的标记走:页头堆叠在 agents.vue,
   筛选条换行在 AgentTemplateToolbar.vue。选择器前缀由拆分前的 .page 改为本组件
   根节点 .tbl —— 表格标记在这个组件里,规则跟着一起搬(命中范围不变)。 */
@media (max-width: 900px) {
  /* 整表给出可读下限:横向卷轴交给全局 v5 的 .ant-table-content */
  .tbl :deep(.ant-table-content) table { min-width: 828px; }

  /* 有 expandedRowRender 时 antd 会把"展开图标列"放在第一列,而全局 v5 钉住的正是第一列。
     auto 布局下没有显式宽度的列会吃掉全部余量 → 展开列白占 ~115px,真正的身份列还会被卷走。
     这里把展开列收成 44px,并让身份列(模板名)紧随其后一起钉住:横扫时始终知道这一行是谁。 */
  .tbl :deep(.ant-table colgroup col:first-child) { width: 44px; }

  .tbl :deep(.ant-table-thead > tr > th:first-child),
  .tbl :deep(.ant-table-tbody > tr > td:first-child) {
    width: 44px;
    min-width: 44px;
    padding-right: 2px;
    padding-left: 6px;
  }

  .tbl :deep(.ant-table-thead > tr > th:nth-child(2)),
  .tbl :deep(.ant-table-tbody > tr > td:nth-child(2)) {
    position: sticky;
    left: 44px;
    z-index: 2;
    min-width: 132px;
    background: var(--paper-raised);
    box-shadow: 1px 0 0 var(--line);
  }

  .tbl :deep(.ant-table-thead > tr > th:nth-child(2)) { z-index: 3; }
}

@media (max-width: 640px) {
  .tpl-name { min-width: 120px; }
  .tbl :deep(.ant-table) .ant-btn-sm { min-height: 34px; }
}

/* 触摸命中区:antd 小开关本体只有 28×16(手指点不中),视觉尺寸保持不变,
   用伪元素把命中区外扩到 ~40×40 —— 与全局 v5 给展开图标做的事同一手法。
   行内没有相邻可点元素(可见性列是 tag+switch,启用列只有 switch),不会误伤。 */
@media (max-width: 900px) {
  .tbl :deep(.ant-switch) { position: relative; }

  .tbl :deep(.ant-switch)::after {
    position: absolute;
    inset: -12px -6px;
    content: '';
  }
}
</style>
