/**
 * 小镇视图 — 设备健康度(KPI 计数 + 环形图)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 * 设备状态计数、健康度百分比与环形图绘制(画布由子组件经 setter 回填)。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'

export function useTownHealth(params: {
  deviceTwins: ReturnType<typeof useDeviceTwins>
}) {
  const { deviceTwins } = params

  const deviceCount = computed(() => deviceTwins.twins.length)
  const runningCount = computed(() => deviceTwins.twins.filter(t => t.state === 'running').length)
  /** 设备健康度(环形图数据) */
  const idleCount = computed(() => deviceTwins.twins.filter(t => t.state === 'idle').length)
  const alarmCount = computed(() => deviceTwins.twins.filter(t => t.state === 'alarm').length)
  const offlineCount = computed(() => deviceTwins.twins.filter(t => t.state === 'offline').length)
  const healthPct = computed(() => {
    const total = deviceTwins.twins.length
    if (!total) return 100
    const healthy = runningCount.value + idleCount.value
    return Math.round((healthy / total) * 100)
  })
  /** 健康分档语义色:中心百分数跟健康走(绿≥90/琥珀≥60/红<60),环保持状态分布语义 */
  const healthTone = computed(() =>
    healthPct.value >= 90 ? '#35e0a0' : healthPct.value >= 60 ? '#f6c453' : '#ff6b6b')
  const donutCanvas = ref<HTMLCanvasElement | null>(null)
  /** 健康环画布元素回填(画布随 components/TownHealthBody.vue 搬移,环形绘制仍由父组件持有) */
  function setDonutCanvas(el: Element | ComponentPublicInstance | null): void {
    donutCanvas.value = (el as HTMLCanvasElement | null)
  }
  function drawDonut(): void {
    const cv = donutCanvas.value
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const total = deviceTwins.twins.length || 1
    const segs: Array<{ n: number, color: string }> = [
      { n: runningCount.value, color: '#35e0a0' },
      { n: idleCount.value, color: '#f6c453' },
      { n: alarmCount.value, color: '#ff6b6b' },
      { n: offlineCount.value, color: '#3a4a63' },
    ]
    ctx.clearRect(0, 0, 118, 118)
    ctx.lineWidth = 12
    let ang = -Math.PI / 2
    for (const seg of segs) {
      if (!seg.n) continue
      const sweep = (seg.n / total) * Math.PI * 2
      ctx.beginPath()
      ctx.strokeStyle = seg.color
      ctx.arc(59, 59, 48, ang, ang + sweep)
      ctx.stroke()
      ang += sweep
    }
  }
  watch(healthPct, () => drawDonut())
  watch(() => deviceTwins.twins.length, () => drawDonut())
  onMounted(() => drawDonut())

  return { deviceCount, runningCount, idleCount, alarmCount, offlineCount, healthPct, healthTone, setDonutCanvas }
}
