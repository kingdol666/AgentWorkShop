/**
 * useLaneWidths —— 泳道列宽拖拽调节状态(PaneSplitter 驱动,双击复位)。
 *
 * 宽度的唯一状态源:useStorage 绑定 localStorage 单键(aw.harness.laneW)。
 * 只在 AgentLanesView 的 setup 中实例化一次(重复实例化 = 各自独立的 ref,
 * 父/子不同步),子组件经 props 共享同一份宽度;更新一律走不可变替换。
 */

import { useStorage } from '@vueuse/core'

export const LANE_W_DEFAULT = 320

export function useLaneWidths() {
  // ===== 泳道列宽拖拽调节(PaneSplitter;按 agentId 持久化,双击复位默认宽) =====
  const laneWidths = useStorage<Record<string, number>>('aw.harness.laneW', {})
  const laneWidth = (id: string): number => laneWidths.value[id] ?? LANE_W_DEFAULT
  const resizeLane = (id: string, d: number): void => {
    laneWidths.value = { ...laneWidths.value, [id]: Math.min(720, Math.max(240, laneWidth(id) + d)) }
  }
  const resetLane = (id: string): void => {
    const next = { ...laneWidths.value }
    Reflect.deleteProperty(next, id)
    laneWidths.value = next
  }

  return { laneWidths, laneWidth, resizeLane, resetLane }
}
