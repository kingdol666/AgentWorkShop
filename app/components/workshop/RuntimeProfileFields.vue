<script setup lang="ts">
/**
 * 运行模型选择（harness 原生目录）：provider / model / effort。
 *
 * 用于 Agent 模板、添加成员、编辑成员与会话 runtime 三处；空串 = 未指定
 * （由该引擎/频道默认决定）。模型与 provider 都可以直接输入自定义值。
 */
import { computed, ref, watch } from 'vue'
import { useWorkshopApi, type HarnessMetaDto } from '~/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

interface CatalogModel { id: string, efforts: string[] }
interface CatalogProvider { id: string, models: CatalogModel[] }
interface Catalog { providers: CatalogProvider[], effortMode: 'levels' | 'freetext' | 'unsupported', note?: string }

const props = defineProps<{
  harness: string
  /** 页面已拉取的 harness 注册表（避免重复请求） */
  harnesses?: HarnessMetaDto[]
  /** 用户是否显式改过 harness；只有显式改动才自动清理不兼容值（打开回填绝不能删值） */
  harnessTouched?: boolean
  testidPrefix?: string
}>()

const provider = defineModel<string>('provider', { default: '' })
const model = defineModel<string>('model', { default: '' })
const effort = defineModel<string>('effort', { default: '' })

const { t } = useI18n()
const api = useWorkshopApi()
const fetched = ref<HarnessMetaDto[]>([])
const catalog = ref<Catalog | null>(null)
const error = ref('')
const loading = ref(false)
const providerSearch = ref('')
const modelSearch = ref('')
let loadSeq = 0

const prefix = computed(() => props.testidPrefix ?? 'runtime-profile')
const metas = computed(() => (props.harnesses?.length ? props.harnesses : fetched.value))
const support = computed(() => {
  const meta = metas.value.find(h => h.id === props.harness)
  return meta?.profile ?? { provider: true, model: true, effort: true }
})
const providerValues = computed(() => (catalog.value?.providers ?? []).map(p => p.id))
const allModels = computed(() => [...new Map((catalog.value?.providers ?? []).flatMap(p => p.models.map(m => [m.id, m] as const))).values()])
const modelValues = computed(() => {
  const list = provider.value
    ? catalog.value?.providers.find(p => p.id === provider.value)?.models ?? []
    : allModels.value
  return list.map(m => m.id)
})
const currentModel = computed(() => allModels.value.find(m => m.id === model.value) ?? null)

function options(values: string[], search: string) {
  const out = [{ value: '', label: t('runtimeProfile.default') }, ...values.filter(Boolean).map(v => ({ value: v, label: v }))]
  const text = search.trim()
  if (text && !values.includes(text)) out.push({ value: text, label: `${text}（${t('runtimeProfile.custom')}）` })
  return out
}

const providerOptions = computed(() => options(providerValues.value, providerSearch.value))
const modelOptions = computed(() => options(modelValues.value, modelSearch.value))
const effortValues = computed(() => {
  if (!catalog.value || catalog.value.effortMode === 'unsupported') return []
  if (catalog.value.effortMode === 'freetext') return []
  if (currentModel.value) return currentModel.value.efforts
  return [...new Set(allModels.value.flatMap(m => m.efforts))]
})

async function loadHarnesses(): Promise<void> {
  if (props.harnesses?.length) return
  try {
    const res = await api.listHarnesses()
    fetched.value = res.data?.harnesses ?? []
  }
  catch { /* 注册表不可用时按“全部支持”展示，由后端最终校验 */ }
}

async function loadCatalog(harness: string, reconcile = false): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const res = await api.listHarnessProviders(harness)
    if (seq !== loadSeq) return
    catalog.value = res.data?.catalog ?? null
    if (reconcile) reconcileSelectors()
  }
  catch (err) {
    if (seq !== loadSeq) return
    catalog.value = null
    error.value = apiErrorMessage(err)
  }
  finally {
    if (seq === loadSeq) loading.value = false
  }
}

/** 仅在用户显式切换 harness 时清理目标引擎读不了/目录里没有的旧值。 */
function reconcileSelectors(): void {
  if (!support.value.provider) provider.value = ''
  if (!support.value.model) model.value = ''
  if (!support.value.effort || catalog.value?.effortMode === 'unsupported') effort.value = ''
  if (provider.value && providerValues.value.length > 0 && !providerValues.value.includes(provider.value)) provider.value = ''
  if (model.value && modelValues.value.length > 0 && !modelValues.value.includes(model.value)) model.value = ''
  if (effort.value && catalog.value?.effortMode === 'levels' && effortValues.value.length > 0
    && !effortValues.value.includes(effort.value)) effort.value = ''
}

watch(
  () => props.harness,
  (value) => {
    if (!value) return
    void loadHarnesses()
    // 初次挂载/回填：只加载目录，不动用户既有值。只有显式 harness 改动才收敛。
    void loadCatalog(value, Boolean(props.harnessTouched))
  },
  { immediate: true },
)

function onProviderChange(): void {
  // 用户改 provider 后，旧 model 很可能不属于新 provider；清空让用户重选。
  if (model.value && modelValues.value.length > 0 && !modelValues.value.includes(model.value)) model.value = ''
}

function onModelChange(): void {
  if (effort.value && catalog.value?.effortMode === 'levels' && effortValues.value.length > 0
    && !effortValues.value.includes(effort.value)) effort.value = ''
}

function onProviderSearch(value: string): void {
  providerSearch.value = value
}

function onModelSearch(value: string): void {
  modelSearch.value = value
}
</script>

<template>
  <div
    class="rpf"
    :data-testid="`${prefix}-fields`"
  >
    <a-alert
      v-if="error"
      type="warning"
      show-icon
      :message="error"
      class="rpf-alert"
    >
      <template #action>
        <a-button
          size="small"
          @click="loadCatalog(harness)"
        >
          {{ t('runtimeProfile.retry') }}
        </a-button>
      </template>
    </a-alert>
    <a-form-item
      v-if="support.provider"
      :label="t('runtimeProfile.provider')"
    >
      <a-select
        v-model:value="provider"
        :options="providerOptions"
        show-search
        :filter-option="false"
        :loading="loading"
        :data-testid="`${prefix}-provider`"
        @search="onProviderSearch"
        @change="onProviderChange"
      />
    </a-form-item>
    <a-form-item
      v-if="support.model"
      :label="t('runtimeProfile.model')"
    >
      <a-select
        v-model:value="model"
        :options="modelOptions"
        show-search
        :filter-option="false"
        :loading="loading"
        :data-testid="`${prefix}-model`"
        @search="onModelSearch"
        @change="onModelChange"
      />
      <template #extra>
        <span class="rpf-hint">{{ t('runtimeProfile.hint') }}</span>
      </template>
    </a-form-item>
    <a-form-item
      v-if="support.effort"
      :label="t('runtimeProfile.effort')"
    >
      <a-input
        v-if="catalog?.effortMode === 'freetext'"
        v-model:value="effort"
        :placeholder="catalog?.note ?? 'variant'"
        :data-testid="`${prefix}-effort`"
      />
      <a-select
        v-else
        v-model:value="effort"
        :options="[{ value: '', label: t('runtimeProfile.default') }, ...effortValues.map(e => ({ value: e, label: e }))]"
        :data-testid="`${prefix}-effort`"
      />
    </a-form-item>
  </div>
</template>

<style scoped>
.rpf-alert {
  margin-bottom: 10px;
}
.rpf-hint {
  font-size: 11px;
  color: var(--ink-faint, #6b7280);
}
</style>
