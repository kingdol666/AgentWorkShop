/**
 * 时间线「加载更早」翻页(beforeSeq 游标;顶部按钮驱动)。
 *
 * 头部插入必须还原视口:历史帧插到列首会把内容整体下推,若不做补偿,
 * 浏览器保持 scrollTop 不变 → 视口里的块"跳"走。这里记住插入前的
 * (scrollTop, scrollHeight),nextTick 后按 scrollHeight 增量还原 scrollTop,
 * 视口锚定在同一批块上(不吸底跳变)。拉取失败保持按钮可重试,不打断时间线。
 *
 * 从 TranscriptTimeline 拆出时逻辑逐行未动;滚动容器由容器组件经参数传入
 * (锚定用,未挂载时为 null)。
 */
import { computed, nextTick, ref, toValue } from 'vue'
import type { MaybeRefOrGetter, Ref } from 'vue'
import { useEventsStore } from '@/app/stores/workshop/events'

export function useTranscriptHistory(
  channelId: MaybeRefOrGetter<string>,
  /** 滚动容器(视口锚定用) */
  scroller: Ref<HTMLElement | null>,
) {
  const events = useEventsStore()

  // ===== 向上翻页历史 =====
  const loadingEarlier = ref(false)
  const earlierExhausted = ref(false)
  /** 已加载事件数 vs 持久化总量 → 是否可能还有更早(粗判,点击时由 loadEarlier 探底) */
  const loadedCount = computed(() => events.ring(toValue(channelId)).items.length)
  const maybeMore = computed(() => !earlierExhausted.value && loadedCount.value > 0)
  const loadEarlier = async (): Promise<void> => {
    if (loadingEarlier.value || earlierExhausted.value) return
    loadingEarlier.value = true
    // 记住滚动位置:头部插入后保持视口锚定(不吸底跳变)
    const el = scroller.value
    const anchor = el ? { top: el.scrollTop, height: el.scrollHeight } : null
    try {
      const hasMore = await events.loadEarlier(toValue(channelId))
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

  return { loadingEarlier, earlierExhausted, loadedCount, maybeMore, loadEarlier }
}
