/**
 * 流式块消费:events store 与 BlockClusterer 的绑定层。
 *
 * 消费模型(对旧版的修改):
 *  - 旧版 TranscriptTimeline 每次响应式触发都对整条时间线执行 aggregateEvents 重建;
 *    这里是增量消费:新帧只推入聚类器,块对象身份稳定 → Vue 组件按 key 复用无满屏闪动
 *  - cid / filter / focus / predicate 变化 → 聚类器全量 reset + 一次重建(过滤语义必须重算)
 *  - 块数组同一 identity,在 v-for 中直接使用
 *  - raw 模式(lanes 用):源 = ring 原始 items + 调用方 predicate,绕过 timeline 的
 *    filter/focus —— 时间线聚焦某 agent 时(Inspector 设置 focusAgents),非聚焦 lane
 *    不能跟着清空;lanes 的重置仅由 cid / predicate / resetKey 驱动
 *
 * 呈现节流(Agent-UI 聚合消费,修复"空白块 + 断断续续渲染"):
 *  - 帧到达即入聚类器(状态零延迟,去重/折回基于全量数据),但呈现(发布到 v-for)
 *    按聚合窗合批:过程帧(delta/工具/进度)160ms 合并为一次呈现 —— 新块"攒够了"再上屏,
 *    不再 1-2 个字符地闪现断续
 *  - 终局/外显帧(落定消息/交付/错误/任务迁移/点对点消息/成员变更/生命周期)即时呈现
 *  - 尾部流块未落定且累计文本不足 8 字符时本拍暂缓(攒出实质内容再上屏);落定必然呈现
 *  - 块内增量文本仍实时(块对象 reactive,既有流块内的打字机增量不经发布通道直传渲染端)
 *    —— 合批只作用于"新块出现"的粒度,不牺牲流式可见性
 */
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import type { MaybeRefOrGetter } from 'vue'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { useEventsStore } from '../../stores/workshop/events'
import { BlockClusterer, buildStreamText, type EventBlock } from './useEventBlocks'

/** 聚合窗:过程帧突发合并为一次呈现(ms) */
const FLUSH_MS = 160
/** 尾部流块最小可见文本(字符):不足则暂缓一拍,避免 1-2 字符的"准空白"块闪现 */
const MIN_STREAM_PREVIEW = 8
/** 即时呈现的终局/外显帧:结果类与状态翻转类内容不合批 */
const IMMEDIATE_TYPES = new Set([
  'agent.message',
  'a2a.artifact',
  'error',
  'task.status',
  'a2a.message',
  'agent.member',
  'agent.status',
])

export function useClusteredBlocks(
  channelId: MaybeRefOrGetter<string | null | undefined>,
  opts: {
    /**
     * 事件谓词(直接传函数本体)。注意不能用 toValue 解包:Vue 的 toValue 对函数
     * 会直接调用,谓词会被无参执行而崩溃;谓词上下文变化由 resetKey 驱动重建。
     */
    predicate?: ((e: AepEnvelope) => boolean) | null | undefined
    /** 外部谓词捕获的上下文(如 agentId)变化 → 全量重建 */
    resetKey?: MaybeRefOrGetter<unknown>
    /** raw 源:绕过 timeline 的 filter/focus(lanes 场景),用 ring items + predicate */
    raw?: boolean
  } = {},
) {
  const events = useEventsStore()
  const clusterer = new BlockClusterer()
  const blocks = shallowRef<EventBlock[]>(clusterer.blocks)

  const cid = computed(() => toValue(channelId) ?? '')
  const filterVal = computed(() => events.filters[cid.value] ?? 'all')
  const focusVal = computed(() => events.focusAgents[cid.value] ?? null)
  const resetKeyVal = computed(() => toValue(opts.resetKey))
  const predRaw = computed(() => opts.predicate ?? null)

  const list = computed(() => {
    if (opts.raw) return cid.value ? events.ring(cid.value).items : []
    return cid.value ? events.timeline(cid.value) : []
  })
  const source = computed(() => {
    // resetKey(外部捕获上下文)列入依赖:变化时 source 重算,配合下方重置重建
    void resetKeyVal.value
    return predRaw.value ? list.value.filter(predRaw.value) : list.value
  })

  // ===== 呈现节流(聚合消费) =====
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  /** reset 重建挂起:过滤/频道切换后的重算必须立即全量呈现(不能等聚合窗) */
  let rebuildPending = false

  /** 尾部流块未落定且文本过短 → 本拍暂缓(攒出实质内容再上屏) */
  const presentable = (list: EventBlock[]): EventBlock[] => {
    const lastIdx = list.length - 1
    if (lastIdx < 0) return list
    const tail = list[lastIdx]!
    if (tail.kind === 'stream' && !tail.settled && buildStreamText(tail).trim().length < MIN_STREAM_PREVIEW) {
      return list.slice(0, lastIdx)
    }
    return list
  }

  const publish = (): void => {
    if (flushTimer != null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    blocks.value = presentable(clusterer.blocks)
  }

  /** 终局帧/重建 → 即时呈现;过程帧(delta/status.message/tool/progress)→ 聚合窗合批 */
  const schedulePublish = (immediate: boolean): void => {
    if (immediate || rebuildPending) {
      rebuildPending = false
      publish()
      return
    }
    if (flushTimer != null) return
    flushTimer = setTimeout(publish, FLUSH_MS)
  }
  onScopeDispose(() => {
    if (flushTimer != null) clearTimeout(flushTimer)
  })

  if (opts.raw) {
    // raw 模式:filter/focus 不影响源,重置仅由 cid / predicate / 上下文驱动
    watch([cid, predRaw, resetKeyVal], () => {
      clusterer.reset()
      rebuildPending = true
    }, { immediate: true })
  }
  else {
    // 过滤/聚焦/predicate/上下文变化 → 全量重建(先注册先执行,重置先于同步)
    watch([cid, filterVal, focusVal, predRaw, resetKeyVal], () => {
      clusterer.reset()
      rebuildPending = true
    }, { immediate: true })
  }

  watch(source, (l) => {
    // 尾帧类别决定呈现 urgency:终局/外显帧即时,过程帧合批
    const tail = l[l.length - 1]
    const immediate = tail != null && IMMEDIATE_TYPES.has(tail.type)
    clusterer.sync(l)
    schedulePublish(immediate)
  }, { immediate: true })

  const totalEvents = computed(() => source.value.length)

  return { blocks, totalEvents, clusterer }
}

export type { EventBlock }
