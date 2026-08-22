<script setup lang="ts">
/**
 * 交付物群 — 每个 artifact 卡片;且内容与相邻回复重复时默认折叠正文(可展开);
 * 命名适配:deliverable/summary/result/output 等语义由 ArtifactCard 完成。
 */
import { computed, ref } from 'vue'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()

const artifacts = computed(() =>
  props.block.events
    .filter(e => e.type === 'a2a.artifact')
    .map(e => (e.payload as { taskId?: string, artifact: { artifactId: string, name?: string, parts: Array<{ text?: string }> } }).artifact),
)

const showBody = computed(() => !props.block.dupStream)
const expanded = ref(props.block.dupStream)
</script>

<template>
  <div class="artifact-cluster">
    <div
      v-if="block.dupStream"
      class="dup-note"
    >
      <span class="i-tabler-copy" />
      <span>交付物正文与上方回复一致</span>
      <button
        class="mini-btn"
        @click="expanded = !expanded"
      >
        {{ expanded ? '隐藏' : '查看' }}
      </button>
    </div>
    <template v-if="showBody || expanded">
      <workshop-artifact-card
        v-for="(a, i) in artifacts"
        :key="i"
        :artifact="a"
      />
    </template>
  </div>
</template>

<style scoped>
.artifact-cluster {
  padding: 2px 0 6px 20px;
}
.dup-note {
  display: flex;
  gap: 6px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-faint);
}
.mini-btn {
  padding: 1px 10px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.mini-btn:hover {
  color: var(--ink);
  background: var(--hover-tint);
  border-color: var(--ink-fainter);
}
.artifact-cluster > :deep(.artifact-card) {
  margin-top: 4px;
}
</style>
