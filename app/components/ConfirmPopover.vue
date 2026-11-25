<script setup lang="ts">
/**
 * 位置化危险操作确认（标准 a-popconfirm 的统一封装）。
 *
 * 删除/移除/归档类操作必须在**触发控件旁边**先问一次：取消不发请求，确认才执行。
 * 统一 danger 按钮、默认文案与 placement，避免各页面各写一套 Modal.confirm（离触发点远、
 * 容易遮住上下文）。复杂多步流程（权限 diff、项目完成门）仍用各自表单/弹窗。
 */
withDefaults(defineProps<{
  title: string
  description?: string
  okText?: string
  cancelText?: string
  danger?: boolean
  disabled?: boolean
  placement?: 'top' | 'topLeft' | 'topRight' | 'bottom' | 'bottomLeft' | 'bottomRight' | 'left' | 'leftTop' | 'leftBottom' | 'right' | 'rightTop' | 'rightBottom'
}>(), {
  danger: true,
  placement: 'topRight',
})

const emit = defineEmits<{ (e: 'confirm'): void }>()
const { t } = useI18n()
</script>

<template>
  <a-popconfirm
    :title="title"
    :description="description"
    :ok-text="okText ?? t('common.confirm')"
    :cancel-text="cancelText ?? t('common.cancel')"
    :ok-button-props="{ danger }"
    :disabled="disabled"
    :placement="placement"
    @confirm="emit('confirm')"
  >
    <slot />
  </a-popconfirm>
</template>
