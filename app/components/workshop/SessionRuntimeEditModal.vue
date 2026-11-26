<script setup lang="ts">
/**
 * 会话运行时元数据编辑弹窗（owner/admin）。
 *
 * - harness / provider / model / effort / runtimePrompt / AgentPrefab 都可在会话实例上覆盖；
 * - 只提交被用户改动的字段（partial overrides）；`''` 表示“不指定（清除继承）”，null 表示回到继承；
 * - 保存后下一回合消息入口热切换，当前回合不打断；
 * - 节点/recipe 绑定在下方独立区块（写入走 agent-tools/bindings，下一回合生效）。
 */
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi, type AgentPrefabRevisionDto, type AgentPrefabSlotDto, type AgentPrefabSummaryDto, type HarnessMetaDto, type SessionRuntimeDto } from '~/composables/workshop/useWorkshopApi'
import { apiErrorCode, apiErrorMessage } from '@/app/utils/api-error'

interface CatalogModel { id: string, efforts: string[], defaultEffort?: string }
interface CatalogProvider { id: string, models: CatalogModel[] }
interface Catalog { providers: CatalogProvider[], effortMode: 'levels' | 'freetext' | 'unsupported', note?: string }

const NONE = '__none__'

const props = defineProps<{
  channelId: string
  sessionId: string
  runtime: SessionRuntimeDto
}>()
const emit = defineEmits<{ (e: 'saved', runtime: SessionRuntimeDto): void }>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const api = useWorkshopApi()
const catalog = ref<Catalog | null>(null)
const harnesses = ref<HarnessMetaDto[]>([])
const prefabs = ref<AgentPrefabSummaryDto[]>([])
const revisions = ref<Array<{ revision: number }>>([])
const slots = reactive<Record<string, string>>({})
const slotDefs = ref<AgentPrefabSlotDto[]>([])
const harness = ref('')
const support = ref<{ provider: boolean, model: boolean, effort: boolean }>({ ...props.runtime.profileSupport })
const provider = ref('')
const model = ref('')
const effort = ref('')
const providerSearch = ref('')
const modelSearch = ref('')
const runtimePrompt = ref('')
const selectedPrefabId = ref('')
const selectedRevision = ref<number | null>(null)
const loading = ref(false)
const saving = ref(false)
const resetting = ref(false)
const error = ref('')
const catalogError = ref('')
const stale = ref(false)
let loadSeq = 0
let initial: {
  harness: string
  provider?: string
  model?: string
  effort?: string
  runtimePrompt?: string
  prefabId?: string
  revision?: number
  slots: Record<string, string>
} = { harness: '', slots: {} }

const providerValues = computed(() => (catalog.value?.providers ?? []).map(p => p.id))
const allModels = computed(() => [...new Map((catalog.value?.providers ?? []).flatMap((p: CatalogProvider) => p.models.map((m: CatalogModel) => [m.id, m] as const))).values()])
const modelValues = computed(() => {
  const list = provider.value && provider.value !== NONE
    ? catalog.value?.providers.find(p => p.id === provider.value)?.models ?? []
    : allModels.value
  return list.map(m => m.id)
})
const currentModel = computed<CatalogModel | null>(() => allModels.value.find(m => m.id === model.value) ?? null)

function selectorOptions(values: string[], search: string, inherit: string) {
  const options = [
    { value: '', label: inherit },
    { value: NONE, label: t('sessionManage.runtime.suppress') },
    ...values.filter(v => v !== '').map(v => ({ value: v, label: v })),
  ]
  const text = search.trim()
  if (text && text !== NONE && !values.includes(text) && text !== '') {
    options.push({ value: text, label: `${text}（自定义）` })
  }
  return options
}

const providerOptions = computed(() => selectorOptions(providerValues.value, providerSearch.value, `${t('sessionManage.runtime.inherit')}${props.runtime.effective.provider ? `（${props.runtime.effective.provider}）` : ''}`))
const modelOptions = computed(() => selectorOptions(modelValues.value, modelSearch.value, `${t('sessionManage.runtime.inherit')}${props.runtime.effective.model ? `（${props.runtime.effective.model}）` : ''}`))
const effortOptions = computed(() => {
  const inherit = `${t('sessionManage.runtime.inherit')}${props.runtime.effective.effort ? `（${props.runtime.effective.effort}）` : ''}`
  if (!catalog.value || catalog.value.effortMode === 'unsupported') return [{ value: '', label: inherit }]
  const levels = catalog.value.effortMode === 'levels' && currentModel.value ? currentModel.value.efforts : []
  return selectorOptions(levels, '', inherit)
})

/** freetext 输入框不显示内部哨兵值。 */
const effortText = computed({
  get: () => (effort.value === NONE ? '' : effort.value),
  set: (value: string) => { effort.value = value },
})

const harnessOptions = computed(() => harnesses.value.map(h => ({
  value: h.id,
  label: h.available === false ? `${h.label}（${t('sessionManage.runtime.harnessUnavailable')}）` : h.label,
  disabled: h.available === false && h.id !== harness.value,
})))

const prefabOptions = computed(() => {
  const options = [
    { value: '', label: t('sessionManage.runtime.prefabInherit') },
    ...prefabs.value.map(p => ({ value: p.id, label: p.name })),
  ]
  if (selectedPrefabId.value && !options.some(o => o.value === selectedPrefabId.value)) {
    options.push({ value: selectedPrefabId.value, label: props.runtime.effective.prefab?.name ?? selectedPrefabId.value })
  }
  return options
})

const revisionOptions = computed(() => revisions.value.map(r => ({ value: r.revision, label: `r${r.revision}` })))

function selectorState(value: string | undefined): string {
  if (value === undefined) return ''
  if (value === '') return NONE
  return value
}

function fillFromRuntime(): void {
  const e = props.runtime.effective
  harness.value = props.runtime.harness
  support.value = { ...props.runtime.profileSupport }
  provider.value = selectorState(props.runtime.overrides.provider)
  model.value = selectorState(props.runtime.overrides.model)
  effort.value = selectorState(props.runtime.overrides.effort)
  providerSearch.value = ''
  modelSearch.value = ''
  runtimePrompt.value = e.runtimePrompt ?? ''
  selectedPrefabId.value = e.prefab?.prefabId ?? ''
  selectedRevision.value = e.prefab?.revision ?? null
  for (const key of Object.keys(slots)) Reflect.deleteProperty(slots, key)
  for (const [key, value] of Object.entries(e.prefab?.slotValues ?? {})) slots[key] = value
  initial = {
    harness: props.runtime.harness,
    provider: props.runtime.overrides.provider,
    model: props.runtime.overrides.model,
    effort: props.runtime.overrides.effort,
    runtimePrompt: e.runtimePrompt ?? undefined,
    prefabId: e.prefab?.prefabId,
    revision: e.prefab?.revision,
    slots: { ...(e.prefab?.slotValues ?? {}) },
  }
}

async function loadHarnesses(): Promise<void> {
  try {
    const res = await api.listHarnesses()
    harnesses.value = res.data?.harnesses ?? []
  }
  catch {
    harnesses.value = []
  }
}

async function loadCatalog(targetHarness: string, reconcile = false): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  catalogError.value = ''
  try {
    const cat = await api.listHarnessProviders(targetHarness)
    if (seq !== loadSeq) return
    catalog.value = cat.data?.catalog ?? null
    const meta = harnesses.value.find(h => h.id === targetHarness)
    if (meta?.profile) support.value = { ...meta.profile }
    if (reconcile) reconcileSelectors()
  }
  catch (err) {
    if (seq !== loadSeq) return
    catalog.value = null
    catalogError.value = apiErrorMessage(err)
  }
  finally {
    if (seq === loadSeq) loading.value = false
  }
}

/** 只有用户显式改 harness 才能收敛旧值；打开回填不能动用户既有覆盖。 */
function reconcileSelectors(): void {
  // 切回原 harness：恢复打开时的三态，避免“看一眼别的引擎”把覆盖变成抑制。
  if (harness.value === initial.harness) {
    provider.value = selectorState(initial.provider)
    model.value = selectorState(initial.model)
    effort.value = selectorState(initial.effort)
    return
  }
  const e = props.runtime.effective
  if (!support.value.provider) {
    if (provider.value && provider.value !== NONE) provider.value = NONE
    else if (provider.value === '' && e.provider) provider.value = NONE
  }
  else if (provider.value && provider.value !== NONE && providerValues.value.length > 0 && !providerValues.value.includes(provider.value)) {
    provider.value = NONE
  }
  else if (provider.value === '' && e.provider && providerValues.value.length > 0 && !providerValues.value.includes(e.provider)) {
    // 继承值来自 Prefab/频道默认：目标目录没有它时也要显式抑制，否则新旧引擎会混用 provider。
    provider.value = NONE
  }
  if (!support.value.model) {
    if (model.value && model.value !== NONE) model.value = NONE
    else if (model.value === '' && e.model) model.value = NONE
  }
  else if (model.value && model.value !== NONE && modelValues.value.length > 0 && !modelValues.value.includes(model.value)) {
    model.value = NONE
  }
  else if (model.value === '' && e.model && modelValues.value.length > 0 && !modelValues.value.includes(e.model)) {
    model.value = NONE
  }
  if (!support.value.effort || catalog.value?.effortMode === 'unsupported') {
    if (effort.value && effort.value !== NONE) effort.value = NONE
    else if (effort.value === '' && e.effort) effort.value = NONE
  }
  else if (catalog.value?.effortMode === 'levels' && currentModel.value && effort.value && effort.value !== NONE
    && !currentModel.value.efforts.includes(effort.value)) {
    effort.value = NONE
  }
}

async function loadPrefabs(): Promise<void> {
  try {
    const prefabList = await api.listAgentPrefabs()
    prefabs.value = (prefabList.data?.prefabs ?? []).filter(p => !p.archivedAt && p.headRevision > 0)
    // 保证 prefab 下拉先拥有 options 再恢复选中，避免只显示 prefabId
    if (selectedPrefabId.value) {
      const selected = selectedPrefabId.value
      selectedPrefabId.value = ''
      await nextTick()
      selectedPrefabId.value = selected
    }
    if (selectedPrefabId.value) await loadPrefab(selectedPrefabId.value, selectedRevision.value ?? undefined)
  }
  catch (err) {
    prefabs.value = []
    error.value = apiErrorMessage(err)
  }
}

async function loadPrefab(prefabId: string, preferRevision?: number): Promise<void> {
  if (!prefabId) {
    revisions.value = []
    selectedRevision.value = null
    slotDefs.value = []
    for (const key of Object.keys(slots)) Reflect.deleteProperty(slots, key)
    return
  }
  try {
    const detail = await api.getAgentPrefab(prefabId)
    revisions.value = detail.data?.revisions ?? []
    const target = preferRevision && revisions.value.some(r => r.revision === preferRevision)
      ? preferRevision
      : (detail.data?.headRevision ?? revisions.value.at(-1)?.revision ?? null)
    selectedRevision.value = target ?? null
    if (target) await loadRevision(prefabId, target)
  }
  catch (err) {
    error.value = apiErrorMessage(err)
    revisions.value = []
    selectedRevision.value = null
    slotDefs.value = []
  }
}

async function loadRevision(prefabId: string, revision: number): Promise<void> {
  try {
    const res = await api.getAgentPrefabRevision(prefabId, revision)
    const data: AgentPrefabRevisionDto = res.data
    slotDefs.value = data.draft?.prompt?.slots ?? []
    const same = initial.prefabId === prefabId && initial.revision === revision
    const base = same ? initial.slots : {}
    for (const key of Object.keys(slots)) Reflect.deleteProperty(slots, key)
    for (const def of slotDefs.value) {
      slots[def.key] = base[def.key] ?? def.defaultValue ?? ''
    }
  }
  catch (err) {
    error.value = apiErrorMessage(err)
    slotDefs.value = []
  }
}

watch(open, async (value) => {
  if (!value) return
  error.value = ''
  stale.value = false
  fillFromRuntime()
  await loadHarnesses()
  await loadCatalog(harness.value, false)
  await loadPrefabs()
}, { immediate: true })

/** 用户改 harness：显式收敛目标引擎读不了的旧值。 */
async function onHarnessChange(value: unknown): Promise<void> {
  const next = typeof value === 'string' ? value : harness.value
  harness.value = next
  await loadCatalog(next, true)
}

function onModelChange(): void {
  const m = currentModel.value
  if (!m) return
  if (m.efforts.length === 0) {
    if (effort.value && effort.value !== NONE) effort.value = NONE
    return
  }
  if (effort.value && effort.value !== NONE && effort.value !== '' && !m.efforts.includes(effort.value)) effort.value = NONE
}

function onProviderChange(): void {
  if (!catalog.value) return
  if (model.value && model.value !== NONE && modelValues.value.length > 0 && !modelValues.value.includes(model.value)) model.value = NONE
}

async function onPrefabChange(value: unknown): Promise<void> {
  const id = typeof value === 'string' ? value : ''
  selectedPrefabId.value = id
  await loadPrefab(id)
}

function onProviderSearch(value: string): void {
  providerSearch.value = value
}

function onModelSearch(value: string): void {
  modelSearch.value = value
}

async function onRevisionChange(value: unknown): Promise<void> {
  selectedRevision.value = Number(value)
  if (selectedPrefabId.value && selectedRevision.value) await loadRevision(selectedPrefabId.value, selectedRevision.value)
}

function selectorPayload(state: string, initialOverride: string | undefined): string | null | undefined {
  if (state === '') return initialOverride === undefined ? undefined : null
  if (state === NONE) return initialOverride === '' ? undefined : ''
  return state === initialOverride ? undefined : state
}

function overridesPayload(): Record<string, unknown> | null {
  const overrides: Record<string, unknown> = {}
  if (harness.value !== initial.harness) {
    overrides.harness = harness.value === props.runtime.baseHarness ? null : harness.value
  }
  const providerNext = selectorPayload(provider.value, initial.provider)
  if (providerNext !== undefined) overrides.provider = providerNext
  const modelNext = selectorPayload(model.value, initial.model)
  if (modelNext !== undefined) overrides.model = modelNext
  const effortNext = selectorPayload(effort.value, initial.effort)
  if (effortNext !== undefined) overrides.effort = effortNext
  if ((runtimePrompt.value.trim() || '') !== (initial.runtimePrompt ?? '')) overrides.runtimePrompt = runtimePrompt.value.trim() || null
  const prefabChanged = (selectedPrefabId.value || '') !== (initial.prefabId ?? '')
    || (selectedRevision.value ?? null) !== (initial.revision ?? null)
    || JSON.stringify(slots) !== JSON.stringify(initial.slots)
  if (prefabChanged) {
    overrides.prefabBinding = selectedPrefabId.value && selectedRevision.value
      ? { prefabId: selectedPrefabId.value, revision: selectedRevision.value, slotValues: { ...slots } }
      : null
  }
  return Object.keys(overrides).length > 0 ? overrides : null
}

async function save(): Promise<void> {
  const overrides = overridesPayload()
  if (!overrides) {
    open.value = false
    return
  }
  saving.value = true
  error.value = ''
  stale.value = false
  try {
    const res = await api.updateSessionRuntime(props.channelId, props.sessionId, props.runtime.runtimeObjectId, {
      expectedRevision: props.runtime.revision,
      overrides,
    })
    emit('saved', res.data.runtime)
    open.value = false
    message.success(t('sessionManage.runtime.savedNextTurn'))
  }
  catch (err) {
    error.value = apiErrorMessage(err)
    stale.value = apiErrorCode(err) === 'RUNTIME_REVISION_CONFLICT'
  }
  finally {
    saving.value = false
  }
}

/** 409 后从服务端取最新 runtime（不能拿旧 props 回填，否则下一次保存继续冲突）。 */
async function refreshFromServer(): Promise<void> {
  try {
    const res = await api.getSessionRuntime(props.channelId, props.sessionId, props.runtime.runtimeObjectId)
    emit('saved', res.data.runtime)
    await nextTick()
    fillFromRuntime()
    await loadCatalog(harness.value, false)
  }
  catch (err) {
    error.value = apiErrorMessage(err)
  }
}

async function reset(): Promise<void> {
  resetting.value = true
  error.value = ''
  try {
    const res = await api.updateSessionRuntime(props.channelId, props.sessionId, props.runtime.runtimeObjectId, {
      expectedRevision: props.runtime.revision,
      reset: true,
    })
    emit('saved', res.data.runtime)
    open.value = false
    message.success(t('sessionManage.runtime.resetNextTurn'))
  }
  catch (err) {
    error.value = apiErrorMessage(err)
    stale.value = apiErrorCode(err) === 'RUNTIME_REVISION_CONFLICT'
  }
  finally {
    resetting.value = false
  }
}
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="t('sessionManage.runtime.editTitle', { name: runtime.name })"
    :width="820"
    :confirm-loading="saving"
    :ok-text="t('common.save')"
    :cancel-text="t('common.cancel')"
    destroy-on-close
    @ok="save"
  >
    <div
      class="src-form"
      data-testid="session-runtime-form"
    >
      <div class="src-meta">
        <div>
          <span>{{ t('sessionManage.runtime.objectId') }}</span>
          <a-typography-text
            copyable
            class="mono"
            data-testid="session-runtime-object-id"
          >
            {{ runtime.runtimeObjectId }}
          </a-typography-text>
        </div>
        <div><span>session</span><code>{{ sessionId }}</code></div>
        <div>
          <span>{{ t('sessionManage.runtime.harnessEffective') }}</span>
          <div class="src-inline">
            <code data-testid="session-runtime-harness-effective">{{ harness }}</code>
            <a-tag
              v-if="harness !== runtime.baseHarness"
              color="gold"
            >
              {{ t('sessionManage.runtime.harnessOverridden') }}
            </a-tag>
          </div>
        </div>
        <div><span>{{ t('sessionManage.runtime.baseHarness') }}</span><code>{{ runtime.baseHarness }}</code></div>
        <div><span>{{ t('sessionManage.runtime.revision') }}</span><code>{{ runtime.revision }}</code></div>
      </div>

      <a-alert
        type="info"
        show-icon
        :message="t('sessionManage.runtime.nextTurnHint')"
        class="src-note"
      />
      <a-alert
        v-for="warning in runtime.warnings"
        :key="warning.code"
        type="warning"
        show-icon
        :message="warning.message"
        class="src-note"
      />
      <a-alert
        v-if="catalogError"
        type="warning"
        show-icon
        :message="catalogError"
      >
        <template #action>
          <a-button
            size="small"
            @click="loadCatalog(harness)"
          >
            {{ t('sessionManage.runtime.retry') }}
          </a-button>
        </template>
      </a-alert>
      <a-alert
        v-if="error"
        type="error"
        show-icon
        :message="error"
      >
        <template #action>
          <a-button
            v-if="stale"
            size="small"
            @click="refreshFromServer"
          >
            {{ t('sessionManage.runtime.refresh') }}
          </a-button>
        </template>
      </a-alert>

      <a-spin :spinning="loading">
        <a-form layout="vertical">
          <a-form-item :label="t('sessionManage.runtime.harnessEffective')">
            <a-select
              v-model:value="harness"
              :options="harnessOptions"
              show-search
              option-filter-prop="label"
              data-testid="session-runtime-harness"
              @change="onHarnessChange"
            />
            <p class="src-hint">
              {{ t('sessionManage.runtime.harnessHint') }}
            </p>
          </a-form-item>

          <a-divider>{{ t('sessionManage.runtime.profileSection') }}</a-divider>
          <p
            v-if="!support.provider && !support.model && !support.effort"
            class="src-hint src-hint-block"
          >
            {{ t('sessionManage.runtime.profileUnsupported') }}
          </p>
          <a-form-item
            v-if="support.provider"
            :label="t('sessionManage.runtime.provider')"
          >
            <a-select
              v-model:value="provider"
              :options="providerOptions"
              show-search
              :filter-option="false"
              data-testid="session-runtime-provider"
              @search="onProviderSearch"
              @change="onProviderChange"
            />
          </a-form-item>
          <a-form-item
            v-if="support.model"
            :label="t('sessionManage.runtime.model')"
          >
            <a-select
              v-model:value="model"
              :options="modelOptions"
              show-search
              :filter-option="false"
              data-testid="session-runtime-model"
              @search="onModelSearch"
              @change="onModelChange"
            />
            <p
              v-if="catalog && catalog.providers.length === 0"
              class="src-hint"
            >
              {{ t('sessionManage.runtime.profileCatalogEmpty') }}
            </p>
          </a-form-item>
          <a-form-item
            v-if="support.effort"
            :label="t('sessionManage.runtime.effort')"
          >
            <a-input
              v-if="!catalog || catalog.effortMode === 'freetext'"
              v-model:value="effortText"
              :placeholder="catalog?.note ?? 'variant'"
              data-testid="session-runtime-effort"
            />
            <a-select
              v-else
              v-model:value="effort"
              :options="effortOptions"
              data-testid="session-runtime-effort"
            />
          </a-form-item>
          <a-form-item :label="t('sessionManage.runtime.prompt')">
            <a-textarea
              v-model:value="runtimePrompt"
              :rows="4"
              :maxlength="4000"
              show-count
              :placeholder="t('sessionManage.runtime.promptPlaceholder')"
              data-testid="session-runtime-prompt"
            />
          </a-form-item>

          <a-divider>{{ t('sessionManage.runtime.prefabSection') }}</a-divider>
          <a-form-item :label="t('sessionManage.runtime.prefab')">
            <a-select
              v-model:value="selectedPrefabId"
              :options="prefabOptions"
              show-search
              option-filter-prop="label"
              data-testid="session-runtime-prefab"
              @change="onPrefabChange"
            />
          </a-form-item>
          <a-form-item
            v-if="selectedPrefabId"
            :label="t('sessionManage.runtime.prefabRevision')"
          >
            <a-select
              :value="selectedRevision ?? undefined"
              :options="revisionOptions"
              data-testid="session-runtime-prefab-revision"
              @change="onRevisionChange"
            />
          </a-form-item>
          <a-form-item
            v-for="def in slotDefs"
            :key="def.key"
            :label="def.label"
            :required="def.required"
          >
            <a-input
              v-model:value="slots[def.key]"
              :maxlength="def.maxLength ?? 2000"
              :disabled="def.allowMemberOverride === false"
            />
          </a-form-item>
        </a-form>
      </a-spin>

      <workshop-session-runtime-bindings
        v-if="runtime.manageable && runtime.active"
        :channel-id="channelId"
        :session-id="sessionId"
        :runtime-object-id="runtime.runtimeObjectId"
        :manageable="runtime.manageable && runtime.active && runtime.enabled === 1"
      />
    </div>

    <template #footer>
      <div class="src-footer">
        <ConfirmPopover
          v-if="runtime.customized"
          :title="t('sessionManage.runtime.resetConfirmTitle')"
          :description="t('sessionManage.runtime.resetConfirmDesc')"
          :ok-text="t('sessionManage.runtime.reset')"
          @confirm="reset"
        >
          <a-button
            danger
            :loading="resetting"
            data-testid="session-runtime-reset"
          >
            {{ t('sessionManage.runtime.reset') }}
          </a-button>
        </ConfirmPopover>
        <span class="src-spacer" />
        <a-button @click="open = false">
          {{ t('common.cancel') }}
        </a-button>
        <a-button
          type="primary"
          :loading="saving"
          data-testid="session-runtime-save"
          @click="save"
        >
          {{ t('common.save') }}
        </a-button>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.src-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.src-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  padding: 10px 12px;
  border: 1px solid var(--line, #e5e7eb);
  border-radius: 4px;
  margin-bottom: 12px;
  font-size: 12px;
}
.src-meta span {
  display: block;
  color: var(--ink-soft, #6b7280);
  font-size: 11px;
}
.src-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.src-hint-block {
  margin: 0 0 12px;
}
.src-note {
  margin-bottom: 12px;
}
.src-hint {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--ink-faint, #6b7280);
}
.src-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.src-spacer {
  flex: 1;
}
.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}
</style>
