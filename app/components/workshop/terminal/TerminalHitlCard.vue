<script setup lang="ts">
/**
 * TerminalHitlCard —— 终端 HITL 对话框卡片(自 OmpTerminalPanel 结构拆分)。
 *
 * omp extension_ui_request 的 select/confirm/input/editor 四类等待人类决策的 UI:
 * 文案/结构/样式逐字保留,应答统一 emit('respond', …) 交宿主写 ui_response。
 * 本地文本(输入/编辑器)取 hitl.prefill ?? hitl.placeholder,与宿主原
 * watch(hitl) 同步语义一致。
 */
import type { TerminalHitlDialog } from '#shared/terminal-protocol'

const props = defineProps<{
  hitl: TerminalHitlDialog
}>()
const emit = defineEmits<{
  respond: [response: { id: string, value?: string, confirmed?: boolean, cancelled?: boolean }]
}>()

const { t } = useI18n()

const hitlText = ref(props.hitl.prefill ?? props.hitl.placeholder ?? '')
watch(() => props.hitl, (h) => {
  hitlText.value = h.prefill ?? h.placeholder ?? ''
})

function hitlRespond(response: { id: string, value?: string, confirmed?: boolean, cancelled?: boolean }): void {
  emit('respond', response)
}
</script>

<template>
  <div class="hitl-card">
    <div class="hitl-head">
      <span class="i-tabler-user-question" />
      <b>{{ t('terminal.hitlTitle') }}</b>
      <a-tag color="magenta">
        {{ hitl.method }}
      </a-tag>
      <a-button
        size="small"
        type="text"
        danger
        @click="hitlRespond({ id: hitl.id, cancelled: true })"
      >
        {{ t('terminal.hitlCancel') }}
      </a-button>
    </div>
    <p class="hitl-question">
      {{ hitl.title }}
    </p>

    <template v-if="hitl.method === 'select'">
      <div class="hitl-options">
        <a-button
          v-for="opt in hitl.options ?? []"
          :key="opt"
          block
          @click="hitlRespond({ id: hitl.id, value: opt })"
        >
          {{ opt }}
        </a-button>
      </div>
    </template>
    <template v-else-if="hitl.method === 'confirm'">
      <p class="hitl-message">
        {{ hitl.message }}
      </p>
      <div class="hitl-row">
        <a-button
          type="primary"
          @click="hitlRespond({ id: hitl.id, confirmed: true })"
        >
          {{ t('terminal.hitlConfirm') }}
        </a-button>
        <a-button @click="hitlRespond({ id: hitl.id, confirmed: false })">
          {{ t('terminal.hitlDeny') }}
        </a-button>
      </div>
    </template>
    <template v-else>
      <a-textarea
        v-model:value="hitlText"
        :rows="3"
        :placeholder="hitl.placeholder"
        class="hitl-textarea"
        @press-enter="hitlRespond({ id: hitl.id, value: hitlText })"
      />
      <div class="hitl-row">
        <a-button
          type="primary"
          @click="hitlRespond({ id: hitl.id, value: hitlText })"
        >
          {{ t('terminal.hitlSubmit') }}
        </a-button>
        <a-button @click="hitlRespond({ id: hitl.id, cancelled: true })">
          {{ t('terminal.hitlCancel') }}
        </a-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* HITL 对话框:悬浮在终端上方(正在等待人类决策) */
.hitl-card {
  position: absolute;
  top: 14px;
  right: 16px;
  z-index: 10;
  width: min(420px, calc(100% - 32px));
  padding: 12px 14px;
  background: rgb(23 30 40 / 97%);
  border: 1px solid #bb9af7;
  border-radius: var(--radius-panel-sm);
  box-shadow: 0 8px 28px rgb(0 0 0 / 55%);
}

.hitl-head {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  color: #bb9af7;
}

.hitl-head > b {
  color: #e6edf3;
}

.hitl-head .ant-btn {
  margin-left: auto;
}

.hitl-question {
  margin: 0 0 10px;
  font-weight: 600;
  color: #e6edf3;
  white-space: pre-wrap;
}

.hitl-message {
  margin: 0 0 10px;
  color: #a9b4c0;
  white-space: pre-wrap;
}

.hitl-options {
  display: flex;
  max-height: 300px;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
}

.hitl-options .ant-btn {
  justify-content: flex-start;
  text-align: left;
  white-space: normal;
}

.hitl-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.hitl-textarea {
  margin-top: 4px;
}
</style>
