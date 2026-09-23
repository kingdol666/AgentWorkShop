<script setup lang="ts">
/**
 * 产品与配方管理 —— 产品筛选行 / 配方卡片(参数与监控窗口 chip、失效徽标) /
 * 应用配方结果横幅 / 批次列表;批次数据视图由 DcwRunDataModal 承载(仍在同一 section 内)。
 * 配方清单与运行数据由页面派生下发,动作一律回抛页面。
 */
import type { ProductView, RecipeRunView, RecipeView, RecipeRunData } from '#shared/dcw-protocol'
import type { StaleRef } from '../../pages/dcw/composables/useDcwDetailScope'

defineProps<{
  lineProducts: ProductView[]
  visibleRecipes: RecipeView[]
  lineRuns: RecipeRunView[]
  applyResult: { runId: string, ok: number, total: number } | null
  runDataView: { runId: string, data: RecipeRunData } | null
  runDataLoading: boolean
  productName: (id: string) => string
  paramStatus: (nodeId: string, lineId: string) => StaleRef | null
  paramNodeName: (nodeId: string) => string
  daqWindowStatus: (nodeId: string, lineId: string) => StaleRef | null
  daqNodeCh: (nodeId: string) => string
}>()

const emit = defineEmits<{
  'create': []
  'open-product': []
  'apply': [id: string]
  'edit': [id: string]
  'history': [id: string]
  'remove-recipe': [id: string]
  'remove-product': [id: string]
  'view-run': [id: string]
  'close-run': [id: string]
  'close-run-data': []
}>()

const { t } = useI18n()

/** 产品筛选(页面唯一副本;配方清单与查询下拉同源) */
const filterProductId = defineModel<string>('filterProductId', { required: true })
</script>

<template>
  <section class="aw-tile recipe-card">
    <div class="recipe-hd">
      <h3>{{ $t('dcwDetail.k1j8w3hd065') }}</h3>
      <span class="panel-tag mono">{{ lineProducts.length }} {{ $t('dcwDetail.k1av3wgs143') }} {{ visibleRecipes.length }} {{ $t('dcwDetail.k48grv027') }}</span>
      <button
        class="pill-btn"
        style="margin-left: auto;"
        @click="emit('create')"
      >
        {{ $t('dcwDetail.k1akm6dc066') }}
      </button>
      <button
        class="mini-btn"
        @click="emit('open-product')"
      >
        {{ $t('dcwDetail.k1aka0ki067') }}
      </button>
    </div>
    <p class="recipe-sub">
      {{ $t('dcwDetail.k6bl2q8068') }}
    </p>

    <!-- 产品管理行 -->
    <div
      v-if="lineProducts.length"
      class="product-row"
    >
      <button
        class="prod-chip"
        :class="{ on: filterProductId === '' }"
        @click="filterProductId = ''"
      >
        {{ $t('dcwDetail.k3x4t1069') }}
      </button>
      <button
        v-for="p in lineProducts"
        :key="p.id"
        class="prod-chip"
        :class="{ on: filterProductId === p.id }"
        :title="p.description"
        @click="filterProductId = p.id"
      >
        {{ p.name }}
        <span
          class="prod-del"
          :title="$t('dcwDetail.k1bpfjgx012')"
          @click.stop="emit('remove-product', p.id)"
        >×</span>
      </button>
    </div>
    <p
      v-else
      class="dim"
      style="margin: 6px 0 12px; font-size: 12px;"
    >
      {{ $t('dcwDetail.knov3zg070') }}
    </p>

    <div class="recipe-grid">
      <div
        v-for="r in visibleRecipes"
        :key="r.id"
        class="recipe-item"
      >
        <div class="recipe-name">
          <b>{{ r.name }}</b>
          <span
            v-if="r.version"
            class="param-chip mono"
            :title="t('dcwDetail.histTitle')"
          >v{{ r.version }}</span>
          <small class="dim">{{ productName(r.productId) }}</small>
          <small class="mono dim">{{ r.id }}</small>
        </div>
        <p
          v-if="r.description"
          class="dim desc"
        >
          {{ r.description }}
        </p>
        <div class="recipe-params mono">
          <span
            v-for="(p, i) in r.params"
            :key="i"
            class="param-chip"
            :class="{ stale: paramStatus(p.nodeId, r.lineId) }"
            :title="paramStatus(p.nodeId, r.lineId)?.label ?? ''"
          >
            {{ paramNodeName(p.nodeId) }} = {{ p.value }}<span
              v-if="paramStatus(p.nodeId, r.lineId)"
              class="chip-stale-tag"
            >{{ paramStatus(p.nodeId, r.lineId)!.label }}</span>
          </span>
          <span
            v-for="(w, i) in r.daqWindows"
            :key="`w-${i}`"
            class="param-chip daqwin"
            :class="{ stale: daqWindowStatus(w.nodeId, r.lineId) }"
            :title="daqWindowStatus(w.nodeId, r.lineId)?.label ?? $t('dcwDetail.k1l11api013')"
          >
            ◎ {{ daqNodeCh(w.nodeId) }} ∈ [{{ w.min ?? '-∞' }}, {{ w.max ?? '+∞' }}]<span
              v-if="daqWindowStatus(w.nodeId, r.lineId)"
              class="chip-stale-tag"
            >{{ daqWindowStatus(w.nodeId, r.lineId)!.label }}</span>
          </span>
        </div>
        <div class="recipe-actions">
          <button
            class="pill-btn"
            @click="emit('apply', r.id)"
          >
            {{ $t('dcwDetail.k1497qvr071') }}
          </button>
          <button
            class="mini-btn"
            @click="emit('edit', r.id)"
          >
            {{ $t('dcwDetail.k45eb0072') }}
          </button>
          <button
            class="mini-btn"
            @click="emit('history', r.id)"
          >
            {{ t('dcwDetail.histBtn') }}<span
              v-if="r.version"
              class="mono"
            >·v{{ r.version }}</span>
          </button>
          <button
            class="mini-btn danger"
            @click="emit('remove-recipe', r.id)"
          >
            {{ $t('dcwDetail.k3xakp063') }}
          </button>
        </div>
      </div>
      <div
        v-if="visibleRecipes.length === 0"
        class="pane-empty"
        style="grid-column: 1 / -1;"
      >
        {{ $t('dcwDetail.keko1xy073') }}
      </div>
    </div>

    <div
      v-if="applyResult"
      class="banner good"
    >
      {{ $t('dcwDetail.k1l3hrvp144') }} {{ applyResult.runId }} {{ $t('dcwDetail.k1g3lh2v167') }}{{ applyResult.ok }}/{{ applyResult.total }} {{ $t('dcwDetail.k1bqci06149') }}
      <button
        class="mini-btn"
        style="margin-left: 10px;"
        :disabled="runDataLoading"
        @click="emit('view-run', applyResult.runId)"
      >
        {{ runDataLoading ? $t('dcwDetail.k1br0ij9161') : $t('dcwDetail.kxwei5175') }}
      </button>
    </div>

    <!-- 批次列表 -->
    <div
      v-if="lineRuns.length"
      class="runs"
    >
      <p class="sec-label">
        {{ $t('dcwDetail.k1rjer8d074') }}
      </p>
      <table class="nodes-table">
        <thead>
          <tr>
            <th>{{ $t('dcwDetail.k400lb075') }}</th>
            <th>{{ $t('dcwDetail.k48grv027') }}</th>
            <th>{{ $t('dcwDetail.k4497j076') }}</th>
            <th>{{ $t('dcwDetail.k1bqhtmu077') }}</th>
            <th class="right">
              {{ $t('dcwDetail.k40aa6061') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="run in [...lineRuns].reverse().slice(0, 8)"
            :key="run.id"
          >
            <td class="mono">
              {{ run.id }}
            </td>
            <td>{{ run.recipeName }}</td>
            <td class="mono dim">
              {{ run.startedAt.slice(5, 19) }} ~ {{ run.endedAt ? run.endedAt.slice(5, 19) : $t('dcwDetail.k3vpfg9162') }}
            </td>
            <td>
              <span
                class="st-pill"
                :class="run.results.every(r => r.ok) ? 'ok' : 'warn'"
              >{{ run.results.filter(r => r.ok).length }}/{{ run.results.length }}</span>
            </td>
            <td class="right">
              <button
                class="mini-btn"
                :disabled="runDataLoading"
                @click="emit('view-run', run.id)"
              >
                {{ $t('dcwDetail.k1dzwrdp078') }}
              </button>
              <button
                v-if="!run.endedAt"
                class="mini-btn"
                @click="emit('close-run', run.id)"
              >
                {{ $t('dcwDetail.k1blr7y7079') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 批次数据视图 -->
    <DcwRunDataModal
      :run-data-view="runDataView"
      @close="emit('close-run-data')"
    />
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.param-chip.daqwin { color: #41c8f4; border-color: rgba(65, 200, 244, 0.4); }

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }

.banner { padding: 9px 14px; margin: 0 0 12px; font-size: 12.5px; border-radius: var(--radius-chip); }
.banner.bad { color: var(--tone-danger-dot); background: var(--tone-danger-bg); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 40%, transparent); }
.banner.good { color: var(--tone-success-dot); background: var(--tone-success-bg); border: 1px solid color-mix(in srgb, var(--tone-success-dot) 40%, transparent); }

.nodes-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.nodes-table th, .nodes-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.nodes-table th { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); border-bottom: 1px solid var(--line-strong); }
.nodes-table td b { margin-left: 8px; }

.right { text-align: right; }

.st-pill { display: inline-block; padding: 3px 9px; font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.04em; border-radius: var(--radius-pill); }
.st-pill.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.writing { color: var(--ink); background: var(--hover-tint); }
.st-pill.error, .st-pill.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.st-pill.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.st-pill.offline, .st-pill.idle { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }
.st-pill.paused { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }

.recipe-hd { flex-wrap: wrap; }
.recipe-actions { flex-wrap: wrap; }

.mini-btn { margin-right: 4px; }
.mini-btn.danger { color: var(--tone-danger-dot); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }

/* 配方参数行:窄屏不再按 5 列硬分,否则数值列被压成竖排字 */
.param-chip { overflow-wrap: anywhere; }
.product-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
.prod-chip { display: inline-flex; gap: 6px; align-items: center; padding: 4px 12px; font-size: 12px; cursor: pointer; color: var(--ink-soft); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-pill); }
.prod-chip.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.prod-del { color: var(--tone-danger-dot); font-weight: 700; }

/* 配方网格:minmax(320px) 在 355px 画布(减去卡片内边距)里会溢出 1px,用 min() 兜住 */
.recipe-grid { grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); }

.recipe-card { padding: 16px 18px; margin-bottom: 14px; }
.recipe-hd { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
.recipe-hd h3 { margin: 0; font-size: 16px; }
.panel-tag { padding: 2px 8px; font-size: 11.5px; color: var(--ink-soft); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }
.recipe-sub { margin: 0 0 14px; font-size: 12px; color: var(--ink-faint); }
.recipe-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.recipe-item { padding: 12px 14px; background: var(--paper-deep); border: 1px solid var(--line); border-radius: var(--radius-chip); }
.recipe-name b { font-size: 13.5px; }
.recipe-name small { margin-left: 8px; }
.desc { margin: 4px 0; font-size: 12px; }
.recipe-params { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.param-chip { padding: 2px 8px; font-size: 11.5px; color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); border-radius: var(--radius-chip); }
.recipe-actions { display: flex; gap: 6px; align-items: center; margin-top: 8px; }

.sec-label { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); }
.runs { margin-top: 6px; }

/* 失效配方参数:灰化 + 徽标 */
.param-chip.stale { color: var(--ink-faint); background: color-mix(in srgb, var(--ink) 5%, transparent); border-color: var(--divider-hair); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--ink-faint) 60%, transparent); }
.chip-stale-tag { margin-left: 5px; padding: 0 5px; font-size: 11.5px; font-style: normal; color: var(--tone-danger-dot); background: color-mix(in srgb, var(--tone-danger-dot) 8%, transparent); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 30%, transparent); border-radius: var(--radius-chip); text-decoration: none; }

@media (prefers-reduced-motion: no-preference) {
  .nodes-table tbody tr:hover { background: var(--hover-tint); }
}

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  .nodes-table { min-width: 1080px; }
  .nodes-table th,
  .nodes-table td { white-space: nowrap; }
  .nodes-table thead > tr > th:first-child,
  .nodes-table tbody > tr > td:first-child {
    position: sticky;
    left: 0;
    z-index: 2;
    background: var(--paper-raised);
    box-shadow: 1px 0 0 var(--line);
  }
  .recipe-card { padding: 12px; }
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .mini-btn,
  .pill-btn,
  .prod-chip {
    min-height: 40px;
  }
  .recipe-hd .pill-btn,
  .recipe-hd .mini-btn { min-height: 40px; }
}
</style>
