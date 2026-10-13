<script setup lang="ts">
/**
 * 数据分析筛选卡:产线 / 类别 / 时间窗 / 关键词 + 查询/重置。
 * 筛选态由页面持有(useAnalysisFeed),这里只做双向绑定;
 * 产线选项与日志页同一份权威目录(useLogsScope → DCW 流单例)。
 */
import { ANALYSIS_CATEGORIES, ANALYSIS_WINDOW_PRESETS } from '@/app/pages/analysis/types'
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
const category = defineModel<string>('category', { required: true })
const preset = defineModel<string>('preset', { required: true })
const text = defineModel<string>('text', { required: true })

const { lines } = useLogsScope()
</script>

<template>
  <section class="filter-card">
    <label class="flt">
      <span>{{ $t('analysis.fLine') }}</span>
      <select
        v-model="lineId"
        class="inp-sel"
      >
        <option value="">
          {{ $t('analysis.all') }}
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
      <span>{{ $t('analysis.fCat') }}</span>
      <select
        v-model="category"
        class="inp-sel"
      >
        <option value="">
          {{ $t('analysis.all') }}
        </option>
        <option
          v-for="c in ANALYSIS_CATEGORIES"
          :key="c"
          :value="c"
        >
          {{ $t(`analysis.cat.${c}`) }}
        </option>
      </select>
    </label>
    <label class="flt">
      <span>{{ $t('analysis.fWindow') }}</span>
      <select
        v-model="preset"
        class="inp-sel"
      >
        <option
          v-for="p in ANALYSIS_WINDOW_PRESETS"
          :key="p.key"
          :value="p.key"
        >
          {{ $t(`analysis.win.${p.key}`) }}
        </option>
      </select>
    </label>
    <label class="flt flt-grow">
      <span>{{ $t('analysis.fKeyword') }}</span>
      <input
        v-model="text"
        class="inp-sel"
        type="search"
        :placeholder="$t('analysis.fKeywordPh')"
        @keydown.enter="$emit('query')"
      >
    </label>
    <button
      class="pill-btn"
      :disabled="loading"
      @click="$emit('query')"
    >
      <span class="i-tabler-search" />
      {{ $t('analysis.query') }}
    </button>
    <button
      v-if="hasFilter"
      class="mini-btn"
      @click="$emit('reset')"
    >
      {{ $t('analysis.reset') }}
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
