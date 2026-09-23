<script setup lang="ts">
/**
 * 配方版本历史 —— 整体修改变更记录(来源/操作者/原因/参数 diff + 单步回退)。
 * 行数据由页面 useDcwRecipes 拉取后下发,回退动作回抛页面。
 */
import type { RecipeView } from '#shared/dcw-protocol'
import type { RecipeVersionRow } from '../../pages/dcw/composables/useDcwRecipes'

const props = defineProps<{
  verRecipe: RecipeView | null
  verRows: RecipeVersionRow[]
  verLoading: boolean
  verMsg: string
  paramNodeName: (nodeId: string) => string
}>()

const emit = defineEmits<{ revert: [version: number], close: [] }>()

const { t } = useI18n()

const verOpen = defineModel<boolean>('open', { required: true })

const verSrcLabel = (by?: string): string => (by === 'agent' ? 'Agent' : by === 'system' ? t('dcwDetail.srcSystem') : t('dcwDetail.srcUser'))

function verDiff(row: RecipeVersionRow, idx: number): string {
  if (idx === 0) return t('dcwDetail.histInit')
  const prev = props.verRows[idx - 1]!
  const changed = row.params
    .map(p => ({ p, old: prev.params.find(x => x.nodeId === p.nodeId) }))
    .filter(({ p, old }) => !old || old.value !== p.value)
    .map(({ p, old }) => `${props.paramNodeName(p.nodeId)}: ${old?.value ?? t('dcwDetail.histAdded')} → ${p.value}`)
  return changed.length > 0 ? changed.join('；') : t('dcwDetail.histNoChange')
}
</script>

<template>
  <div
    v-if="verOpen"
    class="modal-mask"
    @click.self="verOpen = false"
  >
    <div
      class="modal"
      style="max-width: 760px;"
    >
      <div class="modal-head">
        <h3>
          {{ t('dcwDetail.histTitle') }}<span
            v-if="verRecipe"
            class="dim"
            style="margin-left: 8px; font-size: 12px;"
          >{{ verRecipe.name }} · v{{ verRecipe.version }}</span>
        </h3>
        <button
          class="mini-btn"
          @click="verOpen = false"
        >
          ✕
        </button>
      </div>
      <p
        v-if="verMsg"
        class="banner good"
        style="margin: 6px 0;"
      >
        {{ verMsg }}
      </p>
      <p
        v-if="verLoading"
        class="dim"
      >
        {{ t('dcwDetail.histLoading') }}
      </p>
      <div
        v-else-if="verRows.length === 0"
        class="pane-empty"
      >
        {{ t('dcwDetail.histEmpty') }}
      </div>
      <div
        v-for="(row, i) in verRows"
        v-else
        :key="row.version"
        class="ver-row"
        :class="{ cur: row.current }"
      >
        <div class="ver-head">
          <span class="mono ver-v">v{{ row.version }}</span>
          <span
            class="ver-src"
            :class="row.by ?? (row.current ? 'cur' : '')"
          >{{ row.current ? t('dcwDetail.histCurrent') : verSrcLabel(row.by) }}</span>
          <span class="mono dim">{{ row.at.slice(0, 19).replace('T', ' ') }}</span>
          <span class="ver-actor">{{ row.actorName || '—' }}</span>
          <button
            v-if="!row.current"
            class="mini-btn"
            @click="emit('revert', row.version)"
          >
            {{ t('dcwDetail.revertTo') }}
          </button>
        </div>
        <p
          v-if="row.description"
          class="ver-desc"
        >
          {{ row.description }}
        </p>
        <p class="ver-diff mono">
          {{ verDiff(row, i) }}
        </p>
      </div>
    </div>
  </div>
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

.mini-btn { margin-right: 4px; }
.mini-btn.danger { color: var(--tone-danger-dot); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }

/* ---------- 配方版本历史 ---------- */
.ver-row { padding: 10px 12px; margin-bottom: 8px; border: 1px solid var(--divider-hair); border-radius: 10px; }
.ver-row.cur { background: color-mix(in srgb, var(--accent) 6%, transparent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
.ver-head { display: flex; gap: 10px; align-items: center; }
.ver-v { font-weight: 700; font-size: 13px; }
.ver-src { padding: 1px 8px; font-size: 11.5px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); }
.ver-src.agent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); }
.ver-src.user { color: var(--ink-soft); }
.ver-src.system { color: var(--ink-faint); }
.ver-src.cur { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); border-color: transparent; }
.ver-actor { font-family: var(--font-mono); font-size: 12px; color: var(--ink-soft); }
.ver-desc { margin: 6px 0 0; font-size: 12px; color: var(--ink); }
.ver-diff { margin: 4px 0 0; font-size: 11px; color: var(--ink-faint); }

.modal-mask { position: fixed; z-index: 50; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--scrim); backdrop-filter: blur(2px); }
.modal { width: 680px; max-width: 94vw; max-height: 88vh; overflow-y: auto; padding: 22px 24px; background: var(--surface-glass-strong); backdrop-filter: var(--aurora-blur); border: 1px solid var(--glass-line); border-radius: var(--radius-panel); box-shadow: var(--glass-edge), var(--shadow-float); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .mini-btn {
    min-height: 40px;
  }
  /* 弹窗表单:两列/三列在窄屏一律落成一列,否则标签被压成竖排字 */
  .modal {
    width: calc(100vw - 20px);
    max-width: calc(100vw - 20px);
    padding: 16px 14px;
  }
}
</style>
