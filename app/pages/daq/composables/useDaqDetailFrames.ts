import { computed, onMounted, watch, type ComputedRef } from 'vue'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'

/* 向量轮廓(最近一帧预览;SVG polyline,免 canvas 绘制循环) */
export const VEC_W = 320
export const VEC_H = 84

/**
 * 帧视图(v2 多形态信号:向量轮廓 / 图像画廊;scalar 节点不渲染)。
 * 帧缓冲是 store 的客户端资产,这里只做切片与折线投影;
 * 首帧拉取时机与原页面一致(onMounted 内、WS 喂帧之后)。
 */
export function useDaqDetailFrames(nodeId: ComputedRef<string>, isFrameNode: ComputedRef<boolean>) {
  const daq = useDaqStream()

  const frames = computed(() => daq.framesOf(nodeId.value))

  async function loadFrames(): Promise<void> {
    if (!nodeId.value) return
    await daq.fetchFrames(nodeId.value, { limit: 24 }).catch(() => {})
  }
  onMounted(() => {
    if (isFrameNode.value) void loadFrames()
  })
  watch(nodeId, () => {
    if (isFrameNode.value) void loadFrames()
  })

  const latestVector = computed(() => frames.value.find(f => f.kind === 'vector' && f.points?.length))
  const vecPath = computed(() => {
    const pts = latestVector.value?.points ?? []
    if (pts.length < 2) return ''
    const min = Math.min(...pts)
    const max = Math.max(...pts)
    const span = max - min || 1
    return pts
      .map((p, i) => `${((i / (pts.length - 1)) * VEC_W).toFixed(1)},${(VEC_H - 6 - ((p - min) / span) * (VEC_H - 12)).toFixed(1)}`)
      .join(' ')
  })

  return { frames, loadFrames, vecPath }
}
