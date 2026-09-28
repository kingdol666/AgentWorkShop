<script setup lang="ts">
/**
 * 产线操作筛选卡:产线 / 分类 / 来源 / 关键词 + 查询/重置。
 * 筛选态由页面持有(useOperationsFeed),这里只做双向绑定;
 * 产线选项与日志页同一份权威目录(useLogsScope → DCW 流单例)。
 */
import { OPERATION_KIND_FILTERS } from '@/app/pages/operations/composables/useOperationsFeed'
import { useLogsScope } from '@/app/pages/logs/composables/useLogsScope'

defineProps<{
  /** 是否已设任一筛选维度(决定"重置"按钮显隐) */
  hasFilter: boolean
  /** 查询中(查询按钮置灰) */
  loading: boolean
}>()

defineEmits<{
  query: []
  reset: []
}>()

const lineId = defineModel<string>('lineId', { required: true })
const actorKind = defineModel<string>('actorKind', { required: true })
const kind = defineModel<string>('kind', { required: true })
const text = defineModel<string>('text', { required: true })

const { lines } = useLogsScope()
</script>

<template>
  <section class="filter-card">
    <label class="flt">
      <span>{{ $t('operations.fLine') }}</span>
      <select
        v-model="lineId"
        class="inp-sel"
      >
        <option value="">
          {{ $t('operations.all') }}
        </option>
        <option
          v-for="l in lines"
          :key="l.id"
          :value="l.id"
        >
          {{ l.name }}
        </option>
      </select>
    </label>
    <label class="flt">
      <span>{{ $t('operations.fKind') }}</span>
      <select
        v-model="kind"
        class="inp-sel"
      >
        <option value="">
          {{ $t('operations.all') }}
        </option>
        <option
          v-for="k in OPERATION_KIND_FILTERS"
          :key="k"
          :value="k"
        >
          {{ $t(`operations.cat.${k}`) }}
        </option>
      </select>
    </label>
    <label class="flt">
      <span>{{ $t('operations.fSource') }}</span>
      <select
        v-model="actorKind"
        class="inp-sel"
      >
        <option value="">
          {{ $t('operations.all') }}
        </option>
        <option value="agent">
          {{ $t('operations.actorAgent') }}
        </option>
        <option value="user">
          {{ $t('operations.actorUser') }}
        </option>
        <option value="system">
          {{ $t('operations.actorSystem') }}
        </option>
      </select>
    </label>
    <label class="flt flt-grow">
      <span>{{ $t('operations.fKeyword') }}</span>
      <input
        v-model="text"
        class="inp-sel"
        type="search"
        :placeholder="$t('operations.fKeywordPh')"
        @keydown.enter="$emit('query')"
      >
    </label>
    <button
      class="pill-btn"
      :disabled="loading"
      @click="$emit('query')"
    >
      <span class="i-tabler-search" />
      {{ $t('operations.query') }}
    </button>
    <button
      v-if="hasFilter"
      class="mini-btn"
      @click="$emit('reset')"
    >
      {{ $t('operations.reset') }}
    </button>
  </section>
</template>

<style scoped>
.filter-card {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end;
  padding: 10px 14px;
  background: var(--surface-glass);
  border: 1px solid var(--glass-line);
  border-radius: 10px;
  backdrop-filter: var(--aurora-blur) saturate(1.15);
}
@media (max-width: 640px) {
  .filter-card {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    align-items: end;
  }
  .filter-card .flt-grow,
  .filter-card > button {
    grid-column: 1 / -1;
  }
}
.flt { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.flt-grow { flex: 1 1 180px; }
/* 输入框工具类:与 LogsFilterCard 同名规则逐字复制(样式随标记走,不抽公共 css) */
.inp-sel {
  min-width: 0; padding: 6px 9px; font-size: 13px; color: var(--ink);
  background: var(--frost-bg);
  border: 1px solid var(--glass-line); border-radius: 7px; outline: none;
}
.inp-sel:focus { border-color: color-mix(in srgb, var(--tone-info-dot) 55%, transparent); }
@media (max-width: 899px) {
  .filter-card .mini-btn,
  .filter-card .pill-btn {
    min-height: 40px;
    padding: 8px 14px;
  }
  .filter-card {
    padding: 10px;
    gap: 8px;
  }
  .flt,
  .flt-grow,
  .flt .inp-sel {
    flex: 1 1 100%;
    width: 100%;
    min-width: 0;
  }
}
</style>
