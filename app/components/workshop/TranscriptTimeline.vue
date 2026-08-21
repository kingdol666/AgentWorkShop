<script setup lang="ts">
/**
 * Transcript 时间线:过滤条(全部/消息/任务/错误)+ cluster 块流 + 自动吸底。
 * 事件经 useClusteredBlocks 增量聚类(turn block,内容智能去重),
 * 流式更新只命中变化的块组件;新帧到达保持吸底。
 * 历史窗口:默认最近 200 帧(loadHistory);顶部"加载更早"按 beforeSeq 向上翻页。
 */
import { useEventsStore, type EventFilter } from '@/app/stores/workshop/events'
import { useClusteredBlocks } from '@/app/composables/workshop/useClusteredBlocks'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useCodeCopy } from '@/app/composables/useCodeCopy'

const props = defineProps<{ channelId: string }>()
const events = useEventsStore()
const { conn } = useWorkshopWs()
// 代码块复制事件委托(文档级单例;时间线内所有 .code-copy 通用)
useCodeCopy()
const scroller = ref<HTMLElement | null>(null)
const stickBottom = ref(true)

/** 连接中骨架:WS 连接中且尚无块 → 按 block 行形态的 shimmer(open-tag skel 声部) */
const connecting = computed(() =>
  conn.state === 'connecting' && events.ring(props.channelId).items.length === 0)

const filter = computed({
  get: () => events.filters[props.channelId] ?? 'all',
  set: (v: EventFilter) => events.setFilter(props.channelId, v),
})

const { blocks, totalEvents } = useClusteredBlocks(() => props.channelId)

// ===== 向上翻页历史 =====
const loadingEarlier = ref(false)
const earlierExhausted = ref(false)
/** 已加载事件数 vs 持久化总量 → 是否可能还有更早(粗判,点击时由 loadEarlier 探底) */
const loadedCount = computed(() => events.ring(props.channelId).items.length)
const maybeMore = computed(() => !earlierExhausted.value && loadedCount.value > 0)
const loadEarlier = async (): Promise<void> => {
  if (loadingEarlier.value || earlierExhausted.value) return
  loadingEarlier.value = true
  // 记住滚动位置:头部插入后保持视口锚定(不吸底跳变)
  const el = scroller.value
  const anchor = el ? { top: el.scrollTop, height: el.scrollHeight } : null
  try {
    const hasMore = await events.loadEarlier(props.channelId)
    if (!hasMore) earlierExhausted.value = true
    if (el && anchor) {
      await nextTick()
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top
    }
  }
  finally {
    loadingEarlier.value = false
  }
}

const onScroll = (): void => {
  const el = scroller.value
  if (!el) return
  stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

/** 跳回最新:滚底并恢复吸底(用户离开底部后新内容不再自动跟随) */
const jumpToLatest = async (): Promise<void> => {
  stickBottom.value = true
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 吸底:新块出现 / seq 增长 / 块内容尺寸变化(可能高增)后滚到底 */
const scrollToBottom = async (): Promise<void> => {
  if (!stickBottom.value) return
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(() => blocks.value.length, () => {
  void scrollToBottom()
})
watch(() => events.lastSeq(props.channelId), () => {
  void scrollToBottom()
})

const filterOptions: Array<{ value: EventFilter, label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'messages', label: '消息' },
  { value: 'tasks', label: '任务' },
  { value: 'team', label: '团队' },
  { value: 'errors', label: '错误' },
]

// ===== 日期分隔线(open-tag date-divider 移植):块 firstAt 跨日 → 插入 hairline 分隔 =====
const startOfDay = (iso: string): number => {
  const d = new Date(iso)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
const dayLabel = (iso: string): string => {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return '今天'
  if (sameDay(d, yesterday)) return '昨天'
  const y = d.getFullYear() !== today.getFullYear() ? `${d.getFullYear()} 年 ` : ''
  return `${y}${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
/** 每个块是否需要前置日界分隔(与上一块不同日,或首块) */
const blockDayFlags = computed(() => {
  const flags: Array<{ divider: string | null }> = []
  let prevDay: number | null = null
  for (const b of blocks.value) {
    const day = startOfDay(b.firstAt)
    flags.push({ divider: prevDay === null || day !== prevDay ? dayLabel(b.firstAt) : null })
    prevDay = day
  }
  return flags
})
</script>

<template>
  <div class="transcript">
    <div class="filter-bar">
      <a-segmented
        v-model:value="filter"
        size="small"
        :options="filterOptions"
      />
      <span class="count">{{ totalEvents }} 事件 / {{ blocks.length }} 块</span>
    </div>
    <div
      ref="scroller"
      class="scroller"
      @scroll="onScroll"
    >
      <!-- 离底时的跳转最新悬浮按钮(流式新内容到达不强制跟随,点击回底) -->
      <button
        v-if="!stickBottom"
        class="jump-latest"
        title="跳转到最新"
        @click="jumpToLatest"
      >
        <span class="i-tabler-arrow-down" />
        最新
      </button>
      <div class="column">
        <button
          v-if="maybeMore"
          class="earlier-btn"
          :disabled="loadingEarlier"
          @click="loadEarlier"
        >
          {{ loadingEarlier ? '加载中…' : '加载更早的事件' }}
        </button>
        <div
          v-if="earlierExhausted && loadedCount > 0"
          class="earlier-done"
        >
          已加载全部历史(最早 1 条起)
        </div>
        <!-- 连接中骨架:头像圆 + 双行占位,布局对齐最终块形态(免跳变) -->
        <div
          v-if="connecting"
          class="skel-stack"
        >
          <div
            v-for="n in 3"
            :key="n"
            class="skel-row"
            :style="{ '--d': `${(n - 1) * 0.12}s` }"
          >
            <span class="aw-skel skel-ava" />
            <div class="skel-lines">
              <span class="aw-skel skel-line name" />
              <span class="aw-skel skel-line w70" />
              <span class="aw-skel skel-line w45" />
            </div>
          </div>
        </div>
        <div
          v-else-if="blocks.length === 0"
          class="empty"
        >
          <span class="i-tabler-message-dots empty-icon" />
          <p class="empty-title">
            等待事件流入
          </p>
          <p class="empty-hint">
            在下方提交任务后,Agent 执行过程将在此实时渲染
          </p>
        </div>
        <template
          v-for="(b, i) in blocks"
          :key="b.id"
        >
          <div
            v-if="blockDayFlags[i]?.divider"
            class="date-divider"
          >
            <span class="date-divider-label">{{ blockDayFlags[i]!.divider }}</span>
          </div>
          <workshop-event-block
            :block="b"
            :turn-start="i > 0 && blocks[i - 1]!.agentId !== b.agentId"
            :compact="i > 0 && blocks[i - 1]!.agentId === b.agentId"
          />
        </template>
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
}
.filter-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 16px;
  background: var(--paper-raised);
  border-bottom: 1px solid var(--line);
}
.count {
  font-size: 11px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ink-fainter);
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
.earlier-btn {
  display: block;
  margin: 0 auto 10px;
  padding: 4px 14px;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--ink-faint);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.earlier-btn:hover:not(:disabled) {
  color: var(--ink);
  background: var(--paper-deep);
}
.earlier-btn:disabled { opacity: 0.5; cursor: default; }
.earlier-done {
  margin-bottom: 8px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  text-align: center;
  color: var(--ink-fainter);
}
/* 空态:编辑部式 serif 标题(pane-empty 声部) */
.empty {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  padding: 72px 16px;
  text-align: center;
}
.empty-icon {
  font-size: 28px;
  color: var(--ink-fainter);
}
.empty-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}
.empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--ink-faint);
}

/* 连接中骨架:对齐块行网格(26px 头像列 + 内容列),行间延迟入场 */
.skel-stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 26px 6px;
}

.skel-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 10px;
  animation: aw-rise 0.4s cubic-bezier(0.22, 0.68, 0.36, 1) backwards;
  animation-delay: var(--d, 0s);
}

.skel-ava {
  width: 26px;
  height: 26px;
  border-radius: 50%;
}

.skel-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skel-line {
  height: 11px;
}

.skel-line.name { width: 120px; height: 13px; }
.skel-line.w70 { width: 70%; }
.skel-line.w45 { width: 45%; }

@media (prefers-reduced-motion: reduce) {
  .skel-row { animation: none; }
}
</style>
