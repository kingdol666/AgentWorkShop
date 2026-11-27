<script setup lang="ts">
/**
 * 记忆/图谱健康与修复（M36）。
 * 只重建派生索引（FTS）与清理过期数据，不删除记忆正文；修复需 admin。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { apiFetch } from '~/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'
import { useUserStore } from '@/app/stores/workshop/user'

interface HealthGraph {
  entities?: number
  edges?: number
  communities?: number
  provisionalEntities?: number
  provisionalEdges?: number
  orphanEdges?: number
  staleRuns?: number
  entityFtsRows?: number
  entityFtsHealthy?: boolean
  pendingMergeCandidates?: number
  lastRunAt?: string | null
}
interface Health {
  channelId: string
  memories: number
  ftsRows: number
  ftsHealthy: boolean
  vectorRows: number
  blocks: number
  blocksOverLimit: string[]
  documents: number
  documentsOverLimit: string[]
  graph?: HealthGraph
}

const props = defineProps<{
  channels?: Array<{ id: string, name: string }>
  initialChannelId?: string
}>()

const userStore = useUserStore()
const { t } = useI18n()
const gkey = (k: string): string => `memoryCenter.graph.${k}`
const channelId = ref(props.initialChannelId ?? '')
const channelOptions = ref<Array<{ id: string, name: string }>>(props.channels ?? [])
const health = ref<Health | null>(null)
const loading = ref(false)
const repairing = ref(false)
const repairCounts = ref<Record<string, number> | null>(null)

const graph = computed(() => health.value?.graph ?? {})
const issues = computed(() => {
  const list: string[] = []
  if (health.value && !health.value.ftsHealthy) list.push(t(gkey('warnFts'), { a: health.value.ftsRows, b: health.value.memories }))
  if (health.value?.blocksOverLimit.length) list.push(t(gkey('warnBlocks'), { list: health.value.blocksOverLimit.join('、') }))
  if (health.value?.documentsOverLimit.length) list.push(t(gkey('warnDocs'), { list: health.value.documentsOverLimit.join('、') }))
  if (graph.value.orphanEdges) list.push(t(gkey('warnOrphanEdges'), { n: graph.value.orphanEdges }))
  if (graph.value.staleRuns) list.push(t(gkey('warnStaleRuns'), { n: graph.value.staleRuns }))
  if (graph.value.entityFtsHealthy === false) list.push(t(gkey('warnEntityFts')))
  return list
})

async function loadChannels(): Promise<void> {
  if (props.channels?.length) {
    channelOptions.value = props.channels
  }
  else {
    try {
      const list = await apiFetch<Array<{ id: string, name: string }>>({ base: '', path: '/api/workshop/channels' })
      channelOptions.value = Array.isArray(list) ? list : []
    }
    catch { /* 频道列表失败仍可提示选择 */ }
  }
  if (!channelId.value) channelId.value = channelOptions.value[0]?.id ?? ''
}

async function load(): Promise<void> {
  if (!channelId.value) return
  loading.value = true
  try {
    health.value = await apiFetch<Health>({
      base: '', path: `/api/workshop/memory/health?channelId=${encodeURIComponent(channelId.value)}`,
    })
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    loading.value = false
  }
}

async function repair(): Promise<void> {
  repairing.value = true
  try {
    const res = await apiFetch<{ counts: Record<string, number> }>({
      base: '', path: '/api/workshop/memory/repair', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    })
    repairCounts.value = res.counts
    message.success(t(gkey('repaired')))
    await load()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    repairing.value = false
  }
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  }
  catch {
    return value
  }
}

watch(channelId, () => {
  void load()
})
onMounted(() => {
  void (async () => {
    await loadChannels()
    await load()
  })()
})
</script>

<template>
  <section
    class="health-panel"
    data-testid="memory-health-panel"
  >
    <div class="toolbar">
      <a-select
        v-model:value="channelId"
        show-search
        :placeholder="t(gkey('pickChannel'))"
        style="width: 260px"
        :options="channelOptions.map(c => ({ value: c.id, label: c.name }))"
        :filter-option="(input: string, option: any) => String(option.label).toLowerCase().includes(input.toLowerCase())"
      />
      <a-button
        size="small"
        :loading="loading"
        @click="load"
      >
        {{ t(gkey('refresh')) }}
      </a-button>
      <a-popconfirm
        v-if="userStore.isAdmin"
        :title="t(gkey('repairConfirm'))"
        :ok-text="t(gkey('repair'))"
        :cancel-text="t('memoryCenter.cancel')"
        @confirm="repair"
      >
        <a-button
          size="small"
          danger
          :loading="repairing"
          data-testid="memory-health-repair"
        >
          {{ t(gkey('repair')) }}
        </a-button>
      </a-popconfirm>
      <span
        v-else
        class="muted"
      >{{ t(gkey('adminOnly')) }}</span>
    </div>

    <a-alert
      v-if="issues.length"
      type="warning"
      show-icon
      :message="t(gkey('issuesFound'), { n: issues.length })"
      :description="issues.join('；')"
    />

    <a-spin :spinning="loading">
      <div
        v-if="health"
        class="grid"
      >
        <a-card
          size="small"
          :title="t(gkey('healthMemory'))"
        >
          <a-descriptions
            :column="1"
            size="small"
          >
            <a-descriptions-item :label="t(gkey('memRows'))">
              {{ health.memories }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('ftsRowsLabel'))">
              {{ health.ftsRows }} <a-tag :color="health.ftsHealthy ? 'green' : 'red'">
                {{ health.ftsHealthy ? t(gkey('healthy')) : t(gkey('unhealthy')) }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('vecRows'))">
              {{ health.vectorRows }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('coreBlocks'))">
              {{ health.blocks }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('memDocs'))">
              {{ health.documents }}
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
        <a-card
          size="small"
          :title="t(gkey('healthGraph'))"
        >
          <a-descriptions
            :column="1"
            size="small"
          >
            <a-descriptions-item :label="t(gkey('entityEdge'))">
              {{ graph.entities ?? 0 }} / {{ graph.edges ?? 0 }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('statCommunity'))">
              {{ graph.communities ?? 0 }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('provisional'))">
              {{ t(gkey('provisionalStat'), { a: graph.provisionalEntities ?? 0, b: graph.provisionalEdges ?? 0 }) }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('entityFts'))">
              {{ graph.entityFtsRows ?? 0 }} <a-tag :color="graph.entityFtsHealthy === false ? 'red' : 'green'">
                {{ graph.entityFtsHealthy === false ? t(gkey('unhealthy')) : t(gkey('healthy')) }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('orphanStale'))">
              {{ graph.orphanEdges ?? 0 }} / {{ graph.staleRuns ?? 0 }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('pendingMerge'))">
              {{ graph.pendingMergeCandidates ?? 0 }}
            </a-descriptions-item>
            <a-descriptions-item :label="t(gkey('lastCurate'))">
              {{ formatTime(graph.lastRunAt) }}
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </div>
      <a-empty
        v-else
        :description="t(gkey('pickChannel'))"
      />
      <a-alert
        v-if="repairCounts"
        class="repair-result"
        type="success"
        :message="t(gkey('repairCounts'), { json: JSON.stringify(repairCounts) })"
      />
    </a-spin>
  </section>
</template>

<style scoped>
.health-panel { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.muted { color: var(--ink-faint); font-size: 12px; }
.repair-result { margin-top: 12px; }
</style>
