<script setup lang="ts">
/**
 * 时间线块流:日期分隔线 + workshop-event-block 列表(v-for 整体搬入)。
 * 纯呈现:`blocks`(增量聚类结果)与 `staged`(进场编排映射)由容器传入。
 * 日期分隔线的计算随标记一起搬来(块 firstAt 跨日 → 插入 hairline 分隔;
 * .date-divider / .date-divider-label 是 main.css 里的全局规则,故此处无需 scoped 样式)。
 */
import type { EventBlock } from '@/app/composables/workshop/useEventBlocks'
import type { TranscriptEnterStage } from '@/app/composables/workshop/useTranscriptEnterStage'

const props = defineProps<{
  /** 聚类后的块流(与容器 v-for 同源) */
  blocks: EventBlock[]
  /** blockId → 进场延迟映射(useTranscriptEnterStage) */
  staged: Map<string, TranscriptEnterStage>
}>()

const { t } = useI18n()

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
  if (sameDay(d, today)) return t('transcriptTimeline.k3wcqg018')
  if (sameDay(d, yesterday)) return t('transcriptTimeline.k40l1y019')
  const y = d.getFullYear() !== today.getFullYear() ? t('transcriptTimeline.k2hda35028', { p0: d.getFullYear() }) : ''
  return t('transcriptTimeline.kbs29zx029', { p0: y, p1: d.getMonth() + 1, p2: d.getDate() })
}
/** 每个块是否需要前置日界分隔(与上一块不同日,或首块) */
const blockDayFlags = computed(() => {
  const flags: Array<{ divider: string | null }> = []
  let prevDay: number | null = null
  for (const b of props.blocks) {
    const day = startOfDay(b.firstAt)
    flags.push({ divider: prevDay === null || day !== prevDay ? dayLabel(b.firstAt) : null })
    prevDay = day
  }
  return flags
})
</script>

<template>
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
</template>
