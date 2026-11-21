<script setup lang="ts">
/**
 * 系统设置 · AgentPrefab。
 * - 草稿：角色/场景提示、多插槽、现有 harness 的 profile、能力开关（tool/plugin-tool/skill/mcp-tool）
 * - 发布：不可变 revision（head CAS）
 * - 绑定：选择 Channel 成员 + revision，填写允许覆盖的 slot，固定 revision/hash
 * 能力开关只是选择；实际调用仍由服务端 registry/Channel/Project/角色/harness 交集与 dispatch 复核。
 */
import { message, Modal } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import { apiFetch } from '@/app/composables/workshop/apiClient'

defineProps<{ activeTab: string }>()

const { t } = useI18n()
const userStore = useUserStore()

interface Slot { key: string, label: string, description?: string, defaultValue?: string, required?: boolean, allowMemberOverride?: boolean, maxLength?: number }
interface Capability { kind: 'tool' | 'plugin-tool' | 'skill' | 'mcp-tool', id: string, version?: string, required?: boolean }
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
  visibility: 'private' | 'public'
  ownerUserId: string | null
  headRevision: number
  updatedAt: string
  draft: Draft
  revisions?: Array<{ revision: number, contentHash: string, createdAt: string, createdBy: string }>
}
interface Channel { id: string, name: string, ownerUserId?: string | null }
interface Member { id: string, name: string, role: string, harness: string }

const prefabs = ref<PrefabRow[]>([])
const selected = ref<PrefabRow | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const canAdmin = computed(() => userStore.isAdmin)

const form = reactive<{
  name: string
  description: string
  visibility: 'private' | 'public'
  role: string
  scenario: string
  slots: Slot[]
  provider: string
  model: string
  effort: string
  settingsJson: string
  capabilities: Capability[]
}>({
  name: '',
  description: '',
  visibility: 'private',
  role: '',
  scenario: '',
  slots: [],
  provider: '',
  model: '',
  effort: '',
  settingsJson: '{}',
  capabilities: [],
})

const catalog = ref<CatalogEntry[]>([])

const channels = ref<Channel[]>([])
const members = ref<Member[]>([])
const bindChannelId = ref('')
const bindMemberId = ref('')
const bindPrefabId = ref('')
const bindRevision = ref<number | undefined>(undefined)
const bindSlots = reactive<Record<string, string>>({})
const bindDraft = ref<Draft | null>(null)

function applyRow(row: PrefabRow): void {
  selected.value = row
  form.name = row.draft.name
  form.description = row.draft.description ?? ''
  form.visibility = row.draft.visibility ?? row.visibility
  form.role = row.draft.prompt?.role ?? ''
  form.scenario = row.draft.prompt?.scenario ?? ''
  form.slots = (row.draft.prompt?.slots ?? []).map(s => ({ ...s }))
  form.provider = row.draft.profile?.provider ?? ''
  form.model = row.draft.profile?.model ?? ''
  form.effort = row.draft.profile?.effort ?? ''
  form.settingsJson = JSON.stringify(row.draft.profile?.settings ?? {}, null, 2)
  form.capabilities = (row.draft.capabilities ?? []).map(c => ({ ...c }))
}

function buildDraft(): Draft {
  let settings: Record<string, string | number | boolean> = {}
  try {
    settings = JSON.parse(form.settingsJson || '{}')
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
      ...(Object.keys(settings).length ? { settings } : {}),
    },
    capabilities: form.capabilities,
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch<{ prefabs: PrefabRow[] }>({ base: '/api/workshop/agent-prefabs' })
    prefabs.value = res.prefabs ?? []
    if (selected.value) {
      const fresh = prefabs.value.find(p => p.id === selected.value!.id)
      if (fresh) applyRow(fresh)
    }
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function loadChannels(): Promise<void> {
  try {
    const res = await apiFetch<Channel[]>({ base: '/api/workshop/channels' })
    channels.value = Array.isArray(res) ? res : (res as unknown as { channels?: Channel[] }).channels ?? []
  }
  catch { channels.value = [] }
}

async function loadMembers(): Promise<void> {
  members.value = []
  bindMemberId.value = ''
  if (!bindChannelId.value) return
  try {
    const res = await apiFetch<Member[]>({ base: '/api/workshop/channels', path: `/${encodeURIComponent(bindChannelId.value)}/agents` })
    members.value = Array.isArray(res) ? res : []
  }
  catch { members.value = [] }
}

async function createPrefab(): Promise<void> {
  busy.value = true
  try {
    const row = await apiFetch<PrefabRow>({
      base: '/api/workshop/agent-prefabs',
      init: {
        method: 'POST',
        body: JSON.stringify({
          draft: {
            name: 'Expert',
            description: '',
            visibility: 'private',
            prompt: { role: '', scenario: '', slots: [] },
            profile: {},
            capabilities: [],
          },
        }),
      },
    })
    message.success(t('settings.prefabs.created'))
    await load()
    applyRow(prefabs.value.find(p => p.id === row.id) ?? row)
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
  finally {
    busy.value = false
  }
}

async function saveDraft(): Promise<void> {
  if (!selected.value) return
  busy.value = true
  try {
    const draft = buildDraft()
    const row = await apiFetch<PrefabRow>({
      base: '/api/workshop/agent-prefabs',
      path: `/${encodeURIComponent(selected.value.id)}`,
      init: { method: 'PATCH', body: JSON.stringify({ expectedUpdatedAt: selected.value.updatedAt, draft }) },
    })
    message.success(t('settings.prefabs.saved'))
    await load()
    applyRow(prefabs.value.find(p => p.id === row.id) ?? row)
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
  finally {
    busy.value = false
  }
}

async function publish(): Promise<void> {
  if (!selected.value) return
  Modal.confirm({
    title: t('settings.prefabs.publishConfirm'),
    content: `${selected.value.name} → revision ${selected.value.headRevision + 1}`,
    okText: t('settings.prefabs.publish'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      busy.value = true
      try {
        const rev = await apiFetch<{ revision: number, contentHash: string }>({
          base: '/api/workshop/agent-prefabs',
          path: `/${encodeURIComponent(selected.value!.id)}/publish`,
          init: { method: 'POST', body: JSON.stringify({ expectedHead: selected.value!.headRevision }) },
        })
        message.success(t('settings.prefabs.published', { p0: rev.revision, p1: rev.contentHash.slice(0, 12) }))
        await load()
      }
      catch (err) {
        message.error(err instanceof Error ? err.message : String(err))
      }
      finally {
        busy.value = false
      }
    },
  })
}

function onBindPrefabChange(): void {
  bindRevision.value = prefabs.value.find(p => p.id === bindPrefabId.value)?.headRevision ?? undefined
  void loadBindRevision()
}

async function loadBindRevision(): Promise<void> {
  if (!bindPrefabId.value || !bindRevision.value) return
  try {
    const res = await apiFetch<{ draft: Draft }>({
      base: '/api/workshop/agent-prefabs',
      path: `/${encodeURIComponent(bindPrefabId.value)}/revisions/${bindRevision.value}`,
    })
    bindDraft.value = res.draft
    for (const key of Object.keys(bindSlots)) bindSlots[key] = ''
    for (const slot of res.draft.prompt.slots) bindSlots[slot.key] = slot.defaultValue ?? ''
  }
  catch (err) {
    bindDraft.value = null
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function bind(): Promise<void> {
  if (!bindChannelId.value || !bindMemberId.value || !bindPrefabId.value || typeof bindRevision.value !== 'number') return
  busy.value = true
  try {
    await apiFetch({
      base: '/api/workshop/channels',
      path: `/${encodeURIComponent(bindChannelId.value)}/agents/${encodeURIComponent(bindMemberId.value)}/prefab`,
      init: {
        method: 'PATCH',
        body: JSON.stringify({ prefabId: bindPrefabId.value, revision: bindRevision.value, slotValues: { ...bindSlots } }),
      },
    })
    message.success(t('settings.prefabs.bound'))
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
  finally {
    busy.value = false
  }
}

async function unbind(): Promise<void> {
  if (!bindChannelId.value || !bindMemberId.value) return
  busy.value = true
  try {
    await apiFetch({
      base: '/api/workshop/channels',
      path: `/${encodeURIComponent(bindChannelId.value)}/agents/${encodeURIComponent(bindMemberId.value)}/prefab`,
      init: { method: 'PATCH', body: JSON.stringify({ clear: true }) },
    })
    message.success(t('settings.prefabs.unbound'))
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
  finally {
    busy.value = false
  }
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

function capSelected(kind: Capability['kind'], id: string): boolean {
  return form.capabilities.some(c => c.kind === kind && c.id === id)
}

function capRequired(kind: Capability['kind'], id: string): boolean {
  return form.capabilities.find(c => c.kind === kind && c.id === id)?.required === true
}

function toggleCap(entry: CatalogEntry, checked: boolean): void {
  if (checked) {
    if (!capSelected(entry.kind, entry.id)) form.capabilities.push({ kind: entry.kind, id: entry.id, required: false })
  }
  else {
    form.capabilities = form.capabilities.filter(c => !(c.kind === entry.kind && c.id === entry.id))
  }
}

function setCapRequired(entry: CatalogEntry, checked: boolean): void {
  const item = form.capabilities.find(c => c.kind === entry.kind && c.id === entry.id)
  if (item) item.required = checked
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
    <a-alert
      v-if="!canAdmin"
      type="info"
      show-icon
      :message="t('settings.prefabs.adminOnly')"
      class="pf-notice"
    />

    <div class="pf-toolbar">
      <a-button
        :loading="loading"
        @click="load"
      >
        {{ t('settings.prefabs.refresh') }}
      </a-button>
      <a-button
        v-if="canAdmin"
        type="primary"
        :loading="busy"
        @click="createPrefab"
      >
        {{ t('settings.prefabs.create') }}
      </a-button>
    </div>

    <a-table
      :data-source="prefabs"
      :pagination="false"
      row-key="id"
      size="small"
      :locale="{ emptyText: t('settings.prefabs.empty') }"
      @row-click="(record: PrefabRow) => applyRow(record)"
    >
      <a-table-column
        :title="t('settings.prefabs.name')"
        data-index="name"
      />
      <a-table-column
        :title="t('settings.prefabs.visibility')"
        data-index="visibility"
        width="100px"
      />
      <a-table-column
        :title="t('settings.prefabs.revision')"
        data-index="headRevision"
        width="100px"
      />
      <a-table-column
        :title="t('settings.prefabs.updatedAt')"
        data-index="updatedAt"
        width="190px"
      />
    </a-table>

    <a-card
      v-if="selected"
      size="small"
      class="pf-card"
      :title="`${selected.name} · id=${selected.id}`"
    >
      <div class="pf-grid">
        <a-input
          v-model:value="form.name"
          :placeholder="t('settings.prefabs.name')"
        />
        <a-input
          v-model:value="form.description"
          :placeholder="t('settings.prefabs.description')"
        />
        <a-select
          v-model:value="form.visibility"
          :options="[
            { value: 'private', label: 'private' },
            { value: 'public', label: 'public' },
          ]"
        />
      </div>
      <a-textarea
        v-model:value="form.role"
        :rows="3"
        :placeholder="t('settings.prefabs.rolePrompt')"
        class="pf-block"
      />
      <a-textarea
        v-model:value="form.scenario"
        :rows="3"
        :placeholder="t('settings.prefabs.scenarioPrompt')"
        class="pf-block"
      />

      <h4 class="pf-subtitle">
        {{ t('settings.prefabs.slots') }}
      </h4>
      <a-table
        :data-source="form.slots"
        :pagination="false"
        row-key="key"
        size="small"
      >
        <a-table-column
          :title="t('settings.prefabs.slotKey')"
          width="120px"
        >
          <template #default="{ record }">
            <a-input
              v-model:value="record.key"
              size="small"
            />
          </template>
        </a-table-column>
        <a-table-column :title="t('settings.prefabs.slotLabel')">
          <template #default="{ record }">
            <a-input
              v-model:value="record.label"
              size="small"
            />
          </template>
        </a-table-column>
        <a-table-column :title="t('settings.prefabs.slotDefault')">
          <template #default="{ record }">
            <a-input
              v-model:value="record.defaultValue"
              size="small"
            />
          </template>
        </a-table-column>
        <a-table-column
          :title="t('settings.prefabs.slotRequired')"
          width="80px"
        >
          <template #default="{ record }">
            <a-checkbox v-model:checked="record.required" />
          </template>
        </a-table-column>
        <a-table-column
          :title="t('settings.prefabs.slotOverride')"
          width="90px"
        >
          <template #default="{ record }">
            <a-checkbox v-model:checked="record.allowMemberOverride" />
          </template>
        </a-table-column>
        <a-table-column
          :title="t('settings.skills.actions')"
          width="70px"
        >
          <template #default="{ index }">
            <a-button
              danger
              type="link"
              size="small"
              @click="form.slots.splice(index, 1)"
            >
              {{ t('common.delete') }}
            </a-button>
          </template>
        </a-table-column>
      </a-table>
      <a-button
        size="small"
        class="pf-add"
        @click="form.slots.push({ key: `slot${form.slots.length + 1}`, label: '', defaultValue: '', allowMemberOverride: true, maxLength: 4000 })"
      >
        {{ t('settings.prefabs.addSlot') }}
      </a-button>

      <div class="pf-grid pf-block">
        <a-input
          v-model:value="form.provider"
          placeholder="provider"
        />
        <a-input
          v-model:value="form.model"
          placeholder="model"
        />
        <a-input
          v-model:value="form.effort"
          placeholder="effort"
        />
      </div>
      <a-textarea
        v-model:value="form.settingsJson"
        :rows="3"
        :placeholder="t('settings.prefabs.settingsJson')"
        class="pf-block"
      />
      <h4 class="pf-subtitle">
        {{ t('settings.prefabs.capabilities') }}
      </h4>
      <a-table
        :data-source="catalog"
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
            <a-tag :color="record.enabled ? (record.reviewStatus === 'pending' ? 'orange' : 'green') : 'default'">
              {{ record.enabled ? (record.reviewStatus ?? 'enabled') : 'disabled' }}
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column
          :title="t('settings.prefabs.slotOverride')"
          width="90px"
        >
          <template #default="{ record }">
            <a-checkbox
              :checked="capSelected(record.kind, record.id)"
              @change="(v: unknown) => toggleCap(record, v === true)"
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
              :disabled="!capSelected(record.kind, record.id)"
              @change="(v: unknown) => setCapRequired(record, v === true)"
            />
          </template>
        </a-table-column>
      </a-table>

      <div class="pf-actions">
        <a-button
          type="primary"
          :loading="busy"
          :disabled="!canAdmin"
          @click="saveDraft"
        >
          {{ t('settings.prefabs.saveDraft') }}
        </a-button>
        <a-button
          :loading="busy"
          :disabled="!canAdmin"
          @click="publish"
        >
          {{ t('settings.prefabs.publish') }}
        </a-button>
      </div>
    </a-card>

    <a-card
      v-if="canAdmin"
      size="small"
      class="pf-card"
      :title="t('settings.prefabs.bindTitle')"
    >
      <div class="pf-grid">
        <a-select
          v-model:value="bindChannelId"
          :options="channels.map(c => ({ value: c.id, label: c.name }))"
          :placeholder="t('settings.prefabs.channel')"
          @change="loadMembers"
        />
        <a-select
          v-model:value="bindMemberId"
          :options="members.map(m => ({ value: m.id, label: `${m.name} (${m.role})` }))"
          :placeholder="t('settings.prefabs.member')"
        />
        <a-select
          v-model:value="bindPrefabId"
          :options="prefabs.map(p => ({ value: p.id, label: `${p.name} · v${p.headRevision}` }))"
          :placeholder="t('settings.prefabs.name')"
          @change="onBindPrefabChange"
        />
        <a-input-number
          v-model:value="bindRevision"
          :min="1"
          :placeholder="t('settings.prefabs.revision')"
          @change="loadBindRevision"
        />
      </div>
      <div
        v-for="slot in bindDraft?.prompt?.slots ?? []"
        :key="slot.key"
        class="pf-bind-slot"
      >
        <span>{{ slot.label || slot.key }}<em v-if="slot.required"> *</em></span>
        <a-input
          v-model:value="bindSlots[slot.key]"
          :maxlength="slot.maxLength ?? 4000"
          :disabled="slot.allowMemberOverride === false"
        />
      </div>
      <div class="pf-actions">
        <a-button
          type="primary"
          :loading="busy"
          @click="bind"
        >
          {{ t('settings.prefabs.bind') }}
        </a-button>
        <a-button
          danger
          :loading="busy"
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
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
}

.pf-card {
  margin-top: 16px;
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
