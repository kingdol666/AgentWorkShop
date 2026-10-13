<script setup lang="ts">
/**
 * 分析报告台账表:时间 / 产线 / 标题(类别) / 配方 / 关键结论 / 来源 / 详情。
 * 行内展开详情(结论明细 + 完整正文 + 支撑指标 + 证据窗),照 LogsEventTable 的
 * 原生 table + 展开行模式(全站惯例:原生表格,antd a-table 才需要显式 columns)。
 */
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'
import { useLogsScope } from '@/app/pages/logs/composables/useLogsScope'
import type { AnalysisReportView } from '@/app/pages/analysis/types'

defineProps<{
  rows: AnalysisReportView[]
  loading: boolean
  error: string
  /** 管理面:admin 可见删除(清污数据;台账 Agent 面无删) */
  admin: boolean
}>()

const emit = defineEmits<{
  toggle: [row: AnalysisReportView]
  remove: [row: AnalysisReportView]
}>()

const expandedId = defineModel<string>('expandedId', { default: '' })

const { lineName } = useLogsScope()
const { t } = useI18n()

const fmtTime = (iso: string): string => formatLocalClock(iso)
const catLabel = (c: string): string => {
  const known = ['quality', 'oee', 'alarm', 'trend', 'optimization', 'general']
  return known.includes(c) ? t(`analysis.cat.${c}`) : c
}

const recipeLabel = (r: AnalysisReportView): string =>
  r.recipeId ? `${r.recipeId}${r.recipeVersion ? ` v${r.recipeVersion}` : ''}` : '—'

const hasDetail = (r: AnalysisReportView): boolean =>
  Boolean(r.conclusions.length || r.report || Object.keys(r.metrics ?? {}).length || r.dataSources)

const metricsText = (r: AnalysisReportView): string => {
  try {
    return JSON.stringify(r.metrics ?? {}, null, 1)
  }
  catch {
    return ''
  }
}

const contextText = (r: AnalysisReportView): string => {
  try {
    return JSON.stringify(r.context ?? {}, null, 1)
  }
  catch {
    return ''
  }
}
</script>

<template>
  <section class="table-card">
    <div class="card-meta">
      <span class="count">{{ $t('analysis.count', { p0: rows.length }) }}</span>
      <span class="hint">{{ $t('analysis.ledgerHint') }}</span>
    </div>
    <p
      v-if="error"
      class="err"
    >
      {{ error }}
    </p>
    <table class="ar-table">
      <thead>
        <tr>
          <th class="th-time">
            {{ $t('analysis.thTime') }}
          </th>
          <th class="th-line">
            {{ $t('analysis.thLine') }}
          </th>
          <th>{{ $t('analysis.thTitle') }}</th>
          <th class="th-recipe">
            {{ $t('analysis.thRecipe') }}
          </th>
          <th>{{ $t('analysis.thSummary') }}</th>
          <th class="th-src">
            {{ $t('analysis.thSource') }}
          </th>
          <th class="th-detail">
            {{ $t('analysis.thDetail') }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="loading && rows.length === 0">
          <td
            colspan="7"
            class="empty"
          >
            {{ $t('analysis.loading') }}
          </td>
        </tr>
        <tr v-else-if="rows.length === 0">
          <td
            colspan="7"
            class="empty"
          >
            {{ $t('analysis.empty') }}
          </td>
        </tr>
        <template
          v-for="row in rows"
          :key="row.id"
        >
          <tr>
            <td class="mono dim">
              {{ fmtTime(row.createdAt) }}
            </td>
            <td>
              <span class="scope-chip">{{ row.lineName || lineName(row.lineId) || row.lineId || '—' }}</span>
            </td>
            <td class="title-cell">
              {{ row.title }}
              <small
                class="cat-chip"
                :class="row.category"
              >{{ catLabel(row.category) }}</small>
            </td>
            <td class="mono dim">
              {{ recipeLabel(row) }}
            </td>
            <td class="summary">
              {{ row.summary || '—' }}
            </td>
            <td class="src">
              {{ row.actorName || row.actor || '—' }}
              <small
                v-if="row.channelName"
                class="dim"
              >@{{ row.channelName }}</small>
            </td>
            <td class="detail-cell">
              <button
                v-if="hasDetail(row)"
                class="mini-btn"
                @click="emit('toggle', row)"
              >
                {{ expandedId === row.id ? $t('analysis.fold') : $t('analysis.expand') }}
              </button>
              <span
                v-else
                class="dim"
              >{{ $t('analysis.noDetail') }}</span>
              <a-popconfirm
                v-if="admin"
                :title="$t('analysis.removeConfirm', { p0: row.title })"
                :ok-text="$t('analysis.remove')"
                :cancel-text="$t('analysis.cancel')"
                placement="left"
                @confirm="emit('remove', row)"
              >
                <button
                  class="mini-btn danger"
                  :title="$t('analysis.remove')"
                >
                  <span class="i-tabler-trash" />
                </button>
              </a-popconfirm>
            </td>
          </tr>
          <tr
            v-if="expandedId === row.id"
            class="ar-detail-row"
          >
            <td colspan="7">
              <div class="detail-grid">
                <div class="kv">
                  <span class="k">{{ $t('analysis.kId') }}</span>
                  <span class="mono">{{ row.id }}</span>
                </div>
                <div class="kv">
                  <span class="k">{{ $t('analysis.kWindow') }}</span>
                  <span class="mono">
                    {{ row.windowFrom ? fmtTime(row.windowFrom) : '—' }} ~ {{ row.windowTo ? fmtTime(row.windowTo) : '—' }}
                  </span>
                </div>
                <div
                  v-if="row.dataSources"
                  class="kv kv-full"
                >
                  <span class="k">{{ $t('analysis.kSources') }}</span>
                  <span>{{ row.dataSources }}</span>
                </div>
                <template v-if="row.conclusions.length">
                  <div class="sec-title">
                    {{ $t('analysis.kConclusions') }}
                  </div>
                  <ol class="conclusions">
                    <li
                      v-for="(c, i) in row.conclusions"
                      :key="i"
                    >
                      {{ c }}
                    </li>
                  </ol>
                </template>
                <template v-if="row.report">
                  <div class="sec-title">
                    {{ $t('analysis.kReport') }}
                  </div>
                  <pre class="report-body">{{ row.report }}</pre>
                </template>
                <template v-if="Object.keys(row.metrics ?? {}).length">
                  <div class="sec-title">
                    {{ $t('analysis.kMetrics') }}
                  </div>
                  <pre class="json-body">{{ metricsText(row) }}</pre>
                </template>
                <template v-if="Object.keys(row.context ?? {}).length">
                  <div class="sec-title">
                    {{ $t('analysis.kContext') }}
                  </div>
                  <pre class="json-body">{{ contextText(row) }}</pre>
                </template>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.table-card {
  background: var(--surface-glass);
  border: 1px solid var(--glass-line);
  border-radius: 10px;
  backdrop-filter: var(--aurora-blur) saturate(1.15);
  overflow: hidden;
}
.card-meta {
  display: flex; gap: 12px; align-items: center;
  padding: 8px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--glass-line) 55%, transparent);
  font-size: 11.5px; color: var(--ink-faint);
}
.card-meta .count { font-weight: 600; color: var(--ink); }
.card-meta .hint { margin-left: auto; }
.mini-btn.danger { color: var(--tone-danger-dot, #ff6b6b); margin-left: 4px; }
.err { margin: 0; padding: 10px 14px; font-size: 12.5px; color: var(--tone-danger-dot, #ff6b6b); }
.ar-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.ar-table thead th {
  position: sticky; top: 0; z-index: 1;
  padding: 9px 12px; text-align: left; font-weight: 600; font-size: 11.5px; color: var(--ink-faint);
  background: color-mix(in srgb, var(--frost-bg) 92%, transparent);
  border-bottom: 1px solid var(--glass-line);
  white-space: nowrap;
}
.ar-table tbody td { padding: 9px 12px; border-bottom: 1px solid color-mix(in srgb, var(--glass-line) 55%, transparent); vertical-align: top; }
.th-time { width: 128px; }
.th-line { width: 130px; }
.th-recipe { width: 170px; }
.th-src { width: 150px; }
.th-detail { width: 92px; }
.title-cell { max-width: 320px; font-weight: 600; }
.cat-chip {
  display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
  font-size: 10.5px; font-weight: 500; color: var(--ink-faint);
  background: color-mix(in srgb, var(--glass-line) 40%, transparent);
  vertical-align: 1px;
}
.summary { max-width: 380px; }
.src small { display: block; }
.mono { font-family: var(--font-mono, monospace); font-size: 11.5px; }
.dim { color: var(--ink-faint); }
.empty { padding: 28px 12px !important; text-align: center; color: var(--ink-faint); }
.scope-chip {
  display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
  background: color-mix(in srgb, var(--tone-info-dot) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone-info-dot) 25%, transparent);
}
.detail-cell { white-space: nowrap; }
.ar-detail-row td {
  background: color-mix(in srgb, var(--frost-bg) 55%, transparent);
}
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px 18px; padding: 4px 2px; }
.kv { display: flex; gap: 10px; font-size: 12px; align-items: baseline; }
.kv-full { grid-column: 1 / -1; }
.kv .k { flex: none; min-width: 64px; color: var(--ink-faint); font-size: 11.5px; }
.sec-title { grid-column: 1 / -1; margin-top: 6px; font-size: 11.5px; font-weight: 600; color: var(--ink-faint); }
.conclusions { grid-column: 1 / -1; margin: 0; padding-left: 22px; font-size: 12.5px; line-height: 1.7; }
.report-body, .json-body {
  grid-column: 1 / -1; margin: 0; padding: 10px 12px;
  font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  background: color-mix(in srgb, var(--glass-line) 22%, transparent);
  border: 1px solid color-mix(in srgb, var(--glass-line) 45%, transparent);
  border-radius: 8px;
  max-height: 340px; overflow: auto;
}
@media (max-width: 899px) {
  .th-recipe, .th-src { display: none; }
  .ar-table tbody td:nth-child(4), .ar-table tbody td:nth-child(6) { display: none; }
}
</style>
