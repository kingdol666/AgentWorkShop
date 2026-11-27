<script setup lang="ts">
/**
 * 记忆中心（/memory）—— 所有 RSI 持久化内容的人工管理面。
 *
 * 分区：共享区（owner 级 global）/ 产线 / 产品 / Channel / 会话。
 * 能力：覆写（原文留版本）/ 批注 / 版本回滚 / 软删恢复 / 硬删（owner）/
 *       置顶 / 经验晋升 / 显式部署（晋升≠部署：部署后才参与自动注入）。
 *
 * 纪律：所有判定由服务端裁决（409/422 原样展示）；危险动作就地二次确认。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { apiFetch } from '~/composables/workshop/apiClient'

const { t } = useI18n()

interface MemoryItem {
  id: string
  channelId: string
  agentId: string
  kind: string
  title: string
  content: string
  importance: number
  scopeKind: string
  scopeKey: string
  status: string
  authorKind: string
  authorId: string
  ownerUserId: string | null
  revision: number
  pinned: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  originRef: string
}

interface MemoryDetail extends MemoryItem {
  annotations: Array<{ id: string, body: string, authorId: string, createdAt: string }>
  revisions: Array<{ revision: number, title: string, content: string, authorKind: string, authorId: string, reason: string, createdAt: string }>
  effect: { uses: number, successes: number, failures: number, flagged: boolean, restoredAt: string | null } | null
}
interface CurationInfo {
  sources: Array<{ memoryId: string, title: string, kind: string, status: string, updatedAt: string }>
  runs: Array<{ id: string, mode: string, status: string, sourceCount: number, revision: number, fallbackReason: string, startedAt: string }>
}

const loading = ref(false)
const busy = ref(false)
const view = ref<'list' | 'graph' | 'injections' | 'health'>('list')
const items = ref<MemoryItem[]>([])
const total = ref(0)
const facets = ref<{ byScope: Record<string, number>, byStatus: Record<string, number>, deleted: number }>({ byScope: {}, byStatus: {}, deleted: 0 })
const filters = ref<{ q: string, scopeKind: string, status: string, kind: string, includeDeleted: boolean }>({ q: '', scopeKind: '', status: '', kind: '', includeDeleted: false })
const page = ref(1)
const pageSize = 20

const detail = ref<MemoryDetail | null>(null)
const drawerOpen = ref(false)
const curationInfo = ref<CurationInfo | null>(null)

const editing = ref(false)
const editForm = ref({ title: '', content: '', reason: '' })
const annotating = ref('')
const rollbackTo = ref<number | null>(null)
const deleteReason = ref('')
const rejecting = ref(false)
const rejectReason = ref('')

/** 产线追溯（批次 N/M）：频道 → 操作+DAQ 事实 / 参数经验手册 */
interface OperationRow {
  id: string
  ts: string
  nodeName: string
  nodeId: string
  fromValue: number | null
  toValue: number
  path: string
  contextSource: string
  productId: string
  recipeId: string
  recipeRevision: string
  recipeRunId: string | null
  verdict: string
  effect: number | null
  attemptId: string
  approvalId: string | null
  daq: { joinQuality: string, pre: { mean?: number | null }, post: { mean?: number | null }, sampleCount: number, rawAvailable: boolean } | null
}
interface OperationAttempt {
  id: string
  nodeId: string
  state: string
  payload: Record<string, unknown>
  productId: string
  runId: string
}
const industryOpen = ref(false)
const industryLoading = ref(false)
const industryChannels = ref<Array<{ id: string, name: string, lineId?: string, ownerUserId?: string | null }>>([])
const industryChannelId = ref('')
const operationRows = ref<OperationRow[]>([])
const operationAttempts = ref<OperationAttempt[]>([])
const operationCoverage = ref<Record<string, number> | null>(null)
const handbookMarkdown = ref('')
const handbookStats = ref<{ claimCount: number, sourceCount: number } | null>(null)
const proposals = ref<Array<Record<string, unknown>>>([])
const accessMode = ref('inherit')
const accessModes = ['inherit', 'isolated', 'disabled', 'readonly']
const accessScope = ref<'channel' | 'session'>('channel')
const accessSessionId = ref('')
const industrySessions = ref<Array<{ id: string, title: string, status?: string }>>([])
const fabricBlocks = ref<Array<Record<string, unknown>>>([])
const fabricFiles = ref<Array<Record<string, unknown>>>([])
const newBlockLabel = ref('')
const newBlockValue = ref('')
const newFilePath = ref('')
const newFileContent = ref('')
const openFile = ref<Record<string, unknown> | null>(null)

async function loadIndustryChannels() {
  try {
    // apiFetch 已解包信封：data 就是频道数组
    const res = await api<Array<{ id: string, name: string, lineId?: string, ownerUserId?: string | null }>>('/api/workshop/channels')
    industryChannels.value = (Array.isArray(res) ? res : []).filter(c => Boolean(c.lineId))
    if (!industryChannelId.value && industryChannels.value[0]) industryChannelId.value = industryChannels.value[0].id
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function loadIndustryData() {
  if (!industryChannelId.value) return
  industryLoading.value = true
  try {
    const base = `/api/workshop/channels/${industryChannelId.value}`
    const [ops, book] = await Promise.all([
      api<{ items: OperationRow[], attempts: OperationAttempt[], coverage: Record<string, number> }>(`${base}/operations?limit=50`),
      api<{ markdown: string, claimCount: number, sourceCount: number }>(`${base}/parameter-handbook`),
    ])
    operationRows.value = ops.items ?? []
    operationAttempts.value = ops.attempts ?? []
    operationCoverage.value = ops.coverage ?? null
    handbookMarkdown.value = book.markdown ?? ''
    handbookStats.value = { claimCount: book.claimCount ?? 0, sourceCount: book.sourceCount ?? 0 }
    const [props, sessions] = await Promise.all([
      api<{ items: Array<Record<string, unknown>> }>(`${base}/parameter-proposals?limit=20`).catch(() => ({ items: [] })),
      api<Array<{ id: string, title: string, status?: string }>>(`${base}/sessions`).catch(() => []),
    ])
    proposals.value = props.items ?? []
    industrySessions.value = Array.isArray(sessions) ? sessions : []
    if (!industrySessions.value.some(s => s.id === accessSessionId.value)) accessSessionId.value = ''
    await loadAccessMode()
    const [blocks, files] = await Promise.all([
      api<{ items: Array<Record<string, unknown>> }>(`${base}/memory-blocks`).catch(() => ({ items: [] })),
      api<{ items: Array<Record<string, unknown>> }>(`${base}/memory-files`).catch(() => ({ items: [] })),
    ])
    fabricBlocks.value = blocks.items ?? []
    fabricFiles.value = files.items ?? []
    openFile.value = null
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    industryLoading.value = false
  }
}

const operationColumns = computed(() => [
  { title: t('memoryCenter.industry.time'), dataIndex: 'ts', key: 'ts', width: 170 },
  { title: t('memoryCenter.industry.node'), key: 'node', width: 150 },
  { title: t('memoryCenter.industry.change'), key: 'change', width: 130 },
  { title: t('memoryCenter.industry.context'), key: 'context', width: 230 },
  { title: t('memoryCenter.industry.daq'), key: 'daq', width: 190 },
  { title: t('memoryCenter.industry.verdict'), dataIndex: 'verdict', key: 'verdict', width: 140 },
])

watch(industryChannelId, () => {
  if (industryOpen.value) void loadIndustryData()
})

const toggleIndustry = async () => {
  industryOpen.value = !industryOpen.value
  if (industryOpen.value) {
    if (industryChannels.value.length === 0) await loadIndustryChannels()
    await loadIndustryData()
  }
}

const loadAccessMode = async () => {
  if (!industryChannelId.value) return
  const sessionId = accessScope.value === 'session' ? accessSessionId.value : ''
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  const mode = await api<{ mode: string }>(`/api/workshop/channels/${industryChannelId.value}/memory-access-mode${query}`)
    .catch(() => ({ mode: 'inherit' }))
  accessMode.value = mode.mode ?? 'inherit'
}

const onAccessScopeChange = async (scope: unknown) => {
  accessScope.value = scope === 'session' ? 'session' : 'channel'
  if (accessScope.value === 'session' && !accessSessionId.value) accessSessionId.value = industrySessions.value[0]?.id ?? ''
  await loadAccessMode()
}

const onAccessSessionChange = async () => {
  await loadAccessMode()
}

const updateAccessMode = async (mode: string) => {
  if (!industryChannelId.value) return
  const sessionId = accessScope.value === 'session' ? accessSessionId.value : ''
  await api(`/api/workshop/channels/${industryChannelId.value}/memory-access-mode`, {
    method: 'PATCH',
    body: { mode, ...(sessionId ? { sessionId } : {}) },
  })
  accessMode.value = mode
  message.success(t('memoryCenter.industry.accessUpdated'))
}

const generateProposals = async () => {
  if (!industryChannelId.value) return
  const currentValues: Record<string, number> = {}
  for (const row of operationRows.value) currentValues[row.nodeId] = row.toValue
  await api(`/api/workshop/channels/${industryChannelId.value}/parameter-proposals`, {
    method: 'POST',
    body: { currentValues },
  })
  await loadIndustryData()
  message.success(t('memoryCenter.industry.proposalGenerated'))
}

const saveBlock = async () => {
  if (!industryChannelId.value || !newBlockLabel.value.trim()) return
  await api(`/api/workshop/channels/${industryChannelId.value}/memory-blocks`, {
    method: 'POST',
    body: { action: 'replace', label: newBlockLabel.value.trim(), value: newBlockValue.value },
  })
  newBlockLabel.value = ''
  newBlockValue.value = ''
  await loadIndustryData()
  message.success(t('memoryCenter.fabric.saved'))
}

const lockBlock = async (block: Record<string, unknown>) => {
  if (!industryChannelId.value) return
  await api(`/api/workshop/channels/${industryChannelId.value}/memory-blocks`, {
    method: 'POST',
    body: { action: 'lock', label: block.label, locked: !block.locked },
  })
  await loadIndustryData()
}

const saveFile = async () => {
  if (!industryChannelId.value || !newFilePath.value.trim()) return
  await api(`/api/workshop/channels/${industryChannelId.value}/memory-files`, {
    method: 'POST',
    body: { command: 'create', path: newFilePath.value.trim(), content: newFileContent.value },
  })
  newFilePath.value = ''
  newFileContent.value = ''
  await loadIndustryData()
  message.success(t('memoryCenter.fabric.saved'))
}

const viewFile = async (file: Record<string, unknown>) => {
  if (!industryChannelId.value) return
  const res = await api<{ document: Record<string, unknown> }>(`/api/workshop/channels/${industryChannelId.value}/memory-files?path=${encodeURIComponent(String(file.path))}`)
  openFile.value = res.document
}

const deleteFile = async (file: Record<string, unknown>) => {
  if (!industryChannelId.value) return
  await api(`/api/workshop/channels/${industryChannelId.value}/memory-files`, {
    method: 'POST',
    body: { command: 'delete', path: file.path },
  })
  await loadIndustryData()
}

const scopes = ['global', 'line', 'product', 'channel', 'session']
const statuses = ['active', 'candidate', 'validated', 'contested', 'retired']

const scopeLabel = (s: string) => t(`memoryCenter.scope.${s}`)
const isExperience = computed(() => detail.value?.kind === 'experience')
const isCurated = computed(() => detail.value?.kind === 'curated')

/**
 * 统一 API 客户端：解析 {code,message,data} 信封并抛 ApiError。
 * 旧实现直接用 `$fetch` 读 `list.items`，拿到的是信封 → 列表恒空（2026-11-27 实机验收发现）。
 */
type ApiOptions = { method?: string, body?: unknown }
const api = <T = unknown>(url: string, opts?: ApiOptions): Promise<T> =>
  apiFetch<T>({
    base: '',
    path: url,
    retries: 1,
    init: opts
      ? {
          method: opts.method ?? 'GET',
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        }
      : undefined,
  })

async function load() {
  loading.value = true
  try {
    const query = new URLSearchParams()
    if (filters.value.q) query.set('q', filters.value.q)
    if (filters.value.scopeKind) query.set('scopeKind', filters.value.scopeKind)
    if (filters.value.status) query.set('status', filters.value.status)
    if (filters.value.kind) query.set('kind', filters.value.kind)
    if (filters.value.includeDeleted) query.set('includeDeleted', '1')
    query.set('limit', String(pageSize))
    query.set('offset', String((page.value - 1) * pageSize))
    const [list, f] = await Promise.all([
      api(`/api/workshop/memory?${query.toString()}`) as Promise<{ items: MemoryItem[], total: number }>,
      api(`/api/workshop/memory?facets=1`) as Promise<{ byScope: Record<string, number>, byStatus: Record<string, number>, deleted: number }>,
    ])
    items.value = list?.items ?? []
    total.value = list?.total ?? 0
    facets.value = f ?? facets.value
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    loading.value = false
  }
}

async function open(id: string) {
  try {
    detail.value = await api(`/api/workshop/memory/${id}?includeDeleted=1`) as MemoryDetail
    drawerOpen.value = true
    editing.value = false
    annotating.value = ''
    rollbackTo.value = null
    deleteReason.value = ''
    curationInfo.value = null
    if (detail.value.kind === 'curated') {
      try {
        curationInfo.value = await api<CurationInfo>(`/api/workshop/memory/curations/${id}`)
      }
      catch { /* 来源/运行历史读取失败不影响正文查看 */ }
    }
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
}

async function openMemoryFromGraph(id: string) {
  view.value = 'list'
  await open(id)
}

const regenerateCuration = () => act(async () => {
  if (!detail.value) return
  await api(`/api/workshop/memory/curations/${detail.value.id}/regenerate`, { method: 'POST', body: {} })
}, t('memoryCenter.curation.regenerated'))

async function act(fn: () => Promise<unknown>, okText?: string) {
  busy.value = true
  try {
    await fn()
    message.success(okText ?? t('memoryCenter.actionDone'))
    await load()
    if (detail.value) await open(detail.value.id)
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    busy.value = false
  }
}

function startEdit() {
  if (!detail.value) return
  editForm.value = { title: detail.value.title, content: detail.value.content, reason: '' }
  editing.value = true
}

const saveEdit = () => act(async () => {
  if (!detail.value) return
  await api(`/api/workshop/memory/${detail.value.id}`, {
    method: 'PATCH',
    body: {
      expectedRevision: detail.value.revision,
      title: editForm.value.title,
      content: editForm.value.content,
      reason: editForm.value.reason,
    },
  })
  editing.value = false
}, t('memoryCenter.saved'))

const addAnnotation = () => act(async () => {
  if (!detail.value) return
  await api(`/api/workshop/memory/${detail.value.id}/annotations`, {
    method: 'POST',
    body: { body: annotating.value },
  })
  annotating.value = ''
}, t('memoryCenter.annotated'))

const togglePin = () => act(async () => {
  if (!detail.value) return
  await api(`/api/workshop/memory/${detail.value.id}/pin`, {
    method: 'POST',
    body: { pinned: !detail.value.pinned },
  })
})

const softDelete = () => act(async () => {
  if (!detail.value) return
  await api(`/api/workshop/memory/${detail.value.id}?reason=${encodeURIComponent(deleteReason.value || t('memoryCenter.defaultDeleteReason'))}`, { method: 'DELETE' })
  drawerOpen.value = false
}, t('memoryCenter.softDeleted'))

const restore = () => act(async () => {
  if (!detail.value) return
  await api(`/api/workshop/memory/${detail.value.id}/restore`, { method: 'POST' })
}, t('memoryCenter.restored'))

const purge = () => act(async () => {
  if (!detail.value) return
  await api(`/api/workshop/memory/${detail.value.id}/purge`, { method: 'POST' })
  drawerOpen.value = false
}, t('memoryCenter.purged'))

const rollback = () => act(async () => {
  if (!detail.value || rollbackTo.value === null) return
  await api(`/api/workshop/memory/${detail.value.id}/rollback`, {
    method: 'POST',
    body: { revision: rollbackTo.value, expectedRevision: detail.value.revision, reason: t('memoryCenter.rollbackReason') },
  })
}, t('memoryCenter.rolledBack'))

const promote = () => act(async () => {
  if (!detail.value) return
  const res = await api(`/api/workshop/memory/${detail.value.id}/promote`, {
    method: 'POST',
    body: { to: 'validated' },
  }) as { ok: boolean, reasons: string[] }
  if (!res.ok) throw new Error(res.reasons.join('；'))
}, t('memoryCenter.promoted'))

const deploy = (target: 'active' | 'withdrawn') => act(async () => {
  if (!detail.value) return
  const res = await api(`/api/workshop/memory/${detail.value.id}/deploy`, {
    method: 'POST',
    body: { target, reason: t('memoryCenter.deployReason') },
  }) as { ok: boolean, reasons: string[] }
  if (!res.ok) throw new Error(res.reasons.join('；'))
}, target === 'active' ? t('memoryCenter.deployed') : t('memoryCenter.withdrawn'))

const reject = () => act(async () => {
  if (!detail.value) return
  if (!rejectReason.value.trim()) return
  await api(`/api/workshop/memory/${detail.value.id}/reject`, {
    method: 'POST',
    body: { reason: rejectReason.value.trim() },
  })
  rejecting.value = false
  rejectReason.value = ''
}, t('memoryCenter.rejected'))

const columns = computed(() => [
  { title: t('memoryCenter.col.title'), dataIndex: 'title', key: 'title', ellipsis: true },
  { title: t('memoryCenter.col.scope'), key: 'scope', width: 130 },
  { title: t('memoryCenter.col.status'), dataIndex: 'status', key: 'status', width: 110 },
  { title: t('memoryCenter.col.author'), key: 'author', width: 110 },
  { title: t('memoryCenter.col.updated'), dataIndex: 'updatedAt', key: 'updatedAt', width: 170 },
  { title: '', key: 'actions', width: 90 },
])

onMounted(load)
</script>

<template>
  <div class="aw-memory-page">
    <header class="head">
      <h1>{{ t('memoryCenter.title') }}</h1>
      <p class="hint">
        {{ t('memoryCenter.subtitle') }}
      </p>
    </header>

    <div class="view-switch">
      <a-segmented
        v-model:value="view"
        data-testid="memory-view-switch"
        :options="[
          { label: t('memoryCenter.views.list'), value: 'list' },
          { label: t('memoryCenter.views.graph'), value: 'graph' },
          { label: t('memoryCenter.views.injections'), value: 'injections' },
          { label: t('memoryCenter.views.health'), value: 'health' },
        ]"
      />
    </div>

    <template v-if="view === 'list'">
      <section class="industry">
        <a-button
          size="small"
          data-testid="memory-industry-toggle"
          @click="toggleIndustry"
        >
          {{ industryOpen ? t('memoryCenter.industry.hide') : t('memoryCenter.industry.show') }}
        </a-button>
        <div
          v-if="industryOpen"
          class="industry-body"
        >
          <a-space wrap>
            <a-select
              v-model:value="industryChannelId"
              :placeholder="t('memoryCenter.industry.selectChannel')"
              style="width: 320px"
            >
              <a-select-option
                v-for="c in industryChannels"
                :key="c.id"
                :value="c.id"
              >
                {{ c.name }} · {{ c.lineId }}
              </a-select-option>
            </a-select>
            <a-button
              size="small"
              :loading="industryLoading"
              @click="loadIndustryData"
            >
              {{ t('memoryCenter.industry.refresh') }}
            </a-button>
            <a-select
              :value="accessScope"
              style="width: 110px"
              data-testid="memory-access-scope"
              @change="onAccessScopeChange"
            >
              <a-select-option value="channel">
                频道
              </a-select-option>
              <a-select-option value="session">
                会话
              </a-select-option>
            </a-select>
            <a-select
              v-if="accessScope === 'session'"
              :value="accessSessionId"
              style="width: 190px"
              data-testid="memory-access-session"
              @change="(v: unknown) => { accessSessionId = String(v); onAccessSessionChange() }"
            >
              <a-select-option
                v-for="s in industrySessions"
                :key="s.id"
                :value="s.id"
              >
                {{ s.title || s.id.slice(0, 8) }}
              </a-select-option>
            </a-select>
            <a-select
              :value="accessMode"
              style="width: 150px"
              data-testid="memory-access-mode"
              @change="(v: unknown) => updateAccessMode(String(v))"
            >
              <a-select-option
                v-for="m in accessModes"
                :key="m"
                :value="m"
              >
                {{ t(`memoryCenter.industry.access.${m}`) }}
              </a-select-option>
            </a-select>
            <span
              v-if="operationCoverage"
              class="mono"
            >
              exact {{ operationCoverage.exact }} / run {{ operationCoverage.run }} / time-window {{ operationCoverage.timeWindow }} / unknown {{ operationCoverage.unknown }} / raw过期 {{ operationCoverage.rawExpired }}
            </span>
          </a-space>
          <a-spin :spinning="industryLoading">
            <a-table
              :columns="operationColumns"
              :data-source="operationRows"
              :pagination="false"
              row-key="id"
              size="small"
              class="mt"
              data-testid="memory-industry-operations"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'ts'">
                  {{ String(record.ts).slice(0, 19).replace('T', ' ') }}
                </template>
                <template v-else-if="column.key === 'node'">
                  {{ record.nodeName || record.nodeId }}
                </template>
                <template v-else-if="column.key === 'change'">
                  {{ record.fromValue ?? '?' }} → {{ record.toValue }}
                </template>
                <template v-else-if="column.key === 'context'">
                  {{ record.productId || '?' }} / {{ record.recipeId || '?' }}@v{{ record.recipeRevision || '?' }} · {{ record.contextSource }}
                </template>
                <template v-else-if="column.key === 'daq'">
                  <span v-if="record.daq">前 {{ record.daq.pre?.mean ?? '?' }} / 后 {{ record.daq.post?.mean ?? '?' }} (n={{ record.daq.sampleCount }}{{ record.daq.rawAvailable ? '' : ', raw过期' }})</span>
                  <span v-else>—</span>
                </template>
              </template>
            </a-table>
            <div
              v-if="operationAttempts.length > 0"
              class="mt"
            >
              <strong>{{ t('memoryCenter.industry.rejected') }}</strong>
              <ul class="notes">
                <li
                  v-for="a in operationAttempts"
                  :key="a.id"
                >
                  <span class="mono">{{ a.state }}</span>
                  {{ a.nodeId }} · 想写值 {{ a.payload.eng ?? '?' }} · {{ a.productId || '?' }}{{ a.runId ? ` · run=${a.runId}` : '' }}
                </li>
              </ul>
            </div>
            <div class="mt">
              <strong>{{ t('memoryCenter.industry.proposals') }}</strong>
              <a-button
                size="small"
                class="mt"
                data-testid="memory-generate-proposals"
                :loading="industryLoading"
                @click="generateProposals"
              >
                {{ t('memoryCenter.industry.generateProposals') }}
              </a-button>
              <ul
                v-if="proposals.length > 0"
                class="notes mt"
              >
                <li
                  v-for="p in proposals"
                  :key="String(p.id)"
                >
                  <span class="mono">{{ p.status }} / {{ p.mode }}</span>
                  {{ p.nodeName || p.nodeId }} {{ p.fromValue ?? '?' }} → {{ p.toValue }} ·
                  期望 {{ Number(p.expectedEffect ?? 0).toPrecision(4) }} · 置信 {{ Math.round(Number(p.confidence ?? 0) * 100) }}%
                </li>
              </ul>
              <p
                v-else
                class="hint"
              >
                {{ t('memoryCenter.industry.empty') }}
              </p>
            </div>
            <div class="mt">
              <strong>{{ t('memoryCenter.fabric.blocks') }}</strong>
              <ul
                v-if="fabricBlocks.length > 0"
                class="notes mt"
              >
                <li
                  v-for="b in fabricBlocks"
                  :key="String(b.id)"
                >
                  <span class="mono">[{{ b.label }}] r{{ b.revision }}{{ b.locked ? ' 🔒' : '' }}</span>
                  {{ String(b.value).slice(0, 160) }}
                  <a-button
                    size="small"
                    type="link"
                    @click="lockBlock(b)"
                  >
                    {{ b.locked ? t('memoryCenter.fabric.unlock') : t('memoryCenter.fabric.lock') }}
                  </a-button>
                </li>
              </ul>
              <p
                v-else
                class="hint"
              >
                {{ t('memoryCenter.industry.empty') }}
              </p>
              <a-space class="mt">
                <a-input
                  v-model:value="newBlockLabel"
                  :placeholder="t('memoryCenter.fabric.blockLabel')"
                  style="width: 180px"
                />
                <a-input
                  v-model:value="newBlockValue"
                  :placeholder="t('memoryCenter.fabric.blockValue')"
                  style="width: 320px"
                  @press-enter="saveBlock"
                />
                <a-button
                  size="small"
                  @click="saveBlock"
                >
                  {{ t('memoryCenter.save') }}
                </a-button>
              </a-space>
            </div>
            <div class="mt">
              <strong>{{ t('memoryCenter.fabric.files') }}</strong>
              <ul
                v-if="fabricFiles.length > 0"
                class="notes mt"
              >
                <li
                  v-for="f in fabricFiles"
                  :key="String(f.id)"
                >
                  <span class="mono">{{ f.path }} ({{ f.size }}B, r{{ f.revision }})</span>
                  <a-button
                    size="small"
                    type="link"
                    @click="viewFile(f)"
                  >
                    {{ t('memoryCenter.open') }}
                  </a-button>
                  <a-button
                    size="small"
                    type="link"
                    danger
                    @click="deleteFile(f)"
                  >
                    {{ t('memoryCenter.softDelete') }}
                  </a-button>
                </li>
              </ul>
              <p
                v-else
                class="hint"
              >
                {{ t('memoryCenter.industry.empty') }}
              </p>
              <a-space class="mt">
                <a-input
                  v-model:value="newFilePath"
                  placeholder="/memories/channel/note.md"
                  style="width: 260px"
                />
                <a-input
                  v-model:value="newFileContent"
                  :placeholder="t('memoryCenter.fabric.fileContent')"
                  style="width: 280px"
                />
                <a-button
                  size="small"
                  @click="saveFile"
                >
                  {{ t('memoryCenter.save') }}
                </a-button>
              </a-space>
              <pre
                v-if="openFile"
                class="handbook mt"
              >{{ openFile.content }}</pre>
            </div>
            <div class="mt">
              <strong>{{ t('memoryCenter.industry.handbook') }}</strong>
              <span
                v-if="handbookStats"
                class="mono"
              >{{ handbookStats.claimCount }} claims / {{ handbookStats.sourceCount }} sources</span>
              <pre class="handbook">{{ handbookMarkdown || t('memoryCenter.industry.empty') }}</pre>
            </div>
          </a-spin>
        </div>
      </section>

      <section class="toolbar">
        <a-input
          v-model:value="filters.q"
          allow-clear
          :placeholder="t('memoryCenter.searchPlaceholder')"
          style="max-width: 260px"
          @press-enter="load"
        />
        <a-select
          v-model:value="filters.scopeKind"
          allow-clear
          :placeholder="t('memoryCenter.col.scope')"
          style="width: 140px"
        >
          <a-select-option
            v-for="s in scopes"
            :key="s"
            :value="s"
          >
            {{ scopeLabel(s) }}（{{ facets.byScope[s] ?? 0 }}）
          </a-select-option>
        </a-select>
        <a-select
          v-model:value="filters.status"
          allow-clear
          :placeholder="t('memoryCenter.col.status')"
          style="width: 130px"
        >
          <a-select-option
            v-for="s in statuses"
            :key="s"
            :value="s"
          >
            {{ s }}（{{ facets.byStatus[s] ?? 0 }}）
          </a-select-option>
        </a-select>
        <a-select
          v-model:value="filters.kind"
          allow-clear
          :placeholder="t('memoryCenter.curation.kind')"
          style="width: 150px"
          @change="load"
        >
          <a-select-option value="semantic">
            {{ t('memoryCenter.curation.semantic') }}
          </a-select-option>
          <a-select-option value="experience">
            {{ t('memoryCenter.curation.experience') }}
          </a-select-option>
          <a-select-option value="curated">
            {{ t('memoryCenter.curation.curated') }}
          </a-select-option>
        </a-select>
        <a-checkbox v-model:checked="filters.includeDeleted">
          {{ t('memoryCenter.includeDeleted') }}（{{ facets.deleted }}）
        </a-checkbox>
        <a-button
          type="primary"
          data-testid="memory-search"
          @click="load"
        >
          {{ t('memoryCenter.search') }}
        </a-button>
      </section>

      <a-table
        :columns="columns"
        :data-source="items"
        :loading="loading"
        row-key="id"
        size="small"
        :pagination="{ current: page, pageSize, total, onChange: (p: number) => { page = p; load() } }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'scope'">
            <a-tag color="blue">
              {{ scopeLabel(record.scopeKind) }}
            </a-tag>
            <span
              v-if="record.scopeKey"
              class="mono"
            >{{ record.scopeKey.slice(0, 10) }}</span>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="record.status === 'validated' ? 'green' : record.status === 'candidate' ? 'gold' : record.status === 'retired' ? 'default' : 'blue'">
              {{ record.status }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'author'">
            <a-tag :color="record.authorKind === 'human' ? 'purple' : 'default'">
              {{ record.authorKind }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'title'">
            <span
              v-if="record.pinned"
              title="pinned"
            >📌</span>
            <a
              class="link"
              @click="open(record.id)"
            >{{ record.title }}</a>
            <a-tag
              v-if="record.deletedAt"
              color="red"
            >
              {{ t('memoryCenter.deleted') }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'updatedAt'">
            <span class="mono">{{ String(record.updatedAt || record.createdAt).slice(0, 16).replace('T', ' ') }}</span>
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-button
              size="small"
              type="link"
              data-testid="memory-open"
              @click="open(record.id)"
            >
              {{ t('memoryCenter.open') }}
            </a-button>
          </template>
        </template>
      </a-table>
    </template>

    <MemoryGraphView
      v-else-if="view === 'graph'"
      :channels="industryChannels"
      :initial-channel-id="industryChannelId"
      @open-memory="openMemoryFromGraph"
    />
    <MemoryInjectionTracePanel
      v-else-if="view === 'injections'"
      :channels="industryChannels"
      :initial-channel-id="industryChannelId"
      @open-memory="openMemoryFromGraph"
    />
    <MemoryHealthPanel
      v-else
      :channels="industryChannels"
      :initial-channel-id="industryChannelId"
    />

    <a-drawer
      v-model:open="drawerOpen"
      :width="620"
      :title="detail?.title ?? t('memoryCenter.detail')"
    >
      <template v-if="detail">
        <a-descriptions
          :column="2"
          size="small"
          bordered
        >
          <a-descriptions-item :label="t('memoryCenter.col.scope')">
            {{ scopeLabel(detail.scopeKind) }} {{ detail.scopeKey }}
          </a-descriptions-item>
          <a-descriptions-item :label="t('memoryCenter.col.status')">
            {{ detail.status }}
          </a-descriptions-item>
          <a-descriptions-item :label="t('memoryCenter.field.kind')">
            {{ detail.kind }}
          </a-descriptions-item>
          <a-descriptions-item :label="t('memoryCenter.field.revision')">
            r{{ detail.revision }}
          </a-descriptions-item>
          <a-descriptions-item :label="t('memoryCenter.field.channel')">
            <span class="mono">{{ detail.channelId }}</span>
          </a-descriptions-item>
          <a-descriptions-item :label="t('memoryCenter.col.author')">
            {{ detail.authorKind }}{{ detail.authorId ? ` / ${detail.authorId.slice(0, 8)}` : '' }}
          </a-descriptions-item>
        </a-descriptions>
        <p
          v-if="detail.effect"
          class="hint mono"
          data-testid="memory-effect"
        >
          {{ t('memoryCenter.effect', { uses: detail.effect.uses, successes: detail.effect.successes, failures: detail.effect.failures }) }}
        </p>

        <div class="block">
          <template v-if="!editing">
            <p class="content">
              {{ detail.content }}
            </p>
            <a-space wrap>
              <a-button
                size="small"
                data-testid="memory-edit"
                :disabled="detail.status === 'validated' || detail.status === 'retired'"
                @click="startEdit"
              >
                {{ t('memoryCenter.edit') }}
              </a-button>
              <a-button
                size="small"
                @click="togglePin"
              >
                {{ detail.pinned ? t('memoryCenter.unpin') : t('memoryCenter.pin') }}
              </a-button>
            </a-space>
          </template>
          <template v-else>
            <a-input
              v-model:value="editForm.title"
              :placeholder="t('memoryCenter.field.title')"
            />
            <a-textarea
              v-model:value="editForm.content"
              :rows="5"
              class="mt"
            />
            <a-input
              v-model:value="editForm.reason"
              :placeholder="t('memoryCenter.field.reason')"
              class="mt"
            />
            <a-space class="mt">
              <a-button
                type="primary"
                size="small"
                data-testid="memory-save"
                :loading="busy"
                @click="saveEdit"
              >
                {{ t('memoryCenter.save') }}
              </a-button>
              <a-button
                size="small"
                @click="editing = false"
              >
                {{ t('memoryCenter.cancel') }}
              </a-button>
            </a-space>
          </template>
        </div>

        <a-divider
          v-if="isCurated"
          orientation="left"
        >
          {{ t('memoryCenter.curation.title') }}
        </a-divider>
        <div v-if="isCurated">
          <a-space wrap>
            <span
              v-if="curationInfo"
              class="mono"
            >{{ curationInfo.sources.length }} {{ t('memoryCenter.curation.sources') }} · {{ curationInfo.runs[0]?.mode || '—' }} · {{ curationInfo.runs[0]?.status || '—' }}</span>
            <a-button
              size="small"
              data-testid="memory-curation-regenerate"
              :loading="busy"
              @click="regenerateCuration"
            >
              {{ t('memoryCenter.curation.regenerate') }}
            </a-button>
          </a-space>
          <ul
            v-if="curationInfo && curationInfo.sources.length > 0"
            class="notes mt"
          >
            <li
              v-for="s in curationInfo.sources.slice(0, 20)"
              :key="s.memoryId"
            >
              <span class="mono">{{ s.kind }}</span>
              {{ s.title }}
            </li>
          </ul>
          <ul
            v-if="curationInfo && curationInfo.runs.length > 0"
            class="notes"
          >
            <li
              v-for="r in curationInfo.runs.slice(0, 5)"
              :key="r.id"
            >
              <span class="mono">{{ r.startedAt.slice(0, 16).replace('T', ' ') }}</span>
              {{ r.status }} · {{ r.mode }} · {{ r.sourceCount }} sources
              <template v-if="r.fallbackReason">
                · {{ r.fallbackReason }}
              </template>
            </li>
          </ul>
        </div>

        <a-divider orientation="left">
          {{ t('memoryCenter.annotations') }}
        </a-divider>
        <a-empty
          v-if="detail.annotations.length === 0"
          :description="t('memoryCenter.noAnnotations')"
        />
        <ul
          v-else
          class="notes"
        >
          <li
            v-for="a in detail.annotations"
            :key="a.id"
          >
            <span class="mono">{{ a.createdAt.slice(0, 16).replace('T', ' ') }}</span>
            <span class="mono">{{ a.authorId.slice(0, 8) }}</span>
            {{ a.body }}
          </li>
        </ul>
        <a-textarea
          v-model:value="annotating"
          :rows="2"
          :placeholder="t('memoryCenter.annotationPlaceholder')"
        />
        <a-button
          size="small"
          class="mt"
          :disabled="!annotating.trim()"
          :loading="busy"
          @click="addAnnotation"
        >
          {{ t('memoryCenter.annotate') }}
        </a-button>

        <a-divider orientation="left">
          {{ t('memoryCenter.revisions') }}
        </a-divider>
        <a-empty
          v-if="detail.revisions.length === 0"
          :description="t('memoryCenter.noRevisions')"
        />
        <ul
          v-else
          class="notes"
        >
          <li
            v-for="r in detail.revisions"
            :key="r.revision"
          >
            <a-button
              size="small"
              type="link"
              @click="rollbackTo = r.revision"
            >
              r{{ r.revision }}
            </a-button>
            <span class="mono">{{ r.createdAt.slice(0, 16).replace('T', ' ') }}</span>
            <span class="mono">{{ r.authorKind }}</span>
            {{ r.reason }}
          </li>
        </ul>
        <a-button
          v-if="rollbackTo !== null"
          size="small"
          type="primary"
          ghost
          :loading="busy"
          @click="rollback"
        >
          {{ t('memoryCenter.rollbackTo', { r: rollbackTo }) }}
        </a-button>

        <a-divider orientation="left">
          {{ t('memoryCenter.governance') }}
        </a-divider>
        <a-space wrap>
          <a-button
            v-if="isExperience && detail.status === 'candidate'"
            size="small"
            type="primary"
            :loading="busy"
            @click="promote"
          >
            {{ t('memoryCenter.promote') }}
          </a-button>
          <a-button
            v-if="isExperience && detail.status === 'validated'"
            size="small"
            :loading="busy"
            @click="deploy('active')"
          >
            {{ t('memoryCenter.deploy') }}
          </a-button>
          <a-button
            v-if="isExperience && detail.status === 'validated'"
            size="small"
            :loading="busy"
            @click="deploy('withdrawn')"
          >
            {{ t('memoryCenter.withdraw') }}
          </a-button>
          <a-button
            v-if="detail.status !== 'retired' && !detail.deletedAt"
            size="small"
            danger
            data-testid="memory-reject"
            :loading="busy"
            @click="rejecting = !rejecting"
          >
            {{ t('memoryCenter.reject') }}
          </a-button>
          <a-popconfirm
            v-if="!detail.deletedAt"
            :title="t('memoryCenter.confirmSoftDelete')"
            @confirm="softDelete"
          >
            <a-input
              v-model:value="deleteReason"
              :placeholder="t('memoryCenter.field.reason')"
              size="small"
              style="width: 180px"
            />
            <a-button
              size="small"
              danger
            >
              {{ t('memoryCenter.softDelete') }}
            </a-button>
          </a-popconfirm>
          <a-button
            v-if="detail.deletedAt"
            size="small"
            :loading="busy"
            @click="restore"
          >
            {{ t('memoryCenter.restore') }}
          </a-button>
          <a-popconfirm
            v-if="detail.deletedAt"
            :title="t('memoryCenter.confirmPurge')"
            @confirm="purge"
          >
            <a-button
              size="small"
              danger
            >
              {{ t('memoryCenter.purge') }}
            </a-button>
          </a-popconfirm>
        </a-space>
        <div
          v-if="rejecting"
          class="block"
        >
          <a-textarea
            v-model:value="rejectReason"
            :rows="2"
            :placeholder="t('memoryCenter.rejectReason')"
          />
          <a-space class="mt">
            <a-button
              type="primary"
              danger
              size="small"
              data-testid="memory-reject-confirm"
              :disabled="!rejectReason.trim()"
              :loading="busy"
              @click="reject"
            >
              {{ t('memoryCenter.reject') }}
            </a-button>
            <a-button
              size="small"
              @click="rejecting = false"
            >
              {{ t('memoryCenter.cancel') }}
            </a-button>
          </a-space>
        </div>
      </template>
    </a-drawer>
  </div>
</template>

<style scoped>
.aw-memory-page { padding: 20px 24px 40px; }
.head h1 { margin: 0; font-size: 20px; }
.view-switch { margin: 0 0 14px; }
.view-switch :deep(.ant-segmented-group) { flex-wrap: wrap; }
.view-switch :deep(.ant-segmented-item) { display: inline-flex; align-items: center; min-height: 36px; }
@media (pointer: coarse) {
  .view-switch :deep(.ant-segmented-item) { min-height: 44px; }
}
@media (max-width: 640px) {
  .view-switch :deep(.ant-segmented) { padding: 4px; }
  .view-switch :deep(.ant-segmented-group) { gap: 4px; }
  .view-switch :deep(.ant-segmented-item) { flex: 1 1 calc(50% - 4px); justify-content: center; }
  /* 换行后 Ant 的单个绝对定位 thumb 会跨行形成大块白底；窄屏改为逐项选中底色。 */
  .view-switch :deep(.ant-segmented-thumb) { display: none; }
  .view-switch :deep(.ant-segmented-item-selected) {
    background: var(--paper-raised);
    border-radius: 6px;
    box-shadow: 0 1px 2px rgb(12 10 9 / 8%);
  }
}
.hint { margin: 4px 0 16px; color: var(--ink-faint); font-size: 13px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.link { cursor: pointer; }
.mono { font-family: var(--font-mono); font-size: 12px; color: var(--ink-faint); margin-left: 6px; }
.block { margin-top: 14px; }
.content { white-space: pre-wrap; line-height: 1.6; }
.mt { margin-top: 8px; }
.notes { list-style: none; padding: 0; margin: 0 0 10px; display: grid; gap: 6px; font-size: 13px; }
.industry { margin: 8px 0 12px; }
.industry-body { margin-top: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
.handbook { max-height: 320px; overflow: auto; background: var(--paper-deep); padding: 10px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; }
.notes li { border-bottom: 1px dashed var(--line); padding-bottom: 6px; }
@media (max-width: 760px) { .aw-memory-page { padding: 12px; } }
</style>
