<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { ApiError, apiFetch } from '@/app/composables/workshop/apiClient'
import { useUserStore } from '@/app/stores/workshop/user'

defineProps<{ activeTab: string }>()

const { t } = useI18n()
const userStore = useUserStore()
const prefabApi = '/api/workshop/agent-prefabs'
const channelApi = '/api/workshop/channels'

interface Slot { key: string, label: string, description?: string, defaultValue?: string, required?: boolean, allowMemberOverride?: boolean, maxLength?: number }
interface Capability { kind: 'tool' | 'plugin-tool' | 'skill' | 'mcp-tool', id: string, version?: string, required?: boolean, label?: string }
interface CatalogEntry { kind: Capability['kind'], id: string, label?: string, enabled: boolean, reviewStatus?: 'approved' | 'pending' | 'rejected', key?: string }
interface Draft {
  name: string
  description: string
  visibility: 'private' | 'public'
  prompt: { role: string, scenario: string, slots: Slot[] }
  profile: { provider?: string, model?: string, effort?: string, settings?: Record<string, string | number | boolean> }
  capabilities: Capability[]
}
interface PrefabRow {
  id: string
  name: string
  visibility: Draft['visibility']
  ownerUserId: string | null
  canEdit: boolean
  archivedAt: string | null
  headRevision: number
  updatedAt: string
  draft: Draft
}
interface Channel { id: string, name: string, ownerUserId: string | null, permissions: { canManage: boolean } | null }
interface Member {
  id: string
  name: string
  role: string
  prefabBindingVersion: string | null
  prefabBinding: { prefabId: string, revision: number, contentHash: string } | null
}

type EditorMode = 'view' | 'edit' | 'new'

const prefabs = ref<PrefabRow[]>([])
const selected = ref<PrefabRow | null>(null)
const editorMode = ref<EditorMode | null>(null)
const editorHeading = ref<HTMLElement | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const conflict = ref(false)
const catalog = ref<CatalogEntry[]>([])

function formFromDraft(draft?: Draft) {
  return {
    name: draft?.name ?? '',
    description: draft?.description ?? '',
    visibility: draft?.visibility ?? 'private' as Draft['visibility'],
    role: draft?.prompt.role ?? '',
    scenario: draft?.prompt.scenario ?? '',
    slots: (draft?.prompt.slots ?? []).map(s => ({ ...s })),
    provider: draft?.profile.provider ?? '',
    model: draft?.profile.model ?? '',
    effort: draft?.profile.effort ?? '',
    settingsJson: JSON.stringify(draft?.profile.settings ?? {}, null, 2),
    capabilities: (draft?.capabilities ?? []).map(c => ({ ...c })),
  }
}
const form = reactive(formFromDraft())
const baseline = ref('')
const editableForm = computed(() => (editorMode.value === 'new' && userStore.isLoggedIn)
  || (editorMode.value === 'edit' && selected.value && canEditRow(selected.value)))
const dirty = computed(() => Boolean(editableForm.value && baseline.value !== JSON.stringify(form)))
const formDisabled = computed(() => !editableForm.value || busy.value || loading.value)
const canSave = computed(() => !formDisabled.value && !conflict.value && dirty.value && !!form.name.trim())
const canPublish = computed(() => editorMode.value === 'edit' && !formDisabled.value && !dirty.value && !conflict.value)

function canEditRow(row: PrefabRow): boolean {
  return userStore.isLoggedIn && row.canEdit === true && !row.archivedAt
}

function applyEditor(row: PrefabRow | null, mode: EditorMode | null): void {
  selected.value = row
  editorMode.value = row && mode === 'edit' && !canEditRow(row) ? 'view' : mode
  Object.assign(form, formFromDraft(row?.draft))
  baseline.value = JSON.stringify(form)
}

function confirmDiscard(action: () => void): void {
  if (!dirty.value) {
    action()
    return
  }
  Modal.confirm({
    title: t('settings.prefabs.discardTitle'),
    content: t('settings.prefabs.discardDescription'),
    okText: t('settings.prefabs.discard'),
    okType: 'danger',
    cancelText: t('common.cancel'),
    onOk: action,
  })
}

function openEditor(row: PrefabRow | null, mode: EditorMode): void {
  if (busy.value || loading.value || (selected.value?.id === row?.id && editorMode.value === mode)) return
  confirmDiscard(() => {
    applyEditor(row, mode)
    void nextTick(() => editorHeading.value?.focus())
  })
}

function buildDraft(): Draft {
  let settings: Draft['profile']['settings']
  try {
    const parsed: unknown = JSON.parse(form.settingsJson || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.values(parsed).some(value => !['string', 'number', 'boolean'].includes(typeof value))) {
      throw new Error('settings shape')
    }
    settings = Object.keys(parsed).length ? parsed as NonNullable<typeof settings> : undefined
  }
  catch {
    throw new Error(t('settings.prefabs.jsonInvalid'))
  }
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    visibility: form.visibility,
    prompt: { role: form.role, scenario: form.scenario, slots: form.slots },
    profile: {
      ...(form.provider ? { provider: form.provider } : {}),
      ...(form.model ? { model: form.model } : {}),
      ...(form.effort ? { effort: form.effort } : {}),
      ...(settings ? { settings } : {}),
    },
    capabilities: form.capabilities,
  }
}

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return t('settings.prefabs.permissionDenied')
  return err instanceof Error ? err.message : String(err)
}

function reportWriteError(err: unknown): void {
  if (err instanceof ApiError && (err.status === 409 || err.status === 404 || err.status === 403)) {
    conflict.value = true
    error.value = err.status === 403 ? errorText(err) : t('settings.prefabs.conflict')
  }
  else error.value = errorText(err)
}

async function load(preserveEditor = false): Promise<void> {
  loading.value = true
  try {
    const res = await apiFetch<{ prefabs: PrefabRow[] }>({ base: prefabApi })
    prefabs.value = res.prefabs ?? []
    if (selected.value && !preserveEditor) {
      const fresh = prefabs.value.find(p => p.id === selected.value?.id)
      applyEditor(fresh ?? null, fresh ? editorMode.value : null)
    }
    if (!preserveEditor || !conflict.value) error.value = ''
    if (!preserveEditor) conflict.value = false
  }
  catch (err) {
    error.value = errorText(err)
  }
  finally {
    loading.value = false
  }
}

function refreshPrefabs(): void {
  if (busy.value || loading.value) return
  if (!selected.value) void load()
  else confirmDiscard(() => {
    void load()
  })
}

function upsertRow(row: PrefabRow): void {
  const index = prefabs.value.findIndex(p => p.id === row.id)
  if (index === -1) prefabs.value.unshift(row)
  else prefabs.value.splice(index, 1, row)
}

async function saveDraft(): Promise<void> {
  if (!canSave.value) return
  const original = selected.value
  busy.value = true
  error.value = ''
  try {
    const draft = buildDraft()
    const row = await apiFetch<PrefabRow>({
      base: prefabApi,
      path: original ? `/${encodeURIComponent(original.id)}` : undefined,
      init: original
        ? { method: 'PATCH', body: JSON.stringify({ expectedUpdatedAt: original.updatedAt, draft }) }
        : { method: 'POST', body: JSON.stringify({ draft }) },
    })
    upsertRow(row)
    applyEditor(row, 'edit')
    message.success(t(original ? 'settings.prefabs.saved' : 'settings.prefabs.created'))
  }
  catch (err) {
    reportWriteError(err)
  }
  finally {
    busy.value = false
  }
}

function publish(): void {
  const row = selected.value
  if (!row || !canPublish.value) return
  Modal.confirm({
    title: t('settings.prefabs.publishConfirm'),
    content: t('settings.prefabs.publishTarget', { name: row.name, revision: row.headRevision + 1 }),
    okText: t('settings.prefabs.publish'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      if (!canPublish.value || selected.value !== row) return
      busy.value = true
      error.value = ''
      try {
        const rev = await apiFetch<{ revision: number, contentHash: string }>({
          base: prefabApi,
          path: `/${encodeURIComponent(row.id)}/publish`,
          init: { method: 'POST', body: JSON.stringify({ expectedHead: row.headRevision, expectedUpdatedAt: row.updatedAt }) },
        })
        message.success(t('settings.prefabs.published', { p0: rev.revision, p1: rev.contentHash.slice(0, 12) }))
        conflict.value = true // A failed reload must not leave the old write token actionable.
        await load()
      }
      catch (err) {
        reportWriteError(err)
      }
      finally {
        busy.value = false
      }
    },
  })
}

function removePrefab(row: PrefabRow): void {
  if (!canEditRow(row) || busy.value || loading.value || conflict.value) return
  const archive = row.headRevision > 0
  Modal.confirm({
    title: t(archive ? 'settings.prefabs.archiveTitle' : 'settings.prefabs.deleteTitle', { name: row.name }),
    content: t(archive ? 'settings.prefabs.archiveDescription' : 'settings.prefabs.deleteDescription'),
    okText: t(archive ? 'settings.prefabs.archive' : 'common.delete'),
    okType: 'danger',
    cancelText: t('common.cancel'),
    onOk: async () => {
      if (!canEditRow(row) || busy.value || loading.value || conflict.value) return
      busy.value = true
      error.value = ''
      try {
        const result = await apiFetch<{ id: string, archived: boolean }>({
          base: prefabApi,
          path: `/${encodeURIComponent(row.id)}`,
          init: { method: 'DELETE', body: JSON.stringify({ expectedUpdatedAt: row.updatedAt }) },
        })
        prefabs.value = prefabs.value.filter(p => p.id !== result.id)
        if (selected.value?.id === result.id) applyEditor(null, null)
        message.success(t(result.archived ? 'settings.prefabs.archivedDone' : 'settings.prefabs.deleted'))
        // Do not overwrite an unrelated in-progress edit.
        if (result.archived) await load(dirty.value)
      }
      catch (err) {
        reportWriteError(err)
      }
      finally {
        busy.value = false
      }
    },
  })
}

const channels = ref<Channel[]>([])
const members = ref<Member[]>([])
const bindChannelId = ref<string>()
const bindMemberId = ref<string>()
const bindPrefabId = ref<string>()
const bindRevision = ref<number>()
const bindSlots = ref<Record<string, string>>(Object.create(null))
const bindDraft = ref<{ prefabId: string, revision: number, draft: Draft } | null>(null)
const bindingError = ref('')
const revisionError = ref('')
const channelsLoading = ref(false)
const membersLoading = ref(false)
const revisionLoading = ref(false)
const bindingBusy = ref(false)
let membersRequest = 0
let revisionRequest = 0

const bindMember = computed(() => members.value.find(member => member.id === bindMemberId.value))
const hasBinding = computed(() => !!(bindMember.value?.prefabBindingVersion || bindMember.value?.prefabBinding))
const canChooseBinding = computed(() => bindMember.value?.prefabBindingVersion === null && !hasBinding.value
  && !channelsLoading.value && !membersLoading.value && !bindingBusy.value)
const boundPrefab = computed(() => prefabs.value.find(p => p.id === bindMember.value?.prefabBinding?.prefabId))
const bindablePrefabs = computed(() => prefabs.value.filter(p => !p.archivedAt && p.headRevision > 0))
const bindTarget = computed(() => bindablePrefabs.value.find(p => p.id === bindPrefabId.value))
const revisionOptions = computed(() => Array.from({ length: bindTarget.value?.headRevision ?? 0 }, (_, i) => {
  const revision = (bindTarget.value?.headRevision ?? 0) - i
  return { value: revision, label: String(revision) }
}))
const activeBindDraft = computed(() => bindTarget.value && bindDraft.value?.prefabId === bindTarget.value.id
  && bindDraft.value.revision === bindRevision.value
  ? bindDraft.value.draft
  : null)
const missingBindSlot = computed(() => activeBindDraft.value?.prompt.slots.find(slot => slot.required
  && !slotValue(slot).trim()))
const canBind = computed(() => canChooseBinding.value && !revisionLoading.value && !!activeBindDraft.value && !missingBindSlot.value)
const canUnbind = computed(() => !channelsLoading.value && !membersLoading.value && !bindingBusy.value && !!bindMember.value?.prefabBindingVersion)

function slotValue(slot: Slot): string {
  return (slot.allowMemberOverride !== false ? bindSlots.value[slot.key] : undefined) ?? slot.defaultValue ?? ''
}

async function loadChannels(): Promise<void> {
  channelsLoading.value = true
  try {
    const res = await apiFetch<Channel[]>({ base: channelApi })
    channels.value = res.filter(c => c.ownerUserId && c.permissions?.canManage)
  }
  catch (err) {
    channels.value = []
    bindingError.value = errorText(err)
  }
  finally {
    channelsLoading.value = false
  }
}

async function refreshBinding(): Promise<void> {
  if (channelsLoading.value || membersLoading.value || bindingBusy.value) return
  bindingError.value = ''
  await loadChannels()
  if (!channels.value.some(channel => channel.id === bindChannelId.value)) {
    bindChannelId.value = undefined
    bindMemberId.value = undefined
  }
  await loadMembers(true)
}

watch(bindTarget, (target, previous) => {
  if (!target && previous && bindPrefabId.value) clearBindingTarget()
})

function clearRevision(): void {
  revisionRequest++
  bindDraft.value = null
  bindSlots.value = Object.create(null)
  revisionError.value = ''
  revisionLoading.value = false
}

function clearBindingTarget(): void {
  bindPrefabId.value = undefined
  bindRevision.value = undefined
  clearRevision()
}

async function loadMembers(keepError = false): Promise<void> {
  const request = ++membersRequest
  const channelId = bindChannelId.value
  members.value = []
  clearBindingTarget()
  if (!keepError) bindingError.value = ''
  membersLoading.value = !!channelId
  if (!channelId) return
  try {
    const res = await apiFetch<Member[]>({ base: channelApi, path: `/${encodeURIComponent(channelId)}/agents` })
    if (request !== membersRequest) return
    members.value = res
    if (!res.some(m => m.id === bindMemberId.value)) bindMemberId.value = undefined
  }
  catch (err) {
    if (request === membersRequest && (!keepError || !bindingError.value)) bindingError.value = errorText(err)
  }
  finally {
    if (request === membersRequest) membersLoading.value = false
  }
}

function onChannelChange(): void {
  bindMemberId.value = undefined
  void loadMembers()
}

function onMemberChange(): void {
  bindingError.value = ''
  clearBindingTarget()
}

function onBindPrefabChange(): void {
  bindRevision.value = bindTarget.value?.headRevision
  void loadBindRevision()
}

async function loadBindRevision(): Promise<void> {
  clearRevision()
  const request = revisionRequest
  const target = bindTarget.value
  const revision = bindRevision.value
  if (!target || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || revision > target.headRevision) return
  revisionLoading.value = true
  try {
    const res = await apiFetch<{ draft: Draft }>({
      base: prefabApi,
      path: `/${encodeURIComponent(target.id)}/revisions/${revision}`,
    })
    if (request === revisionRequest) bindDraft.value = { prefabId: target.id, revision, draft: res.draft }
  }
  catch (err) {
    if (request === revisionRequest) revisionError.value = errorText(err)
  }
  finally {
    if (request === revisionRequest) revisionLoading.value = false
  }
}

async function writeBinding(channelId: string, memberId: string, body: object, clear: boolean): Promise<void> {
  bindingBusy.value = true
  bindingError.value = ''
  try {
    await apiFetch({
      base: channelApi,
      path: `/${encodeURIComponent(channelId)}/agents/${encodeURIComponent(memberId)}/prefab`,
      init: { method: 'PATCH', body: JSON.stringify(body) },
    })
    message.success(t(clear ? 'settings.prefabs.unbound' : 'settings.prefabs.bound'))
    await loadMembers()
  }
  catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      if (err.code === 'PREFAB_ARCHIVED') {
        bindingError.value = t('settings.prefabs.bindingPrefabArchived')
        clearBindingTarget()
        if (!busy.value && !loading.value) await load(true)
      }
      else if (err.code === 'PREFAB_ALREADY_BOUND' || err.code === 'PREFAB_BINDING_CHANGED') {
        bindingError.value = t(err.code === 'PREFAB_ALREADY_BOUND' ? 'settings.prefabs.alreadyBound' : 'settings.prefabs.bindingChanged')
        await loadMembers(true)
      }
      else bindingError.value = errorText(err)
    }
    else bindingError.value = errorText(err)
  }
  finally {
    bindingBusy.value = false
  }
}

async function bind(): Promise<void> {
  const target = bindDraft.value
  if (!canBind.value || !target || !bindChannelId.value || !bindMember.value) return
  const slotValues = Object.fromEntries(target.draft.prompt.slots
    .filter(slot => slot.allowMemberOverride !== false && Object.hasOwn(bindSlots.value, slot.key))
    .map(slot => [slot.key, bindSlots.value[slot.key]]))
  await writeBinding(bindChannelId.value, bindMember.value.id, { prefabId: target.prefabId, revision: target.revision, slotValues }, false)
}

function unbind(): void {
  const channelId = bindChannelId.value
  const member = bindMember.value
  const expectedBindingVersion = member?.prefabBindingVersion
  if (!canUnbind.value || !channelId || !member || !expectedBindingVersion) return
  Modal.confirm({
    title: t('settings.prefabs.unbindTitle', { name: member.name }),
    content: t('settings.prefabs.unbindDescription'),
    okText: t('settings.prefabs.unbind'),
    okType: 'danger',
    cancelText: t('common.cancel'),
    onOk: () => {
      if (!canUnbind.value || bindChannelId.value !== channelId || bindMember.value?.id !== member.id
        || bindMember.value.prefabBindingVersion !== expectedBindingVersion) return
      return writeBinding(channelId, member.id, { clear: true, expectedBindingVersion }, true)
    },
  })
}

async function loadCatalog(): Promise<void> {
  try {
    const res = await apiFetch<{ entries: CatalogEntry[] }>({ base: '/api/workshop/agent-prefabs/catalog' })
    catalog.value = (res.entries ?? []).map(entry => ({ ...entry, key: `${entry.kind}:${entry.id}` }))
  }
  catch {
    catalog.value = []
  }
}

const displayedCapabilities = computed(() => [
  ...catalog.value,
  ...form.capabilities
    .filter(cap => !catalog.value.some(entry => entry.kind === cap.kind && entry.id === cap.id))
    .map(cap => ({ ...cap, enabled: false, key: `${cap.kind}:${cap.id}` })),
].filter(entry => editorMode.value !== 'view' || capSelected(entry.kind, entry.id)))

function capSelected(kind: Capability['kind'], id: string): boolean {
  return form.capabilities.some(c => c.kind === kind && c.id === id)
}

function capRequired(kind: Capability['kind'], id: string): boolean {
  return form.capabilities.find(c => c.kind === kind && c.id === id)?.required === true
}

function toggleCap(entry: CatalogEntry, checked: boolean): void {
  if (formDisabled.value) return
  if (checked) {
    if (!capSelected(entry.kind, entry.id)) form.capabilities.push({ kind: entry.kind, id: entry.id, required: false })
  }
  else {
    form.capabilities = form.capabilities.filter(c => !(c.kind === entry.kind && c.id === entry.id))
  }
}

function setCapRequired(entry: CatalogEntry, checked: boolean): void {
  if (formDisabled.value) return
  const item = form.capabilities.find(c => c.kind === entry.kind && c.id === entry.id)
  if (item) item.required = checked
}

const slotRowKeys = new WeakMap<Slot, number>()
let nextSlotRowKey = 0
function slotRowKey(slot: Slot): number {
  const key = slotRowKeys.get(slot) ?? nextSlotRowKey++
  slotRowKeys.set(slot, key)
  return key
}

function addSlot(): void {
  let index = 1
  while (form.slots.some(slot => slot.key === `slot${index}`)) index++
  form.slots.push({ key: `slot${index}`, label: '', defaultValue: '', allowMemberOverride: true, maxLength: 4000 })
}

onMounted(async () => {
  await Promise.all([load(), loadChannels(), loadCatalog()])
})
</script>

<template>
  <div v-show="activeTab === 'prefabs'">
    <h3 class="section-title">
      {{ t('settings.prefabsTab') }}
    </h3>
    <p class="section-desc">
      {{ t('settings.prefabs.desc') }}
    </p>

    <a-alert
      v-if="error"
      type="error"
      show-icon
      :message="error"
      class="pf-notice"
    />
    <div class="pf-toolbar">
      <a-button
        :loading="loading"
        :disabled="busy"
        @click="refreshPrefabs"
      >
        {{ t('settings.prefabs.refresh') }}
      </a-button>
      <a-button
        v-if="userStore.isLoggedIn"
        type="primary"
        :disabled="busy || loading"
        @click="openEditor(null, 'new')"
      >
        {{ t('settings.prefabs.create') }}
      </a-button>
    </div>

    <div
      class="pf-table-scroll"
      role="region"
      :aria-label="t('settings.prefabsTab')"
      tabindex="0"
    >
      <a-table
        :data-source="prefabs"
        :loading="loading"
        :pagination="false"
        row-key="id"
        size="small"
        :locale="{ emptyText: t('settings.prefabs.empty') }"
      >
        <a-table-column :title="t('settings.prefabs.name')">
          <template #default="{ record }">
            <strong>{{ record.name }}</strong>
            <div class="pf-meta">
              {{ t(record.ownerUserId === userStore.user?.id ? 'settings.prefabs.ownedByYou' : 'settings.prefabs.otherOwner') }}
              <template v-if="!canEditRow(record)">
                · {{ t('settings.prefabs.readOnly') }}
              </template>
            </div>
          </template>
        </a-table-column>
        <a-table-column :title="t('settings.prefabs.visibility')">
          <template #default="{ record }">
            {{ t(record.visibility === 'public' ? 'settings.prefabs.public' : 'settings.prefabs.private') }}
          </template>
        </a-table-column>
        <a-table-column :title="t('settings.prefabs.revision')">
          <template #default="{ record }">
            <a-tag
              v-if="record.archivedAt"
              :title="t('settings.prefabs.archivedOn', { date: record.archivedAt })"
            >
              {{ t('settings.prefabs.archived') }}
            </a-tag>
            {{ record.headRevision || t('settings.prefabs.draftOnly') }}
          </template>
        </a-table-column>
        <a-table-column
          :title="t('settings.prefabs.updatedAt')"
          data-index="updatedAt"
        />
        <a-table-column :title="t('settings.skills.actions')">
          <template #default="{ record }">
            <div class="pf-row-actions">
              <a-button
                size="small"
                :aria-label="t('settings.prefabs.viewNamed', { name: record.name })"
                :disabled="busy || loading"
                @click="openEditor(record, 'view')"
              >
                {{ t('settings.prefabs.view') }}
              </a-button>
              <template v-if="canEditRow(record)">
                <a-button
                  size="small"
                  :aria-label="t('settings.prefabs.editNamed', { name: record.name })"
                  :disabled="busy || loading"
                  @click="openEditor(record, 'edit')"
                >
                  {{ t('settings.prefabs.edit') }}
                </a-button>
                <a-button
                  size="small"
                  danger
                  :aria-label="t(record.headRevision ? 'settings.prefabs.archiveTitle' : 'settings.prefabs.deleteTitle', { name: record.name })"
                  :disabled="busy || loading || conflict"
                  @click="removePrefab(record)"
                >
                  {{ t(record.headRevision ? 'settings.prefabs.archive' : 'common.delete') }}
                </a-button>
              </template>
            </div>
          </template>
        </a-table-column>
      </a-table>
    </div>

    <a-card
      v-if="editorMode"
      size="small"
      class="pf-card"
    >
      <template #title>
        <h4
          ref="editorHeading"
          class="pf-editor-heading"
          tabindex="-1"
        >
          {{ t(editorMode === 'new' ? 'settings.prefabs.create' : editorMode === 'edit' ? 'settings.prefabs.editNamed' : 'settings.prefabs.viewNamed', { name: selected?.name }) }}
        </h4>
      </template>
      <div class="pf-grid">
        <label class="pf-field">
          <span>{{ t('settings.prefabs.name') }}</span>
          <a-input
            id="pf-name"
            v-model:value="form.name"
            :readonly="formDisabled"
            :maxlength="80"
            :aria-required="editableForm"
          />
        </label>
        <label class="pf-field">
          <span>{{ t('settings.prefabs.description') }}</span>
          <a-input
            v-model:value="form.description"
            :readonly="formDisabled"
            :maxlength="2000"
          />
        </label>
        <div class="pf-field">
          <span>{{ t('settings.prefabs.visibility') }}</span>
          <a-select
            v-model:value="form.visibility"
            :disabled="formDisabled"
            :aria-label="t('settings.prefabs.visibility')"
            :options="[
              { value: 'private', label: t('settings.prefabs.private') },
              { value: 'public', label: t('settings.prefabs.public') },
            ]"
          />
        </div>
      </div>
      <label class="pf-field pf-block">
        <span>{{ t('settings.prefabs.rolePrompt') }}</span>
        <a-textarea
          v-model:value="form.role"
          :rows="3"
          :readonly="formDisabled"
        />
      </label>
      <label class="pf-field pf-block">
        <span>{{ t('settings.prefabs.scenarioPrompt') }}</span>
        <a-textarea
          v-model:value="form.scenario"
          :rows="3"
          :readonly="formDisabled"
        />
      </label>

      <h4 class="pf-subtitle">
        {{ t('settings.prefabs.slots') }}
      </h4>
      <div
        class="pf-table-scroll"
        role="region"
        :aria-label="t('settings.prefabs.slots')"
        tabindex="0"
      >
        <a-table
          :data-source="form.slots"
          :pagination="false"
          :row-key="slotRowKey"
          size="small"
        >
          <a-table-column
            :title="t('settings.prefabs.slotKey')"
            width="120px"
          >
            <template #default="{ record }">
              <a-input
                v-model:value="record.key"
                :readonly="formDisabled"
                :aria-label="t('settings.prefabs.slotKey')"
                size="small"
              />
            </template>
          </a-table-column>
          <a-table-column :title="t('settings.prefabs.slotLabel')">
            <template #default="{ record }">
              <a-input
                v-model:value="record.label"
                :readonly="formDisabled"
                :aria-label="t('settings.prefabs.slotLabel')"
                size="small"
              />
            </template>
          </a-table-column>
          <a-table-column :title="t('settings.prefabs.slotDefault')">
            <template #default="{ record }">
              <a-input
                v-model:value="record.defaultValue"
                :readonly="formDisabled"
                :aria-label="t('settings.prefabs.slotDefault')"
                size="small"
              />
            </template>
          </a-table-column>
          <a-table-column
            :title="t('settings.prefabs.slotRequired')"
            width="80px"
          >
            <template #default="{ record }">
              <a-checkbox
                v-model:checked="record.required"
                :disabled="formDisabled"
                :aria-label="t('settings.prefabs.slotRequired')"
              />
            </template>
          </a-table-column>
          <a-table-column
            :title="t('settings.prefabs.slotOverride')"
            width="90px"
          >
            <template #default="{ record }">
              <a-checkbox
                v-model:checked="record.allowMemberOverride"
                :disabled="formDisabled"
                :aria-label="t('settings.prefabs.slotOverride')"
              />
            </template>
          </a-table-column>
          <a-table-column
            v-if="editableForm"
            :title="t('settings.skills.actions')"
            width="70px"
          >
            <template #default="{ index }">
              <a-button
                danger
                type="link"
                size="small"
                :disabled="formDisabled"
                @click="form.slots.splice(index, 1)"
              >
                {{ t('common.delete') }}
              </a-button>
            </template>
          </a-table-column>
        </a-table>
      </div>
      <a-button
        v-if="editableForm"
        size="small"
        class="pf-add"
        :disabled="formDisabled || form.slots.length >= 20"
        @click="addSlot"
      >
        {{ t('settings.prefabs.addSlot') }}
      </a-button>

      <div class="pf-grid pf-block">
        <label
          v-for="field in (['provider', 'model', 'effort'] as const)"
          :key="field"
          class="pf-field"
        >
          <span>{{ t(`settings.prefabs.${field}`) }}</span>
          <a-input
            v-model:value="form[field]"
            :readonly="formDisabled"
          />
        </label>
      </div>
      <label class="pf-field pf-block">
        <span>{{ t('settings.prefabs.settingsJson') }}</span>
        <a-textarea
          v-model:value="form.settingsJson"
          :rows="3"
          :readonly="formDisabled"
        />
      </label>
      <h4 class="pf-subtitle">
        {{ t('settings.prefabs.capabilities') }}
      </h4>
      <div
        class="pf-table-scroll"
        role="region"
        :aria-label="t('settings.prefabs.capabilities')"
        tabindex="0"
      >
        <a-table
          :data-source="displayedCapabilities"
          :pagination="{ pageSize: 12, size: 'small' }"
          row-key="key"
          size="small"
        >
          <a-table-column
            :title="t('settings.prefabs.capKind')"
            data-index="kind"
            width="110px"
          />
          <a-table-column
            :title="t('settings.prefabs.capId')"
            data-index="id"
          />
          <a-table-column
            :title="t('settings.prefabs.capStatus')"
            width="120px"
          >
            <template #default="{ record }">
              <a-tag :color="record.enabled && record.reviewStatus !== 'rejected' ? (record.reviewStatus === 'pending' ? 'orange' : 'green') : 'default'">
                {{ t(`settings.prefabs.capState.${record.enabled ? (record.reviewStatus ?? 'enabled') : 'disabled'}`) }}
              </a-tag>
            </template>
          </a-table-column>
          <a-table-column
            :title="t('settings.prefabs.capSelected')"
            width="90px"
          >
            <template #default="{ record }">
              <a-checkbox
                :checked="capSelected(record.kind, record.id)"
                :disabled="formDisabled"
                :aria-label="`${t('settings.prefabs.capSelected')}: ${record.id}`"
                @update:checked="(checked: boolean) => toggleCap(record, checked)"
              />
            </template>
          </a-table-column>
          <a-table-column
            :title="t('settings.prefabs.slotRequired')"
            width="80px"
          >
            <template #default="{ record }">
              <a-checkbox
                :checked="capRequired(record.kind, record.id)"
                :disabled="formDisabled || !capSelected(record.kind, record.id)"
                :aria-label="`${t('settings.prefabs.slotRequired')}: ${record.id}`"
                @update:checked="(checked: boolean) => setCapRequired(record, checked)"
              />
            </template>
          </a-table-column>
        </a-table>
      </div>

      <p
        v-if="editableForm && dirty && editorMode === 'edit'"
        class="pf-meta"
        role="status"
      >
        {{ t('settings.prefabs.saveBeforePublish') }}
      </p>
      <div class="pf-actions">
        <a-button
          v-if="editableForm"
          type="primary"
          :loading="busy"
          :disabled="!canSave"
          @click="saveDraft"
        >
          {{ t(editorMode === 'new' ? 'settings.prefabs.createDraft' : 'settings.prefabs.saveDraft') }}
        </a-button>
        <a-button
          v-if="editableForm && editorMode === 'edit'"
          :disabled="!canPublish"
          @click="publish"
        >
          {{ t('settings.prefabs.publish') }}
        </a-button>
        <a-button
          :disabled="busy || loading"
          @click="confirmDiscard(() => applyEditor(null, null))"
        >
          {{ t('common.close') }}
        </a-button>
      </div>
    </a-card>

    <a-card
      size="small"
      class="pf-card"
      :title="t('settings.prefabs.bindTitle')"
    >
      <a-alert
        v-if="bindingError"
        type="error"
        show-icon
        :message="bindingError"
        class="pf-notice"
      />
      <div class="pf-grid">
        <div class="pf-field">
          <span>{{ t('settings.prefabs.channel') }}</span>
          <a-select
            v-model:value="bindChannelId"
            :aria-label="t('settings.prefabs.channel')"
            :options="channels.map(c => ({ value: c.id, label: c.name }))"
            :loading="channelsLoading"
            :disabled="bindingBusy || channelsLoading || !channels.length"
            :placeholder="t('settings.prefabs.selectChannel')"
            @change="onChannelChange"
          />
        </div>
        <div class="pf-field">
          <span>{{ t('settings.prefabs.member') }}</span>
          <a-select
            v-model:value="bindMemberId"
            :aria-label="t('settings.prefabs.member')"
            :options="members.map(m => ({ value: m.id, label: `${m.name} (${m.role})` }))"
            :loading="membersLoading"
            :disabled="!bindChannelId || channelsLoading || membersLoading || bindingBusy"
            :placeholder="t('settings.prefabs.selectMember')"
            @change="onMemberChange"
          />
        </div>
      </div>
      <p
        v-if="!channelsLoading && !channels.length && !bindingError"
        class="pf-meta"
      >
        {{ t('settings.prefabs.noWritableChannels') }}
      </p>
      <p
        v-if="bindMember"
        class="pf-binding-state"
        role="status"
      >
        <strong>{{ t('settings.prefabs.currentBinding') }}</strong>
        <template v-if="bindMember.prefabBinding">
          {{ t('settings.prefabs.bindingSummary', {
            name: boundPrefab?.name ?? bindMember.prefabBinding.prefabId,
            revision: bindMember.prefabBinding.revision,
            hash: bindMember.prefabBinding.contentHash.slice(0, 12),
          }) }}
          <a-tag v-if="boundPrefab?.archivedAt">
            {{ t('settings.prefabs.archived') }}
          </a-tag>
        </template>
        <template v-else-if="hasBinding">
          {{ t('settings.prefabs.invalidBinding') }}
        </template>
        <template v-else-if="bindMember.prefabBindingVersion === null">
          {{ t('settings.prefabs.noBinding') }}
        </template>
        <template v-else>
          {{ t('settings.prefabs.unknownBinding') }}
        </template>
      </p>
      <p
        v-if="hasBinding"
        class="pf-meta"
      >
        {{ t('settings.prefabs.unbindBeforeRebind') }}
      </p>
      <template v-if="canChooseBinding || (bindMember && !hasBinding && bindingBusy)">
        <div class="pf-grid pf-block">
          <div class="pf-field">
            <span>{{ t('settings.prefabs.name') }}</span>
            <a-select
              v-model:value="bindPrefabId"
              :aria-label="t('settings.prefabs.name')"
              :options="bindablePrefabs.map(p => ({ value: p.id, label: p.name }))"
              :disabled="bindingBusy || !bindablePrefabs.length"
              :placeholder="t('settings.prefabs.selectPrefab')"
              @change="onBindPrefabChange"
            />
          </div>
          <div class="pf-field">
            <span>{{ t('settings.prefabs.revision') }}</span>
            <a-select
              v-model:value="bindRevision"
              :aria-label="t('settings.prefabs.revision')"
              :options="revisionOptions"
              :loading="revisionLoading"
              :disabled="bindingBusy || !bindTarget"
              :placeholder="t('settings.prefabs.revision')"
              @change="loadBindRevision"
            />
          </div>
        </div>
        <p
          v-if="!bindablePrefabs.length"
          class="pf-meta"
        >
          {{ t('settings.prefabs.noPublished') }}
        </p>
        <a-alert
          v-if="revisionError"
          type="error"
          show-icon
          :message="revisionError"
          class="pf-block"
        />
        <label
          v-for="slot in activeBindDraft?.prompt.slots ?? []"
          :key="slot.key"
          class="pf-bind-slot"
        >
          <span>
            {{ slot.label || slot.key }}<span
              v-if="slot.required"
              aria-hidden="true"
            > *</span>
            <small v-if="slot.allowMemberOverride === false">{{ t('settings.prefabs.lockedSlot') }}</small>
          </span>
          <a-input
            :value="slotValue(slot)"
            :maxlength="slot.maxLength ?? 4000"
            :aria-required="!!slot.required"
            :readonly="bindingBusy || slot.allowMemberOverride === false"
            @update:value="(value: string) => { if (!bindingBusy && slot.allowMemberOverride !== false) bindSlots[slot.key] = value }"
          />
        </label>
        <p
          v-if="missingBindSlot"
          class="pf-meta"
          role="status"
        >
          {{ t('settings.prefabs.missingSlot', { name: missingBindSlot.label || missingBindSlot.key }) }}
        </p>
      </template>
      <div class="pf-actions">
        <a-button
          :loading="channelsLoading || membersLoading"
          :disabled="bindingBusy"
          @click="refreshBinding"
        >
          {{ t('settings.prefabs.refreshBinding') }}
        </a-button>
        <a-button
          v-if="!hasBinding"
          type="primary"
          :loading="bindingBusy"
          :disabled="!canBind"
          @click="bind"
        >
          {{ t('settings.prefabs.bind') }}
        </a-button>
        <a-button
          v-else
          danger
          :loading="bindingBusy"
          :disabled="!canUnbind"
          @click="unbind"
        >
          {{ t('settings.prefabs.unbind') }}
        </a-button>
      </div>
    </a-card>
  </div>
</template>

<style scoped>
.section-title {
  margin: 0 0 4px;
  font-family: var(--font-body);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.section-desc {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-faint);
}

.pf-notice {
  margin-bottom: 12px;
}

.pf-toolbar,
.pf-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
}

.pf-card {
  min-width: 0;
  margin-top: 16px;
}

.pf-card :deep(.ant-card-head-title) {
  white-space: normal;
}

.pf-actions {
  margin-top: 12px;
  margin-bottom: 0;
}

.pf-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pf-table-scroll {
  min-width: 0;
  max-width: 100%;
  overflow: auto;
}

.pf-table-scroll :deep(.ant-table-cell) {
  overflow-wrap: anywhere;
}

.pf-table-scroll :deep(input) {
  min-width: 6rem;
}

.pf-field {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.pf-editor-heading {
  margin: 0;
  overflow-wrap: anywhere;
}

.pf-meta {
  margin: 6px 0 0;
  color: var(--ink-faint);
  font-size: 12px;
}

.pf-binding-state {
  margin: 10px 0 0;
  color: var(--ink);
  overflow-wrap: anywhere;
}

.pf-bind-slot small {
  display: block;
}

.pf-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.pf-block {
  margin-top: 10px;
}

.pf-subtitle {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.pf-add {
  margin-top: 8px;
}

.pf-bind-slot {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--ink-faint);
}

@media (max-width: 899px) {
  .pf-grid {
    grid-template-columns: 1fr;
  }

  .pf-bind-slot {
    grid-template-columns: 1fr;
  }
}
</style>
