<script setup lang="ts">
/**
 * SaveTemplateModal —— 「保存为模板」弹窗:把当前 Channel 实例捕获为可复用模板
 * (场景/目录/团队快照)。打开时以 channelName 预填模板名;成功后 emit('saved')。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'

const { t } = useI18n()

const props = defineProps<{ channelId: string, channelName: string }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  (e: 'saved'): void
}>()

const api = useWorkshopApi()

// 保存为模板(捕获当前 channel 的场景/目录/团队)
const saveTplForm = reactive({ name: '', description: '', visibility: 'private' as 'private' | 'public' })
const saveTplSubmitting = ref(false)
const openSaveTemplate = (): void => {
  saveTplForm.name = t('channelSessionList.k2hfym5043', { p0: props.channelName || 'channel' })
  saveTplForm.description = ''
  saveTplForm.visibility = 'private'
}
/** 弹窗打开时预填(与原 openSaveTemplate 在点击时同步预填等价) */
watch(open, (v) => {
  if (v) openSaveTemplate()
})
const saveAsTemplate = async (): Promise<void> => {
  if (!saveTplForm.name.trim()) {
    message.warning(t('channelSessionList.k1i0ji0y032'))
    return
  }
  saveTplSubmitting.value = true
  try {
    await api.captureChannelTemplate({
      channelId: props.channelId,
      name: saveTplForm.name.trim(),
      description: saveTplForm.description || undefined,
      visibility: saveTplForm.visibility,
    })
    message.success(t('channelSessionList.kjpguxw033'))
    open.value = false
    emit('saved')
  }
  catch (e) {
    message.error(apiErrorMessage(e))
  }
  finally {
    saveTplSubmitting.value = false
  }
}
</script>

<template>
  <!-- 保存为模板 -->
  <a-modal
    v-model:open="open"
    :title="$t('channelSessionList.k6kpql010')"
    :confirm-loading="saveTplSubmitting"
    :ok-text="$t('channelSessionList.saveTplOk')"
    :cancel-text="$t('common.cancel')"
    @ok="saveAsTemplate"
  >
    <a-form layout="vertical">
      <a-form-item :label="$t('channelSessionList.k1f55q76011')">
        <a-input v-model:value="saveTplForm.name" />
      </a-form-item>
      <a-form-item :label="$t('channelSessionList.k40gkk003')">
        <a-input v-model:value="saveTplForm.description" />
      </a-form-item>
      <a-form-item :label="$t('channelSessionList.k3lrqn0012')">
        <a-radio-group v-model:value="saveTplForm.visibility">
          <a-radio value="private">
            {{ $t('channelSessionList.k1otvrfv022') }}
          </a-radio>
          <a-radio value="public">
            {{ $t('channelSessionList.k1cc399s023') }}
          </a-radio>
        </a-radio-group>
      </a-form-item>
      <a-form-item>
        <span class="ws-hint">{{ $t('channelSessionList.kl9btf7024') }}</span>
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.ws-hint { font-size: 11px; color: var(--ink-faint); }
</style>
