/**
 * 时间线新块进场编排(open-tag motion charter 移植)。
 *
 * 只有实时新到的尾部块做进场动画(60ms stagger,600ms burst 窗口,上限 8 条);
 * 整体重建(过滤切换/聚焦/历史回填——一次出现大量新 id)与组件首载直接显示,
 * 不动画不延迟。映射:blockId → 进场延迟 ms;-1 = 不动画。
 *
 * 从 TranscriptTimeline 拆出时逻辑逐行未动:唯一的改动是私有类型 `Stage`
 * 更名并导出为 `TranscriptEnterStage`(子组件要向 workshop-event-block 传同一结构)。
 */
import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'

export interface TranscriptEnterStage {
  enter: boolean
  delay: number
}

export function useTranscriptEnterStage(blocks: Ref<EventBlock[]>) {
  const staged = ref(new Map<string, TranscriptEnterStage>())
  let burstAt = 0
  let burstN = 0
  const mountedAt = Date.now()
  watch(blocks, (list, prev) => {
    const prevIds = new Set((prev ?? []).map(b => b.id))
    const fresh = list.filter(b => !prevIds.has(b.id))
    const map = new Map<string, TranscriptEnterStage>()
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

  return { staged }
}
