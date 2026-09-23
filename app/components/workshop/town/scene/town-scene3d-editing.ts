/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 编辑/浏览模式与场景对象拖拽。
 *
 * 自 TownScene3D.ts 抽出(用户自定义布局:设备↔地面 / 角色↔落点 / 频道整体 / 边界手柄 / 活动范围):
 *  - setMode / getMode / setSnap / getSnap:只读浏览 ↔ 可编辑(退回浏览即收手柄 + 退出绘制);
 *  - tryStartPointerDrag / isPointerDragging / movePointerDrag / endPointerDrag:指针手势全流程;
 *  - snapWorld:编辑落点网格吸附;
 *  - applyBlockMove / applyResize / refreshChannelHandles / pickResizeHandle / boundaryHandlePoints:
 *    频道整体平移与边界手柄缩放;
 *  - clampAgentsToBoundary:边界变化后把成员落点与活动范围钳回新边界。
 *
 * 活动范围相关的成员经宿主回调(实现见 town-scene3d-ranges.ts),本模块不反向依赖场景实现。
 * 宿主契约:场景类实现 EditingHost(只列本模块触达的成员)。
 */
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import {
  SNAP_SIZE, clampToAgentRange, clampToBoundary, toLocal,
  type AgentRangeLayout, type ChannelLayout,
} from '#shared/town-scene-math'
import type { Agent3D, Block3D, DeviceNode } from './town-scene3d-nodes'
import type {
  ChannelResizeHandle, PointerDragState, TownEventMap, TownScene3DMode,
} from './town-scene3d-types'

/** 编辑/拖拽模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface EditingHost {
  /** 编辑 / 浏览模式(浏览只读:设备/角色不可拖,仅点选) */
  mode: TownScene3DMode
  /** 正在拖曳的场景对象(编辑模式):设备 / 角色落点 / 频道整体 / 边界手柄 / Agent 活动范围 */
  pointerDrag: PointerDragState
  /** 网格吸附(编辑拖拽落点对齐 16 单位网格) */
  snapEnabled: boolean
  /** 脏标记(内容变化 → 重绘) */
  dirty: boolean
  /** Blender 式变换手柄(浏览模式只读 → 收起) */
  readonly tControls: TransformControls | null
  readonly agents: Map<string, Agent3D>
  readonly blocks: Map<string, Block3D>
  readonly deviceNodes: Map<string, DeviceNode>
  /** 边界缩放手柄(编辑模式选中频道时显示;拖拽手柄调整 radiusX/radiusZ) */
  readonly resizeHandles: ChannelResizeHandle[]
  /** 当前选中频道(供边界编辑面板) */
  readonly selectedChannel: string | null
  /** 框选绘制目标 agent(非空 = 编辑模式正在为该角色拉动矩形框) */
  readonly rangeDrawAgent: string | null
  /** 框选绘制当前对角(供 endPointerDrag 生成范围) */
  rangeDrawPreviewState: { x0: number, z0: number, x1: number, z1: number } | null
  /** 管理员布局:保存 Agent 落点/范围(由 TownView 注入;经既有 config 持久化) */
  readonly agentApi: {
    updateHome(agentId: string, channelId: string, x: number, z: number): Promise<unknown>
    updateRange(agentId: string, channelId: string, range: AgentRangeLayout | null): Promise<unknown>
  } | null
  /** 频道布局持久化(由 TownView 注入;频道拖拽移动/边界拖拽调整后落库) */
  readonly channelApi: {
    save(channelId: string, layout: ChannelLayout): Promise<unknown>
  } | null
  /** 场景 → Vue HUD 事件 */
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
  /** 场景保存状态(设备/角色布局持久化进度) */
  emitSaveState(state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at?: number): void
  /** 页面坐标 → 世界 xz(经 canvas rect + 相机射线打在 y=0 平面) */
  screenToWorld(clientX: number, clientY: number): { x: number, z: number }
  /** 手柄是否悬停/拖拽中(调用方应让出相机平移与点选) */
  isGizmoBusy(): boolean
  /** 命中选中 Agent 的活动范围手柄(编辑模式;返回 agentId + 手柄号) */
  pickAgentRangeHandle(x: number, z: number): { agentId: string, handle: number } | null
  /** 命中某成员活动范围边界线(供整框拖移;编辑模式) */
  hitAgentRangeBoundary(x: number, z: number): Agent3D | undefined
  /** 命中频道边界线(世界点落在某领地边界带内 → 边界拖拽等比缩放) */
  pickChannelEdge(x: number, z: number): { cid: string, rx0: number, rz0: number, rd0: number } | null
  /** 命中频道信标(中心 ±34 单位) */
  pickBeacon(x: number, z: number): { cid: string, x: number, z: number } | null
  /** 以世界坐标 hit 一个 Agent 或设备节点(近似距离阈值) */
  pickAt(x: number, z: number): { kind: 'agent' | 'device', id: string } | null
  /** 点选频道:返回包含该点的频道 id(边界内) */
  pickChannel(x: number, z: number): string | null
  /** 点选频道(供频道坞/边界编辑面板打开) */
  selectChannel(channelId: string | null): void
  /** 设置选中(点击后由 Vue 弹缩放/旋转滑杆) */
  setSelected(sel: { kind: 'agent' | 'device', id: string } | null): void
  /** 频道当前布局(实体钳制服务;未放置返回 null) */
  blockLayout(channelId: string): ChannelLayout | null
  /** 频道当前布局(供边界编辑面板初始化) */
  getChannelLayout(channelId: string): ChannelLayout | null
  /** 按当前 Block 字段重建领地几何(平台刻度/边界线框/朝向) */
  applyLayoutToBlock(b: Block3D): void
  /** 缩放过程中调用:范围超出当前视野 → 相机自动拉远(渲染循环平滑跟随) */
  autoFrameTo(rx: number, rz: number): void
  /** 刷新边界手柄位置/可见性(编辑模式选中频道时显示;其余隐藏) */
  refreshChannelHandles(): void
  /** 刷新 Agent 活动范围手柄(编辑模式 + 选中带范围角色时显示) */
  refreshAgentRangeHandles(): void
  /** 通知 Vue 对象面板刷新活动范围草稿 */
  emitAgentRangeChanged(agentId: string): void
  /** 退出框选绘制模式(清理预览与状态) */
  cancelRangeDraw(): void
  /** 框选预览:以 (x0,z0)-(x1,z1) 为对角生成矩形线框(实时跟随指针) */
  updateRangeDrawPreview(x0: number, z0: number, x1: number, z1: number): void
  /** 拖范围手柄 → 实时调整 radiusX/radiusZ(矩形:角点双轴;椭圆:对应轴向轴点) */
  applyAgentRangeResize(range: AgentRangeLayout, handle: number, wx: number, wz: number): AgentRangeLayout
  /** 边界手柄本地坐标(椭圆:轴向四点;矩形:四角;radius 是半轴或半宽) */
  boundaryHandlePoints(layout: { radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' }): Array<[number, number]>
  /** 持久化设备 transform(位置/朝向/缩放一次写入;防抖) */
  persistDeviceTransform(id: string): void
}

// ================================================================
// 编辑/浏览模式 + 场景对象拖拽
// ================================================================

/** 模式切换:浏览(只读:相机+点选) / 编辑(可拖拽设备/调整角色落点/旋转/频道整体移动/边界手柄/Agent 活动范围) */
export function setMode(host: EditingHost, mode: TownScene3DMode): void {
  if (host.mode === mode) return
  host.mode = mode
  if (mode === 'browse') {
    if (host.pointerDrag) endPointerDrag(host)
    host.cancelRangeDraw()
    host.setSelected(null)
    // 运行模式只读:收起变换手柄(拖拽已在 tryStartPointerDrag 门禁)
    host.tControls?.detach()
  }
  host.refreshChannelHandles()
  host.refreshAgentRangeHandles()
  // 编辑模式范围线框可见性(range 线框在编辑模式全部显示,浏览模式仅选中显示)
  for (const a of host.agents.values()) a.renderRangeLine()
  host.dirty = true
}

export function getMode(host: EditingHost): TownScene3DMode {
  return host.mode
}

/** 网格吸附开关(编辑拖拽落点;默认开) */
export function setSnap(host: EditingHost, enabled: boolean): void {
  host.snapEnabled = enabled
}

export function getSnap(host: EditingHost): boolean {
  return host.snapEnabled
}

/**
 * 尝试开始场景拖拽(编辑模式;指针按下命中设备/角色 → 占用该手势)。
 * 返回 true 表示场景已接管指针(调用方应跳过相机平移)。
 */
export function tryStartPointerDrag(host: EditingHost, clientX: number, clientY: number): boolean {
  if (host.mode !== 'edit' || host.isGizmoBusy()) return false
  const w = host.screenToWorld(clientX, clientY)
  // 1) Agent 活动范围手柄(编辑模式选中带范围角色时 → 拖拽调整该 Agent 范围大小)
  const ar = host.pickAgentRangeHandle(w.x, w.z)
  if (ar) {
    host.pointerDrag = { kind: 'agentRangeResize', id: ar.agentId, handle: ar.handle }
    host.emitSaveState('dirty')
    return true
  }
  // 2) 边界缩放手柄(编辑模式选中频道的 4 个手柄 → 调整频道范围大小)
  const h = pickResizeHandle(host, w.x, w.z)
  if (h) {
    host.pointerDrag = { kind: 'resize', id: h.cid, handle: h.handle }
    host.setSelected(null)
    host.emitSaveState('dirty')
    return true
  }
  // 3) 框选绘制:rangeDraw 模式激活 → 以按下点为框角拉动(优先于点选,便于从角色身上起手)
  if (host.rangeDrawAgent) {
    host.pointerDrag = { kind: 'rangeDraw', id: host.rangeDrawAgent, x0: w.x, z0: w.z }
    host.rangeDrawPreviewState = null
    return true
  }
  // 4) 设备 / 角色
  const hit = host.pickAt(w.x, w.z)
  if (hit) {
    if (hit.kind === 'device') {
      if (!host.deviceNodes.has(hit.id)) return false
      host.pointerDrag = hit
      host.setSelected(hit)
      host.emitSaveState('dirty')
      return true
    }
    // 角色:仅频道角色可调整落点(装饰居民不持久化、不可布局)
    const asp = host.agents.get(hit.id)
    if (!asp || !asp.channelId) return false
    if (asp.bubbleTimer) {
      clearTimeout(asp.bubbleTimer)
      asp.bubbleTimer = null
    }
    asp.dragging = true
    asp.behavior.mode = 'idle'
    asp.behavior.targetId = null
    host.pointerDrag = hit
    host.setSelected(hit)
    host.emitSaveState('dirty')
    return true
  }
  // 5) 拖某成员活动范围边界线 → 整框平移(频道整体移动之前;频道移动先排除已按范围接管)
  const rangeHit = host.hitAgentRangeBoundary(w.x, w.z)
  if (rangeHit && rangeHit.range) {
    host.pointerDrag = { kind: 'agentRange', id: rangeHit.agentId, dx: rangeHit.range.x - w.x, dz: rangeHit.range.z - w.z }
    host.setSelected({ kind: 'agent', id: rangeHit.agentId })
    host.emitSaveState('dirty')
    return true
  }
  // 6) 频道边界线拖拽:抓住边界附近 → 整体等比缩放(手柄之外,自由拉边调节范围)
  const edge = host.pickChannelEdge(w.x, w.z)
  if (edge) {
    host.pointerDrag = { kind: 'channelEdge', id: edge.cid, rx0: edge.rx0, rz0: edge.rz0, rd0: edge.rd0 }
    host.setSelected(null)
    host.selectChannel(edge.cid)
    host.emitSaveState('dirty')
    return true
  }
  // 7) 频道信标:非拖拽目标(点击定位语义交给 pointerup;避免编辑模式下点信标变成整体拖动)
  if (host.pickBeacon(w.x, w.z)) return false
  // 8) 频道领地整体拖拽:点中领地空白处 → 平移整个频道(平台/边界/名牌/成员落点)
  const cid = host.pickChannel(w.x, w.z)
  if (cid) {
    const b = host.blocks.get(cid)
    if (!b) return false
    host.pointerDrag = { kind: 'channel', id: cid, dx: b.x - w.x, dz: b.z - w.z }
    host.setSelected(null)
    host.selectChannel(cid)
    host.emitSaveState('dirty')
    return true
  }
  return false
}

export function isPointerDragging(host: EditingHost): boolean {
  return host.pointerDrag !== null
}

export function snapWorld(host: EditingHost, v: number): number {
  return host.snapEnabled ? Math.round(v / SNAP_SIZE) * SNAP_SIZE : Math.round(v * 10) / 10
}

/** 拖拽中:对象跟随指针指向的 xz 平面(仅改内存;落库在 endPointerDrag) */
export function movePointerDrag(host: EditingHost, clientX: number, clientY: number): void {
  if (!host.pointerDrag) return
  const w = host.screenToWorld(clientX, clientY)
  // 无边界画布:仅网格吸附,不钳制世界范围(模型可摆放到任意位置)
  const x = snapWorld(host, w.x)
  const z = snapWorld(host, w.z)
  const pd = host.pointerDrag
  if (pd.kind === 'device') {
    const dev = host.deviceNodes.get(pd.id)
    if (dev) {
      dev.root.position.x = x
      dev.root.position.z = z
      host.dirty = true
    }
  }
  else if (pd.kind === 'agent') {
    const asp = host.agents.get(pd.id)
    if (asp) {
      // 频道角色落点钳制在所属领地边界内(不可拖出频道)
      let px = x
      let pz = z
      const layout = host.blockLayout(asp.channelId)
      if (layout) {
        const clamped = clampToBoundary(layout, x, z, 20)
        px = clamped.x
        pz = clamped.z
      }
      asp.root.position.x = px
      asp.root.position.z = pz
      host.dirty = true
    }
  }
  else if (pd.kind === 'rangeDraw') {
    // 框选绘制:当前点为对角终点(钳入频道边界),实时更新预览矩形
    const asp = host.agents.get(pd.id)
    if (!asp) return
    const layout = host.blockLayout(asp.channelId)
    let cx = w.x
    let cz = w.z
    if (layout) {
      const clamped = clampToBoundary(layout, cx, cz, 12)
      cx = clamped.x
      cz = clamped.z
    }
    host.rangeDrawPreviewState = { x0: pd.x0, z0: pd.z0, x1: cx, z1: cz }
    host.updateRangeDrawPreview(pd.x0, pd.z0, cx, cz)
    host.dirty = true
  }
  else if (pd.kind === 'agentRange') {
    // 拖 Agent 活动范围边界 → 整框平移(钳入频道边界;范围线框/手柄跟随)
    const asp = host.agents.get(pd.id)
    if (!asp || !asp.range) return
    const nx = x + pd.dx
    const nz = z + pd.dz
    asp.range = { ...asp.range, x: nx, z: nz }
    asp.renderRangeLine()
    host.refreshAgentRangeHandles()
    host.dirty = true
  }
  else if (pd.kind === 'agentRangeResize') {
    // 拖 Agent 范围手柄 → 实时调整 radiusX/radiusZ(矩形角点双轴 / 椭圆轴向轴点)
    const asp = host.agents.get(pd.id)
    if (!asp || !asp.range) return
    asp.range = host.applyAgentRangeResize(asp.range, pd.handle, w.x, w.z)
    asp.renderRangeLine()
    host.refreshAgentRangeHandles()
    host.autoFrameTo(asp.range.radiusX, asp.range.radiusZ)
    host.dirty = true
  }
  else if (pd.kind === 'channel') {
    const b = host.blocks.get(pd.id)
    if (b) applyBlockMove(host, b, x + pd.dx, z + pd.dz)
  }
  else if (pd.kind === 'resize') {
    const b = host.blocks.get(pd.id)
    if (b) applyResize(host, b, pd.handle, w.x, w.z)
  }
  else if (pd.kind === 'channelEdge') {
    // 边界线等比缩放:指针沿"中心→边界"射线的归一化距离比例 → 双轴同倍率
    const b = host.blocks.get(pd.id)
    if (b) {
      const lxz = toLocal(b, x, z)
      const rd = Math.hypot(lxz.x / pd.rx0, lxz.z / pd.rz0)
      const factor = pd.rd0 > 0.05 ? rd / pd.rd0 : 1
      b.radiusX = Math.max(60, Math.round(pd.rx0 * factor))
      b.radiusZ = Math.max(40, Math.round(pd.rz0 * factor))
      host.applyLayoutToBlock(b)
      host.autoFrameTo(b.radiusX, b.radiusZ)
    }
  }
}

/** 拖拽结束:设备 → 防抖落库;角色 → home 更新 + 持久化;频道 → 布局落库 */
export function endPointerDrag(host: EditingHost): void {
  if (!host.pointerDrag) return
  const pd = host.pointerDrag
  host.pointerDrag = null
  if (pd.kind === 'device') {
    const dev = host.deviceNodes.get(pd.id)
    if (dev) host.persistDeviceTransform(pd.id)
  }
  else if (pd.kind === 'agent') {
    const asp = host.agents.get(pd.id)
    if (asp) {
      asp.homeX = asp.root.position.x
      asp.homeZ = asp.root.position.z
      asp.dragging = false
      host.emitSaveState('saving')
      void host.agentApi?.updateHome(pd.id, asp.channelId, asp.homeX, asp.homeZ)
        .then(() => host.emitSaveState('saved', Date.now()))
        .catch(() => host.emitSaveState('error'))
    }
  }
  else if (pd.kind === 'rangeDraw') {
    // 框选结束:以拖框中点为中心、半宽为半径生成矩形范围(过小拖动视为取消)
    const asp = host.agents.get(pd.id)
    if (asp && host.rangeDrawPreviewState) {
      const d = host.rangeDrawPreviewState
      const range: AgentRangeLayout = {
        x: (d.x0 + d.x1) / 2,
        z: (d.z0 + d.z1) / 2,
        radiusX: Math.abs(d.x1 - d.x0) / 2,
        radiusZ: Math.abs(d.z1 - d.z0) / 2,
        shape: 'rect',
        rotationY: 0,
      }
      if (range.radiusX >= 40 && range.radiusZ >= 40) {
        asp.range = range
        asp.renderRangeLine()
        // 把角色落点收进新范围(home 若在范围外会导致回归/漫游卡死)
        const c = clampToAgentRange(asp.range, asp.homeX, asp.homeZ, 0)
        if (c.x !== asp.homeX || c.z !== asp.homeZ) {
          asp.homeX = c.x
          asp.homeZ = c.z
          asp.root.position.x = c.x
          asp.root.position.z = c.z
          void host.agentApi?.updateHome(pd.id, asp.channelId, c.x, c.z).catch(() => {})
        }
        host.emitSaveState('saving')
        void host.agentApi?.updateRange(pd.id, asp.channelId, asp.range)
          .then(() => host.emitSaveState('saved', Date.now()))
          .catch(() => host.emitSaveState('error'))
      }
    }
    host.cancelRangeDraw()
    host.refreshAgentRangeHandles()
    host.emitAgentRangeChanged(pd.id)
  }
  else if (pd.kind === 'agentRange' || pd.kind === 'agentRangeResize') {
    // 拖范围整框 / 拖范围手柄结束 → 落库 config.range
    const asp = host.agents.get(pd.id)
    if (asp && asp.range) {
      host.emitSaveState('saving')
      void host.agentApi?.updateRange(pd.id, asp.channelId, asp.range)
        .then(() => host.emitSaveState('saved', Date.now()))
        .catch(() => host.emitSaveState('error'))
    }
    host.refreshAgentRangeHandles()
    host.emitAgentRangeChanged(pd.id)
  }
  else {
    // channel / resize:把成员钳回新边界 + 布局落库 + 通知 Vue 刷新边界面板草稿
    const b = host.blocks.get(pd.id)
    if (b) {
      clampAgentsToBoundary(host, pd.id)
      refreshChannelHandles(host)
      const layout = host.getChannelLayout(pd.id)
      if (layout) {
        host.emitSaveState('saving')
        void host.channelApi?.save(pd.id, layout)
          .then(() => host.emitSaveState('saved', Date.now()))
          .catch(() => host.emitSaveState('error'))
        host.emit('channelResized', { channelId: pd.id, layout })
      }
    }
  }
}

// ================================================================
// 频道整体拖拽 / 边界手柄缩放(编辑模式;用户自定义布局)
// ================================================================

/** 把频道地块整体平移(委托 Block3D.moveBy:平台/边界/名牌/成员落点与各自范围一并位移) */
export function applyBlockMove(host: EditingHost, b: Block3D, nx: number, nz: number): void {
  b.moveBy(nx - b.x, nz - b.z)
  host.refreshAgentRangeHandles()
  host.dirty = true
}

/** 边界手柄本地坐标(椭圆:轴向四点;矩形:四角;radius 是半轴或半宽)。 */
export function boundaryHandlePoints(layout: { radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' }): Array<[number, number]> {
  if (layout.shape === 'rect') return [[layout.radiusX, layout.radiusZ], [-layout.radiusX, layout.radiusZ], [-layout.radiusX, -layout.radiusZ], [layout.radiusX, -layout.radiusZ]]
  return [[layout.radiusX, 0], [-layout.radiusX, 0], [0, layout.radiusZ], [0, -layout.radiusZ]]
}

/** 刷新边界手柄位置/可见性(编辑模式选中频道时显示;其余隐藏) */
export function refreshChannelHandles(host: EditingHost): void {
  for (const hl of host.resizeHandles) hl.mesh.visible = false
  if (host.mode !== 'edit' || !host.selectedChannel) return
  const b = host.blocks.get(host.selectedChannel)
  if (!b) return
  const rot = b.rotationY * Math.PI / 180
  const pts = boundaryHandlePoints(b)
  for (let i = 0; i < host.resizeHandles.length && i < pts.length; i++) {
    const [lx, lz] = pts[i]!
    const wx = b.x + lx * Math.cos(rot) - lz * Math.sin(rot)
    const wz = b.z + lx * Math.sin(rot) + lz * Math.cos(rot)
    host.resizeHandles[i]!.cid = b.channelId
    host.resizeHandles[i]!.mesh.position.set(wx, 1.4, wz)
    host.resizeHandles[i]!.mesh.visible = true
  }
}

/** 命中边界手柄(仅编辑模式;返回频道 id + 手柄号) */
export function pickResizeHandle(host: EditingHost, x: number, z: number): { cid: string, handle: number } | null {
  if (host.mode !== 'edit') return null
  for (const hl of host.resizeHandles) {
    if (!hl.mesh.visible) continue
    if (Math.hypot(hl.mesh.position.x - x, hl.mesh.position.z - z) < 90) return { cid: hl.cid, handle: hl.handle }
  }
  return null
}

/** 拖拽手柄 → 实时调整 radiusX/radiusZ(矩形:角点双轴;椭圆:对应轴向轴点)。 */
export function applyResize(host: EditingHost, b: Block3D, handle: number, wx: number, wz: number): void {
  const rad = -b.rotationY * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = wx - b.x
  const dz = wz - b.z
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos
  if (b.shape === 'rect') {
    // radiusX/radiusZ 表示半宽:角点到中心的局部距离即新半宽(无上限,相机自动跟随取景)
    b.radiusX = Math.max(60, Math.abs(lx))
    b.radiusZ = Math.max(40, Math.abs(lz))
  }
  else {
    if (handle === 0 || handle === 1) b.radiusX = Math.max(60, Math.abs(lx))
    else b.radiusZ = Math.max(40, Math.abs(lz))
  }
  host.applyLayoutToBlock(b)
  refreshChannelHandles(host)
  host.autoFrameTo(b.radiusX, b.radiusZ)
  host.dirty = true
}

/** 缩放/移动结束后把该频道成员落点与活动范围钳回新边界内(委托 Block3D) */
export function clampAgentsToBoundary(host: EditingHost, channelId: string): void {
  const b = host.blocks.get(channelId)
  if (!b) return
  b.clampMembersAndRanges()
  host.dirty = true
}
