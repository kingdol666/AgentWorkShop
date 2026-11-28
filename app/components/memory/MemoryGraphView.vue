<script setup lang="ts">
/**
 * 记忆中心 · 知识图谱视图。
 * 能力：子图/筛选/asOf/聚焦、节点与边编辑、合并候选、社区、整理运行、自动整理开关。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { apiFetch } from '~/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'
import {
  memoryGraphApi,
  type GraphCommunity,
  type GraphEdgeDetail,
  type GraphEntityDetail,
  type GraphLink,
  type GraphNode,
  type GraphRun,
  type GraphSettings,
  type GraphSubgraph,
  type MergeCandidate,
} from '~/pages/memory/api'

const props = defineProps<{
  channels?: Array<{ id: string, name: string, lineId?: string, ownerUserId?: string | null }>
  initialChannelId?: string
}>()

const { t } = useI18n()

const emit = defineEmits<{
  (e: 'open-memory', id: string): void
}>()

const channelOptions = ref<Array<{ id: string, name: string, lineId?: string, ownerUserId?: string | null }>>([])
const channelId = ref('')
const scopeMode = ref<'channel' | 'session' | 'shared' | 'line' | 'product'>('channel')
const sessions = ref<Array<{ id: string, title: string, status?: string }>>([])
const sessionId = ref('')
const products = ref<string[]>([])
const productId = ref('')
const loading = ref(false)
const graph = ref<GraphSubgraph | null>(null)
const settings = ref<GraphSettings | null>(null)
const runs = ref<GraphRun[]>([])
const candidates = ref<MergeCandidate[]>([])
const communities = ref<GraphCommunity[]>([])

const q = ref('')
const asOf = ref('')
const depth = ref(2)
const types = ref<string[]>([])
const relations = ref<string[]>([])
const statuses = ref<string[]>(['active', 'provisional'])
const viewMode = ref<'graph' | 'table'>('graph')
const tab = ref<'graph' | 'communities' | 'candidates' | 'runs'>('graph')

const entityOpen = ref(false)
const entityDetail = ref<GraphEntityDetail | null>(null)
const entityLoading = ref(false)
const edgeOpen = ref(false)
const edgeDetail = ref<GraphEdgeDetail | null>(null)
const edgeLoading = ref(false)
const communityOpen = ref(false)
const communityDetail = ref<{ community: GraphCommunity, members: GraphNode[], edges: GraphLink[] } | null>(null)

const createEntityOpen = ref(false)
const createEdgeOpen = ref(false)
const saving = ref(false)
const entityForm = reactive({ name: '', type: 'concept', aliases: '', summary: '', locked: false })
const edgeForm = reactive({
  srcId: '', dstId: '', relation: 'relates_to', fact: '', confidence: 0.6,
})

const entityTypes = [
  'concept', 'parameter', 'metric', 'device', 'node', 'recipe',
  'product', 'line', 'task', 'event', 'document', 'person',
]
const relationOptions = [
  'mentions', 'relates_to', 'causes', 'affects', 'supports', 'contradicts',
  'supersedes', 'derived_from', 'part_of', 'used_for', 'precedes',
  'has_parameter', 'uses_recipe', 'observed_in', 'co_occurs',
]
const statusOptions = ['active', 'provisional', 'rejected', 'superseded', 'retired']

const nodes = computed(() => graph.value?.nodes ?? [])
const edges = computed(() => graph.value?.edges ?? [])
const nodeName = computed(() => new Map(nodes.value.map(n => [n.id, n.canonicalName])))
const currentScope = computed(() => {
  const kind = scopeMode.value === 'shared' ? 'global' : scopeMode.value
  const current = channelOptions.value.find(c => c.id === channelId.value)
  const key = scopeMode.value === 'session'
    ? sessionId.value
    : scopeMode.value === 'product'
      ? productId.value
      : scopeMode.value === 'line'
        ? (current?.lineId ?? '')
        : scopeMode.value === 'shared'
          ? (current?.ownerUserId ?? '')
          : ''
  return { kind, key }
})
const lastRun = computed(() => {
  const { kind, key } = currentScope.value
  return runs.value.find(r => r.scopeKind === kind && r.scopeKey === key) ?? null
})
const RUN_STATUS_KEY: Record<string, string> = {
  ok: 'runOk',
  skipped_noop: 'runNoop',
  failed: 'runFailed',
  running: 'runRunning',
}
const runStatusText = (status?: string | null): string =>
  status ? (RUN_STATUS_KEY[status] ? t(`memoryCenter.graph.${RUN_STATUS_KEY[status]}`) : status) : '—'
const visibleCommunities = computed(() => {
  const { kind, key } = currentScope.value
  return communities.value.filter(c => c.scopeKind === kind && c.scopeKey === key)
})
const stats = computed(() => graph.value?.stats ?? {
  entityTotal: 0, edgeTotal: 0, communityTotal: 0, truncated: false, asOf: null, revision: 0,
})

const gkey = (k: string): string => `memoryCenter.graph.${k}`
const entityColumns = computed(() => [
  { title: t(gkey('colName')), dataIndex: 'canonicalName', key: 'name' },
  { title: t(gkey('colType')), dataIndex: 'entityType', key: 'type', width: 110 },
  { title: t(gkey('colScope')), key: 'scope', width: 150 },
  { title: t(gkey('colStatus')), dataIndex: 'status', key: 'status', width: 110 },
  { title: t(gkey('colDegree')), dataIndex: 'degree', key: 'degree', width: 80 },
  { title: t(gkey('colConfidence')), dataIndex: 'confidence', key: 'confidence', width: 80 },
  { title: t(gkey('colActions')), key: 'actions', width: 90 },
])
const edgeColumns = computed(() => [
  { title: t(gkey('colSrc')), key: 'src' },
  { title: t(gkey('relation')), dataIndex: 'relation', key: 'relation', width: 120 },
  { title: t(gkey('colDst')), key: 'dst' },
  { title: t(gkey('colStatus')), dataIndex: 'status', key: 'status', width: 110 },
  { title: t(gkey('colConfidence')), dataIndex: 'confidence', key: 'confidence', width: 80 },
  { title: t(gkey('colActions')), key: 'actions', width: 90 },
])
const runColumns = computed(() => [
  { title: t(gkey('colStarted')), dataIndex: 'startedAt', key: 'startedAt', width: 170 },
  { title: t(gkey('colScope')), key: 'scope', width: 150 },
  { title: t(gkey('colMode')), dataIndex: 'mode', key: 'mode', width: 100 },
  { title: t(gkey('colStatus')), dataIndex: 'status', key: 'status', width: 110 },
  { title: t(gkey('colScanned')), dataIndex: 'scanned', key: 'scanned', width: 70 },
  { title: t(gkey('colEntitiesNew')), dataIndex: 'entitiesNew', key: 'entitiesNew', width: 75 },
  { title: t(gkey('colEdgesNew')), dataIndex: 'edgesNew', key: 'edgesNew', width: 75 },
  { title: t(gkey('colCommunities')), dataIndex: 'communities', key: 'communities', width: 70 },
  { title: t(gkey('colLlm')), dataIndex: 'llmCalls', key: 'llmCalls', width: 60 },
  { title: t(gkey('colFallback')), key: 'fallback' },
])

let pollTimer: ReturnType<typeof setTimeout> | null = null

async function loadChannels(): Promise<void> {
  if (props.channels?.length) {
    channelOptions.value = props.channels
  }
  else {
    try {
      const list = await apiFetch<Array<{ id: string, name: string, lineId?: string }>>({
        base: '', path: '/api/workshop/channels',
      })
      channelOptions.value = Array.isArray(list) ? list : []
    }
    catch (err) {
      message.error(apiErrorMessage(err))
    }
  }
  channelId.value = props.initialChannelId || channelId.value || channelOptions.value[0]?.id || ''
}

async function loadScopeMeta(): Promise<void> {
  if (!channelId.value) return
  const [sessionList, productRes] = await Promise.all([
    apiFetch<Array<{ id: string, title: string, status?: string }>>({
      base: '', path: `/api/workshop/channels/${encodeURIComponent(channelId.value)}/sessions`,
    }).catch(() => []),
    apiFetch<{ productIds: string[] }>({
      base: '', path: `/api/workshop/channels/${encodeURIComponent(channelId.value)}/products`,
    }).catch(() => ({ productIds: [] })),
  ])
  sessions.value = Array.isArray(sessionList) ? sessionList : []
  products.value = Array.isArray(productRes.productIds) ? productRes.productIds : []
  if (!sessions.value.some(s => s.id === sessionId.value)) sessionId.value = sessions.value[0]?.id ?? ''
  if (!products.value.includes(productId.value)) productId.value = products.value[0] ?? ''
}

async function loadGraph(): Promise<void> {
  if (!channelId.value) return
  if (scopeMode.value === 'session' && !sessionId.value) {
    graph.value = null
    return
  }
  if (scopeMode.value === 'product' && !productId.value) {
    graph.value = null
    return
  }
  loading.value = true
  try {
    graph.value = await memoryGraphApi.getSubgraph(channelId.value, {
      q: q.value.trim() || undefined,
      depth: depth.value,
      asOf: asOf.value.trim() || undefined,
      types: types.value.length ? types.value : undefined,
      relations: relations.value.length ? relations.value : undefined,
      statuses: statuses.value.length ? statuses.value : undefined,
      scope: scopeMode.value,
      sessionId: scopeMode.value === 'session' ? sessionId.value : undefined,
      productId: scopeMode.value === 'product' ? productId.value : undefined,
      limit: 200,
    })
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    loading.value = false
  }
}

async function loadMeta(): Promise<void> {
  if (!channelId.value) return
  try {
    const [s, c, m, r] = await Promise.all([
      memoryGraphApi.settings(channelId.value),
      memoryGraphApi.communities(channelId.value),
      memoryGraphApi.mergeCandidates(channelId.value),
      memoryGraphApi.runs(channelId.value, 30),
    ])
    settings.value = s
    communities.value = c.items
    candidates.value = m.items
    // 运行台账可能混有旧本地时区字符串与 UTC ISO：按 Date.parse 排序，避免字符串比较错序。
    runs.value = r.items.slice().sort((a, b) => {
      const at = Date.parse(a.startedAt ?? '')
      const bt = Date.parse(b.startedAt ?? '')
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0)
    })
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function loadAll(): Promise<void> {
  await Promise.all([loadGraph(), loadMeta()])
}

function applyFilters(): void {
  void loadGraph()
}

function resetFilters(): void {
  q.value = ''
  asOf.value = ''
  types.value = []
  relations.value = []
  statuses.value = ['active', 'provisional']
  depth.value = 2
  void loadGraph()
}

async function focusNode(node: GraphNode): Promise<void> {
  if (node.entityType === 'episode' && node.memoryId) {
    emit('open-memory', node.memoryId)
    return
  }
  try {
    graph.value = await memoryGraphApi.getSubgraph(channelId.value, {
      entity: node.id, depth: 2, asOf: asOf.value.trim() || undefined, limit: 200,
    })
    tab.value = 'graph'
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function openEntity(id: string): Promise<void> {
  entityOpen.value = true
  entityLoading.value = true
  try {
    entityDetail.value = await memoryGraphApi.getEntity(channelId.value, id)
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    entityLoading.value = false
  }
}

async function openEdge(id: string): Promise<void> {
  edgeOpen.value = true
  edgeLoading.value = true
  try {
    edgeDetail.value = await memoryGraphApi.getEdge(channelId.value, id)
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    edgeLoading.value = false
  }
}

async function refreshAfterMutation(): Promise<void> {
  await loadAll()
  if (entityOpen.value && entityDetail.value) {
    try {
      entityDetail.value = await memoryGraphApi.getEntity(channelId.value, entityDetail.value.entity.id)
    }
    catch { /* 实体可能已被删除 */ }
  }
  if (edgeOpen.value && edgeDetail.value) {
    try {
      edgeDetail.value = await memoryGraphApi.getEdge(channelId.value, edgeDetail.value.edge.id)
    }
    catch { /* 关系可能已被删除 */ }
  }
}

function openCreateEntity(): void {
  entityForm.name = ''
  entityForm.type = 'concept'
  entityForm.aliases = ''
  entityForm.summary = ''
  entityForm.locked = false
  createEntityOpen.value = true
}

async function createEntity(): Promise<void> {
  if (!entityForm.name.trim()) {
    message.warning(t(gkey('nameRequired')))
    return
  }
  saving.value = true
  try {
    const lineId = channelOptions.value.find(c => c.id === channelId.value)?.lineId ?? ''
    const scopeKind = scopeMode.value === 'shared' ? 'global' : scopeMode.value
    const scopeKey = scopeMode.value === 'session'
      ? sessionId.value
      : scopeMode.value === 'product'
        ? productId.value
        : scopeMode.value === 'line'
          ? lineId
          : ''
    await memoryGraphApi.createEntity(channelId.value, {
      name: entityForm.name.trim(),
      type: entityForm.type,
      aliases: entityForm.aliases.split(',').map(s => s.trim()).filter(Boolean),
      summary: entityForm.summary,
      locked: entityForm.locked,
      scopeKind,
      scopeKey,
      ...(scopeMode.value === 'product' ? { productId: productId.value } : {}),
    })
    message.success(t(gkey('entityCreated')))
    createEntityOpen.value = false
    await loadAll()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    saving.value = false
  }
}

function openCreateEdge(): void {
  edgeForm.srcId = ''
  edgeForm.dstId = ''
  edgeForm.relation = 'relates_to'
  edgeForm.fact = ''
  edgeForm.confidence = 0.6
  createEdgeOpen.value = true
}

async function createEdge(): Promise<void> {
  if (!edgeForm.srcId || !edgeForm.dstId) {
    message.warning(t(gkey('endsRequired')))
    return
  }
  saving.value = true
  try {
    await memoryGraphApi.createEdge(channelId.value, {
      srcId: edgeForm.srcId,
      dstId: edgeForm.dstId,
      relation: edgeForm.relation,
      fact: edgeForm.fact,
      confidence: edgeForm.confidence,
    })
    message.success(t(gkey('edgeCreated')))
    createEdgeOpen.value = false
    await loadAll()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    saving.value = false
  }
}

async function startRun(mode: 'incremental' | 'full'): Promise<void> {
  try {
    const res = await memoryGraphApi.startRun(channelId.value, mode, {
      scope: scopeMode.value,
      ...(scopeMode.value === 'session' ? { sessionId: sessionId.value } : {}),
      ...(scopeMode.value === 'product' ? { productId: productId.value } : {}),
    })
    message.info(mode === 'full' ? t(gkey('fullStarted')) : t(gkey('incrementalStarted')))
    await loadMeta()
    pollRun(res.runId)
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

function pollRun(runId: string): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    try {
      const run = await memoryGraphApi.getRun(channelId.value, runId)
      runs.value = [run, ...runs.value.filter(r => r.id !== run.id)]
      if (run.status === 'running') {
        pollRun(runId)
        return
      }
      message.success(t(gkey('curationDone'), { status: run.status }))
      await loadAll()
    }
    catch {
      pollTimer = null
    }
  }, 1200)
}

async function toggleSettings(enabled: boolean): Promise<void> {
  try {
    settings.value = await memoryGraphApi.updateSettings(channelId.value, enabled)
    message.success(enabled ? t(gkey('autoOn')) : t(gkey('autoOff')))
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function acceptCandidate(candidate: MergeCandidate): Promise<void> {
  try {
    await memoryGraphApi.acceptCandidate(channelId.value, candidate.id)
    message.success(t(gkey('mergedMsg')))
    await refreshAfterMutation()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function rejectCandidate(candidate: MergeCandidate): Promise<void> {
  try {
    await memoryGraphApi.rejectCandidate(channelId.value, candidate.id)
    message.success(t(gkey('candidateRejected')))
    await refreshAfterMutation()
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function openCommunity(c: GraphCommunity): Promise<void> {
  try {
    communityDetail.value = await memoryGraphApi.community(channelId.value, c.id)
    communityOpen.value = true
  }
  catch (err) {
    message.error(apiErrorMessage(err))
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

onMounted(async () => {
  await loadChannels()
  await loadScopeMeta()
  await loadAll()
})

onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

watch(channelId, async () => {
  graph.value = null
  await loadScopeMeta()
  await loadAll()
})

watch([scopeMode, sessionId, productId], () => {
  void loadGraph()
})
</script>

<template>
  <section
    class="memory-graph-view"
    data-testid="memory-graph-view"
  >
    <div class="toolbar">
      <a-select
        v-model:value="channelId"
        show-search
        style="width: 220px"
        :placeholder="t(gkey('channel'))"
        :options="channelOptions.map(c => ({ value: c.id, label: `${c.name}${c.lineId ? ` · ${c.lineId}` : ''}` }))"
        :filter-option="(input: string, option: any) => String(option.label).toLowerCase().includes(input.toLowerCase())"
      />
      <a-select
        v-model:value="scopeMode"
        style="width: 130px"
        data-testid="memory-graph-scope"
        :options="[
          { value: 'channel', label: t(gkey('scopeChannel')) },
          { value: 'session', label: t(gkey('scopeSession')) },
          { value: 'shared', label: t(gkey('scopeShared')) },
          { value: 'line', label: t(gkey('scopeLine')) },
          { value: 'product', label: t(gkey('scopeProduct')) },
        ]"
      />
      <a-select
        v-if="scopeMode === 'session'"
        v-model:value="sessionId"
        show-search
        style="width: 180px"
        :placeholder="t(gkey('session'))"
        data-testid="memory-graph-session"
        :options="sessions.map(s => ({ value: s.id, label: s.title || s.id.slice(0, 8) }))"
        :filter-option="(input: string, option: any) => String(option.label).toLowerCase().includes(input.toLowerCase())"
      />
      <a-select
        v-if="scopeMode === 'product'"
        v-model:value="productId"
        show-search
        style="width: 180px"
        :placeholder="t(gkey('product'))"
        data-testid="memory-graph-product"
        :options="products.map(p => ({ value: p, label: p }))"
      />
      <a-input-search
        v-model:value="q"
        :placeholder="t(gkey('search'))"
        style="width: 260px"
        data-testid="memory-graph-search"
        @search="applyFilters"
      />
      <a-input
        v-model:value="asOf"
        :placeholder="t(gkey('asOf'))"
        style="width: 190px"
      />
      <a-select
        v-model:value="types"
        mode="multiple"
        :placeholder="t(gkey('entityType'))"
        style="min-width: 150px"
        :options="entityTypes.map(x => ({ value: x, label: x }))"
      />
      <a-select
        v-model:value="relations"
        mode="multiple"
        :placeholder="t(gkey('relation'))"
        style="min-width: 150px"
        :options="relationOptions.map(r => ({ value: r, label: r }))"
      />
      <a-select
        v-model:value="statuses"
        mode="multiple"
        :placeholder="t(gkey('status'))"
        style="min-width: 130px"
        :options="statusOptions.map(s => ({ value: s, label: s }))"
      />
      <a-segmented
        v-model:value="depth"
        :options="[{ label: t(gkey('hop1')), value: 1 }, { label: t(gkey('hop2')), value: 2 }]"
      />
      <a-button
        size="small"
        @click="applyFilters"
      >
        {{ t(gkey('apply')) }}
      </a-button>
      <a-button
        size="small"
        @click="resetFilters"
      >
        {{ t(gkey('reset')) }}
      </a-button>
      <a-button
        size="small"
        data-testid="memory-graph-refresh"
        :loading="loading"
        @click="loadAll"
      >
        {{ t(gkey('refresh')) }}
      </a-button>
    </div>

    <div class="stats">
      <div class="stat">
        <span class="num">{{ stats.entityTotal }}</span><span class="label">{{ t(gkey('statEntity')) }}</span>
      </div>
      <div class="stat">
        <span class="num">{{ stats.edgeTotal }}</span><span class="label">{{ t(gkey('statEdge')) }}</span>
      </div>
      <div class="stat">
        <span class="num">{{ stats.communityTotal }}</span><span class="label">{{ t(gkey('statCommunity')) }}</span>
      </div>
      <div class="stat">
        <span class="num">{{ runStatusText(lastRun?.status) }}</span>
        <span class="label">{{ t(gkey('lastRun')) }} · {{ formatTime(lastRun?.finishedAt || lastRun?.startedAt) }}</span>
      </div>
      <div class="stat">
        <a-switch
          :checked="settings?.enabled"
          :loading="!settings"
          data-testid="memory-graph-settings"
          @change="(v: any) => toggleSettings(Boolean(v))"
        />
        <span class="label">{{ t(gkey('autoCurate')) }} {{ settings?.enabled ? t(gkey('on')) : t(gkey('off')) }}</span>
      </div>
      <div class="spacer" />
      <a-button
        size="small"
        data-testid="memory-graph-run"
        @click="startRun('incremental')"
      >
        {{ t(gkey('runNow')) }}
      </a-button>
      <a-popconfirm
        :title="t(gkey('rebuildConfirm'))"
        :ok-text="t(gkey('runOkText'))"
        :cancel-text="t('memoryCenter.cancel')"
        @confirm="startRun('full')"
      >
        <a-button
          size="small"
          data-testid="memory-graph-rebuild"
        >
          {{ t(gkey('rebuild')) }}
        </a-button>
      </a-popconfirm>
      <a-button
        size="small"
        data-testid="memory-graph-entity-create"
        @click="openCreateEntity"
      >
        {{ t(gkey('newEntity')) }}
      </a-button>
      <a-button
        size="small"
        data-testid="memory-graph-edge-create"
        @click="openCreateEdge"
      >
        {{ t(gkey('newEdge')) }}
      </a-button>
      <a-segmented
        v-model:value="viewMode"
        :options="[{ label: t(gkey('viewGraph')), value: 'graph' }, { label: t(gkey('viewTable')), value: 'table' }]"
      />
    </div>

    <div
      v-if="stats.truncated"
      class="hint"
    >
      {{ t(gkey('truncated')) }}
    </div>

    <div class="tabbar">
      <a-segmented
        v-model:value="tab"
        :options="[
          { label: viewMode === 'table' ? `${t(gkey('tabGraph'))} / ${t(gkey('viewTable'))}` : t(gkey('tabGraph')), value: 'graph' },
          { label: t(gkey('tabCommunities'), { n: visibleCommunities.length }), value: 'communities' },
          { label: t(gkey('tabCandidates'), { n: candidates.length }), value: 'candidates' },
          { label: t(gkey('tabRuns'), { n: runs.length }), value: 'runs' },
        ]"
      />
    </div>

    <a-spin :spinning="loading">
      <template v-if="tab === 'graph'">
        <MemoryGraphCanvas
          v-if="viewMode === 'graph'"
          :nodes="nodes"
          :edges="edges"
          :selected-node-id="entityDetail?.entity.id ?? null"
          :selected-edge-id="edgeDetail?.edge.id ?? null"
          :height="560"
          @select-node="openEntity($event.id)"
          @select-edge="openEdge($event.id)"
        />
        <div
          v-else
          class="tables"
        >
          <a-table
            size="small"
            :columns="entityColumns"
            :data-source="nodes"
            row-key="id"
            :pagination="{ pageSize: 20 }"
            data-testid="memory-graph-table"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <a @click="focusNode(record as GraphNode)">{{ record.canonicalName }}</a>
                <a-tag
                  v-if="record.locked"
                  color="blue"
                >
                  {{ t(gkey('lockTag')) }}
                </a-tag>
              </template>
              <template v-else-if="column.key === 'scope'">
                {{ record.scopeKind }}{{ record.scopeKey ? `:${record.scopeKey}` : '' }}
              </template>
              <template v-else-if="column.key === 'actions'">
                <a-button
                  size="small"
                  type="link"
                  @click="openEntity(record.id)"
                >
                  {{ t(gkey('detail')) }}
                </a-button>
              </template>
            </template>
          </a-table>
          <a-table
            size="small"
            :columns="edgeColumns"
            :data-source="edges"
            row-key="id"
            :pagination="{ pageSize: 20 }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'src'">
                {{ nodeName.get(record.srcId) || record.srcId }}
              </template>
              <template v-else-if="column.key === 'dst'">
                {{ nodeName.get(record.dstId) || record.dstId }}
              </template>
              <template v-else-if="column.key === 'actions'">
                <a-button
                  size="small"
                  type="link"
                  @click="openEdge(record.id)"
                >
                  {{ t(gkey('detail')) }}
                </a-button>
              </template>
            </template>
          </a-table>
        </div>
      </template>

      <template v-else-if="tab === 'communities'">
        <a-empty
          v-if="visibleCommunities.length === 0"
          :description="t(gkey('noCommunities'))"
        />
        <div
          v-else
          class="cards"
        >
          <a-card
            v-for="c in visibleCommunities"
            :key="c.id"
            size="small"
            hoverable
            @click="openCommunity(c)"
          >
            <template #title>
              {{ c.title }} <a-tag>{{ t(gkey('entitiesTag'), { n: c.memberCount }) }}</a-tag>
            </template>
            <div class="community-summary">
              {{ c.summary }}
            </div>
          </a-card>
        </div>
      </template>

      <template v-else-if="tab === 'candidates'">
        <a-empty
          v-if="candidates.length === 0"
          :description="t(gkey('noCandidates'))"
        />
        <a-table
          v-else
          size="small"
          :data-source="candidates"
          row-key="id"
          :pagination="false"
          :columns="[
            { title: t(gkey('colSrc')), dataIndex: 'sourceName', key: 'sourceName' },
            { title: t(gkey('colDst')), dataIndex: 'targetName', key: 'targetName' },
            { title: t(gkey('colSimilarity')), dataIndex: 'score', key: 'score', width: 90 },
            { title: t(gkey('colReason')), dataIndex: 'reason', key: 'reason' },
            { title: t(gkey('colActions')), key: 'actions', width: 160 },
          ]"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'score'">
              {{ Number(record.score).toFixed(2) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-popconfirm
                :title="t(gkey('mergeConfirm'))"
                :ok-text="t(gkey('merge'))"
                :cancel-text="t('memoryCenter.cancel')"
                @confirm="acceptCandidate(record as MergeCandidate)"
              >
                <a-button
                  size="small"
                  type="primary"
                >
                  {{ t(gkey('merge')) }}
                </a-button>
              </a-popconfirm>
              <a-button
                size="small"
                @click="rejectCandidate(record as MergeCandidate)"
              >
                {{ t(gkey('reject')) }}
              </a-button>
            </template>
          </template>
        </a-table>
      </template>

      <template v-else>
        <a-table
          size="small"
          :columns="runColumns"
          :data-source="runs"
          row-key="id"
          :pagination="{ pageSize: 10 }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'startedAt'">
              {{ formatTime(record.startedAt) }}
            </template>
            <template v-else-if="column.key === 'scope'">
              {{ record.scopeKind }}{{ record.scopeKey ? `:${record.scopeKey}` : '' }}
            </template>
            <template v-else-if="column.key === 'status'">
              <a-tag :color="record.status === 'ok' ? 'green' : record.status === 'failed' ? 'red' : record.status === 'running' ? 'blue' : 'default'">
                {{ runStatusText(record.status) }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'fallback'">
              <span class="muted">{{ record.fallbackReason || record.error || '—' }}</span>
            </template>
          </template>
        </a-table>
      </template>
    </a-spin>

    <MemoryGraphEntityDrawer
      v-model:open="entityOpen"
      :channel-id="channelId"
      :detail="entityDetail"
      :loading="entityLoading"
      @refresh="refreshAfterMutation"
      @open-memory="id => emit('open-memory', id)"
    />
    <MemoryGraphEdgeDrawer
      v-model:open="edgeOpen"
      :channel-id="channelId"
      :detail="edgeDetail"
      :loading="edgeLoading"
      @refresh="refreshAfterMutation"
      @open-memory="id => emit('open-memory', id)"
    />

    <a-drawer
      v-model:open="communityOpen"
      :title="t(gkey('communityDetail'))"
      :width="560"
      placement="right"
    >
      <template v-if="communityDetail">
        <h3>{{ communityDetail.community.title }}</h3>
        <p class="community-summary">
          {{ communityDetail.community.summary }}
        </p>
        <a-divider>{{ t(gkey('members'), { n: communityDetail.members.length }) }}</a-divider>
        <a-list
          size="small"
          :data-source="communityDetail.members"
        >
          <template #renderItem="{ item }">
            <a-list-item>
              <a @click="openEntity(item.id)">{{ item.canonicalName }}</a>
              <span class="muted">{{ item.entityType }} · {{ item.status }}</span>
            </a-list-item>
          </template>
        </a-list>
      </template>
    </a-drawer>

    <a-modal
      v-model:open="createEntityOpen"
      :title="t(gkey('createEntityTitle'))"
      :confirm-loading="saving"
      :ok-text="t(gkey('create'))"
      :cancel-text="t('memoryCenter.cancel')"
      @ok="createEntity"
    >
      <a-form layout="vertical">
        <a-form-item :label="t(gkey('name'))">
          <a-input
            v-model:value="entityForm.name"
            :maxlength="200"
          />
        </a-form-item>
        <a-form-item :label="t(gkey('colType'))">
          <a-select
            v-model:value="entityForm.type"
            :options="entityTypes.map(x => ({ value: x, label: x }))"
          />
        </a-form-item>
        <a-form-item :label="t(gkey('aliases'))">
          <a-input v-model:value="entityForm.aliases" />
        </a-form-item>
        <a-form-item :label="t(gkey('summary'))">
          <a-textarea
            v-model:value="entityForm.summary"
            :rows="3"
            :maxlength="2000"
          />
        </a-form-item>
        <a-form-item :label="t(gkey('locked'))">
          <a-switch v-model:checked="entityForm.locked" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="createEdgeOpen"
      :title="t(gkey('createEdgeTitle'))"
      :confirm-loading="saving"
      :ok-text="t(gkey('create'))"
      :cancel-text="t('memoryCenter.cancel')"
      @ok="createEdge"
    >
      <a-form layout="vertical">
        <a-form-item :label="t(gkey('srcEntity'))">
          <a-select
            v-model:value="edgeForm.srcId"
            show-search
            :options="nodes.filter(n => n.entityType !== 'episode').map(n => ({ value: n.id, label: n.canonicalName }))"
          />
        </a-form-item>
        <a-form-item :label="t(gkey('relation'))">
          <a-select
            v-model:value="edgeForm.relation"
            :options="relationOptions.map(r => ({ value: r, label: r }))"
          />
        </a-form-item>
        <a-form-item :label="t(gkey('dstEntity'))">
          <a-select
            v-model:value="edgeForm.dstId"
            show-search
            :options="nodes.filter(n => n.entityType !== 'episode').map(n => ({ value: n.id, label: n.canonicalName }))"
          />
        </a-form-item>
        <a-form-item :label="t(gkey('fact'))">
          <a-textarea
            v-model:value="edgeForm.fact"
            :rows="3"
            :maxlength="600"
          />
        </a-form-item>
        <a-form-item :label="t(gkey('colConfidence'))">
          <a-input-number
            v-model:value="edgeForm.confidence"
            :min="0"
            :max="1"
            :step="0.05"
            style="width: 100%"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </section>
</template>

<style scoped>
.memory-graph-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--paper-raised);
}
.stat {
  display: flex;
  flex-direction: column;
  min-width: 70px;
}
.stat .num {
  font-family: var(--font-mono);
  font-size: 18px;
  color: var(--ink);
}
.stat .label {
  font-size: 11px;
  color: var(--ink-faint);
}
.spacer { flex: 1; }
.hint {
  font-size: 12px;
  color: var(--ink-faint);
}
.tabbar { display: flex; justify-content: space-between; align-items: center; }
.tables { display: flex; flex-direction: column; gap: 16px; }
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.community-summary {
  white-space: pre-wrap;
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1.55;
  max-height: 120px;
  overflow: auto;
}
.muted { color: var(--ink-faint); font-size: 12px; }
@media (max-width: 760px) {
  .toolbar :deep(.ant-input-search),
  .toolbar :deep(.ant-select),
  .toolbar :deep(.ant-input) {
    width: 100% !important;
  }
}
</style>
