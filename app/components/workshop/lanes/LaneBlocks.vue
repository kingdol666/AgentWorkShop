<script setup lang="ts">
/**
 * Lane 聚合块列 — Agent lanes 的列体。
 *
 * 每个成员 lane 一个实例,内部独占一个 BlockClusterer(经 useClusteredBlocks):
 *  - 相同类型连续事件合并进同一个块组件(工具串/状态串/流式气泡),
 *    实时与历史(刷新回填)走同一聚类路径,行为完全一致;
 *  - raw 源:ring 原始 items + 本 lane 的 agentId 谓词 —— 不受时间线
 *    filter/focus 影响(Inspector 聚焦别的 agent 时本列不清空);
 *  - 重复消费防线与时间线共享(events store consumed seq + 聚类器头部
 *    seq 重建),历史回填与实时增量互不冲突。
 *
 * 历史回填(server 驱动):挂载即按 agent 维度拉取持久化事件(loadLaneHistory,
 * 含"历史的发送消息"——不被全局 200 帧窗口淹没);顶部"加载更早"按 lane
 * 游标向上翻页(loadLaneEarlier),按需加载该成员更早的对话与事件。
 */
import { useClusteredBlocks } from '@/app/composables/workshop/useClusteredBlocks'
import { useEventsStore } from '@/app/stores/workshop/events'
import type { AepEnvelope } from '#shared/workshop-protocol'

const props = defineProps<{
  channelId: string
  agentId: string
}>()

const events = useEventsStore()

const { blocks } = useClusteredBlocks(
  () => props.channelId,
  {
    predicate: (e: AepEnvelope) => e.agentId === props.agentId,
    resetKey: () => props.agentId,
    raw: true,
  },
)

// ===== 历史回填(挂载触发一次;守卫在 store,视图切换不重复拉取) =====
const historyLoading = ref(true)
onMounted(() => {
  void events.loadLaneHistory(props.channelId, props.agentId).finally(() => {
    historyLoading.value = false
  })
})

// ===== 向上翻页(该 agent 维度游标;点击探底,无更早即收起按钮) =====
const loadingEarlier = ref(false)
const earlierExhausted = ref(false)
const laneHasItems = computed(() => blocks.value.length > 0)
const maybeMore = computed(() => !earlierExhausted.value && laneHasItems.value)
const loadLaneEarlier = async (): Promise<void> => {
  if (loadingEarlier.value || earlierExhausted.value) return
  loadingEarlier.value = true
  try {
    const hasMore = await events.loadLaneEarlier(props.channelId, props.agentId)
    if (!hasMore) earlierExhausted.value = true
  }
  catch {
    /* 拉取失败保持按钮可重试 */
  }
  finally {
    loadingEarlier.value = false
  }
}
</script>

<template>
  <div
    v-if="blocks.length === 0 && historyLoading"
    class="lane-empty"
  >
    <span class="i-tabler-refresh lane-empty-icon" />
    {{ $t('laneBlocks.k1otw1r3001') }}
  </div>
  <div
    v-else-if="blocks.length === 0"
    class="lane-empty"
  >
    {{ $t('laneBlocks.k1el0s5k002') }}
  </div>
  <template v-else>
    <button
      v-if="maybeMore"
      type="button"
      class="lane-earlier"
      :disabled="loadingEarlier"
      @click="loadLaneEarlier"
    >
      {{ loadingEarlier ? $t('laneBlocks.k1br0ij9003') : $t('laneBlocks.k1br5dtr004') }}
    </button>
    <workshop-event-block
      v-for="b in blocks"
      :key="b.id"
      :block="b"
    />
  </template>
</template>

<style scoped>
.lane-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  padding: 28px 8px;
  font-size: 11.5px;
  color: var(--ink-fainter);
  text-align: center;
}

.lane-empty-icon {
  font-size: 16px;
  color: var(--ink-fainter);
  animation: lane-sync-spin 1.2s linear infinite;
}

@keyframes lane-sync-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .lane-empty-icon { animation: none; }
}

/* 向上翻页:hairline 小按钮(与时间线"加载更早"同声部) */
.lane-earlier {
  display: block;
  margin: 2px auto 8px;
  padding: 2px 12px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}

.lane-earlier:hover:not(:disabled) {
  color: var(--ink);
  background: var(--hover-tint);
  border-color: var(--ink-fainter);
}

.lane-earlier:disabled {
  cursor: default;
  opacity: 0.55;
}
</style>
