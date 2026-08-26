/**
 * TownSceneMath — 小镇场景的纯几何/色彩决策层(零渲染依赖,可单测)。
 *
 * 从 TownScene3D 抽离的纯函数集:边界几何(椭圆/矩形 + rotationY)、点钳制、
 * 活动范围收敛、身份色哈希。2D/3D 场景与测试共用同一实现,避免答案分叉。
 *
 * 约定:3D 世界用 x/z 平面(y 向上,地面 y=0);2D 世界用 x/y 平面等价映射。
 * 边界围绕中心 (x,z);radiusX/radiusZ 表示椭圆半轴或矩形半宽,rotationY(度)绕纵轴。
 */
import type { AepEnvelope } from './workshop-protocol'

// ================================================================
// 世界尺度(与 2D 对齐:3200×2400,3D 用 x/z 平面,y 向上)
// ================================================================

export const WORLD_W = 3200
export const WORLD_H = 2400
export const WORLD_CX = WORLD_W / 2
export const WORLD_CZ = WORLD_H / 2
/** 地面 y=0,Agent 站立于其上 */
export const GROUND_Y = 0
/** GLB 归一化到该高度(世界单位,角色要清晰可读) */
export const UNITS = 120
export const AGENT_SPEED = 96
export const WAIT_MS = 2600
export const ARRIVE = 48
/** 编辑拖拽网格吸附粒度(世界单位) */
export const SNAP_SIZE = 16
/** 聊天气泡悬挂高度(世界单位;角色头顶名牌上方,随模型缩放微调) */
export const BUBBLE_Y = 86

// ================================================================
// 布局类型(频道领地 / Agent 活动范围)
// ================================================================

/** 频道领地布局:与 AepSceneLayout/useSceneLayouts 同构 */
export interface ChannelLayout {
  channelId: string
  x: number
  z: number
  radiusX: number
  radiusZ: number
  shape: 'ellipse' | 'rect'
  rotationY: number
}

/** Agent 独立活动范围(编辑模式框选绘制/手柄调整;经 config.range 持久化)。
 *  缺省(null)= 未设置,该 Agent 沿用频道边界活动。 */
export interface AgentRangeLayout {
  x: number
  z: number
  radiusX: number
  radiusZ: number
  shape: 'ellipse' | 'rect'
  rotationY: number
}

// ================================================================
// 边界几何
// ================================================================

/** 边界/范围的局部轮廓点(矩形四角 / 椭圆细分;radius 是半轴或半宽,供线框与测试)。 */
export function boundaryPoints(shape: 'ellipse' | 'rect', rx: number, rz: number, seg = 48): Array<[number, number]> {
  if (shape === 'rect') return [[-rx, -rz], [rx, -rz], [rx, rz], [-rx, rz]]
  const pts: Array<[number, number]> = []
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2
    pts.push([Math.cos(t) * rx, Math.sin(t) * rz])
  }
  return pts
}

/** 归一化边界(radius 钳制下限;椭圆半轴 / 矩形半宽) */
export function normLayout<T extends ChannelLayout | { x: number, z: number, radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect', rotationY: number }>(l: T): T {
  return {
    ...l,
    radiusX: Math.max(60, l.radiusX),
    radiusZ: Math.max(40, l.radiusZ),
    shape: l.shape === 'rect' ? 'rect' : 'ellipse',
    rotationY: l.rotationY || 0,
  }
}

/** 旋转坐标到局部系(localX/localZ);用于把世界点折算到未旋转的边界坐标系。 */
export function toLocal(l: { x: number, z: number, rotationY: number }, x: number, z: number): { x: number, z: number } {
  const rad = -l.rotationY * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = x - l.x
  const dz = z - l.z
  return { x: dx * cos - dz * sin, z: dx * sin + dz * cos }
}

/** 局部坐标旋回世界系。 */
export function toWorld(l: { x: number, z: number, rotationY: number }, lx: number, lz: number): { x: number, z: number } {
  const wrad = l.rotationY * Math.PI / 180
  const wcos = Math.cos(wrad)
  const wsin = Math.sin(wrad)
  return { x: l.x + lx * wcos - lz * wsin, z: l.z + lx * wsin + lz * wcos }
}

/** 把点钳制到边界内(带内缩 margin;旋转边界用逆变换求局部坐标) */
export function clampToBoundary(
  layout: ChannelLayout,
  x: number,
  z: number,
  margin = 0,
): { x: number, z: number } {
  const l = normLayout(layout)
  const { x: lx, z: lz } = toLocal(l, x, z)
  const rx = Math.max(8, l.radiusX - margin)
  const rz = Math.max(8, l.radiusZ - margin)
  let cx = lx
  let cz = lz
  if (l.shape === 'rect') {
    cx = Math.max(-rx, Math.min(rx, lx))
    cz = Math.max(-rz, Math.min(rz, lz))
  }
  else {
    // 椭圆:点缩放到单位圆内
    const nx = lx / rx
    const nz = lz / rz
    const d = Math.hypot(nx, nz)
    if (d > 1) {
      cx = nx / d * rx
      cz = nz / d * rz
    }
  }
  return toWorld(l, cx, cz)
}

/** 点到边界内判定(与 clampToBoundary 同旋转约定;纯函数,供工具与场景共用) */
export function pointInBoundary(layout: ChannelLayout, x: number, z: number): boolean {
  const l = normLayout(layout)
  const { x: lx, z: lz } = toLocal(l, x, z)
  if (l.shape === 'rect') return Math.abs(lx) <= l.radiusX && Math.abs(lz) <= l.radiusZ
  const nx = lx / l.radiusX
  const nz = lz / l.radiusZ
  return nx * nx + nz * nz <= 1
}

/** 边界/范围的极值点(矩形四角 / 椭圆轴向四点;世界坐标,含 rotationY) */
export function boundaryExtremePoints(
  layout: { x: number, z: number, radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect', rotationY: number },
  margin = 0,
): Array<[number, number]> {
  const rx = Math.max(0, layout.radiusX - margin)
  const rz = Math.max(0, layout.radiusZ - margin)
  const local: Array<[number, number]> = layout.shape === 'rect'
    ? [[rx, rz], [-rx, rz], [-rx, -rz], [rx, -rz]]
    : [[rx, 0], [-rx, 0], [0, rz], [0, -rz]]
  return local.map(([lx, lz]) => {
    const { x, z } = toWorld(layout, lx, lz)
    return [x, z] as [number, number]
  })
}

/** 把 Agent 活动范围整体收进频道边界:中心钳入 + 半径收缩使极值点全部在边界内 */
export function clampRangeToLayout(layout: ChannelLayout, range: AgentRangeLayout): AgentRangeLayout {
  const l = normLayout(layout)
  const center = clampToBoundary(l, range.x, range.z, 20)
  let rx = Math.max(30, range.radiusX)
  let rz = Math.max(30, range.radiusZ)
  const margin = 12
  for (let i = 0; i < 24; i++) {
    const outside = boundaryExtremePoints({ x: center.x, z: center.z, radiusX: rx, radiusZ: rz, shape: range.shape, rotationY: range.rotationY }, margin)
      .some(([wx, wz]) => !pointInBoundary(l, wx, wz))
    if (!outside) break
    rx = Math.max(30, rx * 0.9)
    rz = Math.max(30, rz * 0.9)
  }
  return { x: center.x, z: center.z, radiusX: rx, radiusZ: rz, shape: range.shape, rotationY: range.rotationY }
}

/** 把点钳制到 Agent 自己活动范围内(带内缩 margin;矩形 radius 是半宽)。 */
export function clampToAgentRange(
  range: AgentRangeLayout,
  x: number,
  z: number,
  margin = 0,
): { x: number, z: number } {
  const { x: lx, z: lz } = toLocal(range, x, z)
  const rx = Math.max(8, range.radiusX - margin)
  const rz = Math.max(8, range.radiusZ - margin)
  let cx = lx
  let cz = lz
  if (range.shape === 'rect') {
    cx = Math.max(-rx, Math.min(rx, lx))
    cz = Math.max(-rz, Math.min(rz, lz))
  }
  else {
    const nx = lx / rx
    const nz = lz / rz
    const d = Math.hypot(nx, nz)
    if (d > 1) {
      cx = (nx / d) * rx
      cz = (nz / d) * rz
    }
  }
  return toWorld(range, cx, cz)
}

/** 世界点到活动范围边界线的最近距离(矩形 4 边带 / 椭圆等距采样;矩形 radius 是半宽)。 */
export function distToRangeBoundary(range: AgentRangeLayout, x: number, z: number): number {
  const { x: lx, z: lz } = toLocal(range, x, z)
  const rx = Math.max(8, range.radiusX)
  const rz = Math.max(8, range.radiusZ)
  if (range.shape === 'rect') {
    return Math.min(Math.abs(lz - rz), Math.abs(lz + rz), Math.abs(lx - rx), Math.abs(lx + rx))
  }
  let best = Infinity
  const seg = 40
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2
    best = Math.min(best, Math.hypot(lx - Math.cos(t) * rx, lz - Math.sin(t) * rz))
  }
  return best
}

// ================================================================
// 身份色(agentId / channelId 哈希 → 稳定色相,一处定义)
// ================================================================

/** FIFO 下每条气泡的展示时长:短句快速切换、长句更久(2.4s~7.2s)——放大气泡后同步延长可读窗口 */
export function bubbleDisplayMs(text: string): number {
  return Math.min(7200, Math.max(2400, 1700 + text.length * 36))
}

export function hashHue(id: string): number {
  if (!id) return 200
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export function hslToRgb(h: number, s: number, l: number): { r: number, g: number, b: number } {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255)
  }
  return { r: f(0), g: f(8), b: f(4) }
}

/** channelId → 稳定色(3D 场景用:RGB 打包 int) */
export function channelColorNum(channelId: string): number {
  const c = hslToRgb(hashHue(channelId) / 360, 0.58, 0.6)
  return (c.r << 16) | (c.g << 8) | c.b
}

/** channelId → CSS 色(UI 用:HSL 字符串,与场景同源) */
export function channelColorCss(channelId: string): string {
  return `hsl(${Math.round(hashHue(channelId))}, 58%, 60%)`
}

// ================================================================
// 调试/统计辅助
// ================================================================

/** 事件流最近活动:提取可读文本(供 HUD 跑马灯;与 town-protocol 同口径) */
export function eventText(e: AepEnvelope): string {
  const p = e.payload as { parts?: Array<{ text?: string } | { data?: unknown }> } | undefined
  const parts = p?.parts ?? []
  return parts
    .map(pt => 'text' in pt ? (pt.text ?? '') : 'data' in pt ? JSON.stringify(pt.data) : '')
    .join('\n')
    .trim()
}
