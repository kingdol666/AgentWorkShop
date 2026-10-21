<template>
  <div class="ledger">
    <!-- 导出任务台账 -->
    <div class="card">
      <div class="row">
        <h3 class="sec">
          {{ $t('data.ledger.jobs') }}
        </h3>
        <button
          class="pill-btn"
          data-test="ledger-refresh"
          @click="loadJobs"
        >
          {{ $t('data.ledger.refresh') }}
        </button>
      </div>
      <div
        v-if="jobs.length"
        class="tblWrap"
      >
        <table
          class="tbl"
          data-test="ledger-jobs"
        >
          <thead>
            <tr>
              <th>ID</th>
              <th>{{ $t('data.ledger.status') }}</th>
              <th>{{ $t('data.ledger.nodes') }}</th>
              <th>{{ $t('data.ledger.window') }}</th>
              <th>{{ $t('data.ledger.rows') }}</th>
              <th>{{ $t('data.ledger.created') }}</th>
              <th>{{ $t('data.ledger.download') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="j in jobs"
              :key="j.id"
            >
              <td class="mono">
                {{ j.id }}
              </td>
              <td :class="j.status">
                {{ stLabel(j.status) }}<template v-if="j.result?.missing">
                  · {{ $t('data.ledger.missing') }}
                </template>
              </td>
              <td class="mono">
                {{ j.spec?.nodeIds?.length ?? 0 }}
              </td>
              <td class="mono">
                {{ shortTs(j.spec?.fromMs) }} ~ {{ shortTs(j.spec?.toMs) }}
              </td>
              <td class="mono">
                {{ j.result?.totalRows ?? '-' }}
              </td>
              <td class="mono">
                {{ j.createdAt?.slice(5, 19).replace('T', ' ') }}
              </td>
              <td>
                <template v-if="j.status === 'ready' && !j.result?.missing">
                  <a :href="fileUrl(j.id, 'manifest.json')">manifest</a>
                  <a
                    v-if="j.result?.mergedFile"
                    :href="fileUrl(j.id, 'merged.csv')"
                  >merged</a>
                </template>
                <span v-else>-</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p
        v-else
        class="empty"
      >
        {{ $t('data.ledger.empty') }}
      </p>
    </div>

    <!-- 批次(run)台账 -->
    <div class="card">
      <div class="row">
        <h3 class="sec">
          {{ $t('data.ledger.runs') }}
        </h3>
        <label class="lbl">{{ $t('data.ledger.outcome') }}</label>
        <select
          v-model="outcome"
          class="input sel"
          @change="loadRuns"
        >
          <option value="">
            {{ $t('data.ledger.any') }}
          </option>
          <option value="open">
            open
          </option>
          <option value="good">
            good
          </option>
          <option value="bad">
            bad
          </option>
          <option value="scrapped">
            scrapped
          </option>
        </select>
        <button
          class="pill-btn"
          @click="loadRuns"
        >
          {{ $t('data.ledger.refresh') }}
        </button>
      </div>
      <div
        v-if="runs.length"
        class="tblWrap"
      >
        <table
          class="tbl"
          data-test="ledger-runs"
        >
          <thead>
            <tr>
              <th>ID</th>
              <th>{{ $t('data.ledger.recipe') }}</th>
              <th>{{ $t('data.ledger.outcome') }}</th>
              <th>{{ $t('data.ledger.samples') }}</th>
              <th>{{ $t('data.ledger.started') }}</th>
              <th>{{ $t('data.ledger.ended') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in runs"
              :key="r.id"
            >
              <td class="mono">
                {{ r.id }}
              </td>
              <td>{{ r.recipeName || r.recipeId }}</td>
              <td>
                <span
                  class="badge"
                  :class="r.outcome"
                >{{ r.outcome }}</span>
              </td>
              <td class="mono">
                {{ r.sampleCount ?? '-' }}
              </td>
              <td class="mono">
                {{ r.startedAt?.slice(5, 19).replace('T', ' ') }}
              </td>
              <td class="mono">
                {{ r.endedAt?.slice(5, 19).replace('T', ' ') || '-' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p
        v-else
        class="empty"
      >
        {{ $t('data.ledger.runsEmpty') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 数据管理台 · 台账面板(plan1 M1 + E1 用户面):
 * 导出任务(异步产物下载)与批次 run 台账(eda_runs;runs.json 环形滚丢的持久镜像)。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { apiFetch } from '@/app/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'

interface ExportJob { id: string, status: 'running' | 'ready' | 'failed', error?: string, spec?: { nodeIds?: string[], fromMs?: number, toMs?: number }, result?: { totalRows?: number, mergedFile?: string, missing?: boolean }, createdAt?: string }
interface RunRow { id: string, recipeId: string, recipeName: string, outcome: string, sampleCount: number | null, startedAt: string, endedAt: string | null }

const { t } = useI18n()
const jobs = ref<ExportJob[]>([])
const runs = ref<RunRow[]>([])
const outcome = ref('')
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const shortTs = (ms?: number): string => (ms ? new Date(ms).toISOString().slice(5, 16).replace('T', ' ') : '-')
const stLabel = (s: string): string => (s === 'ready' ? t('data.ledger.st.ready') : s === 'failed' ? t('data.ledger.st.failed') : t('data.ledger.st.running'))

function fileUrl(jobId: string, rel: string): string {
  return `/api/workshop/daq/export-file?job=${encodeURIComponent(jobId)}&path=${encodeURIComponent(rel)}`
}

async function loadJobs(): Promise<void> {
  try {
    const r = await apiFetch<{ jobs: ExportJob[] }>({ base: '/api/workshop/daq/export', retries: 1 })
    jobs.value = r.jobs ?? []
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

async function loadRuns(): Promise<void> {
  try {
    const p = outcome.value ? `?outcome=${encodeURIComponent(outcome.value)}` : ''
    const r = await apiFetch<{ runs: RunRow[] }>({ base: `/api/workshop/eda/runs${p}`, retries: 1 })
    runs.value = r.runs ?? []
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
}

onMounted(() => {
  void loadJobs()
  void loadRuns()
  // 有 running 任务时轻量轮询(10s),全终态即停
  timer = setInterval(() => {
    if (jobs.value.some(j => j.status === 'running')) void loadJobs()
  }, 10_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.ledger { display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--panel, #fff); border: 1px solid var(--border, rgba(127,127,127,.25)); border-radius: 10px; padding: 12px 14px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sec { font-size: 13px; font-weight: 600; margin: 0; }
.lbl { font-size: 12px; color: var(--ink-soft, #666); }
.input { border: 1px solid var(--border, rgba(127,127,127,.35)); border-radius: 6px; padding: 4px 8px; background: transparent; color: var(--ink, #222); font-size: 12px; }
.empty { color: var(--ink-faint, #999); font-size: 12px; }
.tblWrap { max-height: 360px; overflow: auto; margin-top: 8px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th, .tbl td { border-bottom: 1px solid var(--border, rgba(127,127,127,.18)); padding: 3px 8px; text-align: left; white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; }
.ready { color: #3f7d54; }
.failed { color: #b3403a; }
.running { color: #b3714f; }
.badge { border: 1px solid var(--border, rgba(127,127,127,.3)); border-radius: 999px; padding: 0 8px; font-size: 11px; }
.badge.good { color: #3f7d54; border-color: #3f7d54; }
.badge.bad { color: #b3403a; border-color: #b3403a; }
a { margin-right: 8px; }
</style>
