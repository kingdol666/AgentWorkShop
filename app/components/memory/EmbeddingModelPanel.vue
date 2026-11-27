<script setup lang="ts">
/**
 * 记忆中心 · 检索模型（2026-11-28）。
 *
 * 人类交互目标：一眼看清"现在用什么检索"→ 下载本地向量模型 → 启用 → 回填存量 →
 * 看到向量行数真实增长。所有破坏性动作就地确认（删除模型），下载/回填是长任务，
 * 用轮询进度而不是阻塞请求。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { apiFetch } from '~/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'
import { useUserStore } from '@/app/stores/workshop/user'
import { useI18n } from 'vue-i18n'

interface ModelItem {
  id: string
  name: string
  dims: number
  langs: string
  pooling: string
  license: string
  note: string
  repo: string
  bytes: number
  installed: boolean
  installedBytes: number
  installedAt: string | null
  active: boolean
}
interface DownloadJob {
  id: string
  modelId: string
  status: 'running' | 'done' | 'failed' | 'canceled'
  received: number
  total: number
  fileIndex: number
  fileCount: number
  currentFile: string
  source: string
  error: string
}
type ProviderInfo
  = | { kind: 'local', model: string, dims: number }
    | { kind: 'http', model: string, baseUrl: string, dims: number | null, warning?: 'local_model_missing' }
    | { kind: 'none', reason: 'not_configured' | 'local_model_missing', localModelId: string }
interface Snapshot {
  models: ModelItem[]
  provider: ProviderInfo
  vectors: { rows: number, dims: number | null, eligible: number, pending: number }
  downloads: DownloadJob[]
}

const { t } = useI18n()
const userStore = useUserStore()
const isAdmin = computed(() => userStore.isAdmin)

const snapshot = ref<Snapshot | null>(null)
const loading = ref(false)
const busyModel = ref('')
const backfilling = ref(false)
const backfillDone = ref(0)
const backfillRemaining = ref<number | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null

const providerText = computed(() => {
  const p = snapshot.value?.provider
  if (!p) return '—'
  if (p.kind === 'local') {
    return t('memoryCenter.models.providerLocal', { model: p.model, dims: p.dims })
  }
  if (p.kind === 'http') return t('memoryCenter.models.providerHttp', { model: p.model })
  return p.reason === 'local_model_missing'
    ? t('memoryCenter.models.providerMissing', { model: p.localModelId })
    : t('memoryCenter.models.providerNone')
})

const providerColor = computed(() => {
  const kind = snapshot.value?.provider.kind
  return kind === 'local' ? 'green' : kind === 'http' ? 'blue' : 'orange'
})

const runningJobs = computed(() => (snapshot.value?.downloads ?? []).filter(j => j.status === 'running'))

function jobFor(id: string): DownloadJob | null {
  return runningJobs.value.find(j => j.modelId === id) ?? null
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function percent(job: DownloadJob): number {
  if (job.total <= 0) return 0
  return Math.min(100, Math.round((job.received / job.total) * 100))
}

async function load(): Promise<void> {
  loading.value = true
  try {
    snapshot.value = await apiFetch<Snapshot>({ base: '', path: '/api/workshop/memory/embedding/models' })
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    loading.value = false
  }
  syncPolling()
}

function syncPolling(): void {
  const need = runningJobs.value.length > 0 || backfilling.value
  if (need && !pollTimer) {
    pollTimer = setInterval(() => {
      void load()
    }, 1500)
  }
  else if (!need && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function download(model: ModelItem): Promise<void> {
  busyModel.value = model.id
  try {
    await apiFetch({
      base: '',
      path: `/api/workshop/memory/embedding/models/${encodeURIComponent(model.id)}/download`,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    })
    message.info(t('memoryCenter.models.downloadStarted', { name: model.name }))
    await load()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    busyModel.value = ''
  }
}

async function activate(model: ModelItem | null): Promise<void> {
  busyModel.value = model?.id ?? 'none'
  try {
    const res = await apiFetch<{ provider: ProviderInfo }>({
      base: '',
      path: '/api/workshop/memory/embedding/activate',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: model?.id ?? '' }),
      },
    })
    message.success(model ? t('memoryCenter.models.activated', { name: model.name }) : t('memoryCenter.models.deactivated'))
    // 启用后立即提示回填：换模型/首启用都需要重算向量
    backfillRemaining.value = snapshot.value?.vectors.pending ?? null
    await load()
    void res
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    busyModel.value = ''
  }
}

async function remove(model: ModelItem): Promise<void> {
  busyModel.value = model.id
  try {
    await apiFetch({
      base: '',
      path: `/api/workshop/memory/embedding/models/${encodeURIComponent(model.id)}`,
      init: { method: 'DELETE' },
    })
    message.success(t('memoryCenter.models.deleted', { name: model.name }))
    await load()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    busyModel.value = ''
  }
}

/** 回填：循环调用直到 remaining=0（每批 64 条/25s，UI 侧显示累计与剩余） */
async function backfill(rebuild: boolean): Promise<void> {
  backfilling.value = true
  backfillDone.value = 0
  if (rebuild) backfillRemaining.value = null
  syncPolling()
  try {
    for (let round = 0; round < 200; round++) {
      const res = await apiFetch<{ embedded: number, remaining: number, failed: number, dims: number, resetVec: boolean }>({
        base: '',
        path: '/api/workshop/memory/embedding/backfill',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rebuild: rebuild && round === 0, limit: 64 }),
        },
      })
      backfillDone.value += res.embedded
      backfillRemaining.value = res.remaining
      await load()
      if (res.remaining <= 0 || res.embedded === 0) break
    }
    message.success(t('memoryCenter.models.backfillDone', { n: backfillDone.value }))
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    backfilling.value = false
    syncPolling()
  }
}

onMounted(() => {
  void load()
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
})
</script>

<template>
  <section
    class="embedding-panel"
    data-testid="memory-embedding-panel"
  >
    <a-alert
      v-if="snapshot?.provider.kind !== 'local'"
      type="info"
      show-icon
      :message="t('memoryCenter.models.hintTitle')"
      :description="t('memoryCenter.models.hintBody')"
      data-testid="memory-embedding-hint"
    />

    <div class="status">
      <div class="status-item">
        <span class="label">{{ t('memoryCenter.models.current') }}</span>
        <a-tag :color="providerColor">
          {{ providerText }}
        </a-tag>
      </div>
      <div class="status-item">
        <span class="label">{{ t('memoryCenter.models.vectorRows') }}</span>
        <span class="mono">{{ snapshot?.vectors.rows ?? 0 }} / {{ snapshot?.vectors.eligible ?? 0 }}</span>
        <a-tag
          v-if="(snapshot?.vectors.pending ?? 0) > 0"
          color="orange"
        >
          {{ t('memoryCenter.models.pendingRows', { n: snapshot?.vectors.pending ?? 0 }) }}
        </a-tag>
      </div>
      <div class="spacer" />
      <a-button
        size="small"
        :loading="loading"
        @click="load"
      >
        {{ t('memoryCenter.models.refresh') }}
      </a-button>
      <a-popconfirm
        v-if="snapshot?.provider.kind === 'local'"
        :title="t('memoryCenter.models.backfillConfirm')"
        :ok-text="t('memoryCenter.models.backfill')"
        :cancel-text="t('memoryCenter.models.cancel')"
        @confirm="backfill(true)"
      >
        <a-button
          size="small"
          :loading="backfilling"
          :disabled="!isAdmin"
          data-testid="memory-embedding-backfill"
        >
          {{ backfilling
            ? t('memoryCenter.models.backfilling', { n: backfillDone })
            : t('memoryCenter.models.backfill') }}
        </a-button>
      </a-popconfirm>
    </div>

    <a-alert
      v-if="backfillRemaining !== null && backfillRemaining > 0 && !backfilling"
      type="warning"
      show-icon
      :message="t('memoryCenter.models.backfillPending', { n: backfillRemaining })"
    />

    <div class="grid">
      <a-card
        v-for="model in snapshot?.models ?? []"
        :key="model.id"
        size="small"
        :class="{ active: model.active }"
        :data-testid="`memory-embedding-model-${model.id}`"
      >
        <template #title>
          <span class="title">
            {{ model.name }}
            <a-tag
              v-if="model.active"
              color="green"
            >
              {{ t('memoryCenter.models.active') }}
            </a-tag>
            <a-tag v-else-if="model.installed">
              {{ t('memoryCenter.models.installed') }}
            </a-tag>
          </span>
        </template>
        <p class="note">
          {{ model.note }}
        </p>
        <a-descriptions
          :column="2"
          size="small"
        >
          <a-descriptions-item :label="t('memoryCenter.models.dims')">
            {{ model.dims }}
          </a-descriptions-item>
          <a-descriptions-item :label="t('memoryCenter.models.langs')">
            {{ model.langs }}
          </a-descriptions-item>
          <a-descriptions-item :label="t('memoryCenter.models.size')">
            {{ humanBytes(model.bytes) }}
          </a-descriptions-item>
          <a-descriptions-item label="License">
            {{ model.license }}
          </a-descriptions-item>
        </a-descriptions>

        <div
          v-if="jobFor(model.id)"
          class="progress"
        >
          <a-progress
            :percent="percent(jobFor(model.id)!)"
            size="small"
            :status="jobFor(model.id)!.status === 'failed' ? 'exception' : 'active'"
          />
          <span class="muted">
            {{ jobFor(model.id)!.currentFile }} · {{ humanBytes(jobFor(model.id)!.received) }} / {{ humanBytes(jobFor(model.id)!.total) }}
            <template v-if="jobFor(model.id)!.source">· {{ jobFor(model.id)!.source }}</template>
          </span>
        </div>

        <div class="actions">
          <a-button
            v-if="!model.installed"
            size="small"
            type="primary"
            :loading="busyModel === model.id || Boolean(jobFor(model.id))"
            :disabled="!isAdmin || Boolean(jobFor(model.id))"
            :data-testid="`memory-embedding-download-${model.id}`"
            @click="download(model)"
          >
            {{ jobFor(model.id) ? t('memoryCenter.models.downloading') : t('memoryCenter.models.download') }}
          </a-button>
          <template v-else>
            <a-button
              v-if="!model.active"
              size="small"
              type="primary"
              :loading="busyModel === model.id"
              :disabled="!isAdmin"
              :data-testid="`memory-embedding-activate-${model.id}`"
              @click="activate(model)"
            >
              {{ t('memoryCenter.models.activate') }}
            </a-button>
            <a-button
              v-else
              size="small"
              :loading="busyModel === 'none'"
              :disabled="!isAdmin"
              @click="activate(null)"
            >
              {{ t('memoryCenter.models.deactivate') }}
            </a-button>
            <a-popconfirm
              :title="t('memoryCenter.models.deleteConfirm', { name: model.name })"
              :ok-text="t('memoryCenter.models.delete')"
              :cancel-text="t('memoryCenter.models.cancel')"
              @confirm="remove(model)"
            >
              <a-button
                size="small"
                danger
                :disabled="!isAdmin"
              >
                {{ t('memoryCenter.models.delete') }}
              </a-button>
            </a-popconfirm>
          </template>
        </div>
        <p
          v-if="!isAdmin"
          class="muted"
        >
          {{ t('memoryCenter.models.adminOnly') }}
        </p>
      </a-card>
    </div>

    <p class="muted footer">
      {{ t('memoryCenter.models.footer') }}
    </p>
  </section>
</template>

<style scoped>
.embedding-panel { display: flex; flex-direction: column; gap: 12px; }
.status { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
.status-item { display: flex; align-items: center; gap: 8px; }
.status-item .label { font-size: 12px; color: var(--ink-faint); }
.spacer { flex: 1; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.grid :deep(.ant-card.active) { border-color: var(--accent, #4a6b57); box-shadow: 0 0 0 1px var(--accent, #4a6b57) inset; }
.title { display: inline-flex; align-items: center; gap: 8px; }
.note { color: var(--ink-soft); font-size: 12px; line-height: 1.55; margin: 0 0 8px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.progress { margin-top: 8px; }
.mono { font-family: var(--font-mono); font-size: 13px; }
.muted { color: var(--ink-faint); font-size: 12px; }
.footer { margin: 0; }
</style>
