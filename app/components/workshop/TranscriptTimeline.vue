<script setup lang="ts">
/**
 * Transcript 时间线:过滤条(全部/消息/任务/错误)+ cluster 块流 + 自动吸底。
 * 事件经 useClusteredBlocks 增量聚类(turn block,内容智能去重),
 * 流式更新只命中变化的块组件;新帧到达保持吸底。
 * 历史窗口:默认最近 200 帧(loadHistory);顶部"加载更早"按 beforeSeq 向上翻页。
 *
 * 本层只做编排:数据流(store + composable)与子组件拼装,对外接口仍是
 * props { channelId }(无 emits、无 defineExpose,与拆分前一致)。
 *  - 呈现:workshop/transcript/(过滤条 / 翻页区 / 占位三态 / 块流),scoped 样式随各自标记;
 *  - 逻辑:useTranscriptScroll(吸底+回底动画+ResizeObserver 补滚)、
 *    useTranscriptEnterStage(新块进场)、useTranscriptHistory(加载更早+视口锚定),
 *    副作用注册与清理都成对留在对应 composable 内。
 */
import { useEventsStore, type EventFilter } from '@/app/stores/workshop/events'
import { useClusteredBlocks } from '@/app/composables/workshop/useClusteredBlocks'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useCodeCopy } from '@/app/composables/useCodeCopy'
import { useTranscriptEnterStage } from '@/app/composables/workshop/useTranscriptEnterStage'
import { useTranscriptScroll } from '@/app/composables/workshop/useTranscriptScroll'
import { useTranscriptHistory } from '@/app/composables/workshop/useTranscriptHistory'
// 子组件显式导入(与 AgentLanesView / EventBlock 同款):目录前缀已表意,
// 自动导入名会是 WorkshopTranscriptTranscriptXxx,显式命名更直白也不受命名推导影响
import TranscriptBlockList from '@/app/components/workshop/transcript/TranscriptBlockList.vue'
import TranscriptEarlierPager from '@/app/components/workshop/transcript/TranscriptEarlierPager.vue'
import TranscriptEmptyState from '@/app/components/workshop/transcript/TranscriptEmptyState.vue'
import TranscriptFilterBar from '@/app/components/workshop/transcript/TranscriptFilterBar.vue'

const { t } = useI18n()

const props = defineProps<{ channelId: string }>()
const events = useEventsStore()
const { conn } = useWorkshopWs()
// 代码块复制事件委托(文档级单例;时间线内所有 .code-copy 通用)
useCodeCopy()

/** 连接中骨架:WS 连接中且尚无块 → 按 block 行形态的 shimmer(open-tag skel 声部) */
const connecting = computed(() =>
  conn.state === 'connecting' && events.ring(props.channelId).items.length === 0)

const filter = computed({
  get: () => events.filters[props.channelId] ?? 'all',
  set: (v: EventFilter) => events.setFilter(props.channelId, v),
})

const { blocks, totalEvents } = useClusteredBlocks(() => props.channelId)

// ===== 新块进场编排(open-tag motion charter 移植) =====
const { staged } = useTranscriptEnterStage(blocks)

// ===== 滚动容器:吸底 / 回底动画 / 内容高度增长补滚 =====
const { scroller, columnEl, stickBottom, scrollingDown, onScroll, jumpToLatest } = useTranscriptScroll({
  blockCount: () => blocks.value.length,
  lastSeq: () => events.lastSeq(props.channelId),
})

// ===== 向上翻页历史 =====
const { loadingEarlier, earlierExhausted, loadedCount, maybeMore, loadEarlier }
  = useTranscriptHistory(() => props.channelId, scroller)

/** 断线待对齐(诚实连接态:open-tag 规范——不假装在线,提示同步中) */
const syncing = computed(() => conn.pendingReplay || conn.state === 'connecting')
/** 最后数据时间(x 秒前;无数据返回空) */
const lastDataAgo = computed(() => {
  if (!conn.lastDataAt) return ''
  const s = Math.max(0, Math.round((Date.now() - conn.lastDataAt) / 1000))
  return s < 5 ? t('transcriptTimeline.k3wwxl026') : t('transcriptTimeline.k2gyl6l027', { p0: s })
})

const filterOptions: Array<{ value: EventFilter, label: string }> = [
  { value: 'all', label: t('transcriptTimeline.k3x4t1012') },
  { value: 'key', label: t('transcriptTimeline.k3x5xi013') },
  { value: 'messages', label: t('transcriptTimeline.k41ykc014') },
  { value: 'tasks', label: t('transcriptTimeline.k3wcox015') },
  { value: 'team', label: t('transcriptTimeline.k3y5ja016') },
  { value: 'errors', label: t('transcriptTimeline.k49d2l017') },
]
/**
 * 当前档位标签(过滤空态文案用)。
 * 与过滤条共用同一份 filterOptions:i18n key 只留在本处,避免两处标签漂移。
 */
const filterLabel = computed(() => filterOptions.find(o => o.value === filter.value)?.label ?? filter.value)
</script>

<template>
  <div class="transcript">
    <TranscriptFilterBar
      v-model:filter="filter"
      :options="filterOptions"
      :total-events="totalEvents"
      :block-count="blocks.length"
      :syncing="syncing"
      :conn-state="conn.state"
      :last-data-ago="lastDataAgo"
    />
    <div
      ref="scroller"
      class="scroller"
      @scroll="onScroll"
    >
      <!-- 离底时的跳转最新悬浮按钮(流式新内容到达不强制跟随,点击回底;动画期抑制闪烁) -->
      <button
        v-if="!stickBottom && !scrollingDown"
        class="jump-latest"
        :title="$t('transcriptTimeline.kqu93z8001')"
        @click="jumpToLatest"
      >
        <span class="i-tabler-arrow-down" />
        {{ $t('transcriptTimeline.k40t11002') }}
      </button>
      <div
        ref="columnEl"
        class="column"
      >
        <TranscriptEarlierPager
          :visible="maybeMore"
          :loading="loadingEarlier"
          :exhausted="earlierExhausted"
          :loaded-count="loadedCount"
          @load="loadEarlier"
        />
        <TranscriptEmptyState
          :connecting="connecting"
          :block-count="blocks.length"
          :total-events="totalEvents"
          :syncing="syncing"
          :conn-state="conn.state"
          :filter-label="filterLabel"
        />
        <TranscriptBlockList
          :blocks="blocks"
          :staged="staged"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.transcript {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--paper); /* 灰画布:消息气泡白卡在此浮出(Slack 声部) */
}
.jump-latest {
  position: sticky;
  bottom: 12px;
  z-index: 5;
  display: inline-flex;
  gap: 5px;
  align-items: center;
  float: right;
  margin-right: 14px;
  padding: 5px 12px;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--on-accent);
  cursor: pointer;
  background: var(--accent);
  border: none;
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-float);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.jump-latest:hover { opacity: 0.92; }
.jump-latest:active { transform: translateY(1px); }

.scroller {
  overscroll-behavior: contain;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
/* Codex 式阅读列:宽屏下内容居中,阅读行宽 ~900px;首载轻淡入 */
.column {
  max-width: 900px;
  padding: 10px 4px 24px;
  margin: 0 auto;
  animation: column-in 0.28s ease-out;
}
@keyframes column-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ── 窄屏(≤1023):阅读列收边 + 富文本/代码/终端块横向滚动而非顶破视口 ──
   消息体由 workshop-event-block(及其内部的 prose/code-block)渲染,
   这里用 :deep 给它们一条自己的卷轴:代码不折行(折行会毁掉缩进语义),
   改为在自己块内横扫;图片/画布一律不超列宽。 */
@media (max-width: 1023.98px) {
  .column {
    padding: 8px 8px 22px;
  }

  .column :deep(pre),
  .column :deep(table),
  .column :deep(.code-block),
  .column :deep(.st-text) {
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .column :deep(img),
  .column :deep(video),
  .column :deep(canvas) {
    max-width: 100%;
    height: auto;
  }

  /* 原为 `.earlier-btn, .jump-latest` 一条 min-height 规则,拆组件后随各自标记落位:
     `.earlier-btn` 的同一份声明在 transcript/TranscriptEarlierPager.vue —— 有意重复,
     改一处同步所有副本。 */
  .jump-latest {
    min-height: 40px;
    padding: 8px 14px;
    font-size: 12px;
  }
}
</style>
