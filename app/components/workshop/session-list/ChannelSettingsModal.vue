<script setup lang="ts">
/**
 * ChannelSettingsModal —— 「Channel 实例设置」弹窗:场景描述/工作目录热更新
 * (成员运行时自动回收重装配)+ channel 级默认 LLM + channel 级插件开关
 * + 「保存为模板」入口。打开时按行元数据 channelMeta 预填表单;
 * 保存成功 emit('saved'),由父组件刷新 channel 列表。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type ChannelDto } from '@/app/composables/workshop/useWorkshopApi'

const { t } = useI18n()

const props = defineProps<{ channelId: string, channelMeta: ChannelDto | undefined }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  (e: 'saved'): void
  (e: 'save-template', name: string): void
}>()

const api = useWorkshopApi()

// ===== Channel 实例设置(场景/工作目录热更新)+ 保存为模板 =====
const settingsForm = reactive({ name: '', scenarioPrompt: '', workspace: '' })

// ===== Channel 级默认 LLM(harness → provider/model/effort;空 = 用引擎默认) =====
interface CatalogProvider {
  id: string
  models: Array<{ id: string, efforts: string[], defaultEffort?: string }>
}
const llmForm = reactive({ harness: 'omp', provider: '', model: '', effort: '', enabled: false })
const llmProviders = ref<CatalogProvider[]>([])
const llmEffortMode = ref<'levels' | 'freetext' | 'unsupported'>('levels')
const llmLoading = ref(false)
const llmProviderOptions = computed(() => llmProviders.value.map(p => ({ value: p.id, label: p.id })))
const llmModelOptions = computed(() =>
  (llmProviders.value.find(p => p.id === llmForm.provider)?.models ?? []).map(m => ({ value: m.id, label: m.id })),
)
const llmEffortOptions = computed(() => {
  const m = llmProviders.value.find(p => p.id === llmForm.provider)?.models.find(x => x.id === llmForm.model)
  return (m?.efforts ?? []).map(e => ({ value: e, label: e + (m?.defaultEffort === e ? t('channelSessionList.defaultSuffix') : '') }))
})
const loadLlmCatalog = async (harness: string): Promise<void> => {
  llmLoading.value = true
  llmProviders.value = []
  try {
    const res = await api.listHarnessProviders(harness)
    const cat = (res as unknown as { data?: { catalog?: { providers?: CatalogProvider[], effortMode?: 'levels' | 'freetext' | 'unsupported' } } })?.data?.catalog
    llmProviders.value = cat?.providers ?? []
    llmEffortMode.value = cat?.effortMode ?? 'unsupported'
  }
  catch { /* 目录拉取失败保留空表 */ }
  finally { llmLoading.value = false }
}
const onLlmHarnessChange = async (): Promise<void> => {
  llmForm.provider = ''
  llmForm.model = ''
  llmForm.effort = ''
  await loadLlmCatalog(llmForm.harness)
}
const onLlmProviderChange = (): void => {
  llmForm.model = ''
  llmForm.effort = ''
}
const onLlmModelChange = (): void => {
  llmForm.effort = ''
}
const settingsSaving = ref(false)
const fileSelectorOpen2 = ref(false)
/** channel 设置弹窗预填的默认 LLM(llmJson 反序列化形状;与服务端 channelLlmSchema 对齐) */
interface ChannelLlmDefaults { provider?: string, model?: string, effort?: string }
const openSettings = (): void => {
  const meta = props.channelMeta
  settingsForm.name = meta?.name ?? ''
  settingsForm.scenarioPrompt = meta?.scenarioPrompt ?? ''
  settingsForm.workspace = meta?.workspace ?? ''
  // 预填 channel 默认 LLM(llmJson 由列表接口透传)
  let saved: ChannelLlmDefaults | null = null
  try {
    const metaAny = meta as unknown as { llmJson?: string } | undefined
    saved = metaAny?.llmJson ? JSON.parse(metaAny.llmJson) as ChannelLlmDefaults : null
  }
  catch { saved = null }
  llmForm.enabled = !!saved?.model
  llmForm.harness = 'omp'
  llmForm.provider = saved?.provider ?? ''
  llmForm.model = saved?.model ?? ''
  llmForm.effort = saved?.effort ?? ''
  if (llmForm.enabled) void loadLlmCatalog(llmForm.harness)
  void loadChannelPlugins(props.channelId)
}
/** 弹窗打开时预填(与原 openSettings 在点击时同步预填等价) */
watch(open, (v) => {
  if (v) openSettings()
})

// ===== Channel 级插件开关(设置弹窗内嵌;切换即 PUT,该 channel 在跑 Agent 工具清单热刷新) =====
interface ChannelPluginRow { name: string, description?: string, builtin?: boolean, enabled: boolean }
const pluginRows = ref<ChannelPluginRow[]>([])
const pluginSource = ref<'explicit' | 'default'>('default')
const pluginSaving = ref<string | null>(null)
const loadChannelPlugins = async (channelId: string): Promise<void> => {
  try {
    const res = await api.listChannelPlugins(channelId)
    const data = res?.data ?? {}
    pluginRows.value = data.plugins ?? []
    pluginSource.value = data.source === 'explicit' ? 'explicit' : 'default'
  }
  catch { /* 插件视图不可得(未登录/网络)时留空,不阻塞设置弹窗 */ }
}
const toggleChannelPlugin = async (row: ChannelPluginRow, next: boolean): Promise<void> => {
  if (pluginSaving.value) return
  pluginSaving.value = row.name
  try {
    // 全量提交当前开关视图(仅翻转目标行),与 teams 页插件开关同语义
    const payload = pluginRows.value.map(r => ({ name: r.name, enabled: r.name === row.name ? next : r.enabled }))
    const res = await api.putChannelPlugins(props.channelId, { plugins: payload })
    const data = res?.data ?? {}
    pluginRows.value = data.plugins ?? payload.map(p => ({ ...p }))
    pluginSource.value = data.source === 'explicit' ? 'explicit' : 'default'
    message.success(t('channelSessionList.k1plugon044'))
  }
  catch (e) {
    message.error(apiErrorMessage(e))
  }
  finally {
    pluginSaving.value = null
  }
}
const saveSettings = async (): Promise<void> => {
  settingsSaving.value = true
  try {
    await api.patchChannel(props.channelId, {
      scenarioPrompt: settingsForm.scenarioPrompt,
      workspace: settingsForm.workspace.trim() || undefined,
      llm: llmForm.enabled && llmForm.model
        ? { ...(llmForm.provider ? { provider: llmForm.provider } : {}), model: llmForm.model, ...(llmForm.effort ? { effort: llmForm.effort } : {}) }
        : null,
    })
    message.success(t('channelSessionList.kvsxlu6031'))
    open.value = false
    emit('saved')
  }
  catch (e) {
    message.error(apiErrorMessage(e))
  }
  finally {
    settingsSaving.value = false
  }
}

/** 「保存为模板」入口:把当前渠道名交给父组件打开保存弹窗(捕获当前 channel 的场景/目录/团队) */
const openSaveTemplate = (): void => {
  emit('save-template', settingsForm.name)
}
</script>

<template>
  <!-- Channel 实例设置:场景/工作目录热更新 + 保存为模板 -->
  <a-modal
    v-model:open="open"
    :title="$t('channelSessionList.k1pmemvt039', { p0: settingsForm.name })"
    :confirm-loading="settingsSaving"
    :ok-text="$t('common.save')"
    :cancel-text="$t('common.cancel')"
    @ok="saveSettings"
  >
    <a-form layout="vertical">
      <a-form-item :label="$t('channelSessionList.k1i8q46x007')">
        <a-textarea
          v-model:value="settingsForm.scenarioPrompt"
          :rows="4"
          :placeholder="$t('channelSessionList.ku3ugac008')"
        />
      </a-form-item>
      <a-form-item :label="$t('channelSessionList.k67dzev009')">
        <a-input-group compact>
          <a-input
            v-model:value="settingsForm.workspace"
            style="width: 70%"
            placeholder="data/workspaces/<channelId>"
            allow-clear
          />
          <a-button
            style="width: 30%"
            @click="fileSelectorOpen2 = true"
          >
            {{ $t('channelSessionList.k3pz0ma018') }}
          </a-button>
        </a-input-group>
      </a-form-item>
      <a-form-item :label="$t('channelSessionList.llmDefaultLabel')">
        <a-space>
          <a-switch
            v-model:checked="llmForm.enabled"
            size="small"
            @change="(v: any) => { if (v) void loadLlmCatalog(llmForm.harness) }"
          />
          <a-select
            v-model:value="llmForm.harness"
            style="width: 130px"
            :options="[{ value: 'omp', label: 'omp' }, { value: 'codex', label: 'codex' }, { value: 'opencode', label: 'opencode' }, { value: 'dsh', label: 'dsh' }]"
            :disabled="!llmForm.enabled"
            @change="onLlmHarnessChange"
          />
          <a-select
            v-model:value="llmForm.provider"
            style="width: 170px"
            :placeholder="llmLoading ? $t('channelSessionList.catalogLoading') : 'provider'"
            :options="llmProviderOptions"
            :disabled="!llmForm.enabled || llmLoading"
            show-search
            @change="onLlmProviderChange"
          />
          <a-select
            v-model:value="llmForm.model"
            style="width: 210px"
            placeholder="model"
            :options="llmModelOptions"
            :disabled="!llmForm.enabled || !llmForm.provider"
            show-search
            @change="onLlmModelChange"
          />
          <a-select
            v-if="llmEffortMode === 'levels'"
            v-model:value="llmForm.effort"
            style="width: 130px"
            :placeholder="$t('channelSessionList.effortPh')"
            :options="llmEffortOptions"
            :disabled="!llmForm.enabled || !llmForm.model"
            allow-clear
          />
          <a-input
            v-else-if="llmEffortMode === 'freetext'"
            v-model:value="llmForm.effort"
            style="width: 130px"
            :placeholder="$t('channelSessionList.variantPh')"
            :disabled="!llmForm.enabled || !llmForm.model"
            allow-clear
          />
        </a-space>
      </a-form-item>
      <a-form-item :label="t('channelSessionList.k1pluglbl045')">
        <div
          v-if="pluginRows.length"
          class="ch-plugin-list"
        >
          <div
            v-for="p in pluginRows"
            :key="p.name"
            class="ch-plugin-row"
          >
            <div class="ch-plugin-main">
              <span class="aw-mono">{{ p.name }}</span>
              <span
                v-if="p.builtin"
                class="ws-hint"
              >{{ $t('channelSessionList.builtinTag') }}</span>
              <span
                v-if="p.description"
                class="ws-hint ch-plugin-desc"
              >{{ p.description }}</span>
            </div>
            <a-switch
              :checked="p.enabled"
              size="small"
              :loading="pluginSaving === p.name"
              @change="(v: any) => toggleChannelPlugin(p, !!v)"
            />
          </div>
          <span
            v-if="pluginSource !== 'explicit'"
            class="ws-hint"
          >{{ t('channelSessionList.k1plugsrc046') }}</span>
        </div>
        <span
          v-else
          class="ws-hint"
        >—</span>
      </a-form-item>
      <a-form-item>
        <a-button
          size="small"
          @click="openSaveTemplate"
        >
          <span class="i-tabler-template" />
          {{ $t('channelSessionList.k6kpql010') }}
        </a-button>
        <span class="ws-hint">{{ $t('channelSessionList.k1x6kznr021') }}</span>
      </a-form-item>
    </a-form>
  </a-modal>

  <workshop-file-selector-modal
    v-model:open="fileSelectorOpen2"
    :title="$t('channelSessionList.kbdp56k013')"
    :initial-path="settingsForm.workspace || undefined"
    @select="(p) => { settingsForm.workspace = p }"
  />
</template>

<style scoped>
.ch-plugin-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.ch-plugin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 8px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  border-radius: 6px;
}
.ch-plugin-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.ch-plugin-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-hint { font-size: 11px; color: var(--ink-faint); }
</style>
