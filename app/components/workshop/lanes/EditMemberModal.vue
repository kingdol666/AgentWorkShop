<script setup lang="ts">
/**
 * 编辑成员弹窗 —— 改名 / 改场景提示词(systemPromptPrefix)。
 * 状态自持:打开(open false→true)时从 agent prop 回填表单,与拆分前
 * openEditMember 的赋值逐字段一致(仅 systemPromptPrefix 从 config 暴露)。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { useEntitiesStore, type AgentView } from '@/app/stores/workshop/entities'

const props = defineProps<{
  channelId: string
  agent: AgentView | null
}>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const api = useWorkshopApi()
const entities = useEntitiesStore()

const editSubmitting = ref(false)
const editForm = reactive({ agentId: '', name: '', role: 'worker' as 'lead' | 'worker', harness: '', systemPrompt: '' })

// 打开即回填(拆分前由父级 openEditMember 同步赋值,时序等价)
watch(open, (v) => {
  if (!v) return
  const a = props.agent
  if (!a) return
  editForm.agentId = a.agentId
  editForm.name = a.name
  editForm.role = a.role === 'lead' ? 'lead' : 'worker'
  editForm.harness = a.harness
  editForm.systemPrompt = typeof a.config?.systemPromptPrefix === 'string' ? a.config.systemPromptPrefix : ''
})

const submitEditMember = async (): Promise<void> => {
  const name = editForm.name.trim()
  if (!name) {
    message.warning(t('agentLanesView.ky6jqt4032'))
    return
  }
  editSubmitting.value = true
  try {
    await api.updateChannelAgent(props.channelId, editForm.agentId, {
      name,
      config: {
        // 保留既有 config,仅更新 systemPromptPrefix(编辑弹窗只暴露该字段)
        ...(entities.agents[props.channelId]?.find(a => a.agentId === editForm.agentId)?.config ?? {}),
        systemPromptPrefix: editForm.systemPrompt.trim(),
      },
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
          <a-tag>{{ editForm.harness }}</a-tag>
        </a-space>
      </a-form-item>
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
