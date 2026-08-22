<script setup lang="ts">
/**
 * 团队成员变更行 — 每行独立(added/updated/removed 语义由 render 端解读)。
 */
import { computed, ref } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()
const entities = useEntitiesStore()
const cid = computed(() => props.block.events[0]?.channelId ?? '')

const lines = computed(() =>
  props.block.events.map((e) => {
    const p = e.payload as {
      op: 'added' | 'updated' | 'removed'
      agentId: string
      name: string
      role: string
      harness: string
      enabled?: number
      by: string
      reason?: string
    }
    const who = p.by === 'user' ? '用户' : `lead ${entities.agentName(cid.value, p.by.replace(/^lead:/, ''))}`
    const member = `${p.name}(${p.role}/${p.harness})`
    const verbs = {
      added: `新增成员 ${member}`,
      updated: p.enabled === 0 ? `禁用成员 ${member}` : `更新成员 ${member}`,
      removed: `移除成员 ${member}`,
    } as const
    return { seq: e.seq, text: `${who}${verbs[p.op]}${p.reason ? `,理由:${p.reason}` : ''}`, op: p.op }
  }),
)

const expanded = ref(false)
const MAX = 8
const shown = computed(() => (expanded.value ? lines.value : lines.value.slice(0, MAX)))
const hasMore = computed(() => lines.value.length > MAX)
</script>

<template>
  <div class="member-cluster">
    <div
      v-for="m in shown"
      :key="m.seq"
      class="member-line"
      :data-op="m.op"
    >
      <span class="i-tabler-users" />
      <span class="line-text">{{ m.text }}</span>
    </div>
    <button
      v-if="hasMore"
      class="more-btn"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : `全部 ${lines.length} 条` }}
    </button>
  </div>
</template>

<style scoped>
.member-cluster { padding: 1px 0 4px 20px; }
.member-line {
  display: flex;
  gap: 7px;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 20px;
}
.member-line[data-op='added'] { color: var(--accent-moss); }
.member-line[data-op='removed'] { color: var(--accent-vermilion, #ff6d6a); }
.member-line[data-op='updated'] { color: var(--ink-soft, inherit); }
.line-text { overflow-wrap: anywhere; word-break: break-word; }
.more-btn {
  padding: 0 6px;
  font-size: 9.5px;
  color: var(--accent-cobalt);
  cursor: pointer;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--accent-cobalt) 35%, transparent);
  border-radius: var(--radius-chip);
}
.more-btn:hover { background: color-mix(in srgb, var(--accent-cobalt) 8%, transparent); }
</style>
