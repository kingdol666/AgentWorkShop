<script setup lang="ts">
/**
 * 维度筛选卡:产线 → 产品 → Recipe 级联 + 来源/分类/关键词 + 查询/重置。
 *
 * 筛选态由页面持有(唯一副本),这里只做双向绑定:改选上游维度即清空下游选择,
 * 选项列表按当前口径过滤(与结果表同一套归属维度语义,取自 useLogsScope)。
 */
import { computed } from 'vue'
import { LOG_KINDS } from '@/app/pages/logs/composables/useLogsQuery'
import { useLogsScope } from '@/app/pages/logs/composables/useLogsScope'

defineProps<{
  /** 是否已设任一筛选维度(决定"重置"按钮显隐) */
  hasFilter: boolean
  /** 结果集查询中(查询按钮置灰) */
  loading: boolean
}>()

defineEmits<{
  query: []
  reset: []
}>()

const lineId = defineModel<string>('lineId', { required: true })
const productId = defineModel<string>('productId', { required: true })
const recipeId = defineModel<string>('recipeId', { required: true })
const actorKind = defineModel<string>('actorKind', { required: true })
const kind = defineModel<string>('kind', { required: true })
const text = defineModel<string>('text', { required: true })

const { lines, productsOfLine, recipesOfScope } = useLogsScope()

const productOptions = computed(() => productsOfLine(lineId.value))
const recipeOptions = computed(() => recipesOfScope(lineId.value, productId.value))

/** 产线变更 → 产品/Recipe 选择失效 */
function onLineChange(): void {
  productId.value = ''
  recipeId.value = ''
}

/** 产品变更 → Recipe 选择失效 */
function onProductChange(): void {
  recipeId.value = ''
}
</script>

<template>
  <!-- 维度筛选:产线 → 产品 → Recipe 级联 + 来源/分类/关键词 -->
  <section class="filter-card">
    <label class="flt">
      <span>{{ $t('logs.fLine') }}</span>
      <select
        v-model="lineId"
        class="inp-sel"
        @change="onLineChange"
      >
        <option value="">
          {{ $t('logs.all') }}
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
      <span>{{ $t('logs.fProduct') }}</span>
      <select
        v-model="productId"
        class="inp-sel"
        @change="onProductChange"
      >
        <option value="">
          {{ $t('logs.all') }}
        </option>
        <option
          v-for="p in productOptions"
          :key="p.id"
          :value="p.id"
        >
          {{ p.name }}
        </option>
      </select>
    </label>
    <label class="flt">
      <span>Recipe</span>
      <select
        v-model="recipeId"
        class="inp-sel"
      >
        <option value="">
          {{ $t('logs.all') }}
        </option>
        <option
          v-for="r in recipeOptions"
          :key="r.id"
          :value="r.id"
        >
          {{ r.name }}
        </option>
      </select>
    </label>
    <label class="flt">
      <span>{{ $t('logs.fSource') }}</span>
      <select
        v-model="actorKind"
        class="inp-sel"
      >
        <option value="">
          {{ $t('logs.all') }}
        </option>
        <option value="user">
          {{ $t('logs.src.user') }}
        </option>
        <option value="agent">
          Agent
        </option>
        <option value="system">
          {{ $t('logs.src.system') }}
        </option>
      </select>
    </label>
    <label class="flt">
      <span>{{ $t('logs.fKind') }}</span>
      <select
        v-model="kind"
        class="inp-sel"
      >
        <option value="">
          {{ $t('logs.all') }}
        </option>
        <option
          v-for="k in LOG_KINDS"
          :key="k"
          :value="k"
        >
          {{ $t(`logs.kind.${k}`) }}
        </option>
      </select>
    </label>
    <label class="flt flt-grow">
      <span>{{ $t('logs.fKeyword') }}</span>
      <input
        v-model="text"
        class="inp-sel"
        type="search"
        :placeholder="$t('logs.fKeywordPh')"
        @keydown.enter="$emit('query')"
      >
    </label>
    <button
      class="pill-btn"
      :disabled="loading"
      @click="$emit('query')"
    >
      <span class="i-tabler-search" />
      {{ $t('logs.query') }}
    </button>
    <button
      v-if="hasFilter"
      class="mini-btn"
      @click="$emit('reset')"
    >
      {{ $t('logs.reset') }}
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
/* 窄屏:6 个筛选维度从"一行一个"改成两列网格。
 * 单列时筛选区独占整整一屏,用户要滚过 6 个下拉才看到第一条日志(实测 390)。 */
@media (max-width: 640px) {
  .filter-card {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    align-items: end;
  }

  /* 关键词是"宽输入",跨两列;两个动作按钮也跨两列,各自成行 */
  .filter-card .flt-grow,
  .filter-card > button {
    grid-column: 1 / -1;
  }
}

.flt { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.flt-grow { flex: 1 1 180px; }
/* 输入框工具类:人工记录弹窗内的同名规则是逐字复制(样式随标记走,不抽公共 css) */
.inp-sel {
  min-width: 0; padding: 6px 9px; font-size: 13px; color: var(--ink);
  background: var(--frost-bg);
  border: 1px solid var(--glass-line); border-radius: 7px; outline: none;
}
.inp-sel:focus { border-color: color-mix(in srgb, var(--tone-info-dot) 55%, transparent); }

@media (max-width: 899px) {
  /* 手指命中区:表格内的 mini-btn 原始高度只有 ~24px。
     同一组声明(原页面 scoped 块 @media 899 内)按"样式随标记走"的约束
     逐字复制进需要它的每个组件 —— 此处与 LogsPageHead/LogsEventTable/LogsManualModal
     的对应块是有意重复,不要合并成公共 css。 */
  .filter-card .mini-btn,
  .filter-card .pill-btn {
    min-height: 40px;
    padding: 8px 14px;
  }

  /* 筛选条:窄屏一项一行,不再两列互挤 */
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
