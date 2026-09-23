import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import { useDaqStream, type DaqNodeLive, type DaqTsdbPoint } from '@/app/composables/workshop/useDaqStream'

/**
 * 历史(时序库)与 live 趋势 —— 两张画布 + 拉取节拍 + resize/可见性补绘。
 *
 * 画布 DOM 由子组件渲染(defineModel 反写),绘制指令与定时器留在本 composable:
 * 这是「一个画布一个 ref 所有者」的唯一副本,子组件只负责把 <canvas> 挂上去。
 * 拉取间隔、后台降频与重挂定时器的语义与原页面逐字一致。
 */
export function useDaqDetailHistory(nodeId: ComputedRef<string>, node: ComputedRef<DaqNodeLive | null>) {
  const { t } = useI18n()
  const daq = useDaqStream()

  /** 历史点 = 数采时序点(直接用 DaqTsdbPoint:手写副本漏了 state/cnt,模板取值即报错) */
  type ChartRow = DaqTsdbPoint
  const historyPoints = ref<ChartRow[]>([])
  const bucketMs = ref<number>(15000)
  const histLoading = ref(false)
  const BUCKETS = computed(() => [
    { label: t('daqDetail.bucket1s'), ms: 1000 },
    { label: t('daqDetail.bucket5s'), ms: 5000 },
    { label: t('daqDetail.bucket15s'), ms: 15000 },
    { label: t('daqDetail.bucket30s'), ms: 30000 },
    { label: t('daqDetail.bucket60s'), ms: 60000 },
  ])
  async function loadHistory(): Promise<void> {
    if (!nodeId.value) return
    histLoading.value = true
    try {
      const pts = await daq.samplesOf(nodeId.value, {
        toMs: Date.now(),
        bucketMs: bucketMs.value || undefined,
        limit: 400,
      })
      // 接口 DESC 返回 → 图表时间正序
      historyPoints.value = [...pts].reverse() as ChartRow[]
    }
    finally {
      histLoading.value = false
      drawChart()
    }
  }

  const chartCanvas = ref<HTMLCanvasElement | null>(null)
  const trendColor = '#35e0a0'
  const gridColor = 'rgba(120,135,160,0.18)'
  const inkColor = 'rgba(140,155,175,0.8)'
  function drawChart(): void {
    const cv = chartCanvas.value
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
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
    for (let i = 1; i < 4; i++) {
      ctx.strokeStyle = gridColor
      ctx.beginPath()
      ctx.moveTo(0, (h / 4) * i)
      ctx.lineTo(w, (h / 4) * i)
      ctx.stroke()
    }
    const rows = historyPoints.value
    if (rows.length < 2) return
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const r of rows) {
      const v = r.value ?? r.avg ?? r.min ?? 0
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    const span = Math.max(hi - lo, 1e-9)
    ctx.strokeStyle = inkColor
    ctx.font = '10px monospace'
    ctx.fillStyle = inkColor
    ctx.fillText(hi.toFixed(2), 4, 11)
    ctx.fillText(lo.toFixed(2), 4, h - 4)
    ctx.strokeStyle = trendColor
    ctx.lineWidth = 1.6
    ctx.beginPath()
    rows.forEach((r, i) => {
      const x = (i / (rows.length - 1)) * w
      const y = h - (((r.value ?? r.avg ?? 0) - lo) / span) * (h - 16) - 8
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  /** live 趋势(WS hist 环形缓冲;独立小画布,与历史图互补)。
   *  绘制门控:hist 未变化跳过重绘;后台标签页暂停;容器 resize 后补绘(免错位模糊)。 */
  const liveCanvas = ref<HTMLCanvasElement | null>(null)
  let uiTimer: ReturnType<typeof setInterval> | null = null
  let liveSig = ''
  function drawLive(): void {
    const cv = liveCanvas.value
    const n = node.value
    if (!cv || !n || n.hist.length < 2) return
    const sig = `${n.hist.length}:${n.hist[n.hist.length - 1]}:${n.hist[0]}`
    if (sig === liveSig) return
    liveSig = sig
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
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
    const hi = Math.max(...n.hist)
    const lo = Math.min(...n.hist)
    const span = Math.max(hi - lo, 1e-9)
    ctx.strokeStyle = 'rgba(65,200,244,0.9)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    n.hist.forEach((v, i) => {
      const x = (i / (n.hist.length - 1)) * w
      const y = h - ((v - lo) / span) * (h - 6) - 3
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  /** resize 后历史图与 live 图都需补绘(尺寸变化不触发数据变化,原实现会错位) */
  let resizeObs: ResizeObserver | null = null
  let liveHidden = false
  function onVisChange(): void {
    liveHidden = document.hidden
    if (!liveHidden) {
      drawLive()
      // 后台期间暂停的自动刷新在回到前台时立即补一次拉取(免等待下一个节拍)
      if (effectiveRefreshMs.value) void loadHistory()
    }
  }

  // ---------- 趋势图自动刷新(时序库拉取展示间隔;与采集/WS 下发三个节拍互相独立) ----------
  /** 用户覆盖值(ms;0 = 跟随服务端 daq.query.displayIntervalMs) */
  const refreshOverrideMs = ref<number>(0)
  /** 实际生效的拉取间隔:用户覆盖优先,否则取服务端缺省;统一下钳到服务端下限 */
  const effectiveRefreshMs = computed(() => {
    const min = daq.controller.minQueryDisplayIntervalMs ?? 500
    const base = refreshOverrideMs.value > 0 ? refreshOverrideMs.value : (daq.controller.queryDisplayIntervalMs ?? 0)
    return base > 0 ? Math.max(min, base) : 0
  })
  let histTimer: ReturnType<typeof setInterval> | null = null
  /** 重挂拉取定时器:间隔变化(用户改值/服务端配置热更)即刻生效 */
  function armHistTimer(): void {
    if (histTimer) {
      clearInterval(histTimer)
      histTimer = null
    }
    const ms = effectiveRefreshMs.value
    if (!import.meta.client || !ms) return
    histTimer = setInterval(() => {
      // 后台标签页不查库(省时序库连接);上一拍未结束则跳过(防堆积)
      if (document.hidden || histLoading.value) return
      void loadHistory()
    }, ms)
  }
  onMounted(() => {
    void loadHistory()
    // live 趋势重绘循环(仅浏览器;SSR 安全;绘制由 liveSig 门控,数据未变零开销)
    uiTimer = setInterval(() => {
      if (!liveHidden) drawLive()
    }, 800)
    document.addEventListener('visibilitychange', onVisChange)
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => {
        liveSig = ''
        drawLive()
        drawChart()
      })
      if (liveCanvas.value) resizeObs.observe(liveCanvas.value)
    }
    armHistTimer()
  })
  onBeforeUnmount(() => {
    if (uiTimer) clearInterval(uiTimer)
    if (histTimer) clearInterval(histTimer)
    document.removeEventListener('visibilitychange', onVisChange)
    resizeObs?.disconnect()
    resizeObs = null
  })

  watch(bucketMs, () => void loadHistory())
  watch(effectiveRefreshMs, () => armHistTimer())

  return { historyPoints, bucketMs, histLoading, BUCKETS, loadHistory, chartCanvas, liveCanvas, refreshOverrideMs }
}
