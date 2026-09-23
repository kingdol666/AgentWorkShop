/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— Agent 独立活动范围。
 *
 * 自 TownScene3D.ts 抽出(编辑模式:框选绘制 / 整框平移 / 手柄收缩扩张 / 面板即时调整):
 *  - rangeLineVisible / rangeLineVisibleFor / refreshAgentRangeLines:线框可见性策略
 *    (编辑模式全部显示;浏览模式仅选中角色的范围显示);
 *  - refreshAgentRangeHandles / pickAgentRangeHandle / applyAgentRangeResize:范围手柄位置与命中;
 *  - hitAgentRangeBoundary:整框拖移的边界命中判定;
 *  - updateRangeDrawPreview / startRangeDraw / cancelRangeDraw / isRangeDrawing:框选绘制;
 *  - getAgentRange / setAgentRangeScene / commitAgentRange / clearAgentRange:面板读写与落库;
 *  - emitAgentRangeChanged:通知 Vue 对象面板刷新活动范围草稿。
 *
 * 宿主契约:场景类实现 RangeHost(只列本模块触达的成员)。
 */
import * as THREE from 'three'
import { clampToAgentRange, distToRangeBoundary, type AgentRangeLayout } from '#shared/town-scene-math'
import { makeBoundary, type Agent3D } from './town-scene3d-nodes'
import type {
  AgentRangeHandle, SelectedTarget, TownEventMap, TownScene3DMode,
} from './town-scene3d-types'

/** 活动范围模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface RangeHost {
  /** 场景根(框选预览线框/范围线框挂载与摘除) */
  readonly scene: THREE.Scene
  /** 编辑 / 浏览模式(浏览模式仅选中角色的范围线框显示) */
  readonly mode: TownScene3DMode
  /** 当前选中(kind:id) */
  readonly selected: SelectedTarget | null
  readonly agents: Map<string, Agent3D>
  /** Agent 活动范围缩放手柄(编辑模式选中带范围角色时显示;拖拽调整该 Agent 范围大小) */
  readonly agentRangeHandles: AgentRangeHandle[]
  /** 框选绘制预览线框(rangeDraw 模式;松开后变为正式范围) */
  rangeDrawLine: THREE.LineLoop | null
  /** 框选绘制目标 agent(非空 = 编辑模式正在为该角色拉动矩形框) */
  rangeDrawAgent: string | null
  /** 框选绘制当前对角(供 endPointerDrag 生成范围) */
  rangeDrawPreviewState: { x0: number, z0: number, x1: number, z1: number } | null
  /** setAgentRangeScene 中因范围收缩而位移的 home(面板提交时一并落库) */
  rangeHomeMoved: { agentId: string, x: number, z: number } | null
  /** 脏标记(内容变化 → 重绘) */
  dirty: boolean
  /** 管理员布局:保存 Agent 落点/范围(由 TownView 注入;经既有 config 持久化) */
  readonly agentApi: {
    updateHome(agentId: string, channelId: string, x: number, z: number): Promise<unknown>
    updateRange(agentId: string, channelId: string, range: AgentRangeLayout | null): Promise<unknown>
  } | null
  /** 场景 → Vue HUD 事件 */
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
  /** 场景保存状态(设备/角色布局持久化进度) */
  emitSaveState(state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at?: number): void
  /** 设置选中(点击后由 Vue 弹缩放/旋转滑杆) */
  setSelected(sel: SelectedTarget | null): void
  /** 边界手柄本地坐标(椭圆:轴向四点;矩形:四角;radius 是半轴或半宽) */
  boundaryHandlePoints(layout: { radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' }): Array<[number, number]>
}

// ================================================================
// 可见性 / 手柄 / 命中
// ================================================================

/** 活动范围线框可见性:编辑模式全部显示;浏览模式仅选中角色的范围显示 */
export function rangeLineVisible(host: RangeHost, asp: Agent3D): boolean {
  if (host.mode === 'edit') return true
  return host.selected?.kind === 'agent' && host.selected.id === asp.agentId
}

/** 通知 Vue 对象面板刷新活动范围草稿 */
export function emitAgentRangeChanged(host: RangeHost, agentId: string): void {
  host.emit('agentRangeChanged', { agentId })
}

/** 同步全部范围线框可见性(选中/模式切换后调用) */
export function refreshAgentRangeLines(host: RangeHost): void {
  for (const a of host.agents.values()) {
    if (a.rangeLine) a.rangeLine.visible = rangeLineVisibleFor(host, a)
  }
}

/** 活动范围线框可见性(公众面,供 Agent3D.renderRangeLine):编辑模式全部显示;浏览模式仅选中显示 */
export function rangeLineVisibleFor(host: RangeHost, asp: Agent3D): boolean {
  if (host.mode === 'edit') return true
  return host.selected?.kind === 'agent' && host.selected.id === asp.agentId
}

/** 刷新 Agent 活动范围手柄(编辑模式 + 选中带范围角色时显示;矩形四角 / 椭圆轴向四点) */
export function refreshAgentRangeHandles(host: RangeHost): void {
  for (const hl of host.agentRangeHandles) hl.mesh.visible = false
  if (host.mode !== 'edit' || !host.selected || host.selected.kind !== 'agent') return
  const asp = host.agents.get(host.selected.id)
  if (!asp || !asp.range) return
  const rot = asp.range.rotationY * Math.PI / 180
  const pts = host.boundaryHandlePoints(asp.range)
  for (let i = 0; i < host.agentRangeHandles.length && i < pts.length; i++) {
    const [lx, lz] = pts[i]!
    const wx = asp.range.x + lx * Math.cos(rot) - lz * Math.sin(rot)
    const wz = asp.range.z + lx * Math.sin(rot) + lz * Math.cos(rot)
    host.agentRangeHandles[i]!.agentId = asp.agentId
    host.agentRangeHandles[i]!.mesh.position.set(wx, 1.2, wz)
    host.agentRangeHandles[i]!.mesh.visible = true
  }
}

/** 命中选中 Agent 的活动范围手柄(编辑模式;返回 agentId + 手柄号) */
export function pickAgentRangeHandle(host: RangeHost, x: number, z: number): { agentId: string, handle: number } | null {
  if (host.mode !== 'edit') return null
  for (const hl of host.agentRangeHandles) {
    if (!hl.mesh.visible) continue
    if (Math.hypot(hl.mesh.position.x - x, hl.mesh.position.z - z) < 40) return { agentId: hl.agentId, handle: hl.handle }
  }
  return null
}

/** 命中某成员活动范围边界线(供整框拖移;编辑模式;26 单位内视为命中) */
export function hitAgentRangeBoundary(host: RangeHost, x: number, z: number): Agent3D | undefined {
  if (host.mode !== 'edit') return undefined
  for (const a of host.agents.values()) {
    if (!a.range || !a.channelId) continue
    if (distToRangeBoundary(a.range, x, z) < 26) return a
  }
  return undefined
}

/** 拖范围手柄 → 实时调整 radiusX/radiusZ(矩形:角点双轴;椭圆:对应轴向轴点),并收进频道边界 */
export function applyAgentRangeResize(range: AgentRangeLayout, handle: number, wx: number, wz: number): AgentRangeLayout {
  const rad = -range.rotationY * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = wx - range.x
  const dz = wz - range.z
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos
  let next: AgentRangeLayout
  if (range.shape === 'rect') {
    next = { ...range, radiusX: Math.max(30, Math.abs(lx)), radiusZ: Math.max(30, Math.abs(lz)) }
  }
  else if (handle === 0 || handle === 1) {
    next = { ...range, radiusX: Math.max(30, Math.abs(lx)) }
  }
  else {
    next = { ...range, radiusZ: Math.max(30, Math.abs(lz)) }
  }
  return next
}

// ================================================================
// 框选绘制(编辑模式:拉动矩形框生成活动范围)
// ================================================================

/** 框选预览:以 (x0,z0)-(x1,z1) 为对角生成矩形线框(实时跟随指针) */
export function updateRangeDrawPreview(host: RangeHost, x0: number, z0: number, x1: number, z1: number): void {
  const lx = Math.min(x0, x1)
  const hx = Math.max(x0, x1)
  const lz = Math.min(z0, z1)
  const hz = Math.max(z0, z1)
  const cx = (lx + hx) / 2
  const cz = (lz + hz) / 2
  const rx = Math.max(8, (hx - lx) / 2)
  const rz = Math.max(8, (hz - lz) / 2)
  if (!host.rangeDrawLine) {
    const line = makeBoundary('rect', 1, 1, 0x41c8f4)
    ;(line.material as THREE.LineBasicMaterial).opacity = 0.95
    line.position.y = 0.5
    host.scene.add(line)
    host.rangeDrawLine = line
  }
  host.rangeDrawLine.position.set(cx, 0.5, cz)
  host.rangeDrawLine.rotation.y = 0
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-rx, 0, -rz), new THREE.Vector3(rx, 0, -rz),
    new THREE.Vector3(rx, 0, rz), new THREE.Vector3(-rx, 0, rz),
  ])
  host.rangeDrawLine.geometry.dispose()
  host.rangeDrawLine.geometry = geo
}

/** 退出框选绘制模式(清理预览与状态) */
export function cancelRangeDraw(host: RangeHost): void {
  if (host.rangeDrawAgent === null && !host.rangeDrawLine) return
  host.rangeDrawAgent = null
  host.rangeDrawPreviewState = null
  if (host.rangeDrawLine) {
    host.scene.remove(host.rangeDrawLine)
    host.rangeDrawLine = null
  }
  host.dirty = true
}

/** 进入「框选绘制」模式:为该角色拉动矩形框生成活动范围(编辑模式) */
export function startRangeDraw(host: RangeHost, agentId: string): void {
  const asp = host.agents.get(agentId)
  if (!asp || !asp.channelId || host.mode !== 'edit') return
  host.setSelected({ kind: 'agent', id: agentId })
  cancelRangeDraw(host)
  host.rangeDrawAgent = agentId
  host.rangeDrawPreviewState = null
  refreshAgentRangeHandles(host)
  host.dirty = true
}

/** 当前是否正在为某角色框选绘制 */
export function isRangeDrawing(host: RangeHost, agentId?: string): boolean {
  if (!host.rangeDrawAgent) return false
  return agentId === undefined || host.rangeDrawAgent === agentId
}

// ================================================================
// 面板读写(活动范围草稿 → 落库)
// ================================================================

/** Agent 当前活动范围(供面板初始化;未设置返回 null) */
export function getAgentRange(host: RangeHost, agentId: string): AgentRangeLayout | null {
  return host.agents.get(agentId)?.range ?? null
}

/** 面板滑杆/形状即时调整:局部更新范围(无上限,信任用户设定) + 线框/手柄刷新;home 被迫位移时记档待提交 */
export function setAgentRangeScene(host: RangeHost, agentId: string, patch: Partial<AgentRangeLayout>): void {
  const asp = host.agents.get(agentId)
  if (!asp) return
  if (!asp.range) {
    // 尚无范围:以落点为中心、频道半径 1/4 起手(面板直接给值时)
    asp.range = { x: asp.homeX, z: asp.homeZ, radiusX: 120, radiusZ: 90, shape: 'ellipse', rotationY: 0 }
  }
  const next = { ...asp.range, ...patch }
  asp.range = next
  // 范围收缩致 home 越界 → 落点收进范围(提交时随 updateRange 一并落库)
  const c = clampToAgentRange(asp.range, asp.homeX, asp.homeZ, 0)
  if (c.x !== asp.homeX || c.z !== asp.homeZ) {
    asp.homeX = c.x
    asp.homeZ = c.z
    asp.root.position.x = c.x
    asp.root.position.z = c.z
    host.rangeHomeMoved = { agentId, x: c.x, z: c.z }
  }
  asp.renderRangeLine()
  refreshAgentRangeHandles(host)
  host.dirty = true
}

/** 面板提交:落库范围(updateRange);home 若被迫位移一并落库(updateHome) */
export function commitAgentRange(host: RangeHost, agentId: string): void {
  const asp = host.agents.get(agentId)
  if (!asp) return
  if (host.rangeHomeMoved?.agentId === agentId) {
    const { x, z } = host.rangeHomeMoved
    host.rangeHomeMoved = null
    void host.agentApi?.updateHome(agentId, asp.channelId, x, z).catch(() => {})
  }
  host.emitSaveState('saving')
  void host.agentApi?.updateRange(agentId, asp.channelId, asp.range)
    .then(() => host.emitSaveState('saved', Date.now()))
    .catch(() => host.emitSaveState('error'))
  emitAgentRangeChanged(host, agentId)
}

/** 清除角色活动范围(局部 + 落库 null;回退频道边界) */
export function clearAgentRange(host: RangeHost, agentId: string): void {
  const asp = host.agents.get(agentId)
  if (!asp) return
  if (asp.rangeLine) {
    host.scene.remove(asp.rangeLine)
    asp.rangeLine = null
  }
  asp.range = null
  host.rangeHomeMoved = null
  refreshAgentRangeHandles(host)
  host.emitSaveState('saving')
  void host.agentApi?.updateRange(agentId, asp.channelId, null)
    .then(() => host.emitSaveState('saved', Date.now()))
    .catch(() => host.emitSaveState('error'))
  emitAgentRangeChanged(host, agentId)
  host.dirty = true
}
