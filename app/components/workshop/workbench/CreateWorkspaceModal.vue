<script setup lang="ts">
/**
 * 新建 workspace 弹窗:一个名称输入 + 确认即创建并跳转。
 * 无状态展示件:开合与输入名经 v-model 回流页面(useWorkbenchWorkspaces 持有唯一副本),
 * 确认只上报点击 —— 校验/创建/跳转都在页面那一层,与拆分前一致。
 */
defineProps<{
  /** 创建中(确认按钮 loading) */
  loading: boolean
}>()

/** 注意:必须把 defineEmits 的返回值赋给 emit —— 模板里的 `emit(...)` 才解析得到(setup 绑定) */
const emit = defineEmits<{
  ok: []
}>()

const open = defineModel<boolean>('open', { required: true })
const name = defineModel<string>('name', { required: true })
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="$t('wsHome.newWs')"
    :confirm-loading="loading"
    :ok-text="$t('wsHome.createEnterOk')"
    :cancel-text="$t('common.cancel')"
    @ok="emit('ok')"
  >
    <a-input
      v-model:value="name"
      :placeholder="$t('wsHome.ksmpk8l007')"
      @keydown.enter="emit('ok')"
    />
  </a-modal>
</template>
