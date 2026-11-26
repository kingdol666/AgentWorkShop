<script setup lang="ts">
/**
 * 编辑成员弹窗 —— 改名 / 改场景提示词(systemPromptPrefix)。
 * 状态自持:打开(open false→true)时从 agent prop 回填表单,与拆分前
 * openEditMember 的赋值逐字段一致(仅 systemPromptPrefix 从 config 暴露)。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { useEntitiesStore, type AgentView } from '@/app/stores/workshop/entities'
import { useAgentHarnessOptions } from '@/app/pages/workshop/composables/useAgentHarnessOptions'

const props = defineProps<{
  channelId: string
  agent: AgentView | null
}>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const api = useWorkshopApi()
const entities = useEntitiesStore()
const { harnessOptions, harnesses } = useAgentHarnessOptions()

const editSubmitting = ref(false)
const harnessTouched = ref(false)
const editForm = reactive({
  agentId: '',
  name: '',
  role: 'worker' as 'lead' | 'worker',
  harness: '',
  systemPrompt: '',
  provider: '',
  model: '',
  effort: '',
})

// 打开即回填(拆分前由父级 openEditMember 同步赋值,时序等价)
watch(open, (v) => {
  if (!v) return
  const a = props.agent
  if (!a) return
  const config = (a.config ?? {}) as Record<string, unknown>
  editForm.agentId = a.agentId
  editForm.name = a.name
  editForm.role = a.role === 'lead' ? 'lead' : 'worker'
  editForm.harness = a.harness
  editForm.systemPrompt = typeof config.systemPromptPrefix === 'string' ? config.systemPromptPrefix : ''
  editForm.provider = typeof config.provider === 'string' ? config.provider : ''
  editForm.model = typeof config.model === 'string' ? config.model : ''
  const alias = a.harness === 'omp' ? 'thinkingLevel' : a.harness === 'opencode' ? 'variant' : a.harness === 'pi' ? 'thinking' : ''
  editForm.effort = typeof config.effort === 'string'
    ? config.effort
    : alias && typeof config[alias] === 'string' ? config[alias] as string : ''
  harnessTouched.value = false
})

const submitEditMember = async (): Promise<void> => {
  const name = editForm.name.trim()
  if (!name) {
    message.warning(t('agentLanesView.ky6jqt4032'))
    return
  }
  editSubmitting.value = true
  try {
    const existing = entities.agents[props.channelId]?.find(a => a.agentId === editForm.agentId)?.config ?? {}
    const config: Record<string, unknown> = {
      ...existing,
      systemPromptPrefix: editForm.systemPrompt.trim(),
    }
    // 结构化字段为权威：空 = 从 config 删除该键
    for (const [key, value] of Object.entries({
      provider: editForm.provider.trim(),
      model: editForm.model.trim(),
      effort: editForm.effort.trim(),
    })) {
      if (value) config[key] = value
      else {
        Reflect.deleteProperty(config, key)
        if (key === 'effort') {
          for (const alias of ['thinkingLevel', 'variant', 'thinking']) Reflect.deleteProperty(config, alias)
        }
      }
    }
    const harnessChanged = editForm.harness !== props.agent?.harness
    await api.updateChannelAgent(props.channelId, editForm.agentId, {
      name,
      ...(harnessChanged ? { harness: editForm.harness } : {}),
      config,
      reason: t('agentLanesView.kfvflle033'),
    })
    message.success(t('agentLanesView.k21xjz2044', { p0: name }))
    open.value = false
  }
  catch (err) {
    message.error(t('agentLanesView.k3jmrw1045', { p0: apiErrorMessage(err) }))
  }
  finally {
    editSubmitting.value = false
  }
}
</script>

<template>
  <!-- 编辑成员(名 / 场景提示词) -->
  <a-modal
    v-model:open="open"
    :title="$t('agentLanesView.k19j5rho041', { p0: editForm.name || '' })"
    :confirm-loading="editSubmitting"
    :ok-text="$t('common.save')"
    :cancel-text="$t('common.cancel')"
    @ok="submitEditMember"
  >
    <a-form
      layout="vertical"
      class="member-form"
    >
      <a-form-item :label="$t('agentLanesView.k3nufdm005')">
        <a-input v-model:value="editForm.name" />
      </a-form-item>
      <a-form-item :label="$t('agentLanesView.roleHarnessLabel')">
        <a-space>
          <a-tag :color="editForm.role === 'lead' ? 'purple' : 'blue'">
            {{ editForm.role }}
          </a-tag>
        </a-space>
      </a-form-item>
      <a-form-item label="harness">
        <a-select
          v-model:value="editForm.harness"
          :options="harnessOptions"
          show-search
          option-filter-prop="label"
          data-testid="edit-member-harness"
          @change="harnessTouched = true"
        />
      </a-form-item>
      <a-divider>{{ $t('runtimeProfile.section') }}</a-divider>
      <workshop-runtime-profile-fields
        v-model:provider="editForm.provider"
        v-model:model="editForm.model"
        v-model:effort="editForm.effort"
        :harness="editForm.harness"
        :harnesses="harnesses"
        :harness-touched="harnessTouched"
        testid-prefix="edit-member-profile"
      />
      <a-form-item :label="$t('agentLanesView.syspromptLabel')">
        <a-textarea
          v-model:value="editForm.systemPrompt"
          :rows="6"
          :placeholder="$t('agentLanesView.k10ti81i015')"
        />
        <template #extra>
          <span class="ws-hint">{{ $t('agentLanesView.k1rw1rd2031') }}</span>
        </template>
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.member-form { margin-top: 8px; }
</style>
