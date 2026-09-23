<script setup lang="ts">
/**
 * MountChannelModal —— 「新建 Channel 并挂载(空团队)」弹窗。
 * 表单字段/成功与失败提示/提交后字段重置语义保持不变;
 * 挂载成功后 emit('mounted'),由父组件刷新 channel 列表。
 */
import { message } from 'ant-design-vue'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'

const { t } = useI18n()

const props = defineProps<{ wsId: string }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  (e: 'mounted'): void
}>()

const wsStore = useWorkspacesStore()
const api = useWorkshopApi()

// ===== 新建 Channel 并挂载(空团队) =====
const mountForm = reactive({ name: '', description: '', workspace: '', scenarioPrompt: '' })
const mountSubmitting = ref(false)
/** FileSelector 弹窗(选择服务器目录作为 workspace) */
const fileSelectorOpen = ref(false)
const createAndMount = async (): Promise<void> => {
  if (!mountForm.name.trim()) {
    message.warning(t('channelSessionList.nameRequired'))
    return
  }
  mountSubmitting.value = true
  try {
    const res = await api.createChannel({
      name: mountForm.name.trim(),
      description: mountForm.description || undefined,
      scenarioPrompt: mountForm.scenarioPrompt.trim() || undefined,
      workspace: mountForm.workspace.trim() || undefined,
    })
    const created = (res as unknown as { data?: { channelId?: string } })?.data
    const channelId = created?.channelId
    if (!channelId) throw new Error(t('channelSessionList.k1bg6shc027'))
    await wsStore.mountChannel(props.wsId, channelId)
    open.value = false
    mountForm.name = ''
    mountForm.description = ''
    mountForm.workspace = ''
    mountForm.scenarioPrompt = ''
    emit('mounted')
    message.success(t('channelSessionList.kn89jvs028'))
  }
  catch (e) {
    message.error(t('channelSessionList.k1x2th9e041', { p0: apiErrorMessage(e) }))
  }
  finally {
    mountSubmitting.value = false
  }
}
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="$t('channelSessionList.k1qjyl6l002')"
    :confirm-loading="mountSubmitting"
    :ok-text="$t('common.create')"
    :cancel-text="$t('common.cancel')"
    @ok="createAndMount"
  >
    <a-form layout="vertical">
      <a-form-item :label="$t('channelSessionList.nameLabel')">
        <a-input v-model:value="mountForm.name" />
      </a-form-item>
      <a-form-item :label="$t('channelSessionList.k40gkk003')">
        <a-input v-model:value="mountForm.description" />
      </a-form-item>
      <a-form-item :label="$t('channelSessionList.k1wj4f38004')">
        <a-textarea
          v-model:value="mountForm.scenarioPrompt"
          :rows="4"
          :placeholder="$t('channelSessionList.k1098zie005')"
        />
        <template #extra>
          <span class="ws-hint">{{ $t('channelSessionList.k1u3zsr5017') }}</span>
        </template>
      </a-form-item>
      <a-form-item :label="$t('channelSessionList.kmgv4h5006')">
        <a-input-group compact>
          <a-input
            v-model:value="mountForm.workspace"
            style="width: 70%"
            :placeholder="$t('channelSessionList.wsPh1')"
            allow-clear
            @press-enter="createAndMount"
          />
          <a-button
            style="width: 30%"
            @click="fileSelectorOpen = true"
          >
            {{ $t('channelSessionList.k3pz0ma018') }}
          </a-button>
        </a-input-group>
        <template #extra>
          <span class="ws-hint">{{ $t('channelSessionList.kucq30k019') }}</span>
        </template>
      </a-form-item>
      <a-form-item>
        <span class="ws-hint">{{ $t('channelSessionList.k1ful761020') }}</span>
      </a-form-item>
    </a-form>
  </a-modal>

  <!-- FileSelector:服务器目录选择 -> 回填工作目录 -->
  <workshop-file-selector-modal
    v-model:open="fileSelectorOpen"
    :title="$t('channelSessionList.kbdp56k013')"
    :initial-path="mountForm.workspace || undefined"
    @select="(p) => { mountForm.workspace = p }"
  />
</template>

<style scoped>
.ws-hint { font-size: 11px; color: var(--ink-faint); }
</style>
