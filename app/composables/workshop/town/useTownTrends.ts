/**
 * 小镇视图 — 趋势图(数采历史曲线 + 信号条)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 * 信号条 chip 显隐/折叠、趋势画布绘制(默认前 8 路,直方优先取 rtc 环形缓冲)。
 */
import { computed, ref } from 'vue'
import type { ComponentPublicInstance, ComputedRef } from 'vue'
import type { DeviceTwinView } from '@/app/composables/workshop/useDeviceTwins'
import type { DaqSimState } from './town-view-types'

export function useTownTrends(params: {
  daqTwins: ComputedRef<DeviceTwinView[]>
  daqSim: ComputedRef<Map<string, DaqSimState>>
  rtcHist: Map<string, number[]>
  RTC_HIST_CAP: number
  trendColor: (id: string) => string
}) {
  const { daqTwins, daqSim, rtcHist, RTC_HIST_CAP, trendColor } = params

  function toggleTrend(id: string): void {
    hiddenTrends.value = { ...hiddenTrends.value, [id]: !hiddenTrends.value[id] }
  }

  /** 趋势图(数采历史;画布在 dock 趋势卡) */
  const trendCanvas = ref<HTMLCanvasElement | null>(null)
  /** 趋势画布元素回填(画布随 components/TownTrendDock.vue 搬移,绘制仍由父组件持有) */
  function setTrendCanvas(el: Element | ComponentPublicInstance | null): void {
    trendCanvas.value = (el as HTMLCanvasElement | null)
  }
  const hiddenTrends = ref<Record<string, boolean>>({})
  /** 默认只画前 8 路:52 条曲线叠绘成不可读 spaghetti,数据可读性优先;
   *  用户显式点过 chip 的以 hiddenTrends 覆盖为准 */
  const TREND_VISIBLE_DEFAULT = 8
  function trendOn(id: string, idx?: number): boolean {
    const v = hiddenTrends.value[id]
    if (v != null) return !v
    const i = idx ?? daqTwins.value.findIndex(t => t.id === id)
    return i < TREND_VISIBLE_DEFAULT
  }
  /** 信号条折叠:收起时只渲染前 8 枚 chip,余量聚合成「+N」(展开/收起) */
  const trendExpanded = ref(false)
  const trendOverflow = computed(() => Math.max(daqTwins.value.length - TREND_VISIBLE_DEFAULT, 0))
  const trendChips = computed(() =>
    trendExpanded.value ? daqTwins.value : daqTwins.value.slice(0, TREND_VISIBLE_DEFAULT))
  function drawTrend(): void {
    const cv = trendCanvas.value
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio, 2)
    const w = cv.clientWidth
    const h = cv.clientHeight
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr
      cv.height = h * dpr
    }
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // 网格
    ctx.strokeStyle = 'rgba(29, 42, 66, 0.6)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    daqTwins.value.forEach((t, idx) => {
      if (!trendOn(t.id, idx)) return
      const st = daqSim.value.get(t.id)
      if (!st) return
      // 直方优先:rtc 环形缓冲(帧直写)比 store 批量缓冲新鲜,画出来的就是当前最新轨迹
      const hist = rtcHist.get(t.id) ?? st.hist
      if (hist.length < 2) return
      const lo = st.tpl.min
      const hi = st.tpl.max
      ctx.strokeStyle = trendColor(t.id)
      ctx.lineWidth = 1.6
      ctx.beginPath()
      hist.forEach((v, i) => {
        const x = (i / (RTC_HIST_CAP - 1)) * w
        const y = h - ((v - lo) / (hi - lo)) * (h - 8) - 4
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    })
  }

  return { hiddenTrends, toggleTrend, setTrendCanvas, trendOn, trendExpanded, trendOverflow, trendChips, drawTrend }
}
