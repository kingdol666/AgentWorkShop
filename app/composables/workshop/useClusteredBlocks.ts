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
 */
import { computed, shallowRef, watch } from 'vue'
import type { MaybeRefOrGetter } from 'vue'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { useEventsStore } from '../../stores/workshop/events'
import { BlockClusterer, type EventBlock } from './useEventBlocks'

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
  const blocks = shallowRef(clusterer.blocks)

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

  if (opts.raw) {
    // raw 模式:filter/focus 不影响源,重置仅由 cid / predicate / 上下文驱动
    watch([cid, predRaw, resetKeyVal], () => {
      clusterer.reset()
    }, { immediate: true })
  }
  else {
    // 过滤/聚焦/predicate/上下文变化 → 全量重建(先注册先执行,重置先于同步)
    watch([cid, filterVal, focusVal, predRaw, resetKeyVal], () => {
      clusterer.reset()
    }, { immediate: true })
  }

  watch(source, (l) => {
    clusterer.sync(l)
    // 新数组引用触发 v-for 更新(shallowRef 同引用赋值不触发;块自身已 reactive,
    // 块内变更由深层依赖传导,key 稳定复用组件)
    blocks.value = [...clusterer.blocks]
  }, { immediate: true })

  const totalEvents = computed(() => source.value.length)

  return { blocks, totalEvents, clusterer }
}

export type { EventBlock }
