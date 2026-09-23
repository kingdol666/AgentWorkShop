<script setup lang="ts">
/**
 * 签发新 Token 弹窗:只收一个标签,回车与「创建」都提交。
 *
 * 草稿(label)由页面持有并经 v-model:label 回流 —— 失败时弹窗保持打开、输入不丢,
 * 成功后由页面清空(与原页面一致),组件自己不复制一份草稿。
 */
defineProps<{
  /** 提交中(确认按钮 loading) */
  loading: boolean
}>()

const emit = defineEmits<{
  /** 提交创建 */
  submit: []
}>()

const open = defineModel<boolean>('open', { required: true })
const label = defineModel<string>('label', { required: true })

function onSubmit(): void {
  emit('submit')
}
</script>

<template>
  <!-- 创建 Token -->
  <a-modal
    v-model:open="open"
    :title="$t('chips.issueTitle')"
    :confirm-loading="loading"
    :ok-text="$t('common.create')"
    :cancel-text="$t('common.cancel')"
    @ok="onSubmit"
  >
    <a-input
      v-model:value="label"
      :placeholder="$t('tokens.k1hlqknl001')"
      @keydown.enter="onSubmit"
    />
  </a-modal>
</template>
