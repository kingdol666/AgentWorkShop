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
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { apiFetch } from '~/composables/workshop/apiClient'

const { t, locale } = useI18n()
const { isMobile } = useResponsive()
const mounted = ref(false)
const compactList = computed(() => mounted.value && isMobile.value)

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
}

const loading = ref(true)
const listError = ref('')
const busy = ref(false)
let listRequest = 0
let detailRequest = 0
const items = ref<MemoryItem[]>([])
const total = ref(0)
const facets = ref<{ byScope: Record<string, number>, byStatus: Record<string, number>, deleted: number }>({ byScope: {}, byStatus: {}, deleted: 0 })
const filters = ref<{ q: string, scopeKind?: string, status?: string, includeDeleted: boolean }>({ q: '', includeDeleted: false })
const appliedFilters = ref({ ...filters.value })
const page = ref(1)
const pageSize = 20

const detail = ref<MemoryDetail | null>(null)
const drawerOpen = ref(false)

const editing = ref(false)
const editForm = ref({ title: '', content: '', reason: '' })
const annotating = ref('')
const rollbackTo = ref<number | null>(null)
const deleteReason = ref('')

const scopes = ['global', 'line', 'product', 'channel', 'session']
const statuses = ['active', 'candidate', 'validated', 'contested', 'retired']

const scopeLabel = (s: string) => t(`memoryCenter.scope.${s}`)
const isExperience = computed(() => detail.value?.kind === 'experience')

const memoryPath = '/api/workshop/memory'
const api = <T = unknown>(url: string, opts?: { method: string, body?: unknown }) => apiFetch<T>({
  base: url,
  init: opts && { method: opts.method, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
})
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }))

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : dateFormat.value.format(date)
}

async function load(): Promise<void> {
  const request = ++listRequest
  loading.value = true
  listError.value = ''
  try {
    const query = new URLSearchParams()
    const { q, scopeKind, status, includeDeleted } = appliedFilters.value
    if (q.trim()) query.set('q', q.trim())
    if (scopeKind) query.set('scopeKind', scopeKind)
    if (status) query.set('status', status)
    if (includeDeleted) query.set('includeDeleted', '1')
    query.set('limit', String(pageSize))
    query.set('offset', String((page.value - 1) * pageSize))
    const [list, counts] = await Promise.all([
      api<{ items: MemoryItem[], total: number }>(`${memoryPath}?${query}`),
      api<typeof facets.value>(`${memoryPath}?facets=1`),
    ])
    if (request !== listRequest) return
    const lastPage = Math.max(1, Math.ceil(list.total / pageSize))
    if (page.value > lastPage) {
      page.value = lastPage
      return await load()
    }
    items.value = list.items
    total.value = list.total
    facets.value = counts
  }
  catch (err) {
    if (request === listRequest) listError.value = apiErrorMessage(err)
  }
  finally {
    if (request === listRequest) loading.value = false
  }
}

function changePage(next: number) {
  page.value = next
  void load()
}

function search() {
  appliedFilters.value = { ...filters.value }
  changePage(1)
}

function statusColor(status: string) {
  if (status === 'validated') return 'green'
  if (status === 'candidate') return 'gold'
  if (status === 'retired') return 'default'
  return 'blue'
}

async function open(id: string) {
  const request = ++detailRequest
  try {
    const result = await api<MemoryDetail>(`${memoryPath}/${encodeURIComponent(id)}?includeDeleted=1`)
    if (request !== detailRequest) return
    detail.value = result
    drawerOpen.value = true
    editing.value = false
    annotating.value = ''
    rollbackTo.value = null
    deleteReason.value = ''
  }
  catch (err) {
    if (request === detailRequest) message.error(apiErrorMessage(err))
  }
}

async function act(fn: () => Promise<unknown>, okText?: string) {
  if (busy.value) return
  const request = detailRequest
  const id = detail.value?.id
  busy.value = true
  try {
    await fn()
    message.success(okText ?? t('memoryCenter.actionDone'))
    await load()
    if (drawerOpen.value && id && request === detailRequest) await open(id)
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

const columns = computed(() => [
  { title: t('memoryCenter.col.title'), dataIndex: 'title', key: 'title', ellipsis: true },
  { title: t('memoryCenter.col.scope'), key: 'scope', width: 130 },
  { title: t('memoryCenter.col.status'), dataIndex: 'status', key: 'status', width: 110 },
  { title: t('memoryCenter.col.author'), key: 'author', width: 110 },
  { title: t('memoryCenter.col.updated'), dataIndex: 'updatedAt', key: 'updatedAt', width: 170 },
  { title: '', key: 'actions', width: 90 },
])

onMounted(() => {
  mounted.value = true
  void load()
})
</script>

<template>
  <div class="aw-memory-page">
    <header class="aw-page-head memory-head">
      <div>
        <h1>{{ t('memoryCenter.title') }}</h1>
        <p class="hint">
          {{ t('memoryCenter.subtitle') }}
        </p>
      </div>
    </header>

    <section
      class="library"
      :aria-label="t('memoryCenter.title')"
    >
      <form
        class="toolbar"
        role="search"
        @submit.prevent="search"
      >
        <a-input
          v-model:value="filters.q"
          allow-clear
          :aria-label="t('memoryCenter.search')"
          :placeholder="t('memoryCenter.searchPlaceholder')"
          class="search-input"
        />
        <a-select
          v-model:value="filters.scopeKind"
          allow-clear
          :aria-label="t('memoryCenter.col.scope')"
          :placeholder="t('memoryCenter.col.scope')"
          class="filter-input"
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
          :aria-label="t('memoryCenter.col.status')"
          :placeholder="t('memoryCenter.col.status')"
          class="filter-input"
        >
          <a-select-option
            v-for="s in statuses"
            :key="s"
            :value="s"
          >
            {{ s }}（{{ facets.byStatus[s] ?? 0 }}）
          </a-select-option>
        </a-select>
        <a-checkbox v-model:checked="filters.includeDeleted">
          {{ t('memoryCenter.includeDeleted') }}（{{ facets.deleted }}）
        </a-checkbox>
        <a-button
          type="primary"
          html-type="submit"
          data-testid="memory-search"
          :loading="loading"
        >
          {{ t('memoryCenter.search') }}
        </a-button>
      </form>

      <div
        v-if="!loading && !listError"
        class="result-bar"
        role="status"
      >
        {{ t('memoryCenter.results', { count: total }) }}
      </div>
      <AwStateBlock
        v-if="listError"
        state="error"
        :hint="listError"
        :retry="load"
      />
      <AwStateBlock
        v-if="loading && !items.length"
        state="loading"
      />
      <AwStateBlock
        v-else-if="!listError && !items.length"
        state="empty"
        :title="t('memoryCenter.noMatches')"
      />

      <template v-if="compactList && items.length">
        <ul
          class="memory-list"
          :aria-busy="loading"
        >
          <li
            v-for="record in items"
            :key="record.id"
          >
            <button
              class="record-link memory-list-link"
              type="button"
              @click="open(record.id)"
            >
              <span class="memory-list-title">
                <span
                  v-if="record.pinned"
                  class="i-tabler-pin"
                  role="img"
                  :aria-label="t('memoryCenter.pin')"
                />
                {{ record.title }}
              </span>
              <span
                class="i-tabler-chevron-right"
                aria-hidden="true"
              />
            </button>
            <div class="memory-list-meta">
              <a-tag color="blue">
                {{ scopeLabel(record.scopeKind) }}
              </a-tag>
              <a-tag :color="statusColor(record.status)">
                {{ record.status }}
              </a-tag>
              <a-tag
                v-if="record.deletedAt"
                color="red"
              >
                {{ t('memoryCenter.deleted') }}
              </a-tag>
              <time
                class="mono"
                :datetime="record.updatedAt || record.createdAt"
              >{{ formatDate(record.updatedAt || record.createdAt) }}</time>
            </div>
          </li>
        </ul>
        <a-pagination
          v-if="total > pageSize"
          class="memory-list-pagination"
          size="small"
          :current="page"
          :page-size="pageSize"
          :total="total"
          :show-size-changer="false"
          :disabled="loading"
          @change="changePage"
        />
      </template>
      <a-table
        v-else-if="items.length"
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :scroll="{ x: 720 }"
        row-key="id"
        size="middle"
        :pagination="{ current: page, pageSize, total, showSizeChanger: false, onChange: changePage }"
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
            <a-tag :color="statusColor(record.status)">
              {{ record.status }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'author'">
            <a-tag :color="record.authorKind === 'human' ? 'purple' : 'default'">
              {{ record.authorKind }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'title'">
            <button
              class="record-link"
              type="button"
              @click="open(record.id)"
            >
              <span
                v-if="record.pinned"
                class="i-tabler-pin"
                :title="t('memoryCenter.pin')"
                :aria-label="t('memoryCenter.pin')"
                role="img"
              />
              {{ record.title }}
            </button>
            <a-tag
              v-if="record.deletedAt"
              color="red"
            >
              {{ t('memoryCenter.deleted') }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'updatedAt'">
            <time
              class="mono"
              :datetime="record.updatedAt || record.createdAt"
            >{{ formatDate(record.updatedAt || record.createdAt) }}</time>
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
    </section>

    <a-drawer
      v-model:open="drawerOpen"
      width="min(100vw, 620px)"
      :title="detail?.title ?? t('memoryCenter.detail')"
      @close="detailRequest++"
    >
      <template v-if="detail">
        <a-descriptions
          :column="compactList ? 1 : 2"
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
          <a-input
            v-if="!detail.deletedAt"
            v-model:value="deleteReason"
            :aria-label="t('memoryCenter.field.reason')"
            :placeholder="t('memoryCenter.field.reason')"
            size="small"
            class="delete-reason"
          />
          <ConfirmPopover
            v-if="!detail.deletedAt"
            :title="t('memoryCenter.confirmSoftDelete')"
            :ok-text="t('memoryCenter.softDelete')"
            :disabled="busy"
            @confirm="softDelete"
          >
            <a-button
              size="small"
              danger
              :disabled="busy"
            >
              {{ t('memoryCenter.softDelete') }}
            </a-button>
          </ConfirmPopover>
          <a-button
            v-if="detail.deletedAt"
            size="small"
            :loading="busy"
            @click="restore"
          >
            {{ t('memoryCenter.restore') }}
          </a-button>
          <ConfirmPopover
            v-if="detail.deletedAt"
            :title="t('memoryCenter.confirmPurge')"
            :ok-text="t('memoryCenter.purge')"
            :disabled="busy"
            @confirm="purge"
          >
            <a-button
              size="small"
              danger
              :disabled="busy"
            >
              {{ t('memoryCenter.purge') }}
            </a-button>
          </ConfirmPopover>
        </a-space>
      </template>
    </a-drawer>
  </div>
</template>

<style scoped>
.aw-memory-page { min-width: 0; padding-bottom: 32px; }
.memory-head { align-items: flex-start; }
.hint { max-width: 70ch; margin: 6px 0 0; color: var(--ink-soft); font-size: 14px; line-height: 1.6; }
.library { overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--paper-raised); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 16px; }
.search-input { flex: 1 1 240px; min-width: 0; }
.filter-input { flex: 0 1 148px; min-width: 112px; }
.result-bar { padding: 4px 16px 12px; color: var(--ink-soft); font-size: 13px; font-variant-numeric: tabular-nums; }
.library :deep(.aw-state-skeleton) { margin-inline: 16px; }
.library :deep(.ant-pagination) { padding-inline: 16px; }
.record-link {
  max-width: 100%;
  border: 0;
  padding: 3px 0;
  color: var(--ink);
  background: transparent;
  font-weight: 600;
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.record-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.memory-list { margin: 0; padding: 0; list-style: none; }
.memory-list > li { padding: 6px 12px 13px; border-top: 1px solid var(--line); }
.memory-list-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 44px;
  padding-block: 8px;
  line-height: 1.4;
}
.memory-list-title { min-width: 0; }
.memory-list-link > .i-tabler-chevron-right { flex: none; color: var(--ink-soft); }
.memory-list-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.memory-list-meta :deep(.ant-tag) { margin-inline-end: 0; }
.memory-list-pagination { margin-block: 12px; }
.mono { font-size: 12px; color: var(--ink-faint); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.block { margin-top: 18px; }
.content { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.mt { margin-top: 8px; }
.delete-reason { width: min(180px, 100%); }
.notes { list-style: none; padding: 0; margin: 0 0 10px; display: grid; gap: 8px; font-size: 14px; }
.notes li { border-bottom: 1px solid var(--line); padding-bottom: 8px; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .toolbar { gap: 10px; padding: 12px; }
  .search-input { flex-basis: 100%; }
  .filter-input { flex: 1 1 120px; }
}
</style>
