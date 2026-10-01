<script setup lang="ts">
/**
 * 整包方案审批卡(产线详情页)—— 诊断 Channel recipe_propose 的「配方整包·
 * 多套候选」结构化审批单:方案 tab(1~3 套,选中态清晰)+ 参数对照表
 * (参数 | 当前值→目标值(mono+单位) | 预检徽标 | 依据 | 经验引用)+
 * 低置信黄条 / AML 活动红条(载荷可选字段,缺省不渲染)。
 * 批准=按选中方案整包原子下发(choice=选中下标,未选中点击 → 行内提示
 * needChoice 不发请求,fail-closed);拒绝=无需选方案,意见逐字回流。
 * 数据与裁决由页面 useRecipeDispatchApprovals 独占持有(经 props/emit 回抛,
 * 与 DcwParamApprovalCard 同模式);空态由页面 v-if 收敛(整卡不渲染)。
 * payload 缺失或 schemaVersion 不识别的行(legacy/异常兜底)降级渲染 detail
 * 文本 + 仅拒绝(fail-closed:无 choice 的批准一律按拒绝收敛,不给批准按钮)。
 */
import type { RecipeDispatchApprovalRow, RecipeDispatchDecideOpts, RecipeProposePayload } from '../../pages/dcw/composables/useRecipeDispatchApprovals'
import { computed, ref } from 'vue'

const props = defineProps<{
  items: RecipeDispatchApprovalRow[]
  /** 在飞裁决的行 id(行内按钮禁用) */
  decidingId: string
  /** 裁决失败提示(非空时卡内红字提示) */
  decideError: string
}>()

const emit = defineEmits<{ decide: [id: string, opts: RecipeDispatchDecideOpts] }>()

const comments = defineModel<Record<string, string>>('comments', { required: true })

/** 逐行选中方案下标(未选中=undefined;批准前必须点选一个方案 tab) */
const selected = ref<Record<string, number>>({})
/** 行内「请先选择方案」提示的行 id(点选任一方案 tab 即清除) */
const needChoiceId = ref('')

/** 结构化载荷(schemaVersion 守卫:不识别的版本按缺失降级) */
function payloadOf(row: RecipeDispatchApprovalRow): RecipeProposePayload | undefined {
  return row.payload && row.payload.schemaVersion === 1 ? row.payload : undefined
}

/** 行视图模型:payload 判定一次,模板按有无 payload 分流 */
const rows = computed(() => props.items.map(row => ({ row, payload: payloadOf(row) })))

/** 概要参数总数(全部方案合计) */
function totalParams(payload: RecipeProposePayload): number {
  return payload.packages.reduce((n, pkg) => n + pkg.params.length, 0)
}

function select(rowId: string, idx: number): void {
  selected.value[rowId] = idx
  if (needChoiceId.value === rowId)
    needChoiceId.value = ''
}

/** 批准:必须先选中方案(未选中 → 行内提示,不发请求;fail-closed) */
function approve(row: RecipeDispatchApprovalRow): void {
  const choice = selected.value[row.id]
  if (choice === undefined) {
    needChoiceId.value = row.id
    return
  }
  emit('decide', row.id, { approved: true, comment: comments.value[row.id] ?? '', choice })
}

/** 拒绝:无需选方案(意见逐字回流 Agent) */
function reject(row: RecipeDispatchApprovalRow): void {
  emit('decide', row.id, { approved: false, comment: comments.value[row.id] ?? '' })
}
</script>

<template>
  <section class="aw-tile rp-card">
    <div class="rp-head">
      <b>{{ $t('recipePropose.title') }}</b>
      <span class="rp-count mono">{{ items.length }}</span>
      <small class="rp-rule">{{ $t('recipePropose.rule') }}</small>
    </div>
    <p
      v-if="decideError"
      class="rp-err"
    >
      {{ decideError }}
    </p>
    <article
      v-for="{ row, payload } in rows"
      :key="row.id"
      class="rp-row"
    >
      <template v-if="payload">
        <!-- AML 活动 / 低置信警示(载荷可选字段,缺省按 normal/无警示不渲染) -->
        <p
          v-if="payload.amlActive"
          class="rp-banner bad"
        >
          {{ $t('recipePropose.amlActive') }}
        </p>
        <p
          v-if="payload.confidence === 'low'"
          class="rp-banner warn"
        >
          {{ $t('recipePropose.lowConfidence') }}
        </p>

        <div class="rp-rowhead">
          <span class="rp-recipe mono">{{ payload.recipeId }}</span>
          <small class="rp-summary">{{ $t('recipePropose.packagesLabel', { p0: payload.packages.length, p1: totalParams(payload) }) }}</small>
        </div>

        <!-- 方案 tab(选中态清晰;在飞裁决时冻结) -->
        <div
          class="rp-tabs"
          role="tablist"
        >
          <button
            v-for="(pkg, pi) in payload.packages"
            :key="pi"
            type="button"
            role="tab"
            class="rp-tab"
            :class="{ active: selected[row.id] === pi }"
            :aria-selected="selected[row.id] === pi"
            :disabled="decidingId === row.id"
            @click="select(row.id, pi)"
          >
            {{ $t('recipePropose.tab', { p0: pi + 1 }) }}
            <span class="rp-tab-name">{{ pkg.name }}</span>
            <span class="rp-tab-count mono">{{ pkg.params.length }}</span>
          </button>
        </div>

        <!-- 未选中方案:提示先行(与批准拦截同一文案,前置可见) -->
        <p
          v-if="selected[row.id] === undefined"
          class="rp-hint"
        >
          {{ $t('recipePropose.needChoice') }}
        </p>

        <!-- 参数对照表(每方案一张,tab 切换显隐;预检不过的行弱化仅展示) -->
        <template
          v-for="(pkg, pi) in payload.packages"
          :key="pi"
        >
          <div
            v-show="selected[row.id] === pi"
            class="rp-pkg"
          >
            <small class="rp-rationale">{{ pkg.rationale }}</small>
            <div class="rp-table-wrap">
              <table class="rp-table">
                <thead>
                  <tr>
                    <th>{{ $t('recipePropose.paramCol') }}</th>
                    <th>{{ $t('recipePropose.changeCol') }}</th>
                    <th>{{ $t('recipePropose.preflightCol') }}</th>
                    <th>{{ $t('recipePropose.basisCol') }}</th>
                    <th>{{ $t('recipePropose.expRefCol') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(p, ki) in pkg.params"
                    :key="ki"
                    :class="{ dropped: !p.preflight.ok }"
                  >
                    <td class="rp-param">
                      {{ p.paramName }}
                    </td>
                    <td class="rp-change mono">
                      {{ p.from }} → {{ p.to }}<span
                        v-if="p.unit"
                        class="rp-unit"
                      >{{ p.unit }}</span>
                    </td>
                    <td>
                      <span
                        v-if="p.preflight.ok"
                        class="rp-pf ok"
                      >{{ $t('recipePropose.preflightOk') }}</span>
                      <span
                        v-else
                        class="rp-pf fail"
                        :title="p.preflight.reason"
                      >{{ $t('recipePropose.preflightFail') }}</span>
                    </td>
                    <td class="rp-basis">
                      {{ p.basis }}
                    </td>
                    <td class="rp-expref mono">
                      {{ p.exp_ref }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>

        <!-- 操作区:意见框 + 批准(需选中方案)/ 拒绝(danger,随时可拒) -->
        <div class="rp-act">
          <input
            v-model="comments[row.id]"
            class="inp rp-comment"
            :placeholder="$t('recipePropose.commentPh')"
          >
          <div class="rp-actions">
            <button
              class="mini-btn rp-ok"
              type="button"
              :disabled="decidingId === row.id"
              @click="approve(row)"
            >
              {{ $t('recipePropose.approveBtn') }}
            </button>
            <button
              class="mini-btn danger"
              type="button"
              :disabled="decidingId === row.id"
              @click="reject(row)"
            >
              {{ $t('recipePropose.rejectBtn') }}
            </button>
          </div>
        </div>
        <p
          v-if="needChoiceId === row.id"
          class="rp-err"
        >
          {{ $t('recipePropose.needChoice') }}
        </p>
      </template>

      <!-- 异常兜底:payload 缺失/schemaVersion 不识别 → detail 文本 + 仅拒绝(fail-closed) -->
      <template v-else>
        <div class="rp-legacy">
          <span class="rp-detail">{{ row.detail }}</span>
          <button
            class="mini-btn danger"
            type="button"
            :disabled="decidingId === row.id"
            @click="reject(row)"
          >
            {{ $t('recipePropose.rejectBtn') }}
          </button>
        </div>
      </template>
    </article>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   .mono/.inp 在多组件出现,在此各持一份逐字相同的副本;
   .mini-btn/.aw-tile 为 main.css 全局类,不在此重复。 */

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

.rp-card { padding: 12px 18px; margin-bottom: 14px; border-color: color-mix(in srgb, var(--tone-warning-dot) 35%, transparent); }
.rp-head { display: flex; gap: 8px; align-items: baseline; }
.rp-head b { font-size: 13.5px; }
.rp-count { padding: 0 7px; font-size: 11.5px; color: var(--tone-warning-dot); border: 1px solid var(--tone-warning-dot); border-radius: 4px; }
.rp-rule { margin-left: auto; font-size: 10.5px; color: var(--ink-faint); }
.rp-err { margin: 8px 0 0; font-size: 12px; color: var(--tone-danger-dot); }

.rp-row { padding: 10px 0; border-top: 1px solid var(--divider-hair); }
.rp-row:first-of-type { border-top: 0; margin-top: 8px; }

/* 警示横幅(AML 活动=红 / 低置信=黄;配色对齐页面 banner 先例) */
.rp-banner { padding: 6px 10px; margin: 0 0 8px; font-size: 12px; border-radius: var(--radius-chip); }
.rp-banner.bad { color: var(--tone-danger-dot); background: var(--tone-danger-bg); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 40%, transparent); }
.rp-banner.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); border: 1px solid color-mix(in srgb, var(--tone-warning-dot) 40%, transparent); }

.rp-rowhead { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.rp-recipe { font-weight: 600; font-size: 12.5px; }
.rp-summary { font-size: 11px; color: var(--ink-faint); }

/* 方案 tab:选中态加深底+重边+加粗,未选中弱化 */
.rp-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.rp-tab { display: inline-flex; gap: 6px; align-items: baseline; padding: 4px 11px; font-family: inherit; font-size: 12px; color: var(--ink-faint); cursor: pointer; background: transparent; border: 1px solid var(--divider-hair); border-radius: 999px; transition: border-color var(--transition-fast), background-color var(--transition-fast), color var(--transition-fast); }
.rp-tab:hover:not(:disabled) { color: var(--ink-soft); border-color: var(--ink-fainter); }
.rp-tab.active { font-weight: 600; color: var(--ink); background: var(--paper-deep); border-color: var(--ink-fainter); }
.rp-tab:disabled { opacity: 0.45; cursor: default; }
.rp-tab-name { overflow: hidden; max-width: 180px; text-overflow: ellipsis; white-space: nowrap; }
.rp-tab-count { font-size: 10.5px; color: var(--ink-faint); }

.rp-hint { margin: 8px 0 0; font-size: 12px; color: var(--ink-faint); }

/* 参数对照表(每方案一张;窄屏横向滚动) */
.rp-pkg { margin-top: 8px; }
.rp-rationale { display: block; margin-bottom: 6px; font-size: 11.5px; color: var(--ink-soft); overflow-wrap: anywhere; }
.rp-table-wrap { overflow-x: auto; }
.rp-table { width: 100%; font-size: 12px; border-collapse: collapse; }
.rp-table th { padding: 4px 10px 4px 0; font-size: 10.5px; font-weight: 500; text-align: left; color: var(--ink-faint); white-space: nowrap; border-bottom: 1px solid var(--divider-hair); }
.rp-table td { padding: 5px 10px 5px 0; vertical-align: top; border-bottom: 1px solid var(--divider-hair); }
.rp-table tr:last-child td { border-bottom: 0; }
.rp-param { font-weight: 600; white-space: nowrap; }
.rp-change { font-size: 12px; color: var(--ink-soft); white-space: nowrap; }
.rp-unit { margin-left: 4px; font-size: 11px; color: var(--ink-faint); }
.rp-pf { display: inline-block; padding: 1px 7px; font-size: 10.5px; border-radius: 4px; white-space: nowrap; }
.rp-pf.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.rp-pf.fail { color: var(--tone-danger-dot); background: var(--tone-danger-bg); cursor: help; }
.rp-basis { min-width: 160px; color: var(--ink-soft); overflow-wrap: anywhere; }
.rp-expref { max-width: 180px; font-size: 11px; color: var(--ink-faint); overflow-wrap: anywhere; }
.rp-table tr.dropped .rp-param,
.rp-table tr.dropped .rp-change,
.rp-table tr.dropped .rp-basis,
.rp-table tr.dropped .rp-expref { opacity: 0.5; }

/* 操作区:意见框 + 按钮组(对齐 DcwParamApprovalCard 的行内操作先例) */
.rp-act { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
.rp-comment { flex: none; width: 280px; padding: 5px 9px; font-size: 12px; }
.rp-actions { display: flex; flex: none; gap: 6px; }
.rp-ok { color: var(--tone-success-dot); }

/* 异常兜底降级面:detail 文本 + 仅拒绝 */
.rp-legacy { display: flex; gap: 10px; align-items: center; }
.rp-detail { flex: 1; min-width: 0; font-size: 12px; color: var(--ink-soft); overflow-wrap: anywhere; }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖):操作区落成一列,触摸目标 ≥40px ══ */
  .rp-card { padding: 12px; }
  .rp-rule { margin-left: 0; }
  .rp-act { flex-wrap: wrap; }
  .rp-comment { flex: 1 1 100%; width: auto; }
  .rp-actions { margin-left: auto; }
  .mini-btn,
  .inp {
    min-height: 40px;
  }
}
</style>
