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
  catch {
    /* 历史拉取失败:保持按钮可重试,不打断时间线 */
  }
  finally {
    loadingEarlier.value = false
  }
}

const onScroll = (): void => {
  const el = scroller.value
  if (!el) return
  stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

// ===== 回底动画(open-tag jump-bottom:800ms ease-out,动画期抑制按钮闪烁) =====
const scrollingDown = ref(false)
/** 结构化滚动容器(绕开 vue-tsc 双 lib.dom 的 Element 类型不兼容) */
type ScrollBox = { scrollTop: number, scrollHeight: number, clientHeight: number }
const animateScroll = (el: ScrollBox, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.scrollTop = el.scrollHeight
      resolve()
      return
    }
    const from = el.scrollTop
    const delta = el.scrollHeight - el.clientHeight - from
    const t0 = performance.now()
    const step = (t: number): void => {
      const k = Math.min(1, (t - t0) / ms)
      const eased = 1 - (1 - k) ** 3 // ease-out cubic
      el.scrollTop = from + delta * eased
      if (k < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })

/** 跳回最新:滚底并恢复吸底(用户离开底部后新内容不再自动跟随) */
const jumpToLatest = async (): Promise<void> => {
  stickBottom.value = true
  const el = scroller.value
  if (!el) return
  scrollingDown.value = true
  try {
    await animateScroll(el, 800)
  }
  finally {
    scrollingDown.value = false
  }
}

// ===== 新块进场编排(open-tag motion charter 移植) =====
/**
 * 只有实时新到的尾部块做进场动画(60ms stagger,600ms burst 窗口,上限 8 条);
 * 整体重建(过滤切换/聚焦/历史回填——一次出现大量新 id)与组件首载直接显示,
 * 不动画不延迟。映射:blockId → 进场延迟 ms;-1 = 不动画。
 */
type Stage = { enter: boolean, delay: number }
const staged = ref(new Map<string, Stage>())
let burstAt = 0
let burstN = 0
const mountedAt = Date.now()
watch(blocks, (list, prev) => {
  const prevIds = new Set((prev ?? []).map(b => b.id))
  const fresh = list.filter(b => !prevIds.has(b.id))
  const map = new Map<string, Stage>()
  const wholesale = fresh.length === 0
    || fresh.length > Math.max(8, Math.ceil(list.length * 0.4))
    || Date.now() - mountedAt < 1500
  if (!wholesale) {
    const now = Date.now()
    if (now - burstAt > 600) {
      burstAt = now
      burstN = 0
    }
  }
  for (const b of list) {
    const isFresh = !prevIds.has(b.id)
    const delay = isFresh && !wholesale ? Math.min(burstN++, 7) * 60 : -1
    map.set(b.id, { enter: delay >= 0, delay: Math.max(0, delay) })
  }
  staged.value = map
}, { immediate: true })

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

// 内容高度增长吸底:同一流块 delta 打字机让块变高(块数与 seq 不变或合并帧不推 seq),
// ResizeObserver 观测内容列高度变化补一次滚底 —— 长输出不再"卡"在中途。
// (观察器以结构化类型声明:绕开 vue-tsc 双 lib.dom 下 Element 类型不兼容问题)
const columnEl = ref<HTMLElement | null>(null)
let contentObserver: { disconnect(): void } | null = null
onMounted(() => {
  const el = scroller.value
  const column = columnEl.value
  if (!el || !column || typeof ResizeObserver === 'undefined') return
  const Observer = ResizeObserver as unknown as
    new (cb: () => void) => { observe(target: unknown): void, disconnect(): void }
  const observer = new Observer(() => {
    if (stickBottom.value) el.scrollTop = el.scrollHeight
  })
  observer.observe(column)
  contentObserver = observer
})
onBeforeUnmount(() => {
  contentObserver?.disconnect()
  contentObserver = null
})

/** 断线待对齐(诚实连接态:open-tag 规范——不假装在线,提示同步中) */
const syncing = computed(() => conn.pendingReplay || conn.state === 'connecting')
/** 最后数据时间(x 秒前;无数据返回空) */
const lastDataAgo = computed(() => {
  if (!conn.lastDataAt) return ''
  const s = Math.max(0, Math.round((Date.now() - conn.lastDataAt) / 1000))
  return s < 5 ? '刚刚' : `${s}s 前`
})

const filterOptions: Array<{ value: EventFilter, label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'key', label: '关键' },
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
      <!-- 连接诚实态:断线待对齐 → 同步中脉搏;在线 → 最后数据时间(open-tag 规范) -->
      <span
        class="sync-chip"
        :data-state="syncing ? 'syncing' : conn.state"
        :title="syncing ? '连接中断,重连后将自动对齐缺失事件' : `最后数据更新:${lastDataAgo || '无'}`"
      >
        <span
          v-if="syncing"
          class="sync-pulse"
        />
        <span
          v-else-if="conn.state === 'open'"
          class="i-tabler-point-filled sync-dot"
        />
        {{ syncing ? '同步中' : conn.state === 'open' ? lastDataAgo || '在线' : '离线' }}
      </span>
    </div>
    <div
      ref="scroller"
      class="scroller"
      @scroll="onScroll"
    >
      <!-- 离底时的跳转最新悬浮按钮(流式新内容到达不强制跟随,点击回底;动画期抑制闪烁) -->
      <button
        v-if="!stickBottom && !scrollingDown"
        class="jump-latest"
        title="跳转到最新"
        @click="jumpToLatest"
      >
        <span class="i-tabler-arrow-down" />
        最新
      </button>
      <div
        ref="columnEl"
        class="column"
      >
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
          v-else-if="blocks.length === 0 && totalEvents === 0"
          class="empty"
        >
          <!-- 同步中 ≠ 空:诚实区分(快照未到时不断言"无事件") -->
          <span
            v-if="syncing || conn.state !== 'open'"
            class="i-tabler-refresh empty-icon"
          />
          <span
            v-else
            class="i-tabler-message-dots empty-icon"
          />
          <p class="empty-title">
            {{ syncing || conn.state !== 'open' ? '正在同步时间线…' : '等待事件流入' }}
          </p>
          <p class="empty-hint">
            {{ syncing || conn.state !== 'open' ? '连接恢复后事件将自动对齐' : '在下方提交任务后,Agent 执行过程将在此实时渲染' }}
          </p>
        </div>
        <!-- 过滤空态:有事件但当前过滤无匹配(区别于真空) -->
        <div
          v-else-if="blocks.length === 0"
          class="empty filtered"
        >
          <span class="i-tabler-filter-off empty-icon" />
          <p class="empty-title">
            无匹配事件
          </p>
          <p class="empty-hint">
            「{{ filterOptions.find(o => o.value === filter)?.label ?? filter }}」过滤下没有事件,可切换过滤条件
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
            :enter-stage="staged.get(b.id)"
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
/* 连接诚实态 chip:同步中琥珀脉搏 / 在线绿点+最后数据时间 / 离线灰 */
.sync-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  margin-left: auto;
  padding: 1px 8px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border-radius: var(--radius-pill);
}
.sync-chip[data-state='syncing'] {
  color: var(--tone-warning-dot);
}
.sync-chip[data-state='open'] .sync-dot {
  font-size: 7px;
  color: var(--tone-success-dot);
}
.sync-pulse {
  width: 6px;
  height: 6px;
  background: var(--tone-warning-dot);
  border-radius: 50%;
  animation: sync-breath 1.2s ease-in-out infinite;
}
@keyframes sync-breath {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .sync-pulse { animation: none; opacity: 0.8; }
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
