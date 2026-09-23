<script setup lang="ts">
/**
 * 回复目标 chip(引用链:replyToId):只渲染发送人/摘要,取消动作回抛父组件
 * (父组件负责 chat.clearReplyTarget())。
 */
defineProps<{
  senderName: string
  excerpt: string
}>()

const emit = defineEmits<{
  (e: 'cancel'): void
}>()
</script>

<template>
  <div class="reply-chip">
    <span class="i-tabler-arrow-back-up" />
    <span class="reply-label">回复 <b>{{ senderName }}</b></span>
    <span class="reply-excerpt">{{ excerpt }}</span>
    <button
      type="button"
      class="reply-cancel"
      title="取消回复"
      @click="emit('cancel')"
    >
      <span class="i-tabler-x" />
    </button>
  </div>
</template>

<style scoped>
/* 回复目标 chip(引用链) */
.reply-chip {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 2px 0 4px;
  padding: 3px 8px;
  font-size: 11.5px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border-left: 2px solid var(--ink-fainter);
  border-radius: var(--radius-chip);
}
.reply-label b { color: var(--ink); }
.reply-excerpt {
  max-width: 46%;
  overflow: hidden;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reply-cancel {
  display: inline-flex;
  align-items: center;
  padding: 0 2px;
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
}
.reply-cancel:hover { color: var(--ink); }
</style>
