<script setup lang="ts">
/**
 * 产线数据查询(产品/配方/参数/时间/间隔)—— 限定本产线通道,结果按通道聚合。
 * 查询表单对象由页面 useDcwQuery 独占持有(经 v-model 就地读写同一 reactive 对象)。
 */
import type { ProductView, RecipeView, LineQueryResult } from '#shared/dcw-protocol'
import type { DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import type { DcwQueryForm } from '../../pages/dcw/composables/useDcwQuery'

defineProps<{
  lineProducts: ProductView[]
  visibleRecipes: RecipeView[]
  lineDaqNodes: DaqNodeLive[]
  daqParamKeys: string[]
  queryBusy: boolean
  queryError: string
  queryResult: LineQueryResult | null
}>()

const emit = defineEmits<{ run: [] }>()

const query = defineModel<DcwQueryForm>('query', { required: true })

/** 查询点位展示(原始值或桶均值) */
function fmtPoint(p: { value?: number, avg?: number } | undefined): string {
  const v = p?.value ?? p?.avg
  return v == null ? '--' : String(Math.round(v * 1000) / 1000)
}
</script>

<template>
  <section class="aw-tile query-card">
    <p class="sec-label">
      {{ $t('dcwDetail.k1us3jse106') }}
    </p>
    <div class="q-grid">
      <label class="f">
        <span>{{ $t('dcwDetail.k3waz1025') }}</span>
        <select
          v-model="query.productId"
          class="inp"
          @change="query.recipeId = ''"
        >
          <option value="">
            {{ $t('dcwDetail.k1bkl1jx107') }}
          </option>
          <option
            v-for="p in lineProducts"
            :key="p.id"
            :value="p.id"
          >
            {{ p.name }}
          </option>
        </select>
      </label>
      <label class="f">
        <span>{{ $t('dcwDetail.k48grv027') }}</span>
        <select
          v-model="query.recipeId"
          class="inp"
          :disabled="!query.productId"
        >
          <option value="">
            {{ $t('dcwDetail.k1bkx7cr108') }}
          </option>
          <option
            v-for="r in visibleRecipes"
            :key="r.id"
            :value="r.id"
          >
            {{ r.name }}
          </option>
        </select>
      </label>
      <label class="f">
        <span>{{ $t('dcwDetail.k1demcae109') }}</span>
        <select
          v-model="query.paramKey"
          class="inp"
        >
          <option value="">
            {{ $t('dcwDetail.k1bkx7ya110') }}
          </option>
          <option
            v-for="k in daqParamKeys"
            :key="k"
            :value="k"
          >
            {{ k }}
          </option>
        </select>
      </label>
      <label class="f">
        <span>{{ $t('dcwDetail.k45uio082') }}</span>
        <select
          v-model="query.nodeId"
          class="inp"
        >
          <option value="">
            {{ $t('dcwDetail.k1bkul3k111') }}
          </option>
          <option
            v-for="n in lineDaqNodes"
            :key="n.id"
            :value="n.id"
          >
            {{ n.name }}
          </option>
        </select>
      </label>
      <label class="f">
        <span>{{ $t('dcwDetail.kx2ojn0112') }}</span>
        <input
          v-model.number="query.lastMin"
          type="number"
          min="1"
          max="10080"
          class="inp"
        >
      </label>
      <label class="f">
        <span>{{ $t('dcwDetail.kjvnvn4113') }}</span>
        <input
          v-model.number="query.bucketMs"
          type="number"
          min="1000"
          step="500"
          class="inp"
        >
      </label>
      <div class="f q-actions">
        <button
          class="pill-btn"
          :disabled="queryBusy"
          @click="emit('run')"
        >
          {{ queryBusy ? $t('dcwDetail.k1eyx09r165') : $t('dcwDetail.k416ek178') }}
        </button>
      </div>
    </div>
    <p
      v-if="queryError"
      class="banner bad"
      style="margin-top: 8px;"
    >
      {{ queryError }}
    </p>
    <div
      v-if="queryResult"
      class="q-result"
    >
      <table class="nodes-table">
        <thead>
          <tr>
            <th>{{ $t('dcwDetail.k48hde081') }}</th>
            <th>{{ $t('dcwDetail.k45uio082') }}</th>
            <th>{{ $t('dcwDetail.k42kcu114') }}</th>
            <th>{{ $t('dcwDetail.k49ujb115') }}</th>
            <th>{{ $t('dcwDetail.k40pvw116') }}</th>
            <th>{{ $t('dcwDetail.k3xho3117') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in queryResult.channels"
            :key="c.nodeId"
          >
            <td>{{ c.ch }}<small class="mono dim"> {{ c.unit }}</small></td>
            <td>{{ c.nodeName }}</td>
            <td class="mono">
              {{ c.points.length }}
            </td>
            <td class="mono">
              {{ fmtPoint(c.points[0]) }}
            </td>
            <td class="mono">
              {{ fmtPoint(c.points[c.points.length - 1]) }}
            </td>
            <td class="mono dim">
              {{ new Date(c.points[0]?.at ?? 0).toLocaleTimeString() }} ~ {{ new Date(c.points[c.points.length - 1]?.at ?? 0).toLocaleTimeString() }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }

.banner { padding: 9px 14px; margin: 0 0 12px; font-size: 12.5px; border-radius: var(--radius-chip); }
.banner.bad { color: var(--tone-danger-dot); background: var(--tone-danger-bg); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 40%, transparent); }
.banner.good { color: var(--tone-success-dot); background: var(--tone-success-bg); border: 1px solid color-mix(in srgb, var(--tone-success-dot) 40%, transparent); }

.nodes-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.nodes-table th, .nodes-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.nodes-table th { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); border-bottom: 1px solid var(--line-strong); }
.nodes-table td b { margin-left: 8px; }

.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

.query-card { padding: 14px 18px; margin-bottom: 14px; }
.q-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; align-items: end; }

.q-grid .f { font-size: 11px; color: var(--ink-faint); }
.q-actions { justify-content: flex-end; }
.q-result { margin-top: 12px; overflow-x: auto; }

.sec-label { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); }

.f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }

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
  .query-card { padding: 12px; }
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .pill-btn,
  .inp {
    min-height: 40px;
  }
  /* 弹窗表单:两列/三列在窄屏一律落成一列,否则标签被压成竖排字 */
  .q-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 640px) {
  .q-grid { grid-template-columns: 1fr; }
}
</style>
