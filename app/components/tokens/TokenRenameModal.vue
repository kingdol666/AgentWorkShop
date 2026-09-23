<script setup lang="ts">
/**
 * 重命名 Token 弹窗:草稿(label)与目标行 id 都由页面的 useTokenRename 持有,
 * 打开时按行回填、成功后由页面关窗并清空 —— 组件只做呈现与上报。
 */
defineProps<{
  /** 提交中(确认按钮 loading) */
  loading: boolean
}>()

const emit = defineEmits<{
  /** 提交重命名 */
  submit: []
}>()

const open = defineModel<boolean>('open', { required: true })
const label = defineModel<string>('label', { required: true })

function onSubmit(): void {
  emit('submit')
}
</script>

<template>
  <!-- 重命名 -->
  <a-modal
    v-model:open="open"
    :title="$t('tokens.renameTitle')"
    :confirm-loading="loading"
    :ok-text="$t('common.save')"
    :cancel-text="$t('common.cancel')"
    @ok="onSubmit"
  >
    <a-input
      v-model:value="label"
      :placeholder="$t('tokens.k41416002')"
      @keydown.enter="onSubmit"
    />
  </a-modal>
</template>
