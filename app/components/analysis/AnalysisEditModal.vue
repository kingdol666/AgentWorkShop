<script setup lang="ts">
/**
 * 分析报告人工修订弹窗(v27 编辑面):预填当前值 → PATCH → 父级刷新。
 * 可见性由行级 canEdit(admin/产线 operate)控制;结论明细每行一条,
 * 支撑指标为 JSON 文本(留空 = 保留原值;Agent 面仍无改删,修订全程审计)。
 */
import { reactive, watch } from 'vue'
import { ANALYSIS_CATEGORIES } from '@/app/pages/analysis/types'
import type { AnalysisReportView } from '@/app/pages/analysis/types'

const props = defineProps<{
  /** 待编辑报告(null = 弹窗关闭) */
  report: AnalysisReportView | null
  saving: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [patch: Record<string, unknown>]
}>()

const form = reactive({
  title: '', summary: '', category: '', recipeId: '', recipeVersion: '',
  windowFrom: '', windowTo: '', dataSources: '', conclusions: '', report: '', metrics: '',
})

watch(() => props.report, (r) => {
  if (!r) return
  form.title = r.title
  form.summary = r.summary
  form.category = r.category
  form.recipeId = r.recipeId
  form.recipeVersion = r.recipeVersion
  form.windowFrom = r.windowFrom ?? ''
  form.windowTo = r.windowTo ?? ''
  form.dataSources = r.dataSources
  form.conclusions = (r.conclusions ?? []).join('\n')
  form.report = r.report ?? ''
  form.metrics = Object.keys(r.metrics ?? {}).length ? JSON.stringify(r.metrics, null, 1) : ''
}, { immediate: true })

function submit(): void {
  let metrics: unknown = undefined
  if (form.metrics.trim()) {
    try {
      metrics = JSON.parse(form.metrics)
    }
    catch {
      // JSON 非法直接留原值并由后端校验;此处不阻断
      metrics = form.metrics
    }
  }
  emit('save', {
    title: form.title,
    summary: form.summary,
    category: form.category || 'general',
    recipe_id: form.recipeId.trim(),
    recipe_version: form.recipeVersion.trim(),
    window_from: form.windowFrom.trim(),
    window_to: form.windowTo.trim(),
    data_sources: form.dataSources,
    conclusions: form.conclusions,
    report: form.report,
    ...(metrics !== undefined ? { metrics } : {}),
  })
}
</script>

<template>
  <a-modal
    :open="Boolean(report)"
    :title="$t('analysis.editTitle')"
    :confirm-loading="saving"
    :ok-text="$t('analysis.save')"
    :cancel-text="$t('analysis.cancel')"
    width="720px"
    @ok="submit"
    @cancel="emit('close')"
  >
    <div class="edit-form">
      <label class="fld">
        <span>{{ $t('analysis.thTitle') }}</span>
        <input
          v-model="form.title"
          class="inp-sel"
        >
      </label>
      <label class="fld">
        <span>{{ $t('analysis.thSummary') }}</span>
        <input
          v-model="form.summary"
          class="inp-sel"
        >
      </label>
      <div class="fld-row">
        <label class="fld">
          <span>{{ $t('analysis.fCat') }}</span>
          <select
            v-model="form.category"
            class="inp-sel"
          >
            <option
              v-for="c in ANALYSIS_CATEGORIES"
              :key="c"
              :value="c"
            >
              {{ $t(`analysis.cat.${c}`) }}
            </option>
          </select>
        </label>
        <label class="fld">
          <span>{{ $t('analysis.kRecipe') }}</span>
          <input
            v-model="form.recipeId"
            class="inp-sel"
            placeholder="rcp-…"
          >
        </label>
        <label class="fld">
          <span>{{ $t('analysis.kVersion') }}</span>
          <input
            v-model="form.recipeVersion"
            class="inp-sel"
          >
        </label>
      </div>
      <div class="fld-row">
        <label class="fld">
          <span>{{ $t('analysis.kWindowFrom') }}</span>
          <input
            v-model="form.windowFrom"
            class="inp-sel"
            placeholder="ISO 8601"
          >
        </label>
        <label class="fld">
          <span>{{ $t('analysis.kWindowTo') }}</span>
          <input
            v-model="form.windowTo"
            class="inp-sel"
            placeholder="ISO 8601"
          >
        </label>
      </div>
      <label class="fld">
        <span>{{ $t('analysis.kSources') }}</span>
        <input
          v-model="form.dataSources"
          class="inp-sel"
        >
      </label>
      <label class="fld">
        <span>{{ $t('analysis.kConclusions') }}({{ $t('analysis.conclusionsHint') }})</span>
        <textarea
          v-model="form.conclusions"
          class="inp-sel"
          rows="4"
        />
      </label>
      <label class="fld">
        <span>{{ $t('analysis.kReport') }}</span>
        <textarea
          v-model="form.report"
          class="inp-sel mono"
          rows="6"
        />
      </label>
      <label class="fld">
        <span>{{ $t('analysis.kMetrics') }}(JSON)</span>
        <textarea
          v-model="form.metrics"
          class="inp-sel mono"
          rows="4"
        />
      </label>
    </div>
  </a-modal>
</template>

<style scoped>
.edit-form { display: flex; flex-direction: column; gap: 10px; max-height: 64vh; overflow: auto; padding-right: 4px; }
.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-faint); }
.fld-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.inp-sel {
  min-width: 0; padding: 6px 9px; font-size: 13px; color: var(--ink);
  background: var(--frost-bg);
  border: 1px solid var(--glass-line); border-radius: 7px; outline: none;
}
.inp-sel:focus { border-color: color-mix(in srgb, var(--tone-info-dot) 55%, transparent); }
textarea.inp-sel { resize: vertical; line-height: 1.6; }
.mono { font-family: var(--font-mono, monospace); font-size: 11.5px; }
</style>
