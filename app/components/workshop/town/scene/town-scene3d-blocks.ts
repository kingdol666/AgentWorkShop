/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 频道领地放置层。
 *
 * 自 TownScene3D.ts 抽出(布局驱动放置:只呈现「已放置」的频道;未放置不进场景):
 *  - buildBlocks / placeChannel / layoutAgentsInBlock:实体基线 → Block3D + 边界内铺放 Agent;
 *  - applySceneLayouts / hasChannel / blockLayout / placedChannels / getChannelLayout / trackLayout;
 *  - dropChannelOnWorld:频道坞拖入落点建领地(缺省布局按 Agent 数匹配);
 *  - updateChannelLayout / removeChannel / getAllChannelLayouts / applyLayoutToBlock;
 *  - getCameraTarget:频道坞首放落点。
 *
 * 宿主契约:场景类实现 BlockLayerHost(只列本模块触达的成员)。
 */
import type * as THREE from 'three'
import { channelColorNum, normLayout, type ChannelLayout } from '#shared/town-scene-math'
import { applyPadToBlock, makeBlock, makeLabel } from './town-scene3d-factory'
import { Block3D, makeBoundary, type Agent3D } from './town-scene3d-nodes'
import type {
  AgentRangeHandle, BlockHost, ChannelMessageReceiver, ChannelResizeHandle, TownEntityInput, TownEventMap,
} from './town-scene3d-types'

/** 领地层模块的宿主契约(继承节点侧 BlockHost,保证 block.host 注入可编译期校验) */
export interface BlockLayerHost extends BlockHost {
  readonly scene: THREE.Scene
  readonly blocks: Map<string, Block3D>
  /** 频道领地布局(channelId → 放置);驱动 buildBlocks/边界约束 */
  readonly layouts: Map<string, ChannelLayout>
  /** 频道实体基线(channelId → seed;供 dropChannelOnWorld 即时铺放) */
  readonly entityIndex: Map<string, TownEntityInput>
  readonly agents: Map<string, Agent3D>
  /** 频道信息接收器(channelId → FIFO 队列) */
  readonly receivers: Map<string, ChannelMessageReceiver>
  readonly resizeHandles: ChannelResizeHandle[]
  readonly agentRangeHandles: AgentRangeHandle[]
  /** 框选绘制目标 agent(非空 = 编辑模式正在为该角色拉动矩形框) */
  readonly rangeDrawAgent: string | null
  /** 当前选中频道(供边界编辑面板) */
  selectedChannel: string | null
  /** 相机注视目标(供频道坞首放落点/聚焦) */
  readonly camTarget: { x: number, z: number }
  /** 场景 → Vue HUD 事件 */
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
  /** 请求下一帧重绘 */
  markDirty(): void
  /** 按实体元数据实例化 Agent3D */
  ensureAgent(a: TownEntityInput['agents'][number] & { channelId: string }, cx: number, cz: number, color: number): void
  /** 退出框选绘制模式(清理预览与状态) */
  cancelRangeDraw(): void
  /** 刷新 Agent 活动范围手柄 */
  refreshAgentRangeHandles(): void
  /** 缓动聚焦某世界点 */
  focusTo(x: number, z: number): void
  /** 释放对象树内所有 Canvas 纹理 */
  disposeCanvasTextures(root: THREE.Object3D | null): void
  /** 释放单个 agent 的实例资源 */
  disposeAgentAssets(a: { nameSprite?: THREE.Sprite | null, bubble?: THREE.Sprite | null, rangeLine?: THREE.Line | null, aura?: THREE.Group | null }): void
  /** 频道边界变化后把成员活动范围一并收进新边界 */
  clampAgentsToBoundary(channelId: string): void
}

/**
 * 用频道实体基线同步领地/角色。仅放置已保存布局的频道(布局来自 useSceneLayouts,
 * 经 applySceneLayouts 注入);未放置频道只出现在频道坞,不进 3D。
 */
export function buildBlocks(host: BlockLayerHost, seeds: TownEntityInput[]): void {
  host.entityIndex.clear()
  for (const ch of seeds) {
    host.entityIndex.set(ch.channelId, ch)
    const layout = host.layouts.get(ch.channelId)
    if (!layout) continue
    placeChannel(host, ch, layout)
  }
  host.emit('blockCount', host.blocks.size)
  host.emit('agentCount', host.agents.size)
}

/** 按布局放置一个频道领地(面向对象:Block3D 实例)+ 在其边界内铺放全部 Agent */
export function placeChannel(host: BlockLayerHost, ch: TownEntityInput, rawLayout: ChannelLayout): void {
  const layout = normLayout(rawLayout)
  const color = channelColorNum(ch.channelId)
  const pad = makeBlock(host.scene, ch.channelName, color, layout)
  const block = new Block3D({
    channelId: ch.channelId, name: ch.channelName,
    x: layout.x, z: layout.z,
    radiusX: layout.radiusX, radiusZ: layout.radiusZ,
    shape: layout.shape, rotationY: layout.rotationY,
    color,
    platform: pad.platform,
    padRing: pad.padRing,
    beacon: pad.beacon,
    boundary: makeBoundary(layout.shape, layout.radiusX, layout.radiusZ, color),
    label: makeLabel(host.scene, ch.channelName, layout.x, 30, layout.z),
  })
  block.host = host
  block.boundary.position.set(layout.x, 0.3, layout.z)
  block.boundary.rotation.y = layout.rotationY * Math.PI / 180
  host.scene.add(block.boundary)
  host.blocks.set(ch.channelId, block)
  // 在边界内铺放该频道的全部 Agent(lead 居中心,worker 左右展开;钳在边界内)
  layoutAgentsInBlock(host, ch, block)
  // 面向对象聚合:把该频道全部成员挂到 Block3D.members(供整体移动/边界钳制批量处理)
  for (const a of host.agents.values()) {
    if (a.channelId === ch.channelId && !block.members.includes(a)) block.members.push(a)
  }
}

/** 在频道领地里铺放全部 Agent(按边界内分布;客户自定 home 优先) */
export function layoutAgentsInBlock(host: BlockLayerHost, ch: TownEntityInput, block: Block3D): void {
  const { x, z, radiusX, radiusZ } = block
  const inner = 0.6 // 内缩比例:agent 铺在边界内侧
  const n = Math.max(1, ch.agents.length)
  ch.agents.forEach((a, i) => {
    // 若该 agent 有 persisted home(且在边界附近)则用之;否则沿长轴均匀铺放
    let px: number
    let pz: number
    if (typeof a.homeX === 'number' && typeof a.homeZ === 'number') {
      px = a.homeX
      pz = a.homeZ
    }
    else {
      const t = n <= 1 ? 0 : (i / (n - 1)) * 2 - 1
      px = x + t * radiusX * inner * 0.8
      pz = z + (a.role === 'lead' ? 0 : (i % 2 === 0 ? -1 : 1) * radiusZ * inner * 0.4)
    }
    host.ensureAgent({ ...a, channelId: ch.channelId }, px, pz, block.color)
  })
}

/**
 * 注入频道领地布局(来自 useSceneLayouts)。构建场景前必须调用;
 * 未放置的频道会在 rebuild 时被跳过(只停留在频道坞)。
 */
export function applySceneLayouts(host: BlockLayerHost, layouts: ChannelLayout[]): void {
  host.layouts.clear()
  for (const l of layouts) {
    const n = normLayout(l)
    host.layouts.set(n.channelId, n)
  }
}

/** 频道是否已放入场景(供频道坞标记已放置/未放置) */
export function hasChannel(host: BlockLayerHost, channelId: string): boolean {
  return host.blocks.has(channelId)
}

/** 频道当前布局(供边界约束;未放置返回空) */
export function blockLayout(host: BlockLayerHost, channelId: string): ChannelLayout | null {
  const b = host.blocks.get(channelId)
  return b ? b.layout() : null
}

/** 已放入场景的频道集(供频道坞/选中面板) */
export function placedChannels(host: BlockLayerHost): string[] {
  return [...host.blocks.keys()]
}

/** 频道当前布局(供边界编辑面板初始化) */
export function getChannelLayout(host: BlockLayerHost, channelId: string): ChannelLayout | null {
  const b = host.blocks.get(channelId)
  return b ? b.layout() : null
}

/** 记录频道当前布局到场景布局表(移动/缩放后由 Block3D 调用) */
export function trackLayout(host: BlockLayerHost, b: Block3D): void {
  host.layouts.set(b.channelId, b.normLayout())
}

/** 相机注视目标(供频道坞首放落点/聚焦) */
export function getCameraTarget(host: BlockLayerHost): { x: number, z: number } {
  return { x: Math.round(host.camTarget.x), z: Math.round(host.camTarget.z) }
}

/**
 * 频道拖入场景:在落点建领地 + 铺放其全部 Agent(钳在边界内)。
 * 频道 id 需已在实体基线中;返回落点世界坐标(供 HUD 提示)。
 */
export function dropChannelOnWorld(host: BlockLayerHost, x: number, z: number, channelId: string, channelName: string, agentCount: number): { x: number, z: number, channelId: string, name: string } {
  const existing = host.blocks.get(channelId)
  if (existing) {
    host.focusTo(existing.x, existing.z)
    return { x: Math.round(existing.x), z: Math.round(existing.z), channelId, name: existing.name }
  }
  // 缺省布局:以落点为中心、与 Agent 数匹配的边界
  const rx = Math.max(120, 110 + agentCount * 18)
  const rz = Math.max(80, 70 + agentCount * 14)
  const layout: ChannelLayout = { channelId, x, z, radiusX: rx, radiusZ: rz, shape: 'ellipse', rotationY: 0 }
  host.layouts.set(channelId, normLayout(layout))
  // 从实体基线取该频道 agents(由 TownView ensureChannelPresent 提前放置)
  const seed = host.entityIndex.get(channelId)
  if (seed) {
    placeChannel(host, seed, layout)
  }
  else {
    // 无实体基线(频道坞拖入,数据尚未到达):只建空领地占位
    const color = channelColorNum(channelId)
    const pad = makeBlock(host.scene, channelName, color, layout)
    const block = new Block3D({
      channelId, name: channelName, x, z,
      radiusX: layout.radiusX, radiusZ: layout.radiusZ,
      shape: layout.shape, rotationY: layout.rotationY, color,
      platform: pad.platform,
      padRing: pad.padRing,
      beacon: pad.beacon,
      boundary: makeBoundary(layout.shape, layout.radiusX, layout.radiusZ, color),
      label: makeLabel(host.scene, channelName, x, 30, z),
    })
    block.host = host
    block.boundary.position.set(x, 0.3, z)
    host.scene.add(block.boundary)
    host.blocks.set(channelId, block)
  }
  host.emit('blockCount', host.blocks.size)
  host.emit('agentCount', host.agents.size)
  return { x: Math.round(x), z: Math.round(z), channelId, name: channelName }
}

/** 更新频道布局(编辑边界后本地即时生效;持久化由 TownView 经 useSceneLayouts.save 落库) */
export function updateChannelLayout(host: BlockLayerHost, channelId: string, patch: Partial<ChannelLayout>): void {
  const b = host.blocks.get(channelId)
  if (!b) return
  if (patch.x !== undefined) b.x = patch.x
  if (patch.z !== undefined) b.z = patch.z
  if (patch.radiusX !== undefined) b.radiusX = Math.max(60, patch.radiusX)
  if (patch.radiusZ !== undefined) b.radiusZ = Math.max(40, patch.radiusZ)
  if (patch.shape !== undefined) b.shape = patch.shape
  if (patch.rotationY !== undefined) b.rotationY = patch.rotationY
  const layout = normLayout({ channelId, x: b.x, z: b.z, radiusX: b.radiusX, radiusZ: b.radiusZ, shape: b.shape, rotationY: b.rotationY })
  host.layouts.set(channelId, layout)
  // 重建领地平台/边界/名牌
  host.scene.remove(b.boundary)
  applyPadToBlock(b)
  b.boundary = makeBoundary(layout.shape, layout.radiusX, layout.radiusZ, b.color)
  b.boundary.position.set(layout.x, 0.3, layout.z)
  b.boundary.rotation.y = layout.rotationY * Math.PI / 180
  host.scene.add(b.boundary)
  // 频道边界变化后把成员活动范围一并收进新边界(面板滑杆编辑路径)
  host.clampAgentsToBoundary(channelId)
  host.markDirty()
}

/** 移除频道放置(从场景撤走领地及其 Agent) */
export function removeChannel(host: BlockLayerHost, channelId: string): void {
  const b = host.blocks.get(channelId)
  if (!b) return
  host.scene.remove(b.platform)
  host.scene.remove(b.padRing)
  host.scene.remove(b.beacon)
  if (b.boundary) host.scene.remove(b.boundary)
  host.scene.remove(b.label)
  for (const [aid, a] of [...host.agents.entries()]) {
    if (a.channelId === channelId) {
      host.scene.remove(a.root)
      if (a.nameSprite) host.scene.remove(a.nameSprite)
      if (a.bubble) host.scene.remove(a.bubble)
      if (a.rangeLine) host.scene.remove(a.rangeLine)
      host.disposeAgentAssets(a)
      host.agents.delete(aid)
    }
  }
  if (b.label) host.disposeCanvasTextures(b.label)
  if (host.rangeDrawAgent && host.agents.get(host.rangeDrawAgent) === undefined) host.cancelRangeDraw()
  host.blocks.delete(channelId)
  host.layouts.delete(channelId)
  host.receivers.delete(channelId)
  for (const hl of host.resizeHandles) hl.mesh.visible = false
  for (const hl of host.agentRangeHandles) hl.mesh.visible = false
  if (host.selectedChannel === channelId) {
    host.selectedChannel = null
    host.emit('selectChannel', null)
  }
  host.emit('blockCount', host.blocks.size)
  host.emit('agentCount', host.agents.size)
  host.markDirty()
}

/** 当前场景内全部频道布局(供「保存全部布局」/E2E) */
export function getAllChannelLayouts(host: BlockLayerHost): ChannelLayout[] {
  return [...host.blocks.values()].map(b => ({
    channelId: b.channelId, x: b.x, z: b.z,
    radiusX: b.radiusX, radiusZ: b.radiusZ,
    shape: b.shape, rotationY: b.rotationY,
  }))
}

/** 按当前 Block 字段重建领地几何(平台刻度/边界线框/朝向),供缩放与移动共用 */
export function applyLayoutToBlock(host: BlockLayerHost, b: Block3D): void {
  const layout = { channelId: b.channelId, x: b.x, z: b.z, radiusX: b.radiusX, radiusZ: b.radiusZ, shape: b.shape, rotationY: b.rotationY }
  host.layouts.set(b.channelId, normLayout(layout))
  b.platform.position.set(b.x, 0.16, b.z)
  b.padRing.position.set(b.x, 0.34, b.z)
  applyPadToBlock(b)
  if (b.boundary) host.scene.remove(b.boundary)
  b.boundary = makeBoundary(b.shape, b.radiusX, b.radiusZ, b.color)
  b.boundary.position.set(b.x, 0.3, b.z)
  b.boundary.rotation.y = b.rotationY * Math.PI / 180
  host.scene.add(b.boundary)
  host.markDirty()
}
