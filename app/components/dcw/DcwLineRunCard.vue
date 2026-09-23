<script setup lang="ts">
/**
 * 产线运行控制 —— 开跑必设配方;窗口内数采逐样本打标。
 * 运行态 ls 由页面(server 权威)下发;产品/配方选择经 v-model 就地读写页面状态。
 */
import type { LineRunState, ProductView, RecipeView } from '#shared/dcw-protocol'

defineProps<{
  ls: LineRunState
  lineProducts: ProductView[]
  lineRecipes: RecipeView[]
  lineBusy: boolean
  lineMsg: string
  lineErr: string
}>()

const emit = defineEmits<{ start: [], stop: [] }>()

const lineProductId = defineModel<string>('productId', { required: true })
const lineRecipeId = defineModel<string>('recipeId', { required: true })
</script>

<template>
  <section class="aw-tile line-card">
    <div class="line-status">
      <span
        class="line-dot"
        :class="{ on: ls.active }"
      />
      <div class="line-info">
        <b>{{ ls.active ? $t('dcwDetail.k1pxrhx0154') : $t('dcwDetail.k1b2hxmx170') }}</b>
        <small
          v-if="ls.active"
          class="mono dim"
        >{{ ls.productName }} · {{ ls.recipeName }} · {{ $t('dcwDetail.k400lb075') }} {{ ls.runId }} · {{ $t('dcwDetail.k3zkt2166') }} {{ ls.startedAt?.slice(11, 19) }} {{ $t('dcwDetail.k69vag8168') }} {{ ls.taggedSamples }} {{ $t('dcwDetail.k4118o085') }}</small>
        <small
          v-else
          class="dim"
        >{{ $t('dcwDetail.k19pof14024') }}</small>
      </div>
    </div>
    <div class="line-ctl">
      <label class="ctl-sel">
        <span>{{ $t('dcwDetail.k3waz1025') }}</span>
        <select
          v-model="lineProductId"
          class="inp"
          @change="lineRecipeId = ''"
        >
          <option value="">
            {{ $t('dcwDetail.kuisodh026') }}
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
      <label class="ctl-sel">
        <span>{{ $t('dcwDetail.k48grv027') }}</span>
        <select
          v-model="lineRecipeId"
          class="inp"
          :disabled="!lineProductId"
        >
          <option value="">
            {{ $t('dcwDetail.kutxzsz028') }}
          </option>
          <option
            v-for="r in lineRecipes"
            :key="r.id"
            :value="r.id"
            :disabled="r.params.length === 0"
          >
            {{ r.name }}{{ r.params.length === 0 ? $t('dcwDetail.k1hicmch155') : $t('dcwDetail.k1lzfi4g180', { p0: r.params.length }) }}
          </option>
        </select>
      </label>
      <button
        v-if="!ls.active"
        class="pill-btn"
        :disabled="lineBusy || !lineRecipeId"
        :title="!lineRecipeId ? $t('dcwDetail.startNeedRecipe') : $t('dcwDetail.startTip')"
        @click="emit('start')"
      >
        {{ $t('dcwDetail.kfb8vml029') }}
      </button>
      <button
        v-else
        class="pill-btn stop"
        :disabled="lineBusy"
        @click="emit('stop')"
      >
        {{ $t('dcwDetail.k1xyhd2y030') }}
      </button>
    </div>
    <p
      v-if="lineErr"
      class="banner bad"
      style="margin-top: 10px;"
    >
      {{ lineErr }}
    </p>
    <p
      v-if="lineMsg"
      class="banner good"
      style="margin-top: 10px;"
    >
      {{ lineMsg }}
    </p>
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

.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

.line-card { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; padding: 14px 18px; margin-bottom: 14px; }
.line-status { display: flex; gap: 12px; align-items: center; min-width: 260px; }
.line-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--tone-neutral-dot); box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone-neutral-dot) 20%, transparent); }
.line-dot.on { background: var(--tone-success-dot); box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone-success-dot) 22%, transparent); animation: linePulse 1.6s infinite; }
@keyframes linePulse { 0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone-success-dot) 25%, transparent); } 50% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--tone-success-dot) 8%, transparent); } }
.line-info b { font-size: 14px; }
.line-info small { display: block; margin-top: 2px; font-size: 11px; }
.line-ctl { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.ctl-sel { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--ink-faint); }
.ctl-sel .inp { min-width: 150px; }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  .line-card { gap: 12px; padding: 12px; }
  .line-status { min-width: 0; }
  .line-ctl { width: 100%; }
  .ctl-sel { flex: 1 1 140px; min-width: 0; }
  .ctl-sel .inp { min-width: 0; width: 100%; }
  .line-ctl .pill-btn { flex: 1 1 120px; }
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .pill-btn,
  .inp {
    min-height: 40px;
  }
}
</style>
