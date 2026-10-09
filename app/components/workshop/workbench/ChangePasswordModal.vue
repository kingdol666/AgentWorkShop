<script setup lang="ts">
/**
 * 首登强制改密门(admin 建号下发临时口令 / 管理员重置后弹出)。
 * 不可关闭(maskClosable=false + 无取消按钮):改密成功前不得进入工作台 ——
 * 口令经管理员之手,不属于用户本人的秘密。状态真源是 userStore.user
 * .mustChangePassword(服务端 /me 也带同一字段,双保险)。
 */
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import { apiErrorMessage } from '@/app/utils/api-error'

const { t } = useI18n()
const userStore = useUserStore()

const current = ref('')
const next = ref('')
const confirm = ref('')
const loading = ref(false)

const submit = async (): Promise<void> => {
  if (!current.value || !next.value) {
    message.warning(t('wsHome.mcFillBoth'))
    return
  }
  if (next.value !== confirm.value) {
    message.warning(t('wsHome.mcMismatch'))
    return
  }
  if (next.value.length < 6 || !/[A-Za-z]/.test(next.value) || !/[0-9]/.test(next.value)) {
    message.warning(t('wsHome.mcPolicy'))
    return
  }
  if (next.value === current.value) {
    message.warning(t('wsHome.mcSameAsOld'))
    return
  }
  loading.value = true
  try {
    await userStore.changePassword(current.value, next.value)
    current.value = ''
    next.value = ''
    confirm.value = ''
    message.success(t('wsHome.mcDone'))
  }
  catch (e) {
    message.error(apiErrorMessage(e))
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <a-modal
    :open="userStore.user?.mustChangePassword === true"
    :closable="false"
    :mask-closable="false"
    :keyboard="false"
    :title="t('wsHome.mcTitle')"
    :width="440"
  >
    <p class="mc-sub">
      {{ t('wsHome.mcSub', { p0: userStore.user?.name ?? '' }) }}
    </p>
    <a-space
      direction="vertical"
      style="width: 100%"
    >
      <a-input-password
        v-model:value="current"
        :placeholder="t('wsHome.mcCurrent')"
        @keydown.enter="submit"
      />
      <a-input-password
        v-model:value="next"
        :placeholder="t('wsHome.mcNew')"
        @keydown.enter="submit"
      />
      <a-input-password
        v-model:value="confirm"
        :placeholder="t('wsHome.mcConfirm')"
        @keydown.enter="submit"
      />
      <p class="mc-hint">
        {{ t('wsHome.mcPolicyHint') }}
      </p>
    </a-space>
    <template #footer>
      <a-button
        type="primary"
        block
        :loading="loading"
        @click="submit"
      >
        {{ t('wsHome.mcCta') }}
      </a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.mc-sub { margin: 0 0 12px; font-size: 12.5px; color: var(--ink-faint, #888); }
.mc-hint { margin: 4px 0 0; font-size: 11px; color: var(--ink-faint, #888); }
</style>
