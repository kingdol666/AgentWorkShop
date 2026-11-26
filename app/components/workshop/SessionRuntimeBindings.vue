<script setup lang="ts">
/**
 * 会话 runtime 的工业绑定面（只读摘要 + 增删/模式切换）。
 *
 * 绑定仓库按 agentId（= runtimeObjectId）实时读取，执行授权在下一次工具调用即生效；
 * 会话的 product/line/recipes 由「会话产线范围」覆盖（运行期可改，下一回合热切换）；
 * 无覆盖时回落到创建快照。写入复用 /agent-tools/bindings 与 /sessions/:sid/binding。
 */
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi, type RuntimeBindingKindDto, type SessionBindingDto, type SessionRuntimeBindingsDto } from '~/composables/workshop/useWorkshopApi'
import { apiErrorCode, apiErrorMessage } from '@/app/utils/api-error'

const props = defineProps<{
  channelId: string
  sessionId: string
  runtimeObjectId: string
  manageable: boolean
}>()

const { t } = useI18n()
const api = useWorkshopApi()
const summary = ref<SessionRuntimeBindingsDto | null>(null)
const scopeBinding = ref<SessionBindingDto | null>(null)
const bindingError = ref('')
const savingScope = ref(false)
const resettingScope = ref(false)
const scopeProduct = ref('')
const scopeRecipeIds = ref<string[]>([])
const loading = ref(false)
const error = ref('')
const adding = ref(false)
const kind = ref<RuntimeBindingKindDto>('daq')
const resourceId = ref('')
const busyId = ref('')
const rebuilding = ref(false)
let loadSeq = 0

const kindOptions = computed(() => [
  { value: 'daq', label: t('sessionManage.runtime.bindingKindDaq') },
  { value: 'dcw', label: t('sessionManage.runtime.bindingKindDcw') },
  { value: 'recipe', label: t('sessionManage.runtime.bindingKindRecipe') },
  { value: 'line-recipe', label: t('sessionManage.runtime.bindingKindLineRecipe') },
])

const resourceOptions = computed(() => {
  const data = summary.value
  if (!data) return []
  const bound = new Set(data.bindings.filter(b => b.kind === kind.value).map(b => b.nodeId))
  if (kind.value === 'daq') {
    return data.resources.daqNodes.filter(n => !bound.has(n.id)).map(n => ({ value: n.id, label: `${n.name} · ${n.id}` }))
  }
  if (kind.value === 'dcw') {
    return data.resources.dcwNodes.filter(n => !bound.has(n.id)).map(n => ({ value: n.id, label: `${n.name} · ${n.id}` }))
  }
  if (kind.value === 'recipe') {
    return data.resources.recipes.filter(r => !bound.has(r.id)).map(r => ({ value: r.id, label: `${r.name} · v${r.version}` }))
  }
  return data.resources.lines.filter(l => !bound.has(l.id)).map(l => ({ value: l.id, label: l.name }))
})

const toolRefreshText = computed(() => {
  const mode = summary.value?.toolRefresh
  if (mode === 'native') return t('sessionManage.runtime.toolRefreshNative')
  if (mode === 'per_turn') return t('sessionManage.runtime.toolRefreshPerTurn')
  return t('sessionManage.runtime.toolRefreshListChanged')
})

const scopeEnabled = computed(() => Boolean(scopeBinding.value && scopeBinding.value.channelMode === 'production_line_integrated'))
const productOptions = computed(() => (scopeBinding.value?.products ?? []).map(p => ({ value: p.id, label: p.name })))
const scopeRecipeOptions = computed(() => (scopeBinding.value?.recipesByProduct[scopeProduct.value] ?? []).map(r => ({ value: r.id, label: `${r.name} · v${r.version}` })))
const scopeSourceLabel = computed(() => {
  const source = scopeBinding.value?.source
  if (source === 'override') return t('sessionManage.runtime.scopeSourceOverride')
  if (source === 'snapshot') return t('sessionManage.runtime.scopeSourceSnapshot')
  return t('sessionManage.runtime.scopeSourceNone')
})

function applyBinding(data: SessionBindingDto): void {
  scopeBinding.value = data
  scopeProduct.value = data.productId ?? data.products[0]?.id ?? ''
  scopeRecipeIds.value = data.recipes.map(recipe => recipe.id)
}

async function loadBinding(): Promise<void> {
  bindingError.value = ''
  try {
    const res = await api.getSessionBinding(props.channelId, props.sessionId)
    applyBinding(res.data)
  }
  catch (err) {
    scopeBinding.value = null
    bindingError.value = apiErrorMessage(err)
  }
}

function onScopeProductChange(): void {
  // 切产品默认全选该产品配方；用户可再取消。
  scopeRecipeIds.value = (scopeBinding.value?.recipesByProduct[scopeProduct.value] ?? []).map(recipe => recipe.id)
}

async function saveScope(): Promise<void> {
  if (!scopeBinding.value || !scopeProduct.value) return
  savingScope.value = true
  bindingError.value = ''
  try {
    const res = await api.updateSessionBinding(props.channelId, props.sessionId, {
      expectedRevision: scopeBinding.value.overrideRevision,
      productId: scopeProduct.value,
      recipeIds: scopeRecipeIds.value,
    })
    applyBinding(res.data.binding)
    message.success(t('sessionManage.runtime.scopeSaved'))
    await load()
  }
  catch (err) {
    bindingError.value = apiErrorCode(err) === 'SESSION_BINDING_REVISION_CONFLICT'
      ? t('sessionManage.runtime.scopeStale')
      : apiErrorMessage(err)
    if (apiErrorCode(err) === 'SESSION_BINDING_REVISION_CONFLICT') await loadBinding()
  }
  finally {
    savingScope.value = false
  }
}

async function resetScope(): Promise<void> {
  if (!scopeBinding.value) return
  resettingScope.value = true
  bindingError.value = ''
  try {
    const res = await api.updateSessionBinding(props.channelId, props.sessionId, {
      expectedRevision: scopeBinding.value.overrideRevision,
      reset: true,
    })
    applyBinding(res.data.binding)
    message.success(t('sessionManage.runtime.scopeResetDone'))
    await load()
  }
  catch (err) {
    bindingError.value = apiErrorMessage(err)
  }
  finally {
    resettingScope.value = false
  }
}

function kindLabel(value: RuntimeBindingKindDto): string {
  return kindOptions.value.find(o => o.value === value)?.label ?? value
}

async function load(): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const res = await api.getSessionRuntimeBindings(props.channelId, props.sessionId, props.runtimeObjectId)
    if (seq !== loadSeq) return
    summary.value = res.data
    if (!resourceOptions.value.some(o => o.value === resourceId.value)) resourceId.value = ''
  }
  catch (err) {
    if (seq !== loadSeq) return
    summary.value = null
    error.value = apiErrorMessage(err)
  }
  finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch(
  () => [props.channelId, props.sessionId, props.runtimeObjectId] as const,
  () => {
    void load()
    void loadBinding()
  },
  { immediate: true },
)

watch(kind, () => {
  resourceId.value = resourceOptions.value[0]?.value ?? ''
})

async function addBinding(): Promise<void> {
  if (!resourceId.value) return
  adding.value = true
  error.value = ''
  try {
    const res = await api.addAgentBinding({
      agentId: props.runtimeObjectId,
      nodeId: resourceId.value,
      kind: kind.value,
    })
    if (res.data?.notice) message.info(res.data.notice)
    else message.success(t('sessionManage.runtime.bindingAdded'))
    resourceId.value = ''
    await load()
  }
  catch (err) {
    error.value = apiErrorMessage(err)
  }
  finally {
    adding.value = false
  }
}

async function removeBinding(id: string): Promise<void> {
  busyId.value = id
  error.value = ''
  try {
    await api.removeAgentBinding(id)
    message.success(t('sessionManage.runtime.bindingRemoved'))
    await load()
  }
  catch (err) {
    error.value = apiErrorMessage(err)
  }
  finally {
    busyId.value = ''
  }
}

async function switchMode(id: string, mode: 'auto' | 'manual'): Promise<void> {
  busyId.value = id
  error.value = ''
  try {
    await api.updateAgentBinding(id, mode === 'auto' ? { mode: 'auto', confirm: true } : { mode: 'manual' })
    message.success(t('sessionManage.runtime.bindingModeChanged'))
    await load()
  }
  catch (err) {
    // manual→auto 缺确认时后端返回 MODE_CONFIRM_REQUIRED；UI 已用 Popconfirm 显式确认。
    error.value = apiErrorCode(err) === 'MODE_CONFIRM_REQUIRED' ? t('sessionManage.runtime.bindingModeConfirmDesc') : apiErrorMessage(err)
  }
  finally {
    busyId.value = ''
  }
}

async function rebuild(): Promise<void> {
  rebuilding.value = true
  error.value = ''
  try {
    const res = await api.rebuildSessionRuntime(props.channelId, props.sessionId, props.runtimeObjectId)
    message.success(res.data?.queued ? t('sessionManage.runtime.rebuildQueued') : t('sessionManage.runtime.rebuildAlreadyFresh'))
  }
  catch (err) {
    error.value = apiErrorMessage(err)
  }
  finally {
    rebuilding.value = false
  }
}
</script>

<template>
  <section
    class="srb"
    data-testid="session-runtime-bindings"
  >
    <header class="srb-head">
      <div>
        <h3>{{ t('sessionManage.runtime.bindingsTitle') }}</h3>
        <p>{{ t('sessionManage.runtime.bindingsHint') }}</p>
      </div>
      <ConfirmPopover
        v-if="manageable"
        :title="t('sessionManage.runtime.rebuildTitle')"
        :description="t('sessionManage.runtime.rebuildDesc')"
        :ok-text="t('sessionManage.runtime.rebuild')"
        @confirm="rebuild"
      >
        <a-button
          size="small"
          :loading="rebuilding"
          data-testid="session-runtime-rebuild"
        >
          {{ t('sessionManage.runtime.rebuild') }}
        </a-button>
      </ConfirmPopover>
    </header>

    <a-alert
      v-if="error"
      type="error"
      show-icon
      :message="error"
      class="srb-alert"
    />

    <section
      v-if="scopeBinding"
      class="srb-scope"
      data-testid="session-scope"
    >
      <div class="srb-frozen-title">
        {{ t('sessionManage.runtime.scopeTitle') }}
      </div>
      <p class="srb-frozen-hint">
        {{ t('sessionManage.runtime.scopeHint') }}
      </p>
      <a-alert
        v-if="bindingError"
        type="error"
        show-icon
        :message="bindingError"
        class="srb-alert"
      />
      <a-alert
        v-if="!scopeEnabled"
        type="info"
        show-icon
        :message="t('sessionManage.runtime.scopeGeneric')"
      />
      <a-form layout="vertical">
        <a-form-item :label="t('sessionManage.runtime.scopeProduct')">
          <a-select
            v-model:value="scopeProduct"
            :options="productOptions"
            :disabled="!manageable || !scopeEnabled"
            data-testid="session-scope-product"
            @change="onScopeProductChange"
          />
        </a-form-item>
        <a-form-item :label="t('sessionManage.runtime.scopeRecipes')">
          <a-select
            v-model:value="scopeRecipeIds"
            mode="multiple"
            :options="scopeRecipeOptions"
            :disabled="!manageable || !scopeEnabled"
            data-testid="session-scope-recipes"
          />
        </a-form-item>
      </a-form>
      <div class="srb-scope-actions">
        <a-button
          type="primary"
          size="small"
          :loading="savingScope"
          :disabled="!manageable || !scopeEnabled || !scopeProduct"
          data-testid="session-scope-save"
          @click="saveScope"
        >
          {{ t('common.save') }}
        </a-button>
        <ConfirmPopover
          v-if="scopeBinding.source === 'override'"
          :title="t('sessionManage.runtime.scopeResetTitle')"
          :description="t('sessionManage.runtime.scopeResetDesc')"
          :ok-text="t('sessionManage.runtime.scopeReset')"
          @confirm="resetScope"
        >
          <a-button
            size="small"
            :loading="resettingScope"
            data-testid="session-scope-reset"
          >
            {{ t('sessionManage.runtime.scopeReset') }}
          </a-button>
        </ConfirmPopover>
        <span class="srb-scope-meta">
          {{ t('sessionManage.runtime.scopeEffective', { product: scopeBinding.productId ?? '—', recipes: scopeBinding.recipes.length, revision: scopeBinding.revision, source: scopeSourceLabel }) }}
        </span>
      </div>
      <p class="srb-note">
        {{ t('sessionManage.runtime.scopeNote') }}
      </p>
    </section>

    <div
      v-if="loading"
      class="srb-loading"
      role="status"
    >
      <a-spin size="small" />
    </div>

    <template v-else-if="summary">
      <div
        v-if="summary.bindings.length === 0"
        class="srb-empty"
      >
        {{ t('sessionManage.runtime.bindingsEmpty') }}
      </div>
      <table
        v-else
        class="srb-table"
      >
        <thead>
          <tr>
            <th>{{ t('sessionManage.runtime.bindingKind') }}</th>
            <th>{{ t('sessionManage.runtime.bindingResource') }}</th>
            <th>{{ t('sessionManage.runtime.bindingMode') }}</th>
            <th>{{ t('sessionManage.runtime.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="binding in summary.bindings"
            :key="binding.id"
            :data-testid="`session-runtime-binding-row-${binding.id}`"
          >
            <td>{{ kindLabel(binding.kind) }}</td>
            <td>
              <span class="mono">{{ binding.name }}</span>
              <span class="srb-sub">{{ binding.nodeId }}</span>
            </td>
            <td>
              <a-tag :color="binding.mode === 'manual' ? 'gold' : 'green'">
                {{ binding.mode === 'manual' ? t('sessionManage.runtime.bindingModeManual') : t('sessionManage.runtime.bindingModeAuto') }}
              </a-tag>
            </td>
            <td class="srb-actions">
              <ConfirmPopover
                v-if="binding.mode === 'manual'"
                :title="t('sessionManage.runtime.bindingModeConfirmTitle')"
                :description="t('sessionManage.runtime.bindingModeConfirmDesc')"
                :ok-text="t('sessionManage.runtime.bindingModeAutoSwitch')"
                @confirm="switchMode(binding.id, 'auto')"
              >
                <a-button
                  size="small"
                  type="link"
                  :loading="busyId === binding.id"
                  :data-testid="`session-runtime-binding-mode-${binding.id}`"
                >
                  {{ t('sessionManage.runtime.bindingModeAutoSwitch') }}
                </a-button>
              </ConfirmPopover>
              <a-button
                v-else
                size="small"
                type="link"
                :loading="busyId === binding.id"
                :data-testid="`session-runtime-binding-mode-${binding.id}`"
                @click="switchMode(binding.id, 'manual')"
              >
                {{ t('sessionManage.runtime.bindingModeManualSwitch') }}
              </a-button>
              <ConfirmPopover
                :title="t('sessionManage.runtime.bindingRemoveTitle')"
                :description="t('sessionManage.runtime.bindingRemoveDesc')"
                :ok-text="t('sessionManage.runtime.bindingRemove')"
                @confirm="removeBinding(binding.id)"
              >
                <a-button
                  size="small"
                  type="link"
                  danger
                  :loading="busyId === binding.id"
                  :data-testid="`session-runtime-binding-remove-${binding.id}`"
                >
                  {{ t('sessionManage.runtime.bindingRemove') }}
                </a-button>
              </ConfirmPopover>
            </td>
          </tr>
        </tbody>
      </table>

      <div
        v-if="manageable"
        class="srb-add"
      >
        <a-select
          v-model:value="kind"
          :options="kindOptions"
          class="srb-kind"
          data-testid="session-runtime-binding-kind"
        />
        <a-select
          v-model:value="resourceId"
          :options="resourceOptions"
          show-search
          option-filter-prop="label"
          class="srb-resource"
          :placeholder="t('sessionManage.runtime.bindingResource')"
          data-testid="session-runtime-binding-resource"
        />
        <a-button
          type="primary"
          :loading="adding"
          :disabled="!resourceId"
          data-testid="session-runtime-binding-add"
          @click="addBinding"
        >
          {{ t('sessionManage.runtime.bindingAdd') }}
        </a-button>
      </div>
      <p class="srb-note">
        {{ toolRefreshText }}
      </p>
    </template>

    <a-button
      v-if="!summary && !loading"
      size="small"
      @click="load"
    >
      {{ t('sessionManage.runtime.retry') }}
    </a-button>
  </section>
</template>

<style scoped>
.srb {
  margin-top: 18px;
  padding: 14px 16px;
  border: 1px solid var(--line, #e5e7eb);
  border-radius: 6px;
  background: var(--surface-card, #fff);
}
.srb-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.srb-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.srb-head p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ink-soft, #6b7280);
}
.srb-alert {
  margin-top: 10px;
}
.srb-frozen {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px dashed var(--line, #d1d5db);
  border-radius: 4px;
}
.srb-frozen-title {
  font-size: 12px;
  font-weight: 600;
}
.srb-frozen-hint {
  margin: 4px 0 8px;
  font-size: 11px;
  color: var(--ink-faint, #6b7280);
}
.srb-scope {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px dashed var(--line, #d1d5db);
  border-radius: 4px;
}
.srb-scope-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.srb-scope-meta {
  font-size: 11px;
  color: var(--ink-faint, #6b7280);
}
.srb-frozen dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px 16px;
  margin: 0;
  font-size: 12px;
}
.srb-frozen dt {
  color: var(--ink-soft, #6b7280);
  font-size: 11px;
}
.srb-frozen dd {
  margin: 2px 0 0;
  font-family: var(--font-mono, ui-monospace, monospace);
}
.srb-frozen-recipes {
  grid-column: 1 / -1;
}
.srb-loading,
.srb-empty {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 14px 2px;
  font-size: 12.5px;
  color: var(--ink-soft, #6b7280);
}
.srb-table {
  width: 100%;
  margin-top: 10px;
  border-collapse: collapse;
  font-size: 12.5px;
}
.srb-table th,
.srb-table td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--line, #eef0f2);
  text-align: left;
  vertical-align: middle;
}
.srb-table th {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-soft, #6b7280);
}
.srb-sub {
  margin-left: 6px;
  font-size: 11px;
  color: var(--ink-faint, #6b7280);
  font-family: var(--font-mono, ui-monospace, monospace);
}
.srb-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.srb-add {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.srb-kind {
  width: 150px;
}
.srb-resource {
  min-width: 220px;
  flex: 1;
}
.srb-note {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--ink-faint, #6b7280);
}
.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}
@media (max-width: 760px) {
  .srb-frozen dl {
    grid-template-columns: 1fr;
  }
  .srb-table {
    min-width: 620px;
  }
  .srb {
    overflow-x: auto;
  }
}
</style>
