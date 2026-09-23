/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 拾取 / 选中 / 缩放旋转 / 频道选中。
 *
 * 自 TownScene3D.ts 抽出(客制化:场景内点选 Agent/设备 → 弹滑杆调大小):
 *  - pickBeacon / pickAt / pickChannel / pickChannelEdge:世界坐标命中判定;
 *  - setSelected / getSelectedScale / registerScalable / persistScale:可缩放目标注册与滑杆;
 *  - setModelScale / setModelRotation / getModelRotation:倍率与朝向;
 *  - setTransformMode / isGizmoBusy:Blender 式变换手柄;
 *  - setExposure / setTerritoryOpacity:环境光照与领地染色浓度;
 *  - selectChannel / getSelectedChannel:频道选中(边界面板 + 边界高亮 + 聚焦)。
 *
 * 宿主契约:场景类实现 SelectionHost(只列本模块触达的成员)。
 */
import * as THREE from 'three'
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { WORLD_CX, WORLD_CZ, pointInBoundary, toLocal } from '#shared/town-scene-math'
import type { Agent3D, Block3D, DeviceNode } from './town-scene3d-nodes'
import type { PointerDragState, ScaledTarget, SelectedTarget, TownEventMap, TownScene3DMode } from './town-scene3d-types'

/** 拾取 / 选中模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface SelectionHost {
  readonly scene: THREE.Scene
  readonly renderer: THREE.WebGLRenderer
  readonly agents: Map<string, Agent3D>
  readonly deviceNodes: Map<string, DeviceNode>
  readonly blocks: Map<string, Block3D>
  /** 场景内可缩放目标(Agent 或设备) */
  readonly scalables: Map<string, ScaledTarget>
  selected: SelectedTarget | null
  /** 当前选中频道(供边界编辑面板) */
  selectedChannel: string | null
  readonly pointerDrag: PointerDragState
  /** 框选绘制目标 agent(非空 = 编辑模式正在为该角色拉动矩形框) */
  readonly rangeDrawAgent: string | null
  readonly mode: TownScene3DMode
  /** Blender 式变换手柄(选中设备) */
  readonly tControls: TransformControls | null
  /** 请求下一帧重绘 */
  markDirty(): void
  /** 场景 → Vue HUD 事件 */
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
  /** 退出框选绘制模式(清理预览与状态) */
  cancelRangeDraw(): void
  /** 同步全部范围线框可见性 */
  refreshAgentRangeLines(): void
  /** 刷新 Agent 活动范围手柄 */
  refreshAgentRangeHandles(): void
  /** 刷新边界手柄位置/可见性 */
  refreshChannelHandles(): void
  /** 缓动聚焦某世界点 */
  focusTo(x: number, z: number): void
  /** 持久化设备 transform(防抖) */
  persistDeviceTransform(id: string): void
}

/** 命中频道信标(中心 ±34 单位;点击信标 = 定位中心 + 唤醒边界编辑,任何模式) */
export function pickBeacon(host: SelectionHost, x: number, z: number): { cid: string, x: number, z: number } | null {
  for (const b of host.blocks.values()) {
    if (Math.hypot(b.x - x, b.z - z) < 34) return { cid: b.channelId, x: b.x, z: b.z }
  }
  return null
}

/** 以世界坐标 hit 一个 Agent 或设备节点(近似距离阈值;供点击选中) */
export function pickAt(host: SelectionHost, x: number, z: number): { kind: 'agent' | 'device', id: string } | null {
  let best: { kind: 'agent' | 'device', id: string, d: number } | null = null
  for (const a of host.agents.values()) {
    const d = Math.hypot(a.root.position.x - x, a.root.position.z - z)
    if (d < 90 && (!best || d < best.d)) best = { kind: 'agent', id: a.agentId, d }
  }
  for (const dev of host.deviceNodes.values()) {
    const d = Math.hypot(dev.root.position.x - x, dev.root.position.z - z)
    if (d < 90 && (!best || d < best.d)) best = { kind: 'device', id: dev.twinId, d }
  }
  return best ? { kind: best.kind, id: best.id } : null
}

/** 点选频道:返回包含该点的频道 id(边界内;供编辑模式打开边界编辑面板) */
export function pickChannel(host: SelectionHost, x: number, z: number): string | null {
  for (const b of host.blocks.values()) {
    const layout = {
      channelId: b.channelId, x: b.x, z: b.z,
      radiusX: b.radiusX, radiusZ: b.radiusZ,
      shape: b.shape, rotationY: b.rotationY,
    }
    if (pointInBoundary(layout, x, z)) return b.channelId
  }
  return null
}

/** 命中频道边界线(世界点落在某领地边界带 ±42 单位内 → 边界拖拽等比缩放)。 */
export function pickChannelEdge(host: SelectionHost, x: number, z: number): { cid: string, rx0: number, rz0: number, rd0: number } | null {
  for (const b of host.blocks.values()) {
    const lxz = toLocal(b, x, z)
    const rd = Math.hypot(lxz.x / b.radiusX, lxz.z / b.radiusZ)
    const tol = 42 / Math.min(b.radiusX, b.radiusZ)
    if (Math.abs(rd - 1) <= tol) {
      return { cid: b.channelId, rx0: b.radiusX, rz0: b.radiusZ, rd0: rd }
    }
  }
  return null
}

/** 设置选中(点击后由 Vue 弹缩放/旋转滑杆) */
export function setSelected(host: SelectionHost, sel: { kind: 'agent' | 'device', id: string } | null): void {
  // 选中切换/取消 → 退出框选绘制(清理预览)
  if (!sel || sel.kind !== 'agent' || sel.id !== host.rangeDrawAgent) host.cancelRangeDraw()
  host.selected = sel
  // 变换手柄跟随选中设备(Blender 规范:选中即出手柄;运行模式只读 → 不出手柄)
  if (host.tControls) {
    if (sel?.kind === 'device' && host.mode === 'edit' && host.deviceNodes.has(sel.id)) host.tControls.attach(host.deviceNodes.get(sel.id)!.root)
    else host.tControls.detach()
  }
  host.refreshAgentRangeLines()
  host.refreshAgentRangeHandles()
  if (!sel) {
    host.emit('select', null)
    return
  }
  const st = host.scalables.get(`${sel.kind}:${sel.id}`)
  if (st) {
    host.emit('select', {
      kind: sel.kind,
      id: sel.id,
      scale: st.userScale,
      rotation: Math.round(getModelRotation(host, sel.id, sel.kind) * 10) / 10,
    })
  }
}

/** 场景内缩放:为 Agent(id)或设备(id)设定用户缩放倍率(0.2~5;1=默认归一化) */
export function setModelScale(host: SelectionHost, id: string, scale: number, kind?: 'agent' | 'device'): void {
  const k = kind ?? (host.scalables.has(`device:${id}`) ? 'device' : 'agent')
  const key = `${k}:${id}`
  const st = host.scalables.get(key)
  if (!st) return
  st.userScale = scale
  // 施加于模型 holder(相对已归一化的默认尺寸)
  st.holder.scale.setScalar(st.userScale)
  if (k === 'device') {
    const dev = host.deviceNodes.get(id)
    if (dev) dev.topYCache = null
  }
  host.markDirty()
}

/** 当前选中对象(供 Vue/滑杆初始化) */
export function getSelectedScale(host: SelectionHost): { kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null {
  if (!host.selected) return null
  const st = host.scalables.get(`${host.selected.kind}:${host.selected.id}`)
  if (!st) return null
  return {
    kind: host.selected.kind,
    id: host.selected.id,
    scale: st.userScale,
    rotation: Math.round(getModelRotation(host, host.selected.id, host.selected.kind) * 10) / 10,
  }
}

/** 组装可缩放目标并恢复初始化缩放(initialScale 优先=服务端持久化;否则 localStorage) */
export function registerScalable(host: SelectionHost, kind: 'agent' | 'device', id: string, holder: THREE.Group, initialScale?: number): void {
  const saved = initialScale !== undefined
    ? initialScale
    : (typeof localStorage !== 'undefined' ? Number(localStorage.getItem(`town.scale.${kind}:${id}`) ?? 1) : 1)
  const userScale = Number.isFinite(saved) && saved > 0 ? saved : 1
  host.scalables.set(`${kind}:${id}`, { kind, id, userScale, holder })
  holder.scale.setScalar(userScale)
  if (kind === 'device') {
    const dev = host.deviceNodes.get(id)
    if (dev) dev.topYCache = null
  }
}

/** 持久化指定对象的缩放(滑杆松手时调用;设备同时落库,角色仅本地) */
export function persistScale(host: SelectionHost, kind: 'agent' | 'device', id: string): void {
  const st = host.scalables.get(`${kind}:${id}`)
  if (!st || typeof localStorage === 'undefined') return
  localStorage.setItem(`town.scale.${kind}:${id}`, String(st.userScale))
  if (kind === 'device') host.persistDeviceTransform(id)
}

/** 对象朝向(度;编辑模式旋转滑杆实时) */
export function setModelRotation(host: SelectionHost, id: string, deg: number, kind?: 'agent' | 'device'): void {
  const k = kind ?? (host.deviceNodes.has(id) ? 'device' : 'agent')
  if (k === 'device') {
    const dev = host.deviceNodes.get(id)
    if (!dev) return
    dev.root.rotation.y = deg * Math.PI / 180
  }
  else {
    const asp = host.agents.get(id)
    if (!asp) return
    asp.root.rotation.y = deg * Math.PI / 180
  }
  host.markDirty()
}

export function getModelRotation(host: SelectionHost, id: string, kind?: 'agent' | 'device'): number {
  const k = kind ?? (host.deviceNodes.has(id) ? 'device' : 'agent')
  if (k === 'device') {
    const dev = host.deviceNodes.get(id)
    return dev ? THREE.MathUtils.radToDeg(dev.root.rotation.y) : 0
  }
  const asp = host.agents.get(id)
  return asp ? THREE.MathUtils.radToDeg(asp.root.rotation.y) : 0
}

/** 变换模式(Blender 规范):translate=移动 G / rotate=旋转 R / scale=缩放 S。
 *  轴约束:移动仅 XZ(模型贴地),旋转仅 Y(2.5D 朝向),缩放 XYZ。 */
export function setTransformMode(host: SelectionHost, mode: 'translate' | 'rotate' | 'scale'): void {
  if (!host.tControls) return
  host.tControls.setMode(mode)
  host.tControls.showX = mode !== 'rotate'
  host.tControls.showY = mode !== 'translate'
  host.tControls.showZ = mode !== 'rotate'
}

/** 手柄是否悬停/拖拽中(调用方应让出相机平移与点选) */
export function isGizmoBusy(host: SelectionHost): boolean {
  return !!host.tControls && (host.tControls.dragging || !!host.tControls.axis)
}

/** 渲染曝光(场景控制坞"环境光照";0.2~2.2) */
export function setExposure(host: SelectionHost, v: number): void {
  host.renderer.toneMappingExposure = Math.min(2.2, Math.max(0.2, v))
}

/** 领地染色浓度(平台透明度系数;0.05~1) */
export function setTerritoryOpacity(host: SelectionHost, v: number): void {
  const o = Math.min(1, Math.max(0.05, v))
  for (const b of host.blocks.values()) {
    ;(b.platform.material as THREE.MeshStandardMaterial).opacity = 0.24 * o
  }
  host.markDirty()
}

/** 点选频道(供频道坞/边界编辑面板打开) */
export function selectChannel(host: SelectionHost, channelId: string | null): void {
  host.selectedChannel = channelId
  host.emit('selectChannel', channelId)
  host.refreshChannelHandles()
  host.cancelRangeDraw()
  host.refreshAgentRangeHandles()
  // 选中频道边界高亮勾边(取消时恢复频道本色)
  for (const bb of host.blocks.values()) {
    const m = bb.boundary.material as THREE.LineBasicMaterial
    m.color.setHex(bb.channelId === channelId ? 0xf6c453 : bb.color)
    m.opacity = bb.channelId === channelId ? 1 : 0.75
  }
  // 拖拽中不聚焦(避免拖频道/手柄时相机被拽走导致落点错乱)
  if (channelId && !host.pointerDrag) host.focusTo(host.blocks.get(channelId)?.x ?? WORLD_CX, host.blocks.get(channelId)?.z ?? WORLD_CZ)
}

/** 频道是否在场景内且被选中(供边界编辑面板) */
export function getSelectedChannel(host: SelectionHost): string | null {
  return host.selectedChannel
}
