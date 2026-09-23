/**
 * 小镇视图 — 事件流与趋势节拍(右轨实时事件 / 200ms 重绘)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 * 最近事件队列(400ms)与趋势/火花线重绘(200ms;读 rtc 实时缓冲,数据消费在帧通道)。
 */
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'
import type { ShallowRef } from 'vue'
import type { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import type { TownViewScene } from '@/app/components/workshop/town/TownView.vue'

export function useTownHudTickers(params: {
  sceneRef: ShallowRef<TownViewScene | null>
  daq: ReturnType<typeof useDaqStream>
  drawTrend: () => void
  drawBindSparks: () => void
}) {
  const { sceneRef, daq, drawTrend, drawBindSparks } = params

  let tickerTimer: ReturnType<typeof setInterval> | null = null
  let daqTimer: ReturnType<typeof setInterval> | null = null

  /** 事件流:最近事件队列(at 供右轨"实时事件"面板;2D 场景无 at → 占位) */
  const ticker = shallowRef<Array<{ channelId: string, agentName: string, text: string, at?: number }>>([])
  /** 后台标签页暂停事件/趋势节拍(前台恢复;恒定 CPU 底噪归零) */
  function onVisChange(): void {
    if (document.hidden) {
      if (daqTimer) {
        clearInterval(daqTimer)
        daqTimer = null
      }
      if (tickerTimer) {
        clearInterval(tickerTimer)
        tickerTimer = null
      }
      return
    }
    if (!daqTimer) {
      daqTimer = setInterval(() => {
        if (daq.nodes.length) {
          drawTrend()
          drawBindSparks()
        }
      }, 200)
    }
    if (!tickerTimer) {
      tickerTimer = setInterval(() => {
        const s = sceneRef.value
        if (s?.getRecentActivity) ticker.value = s.getRecentActivity()
      }, 400)
    }
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisChange)
    // 趋势/火花线 200ms 重绘(读 rtc 实时缓冲;数据消费在帧通道,这里只负责出图)
    daqTimer = setInterval(() => {
      if (daq.nodes.length) {
        drawTrend()
        drawBindSparks()
      }
    }, 200)
    tickerTimer = setInterval(() => {
      const s = sceneRef.value
      if (s?.getRecentActivity) ticker.value = s.getRecentActivity()
    }, 400)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisChange)
    if (daqTimer) clearInterval(daqTimer)
    if (tickerTimer) clearInterval(tickerTimer)
    daqTimer = null
    tickerTimer = null
  })

  return { ticker }
}
