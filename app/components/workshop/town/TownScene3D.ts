/**
 * AgentTeam RPG 小镇 — Three.js 3D 表现层(默认渲染器)。
 *
 * 职责(只渲染,不决策):
 *  - 3D 斜俯视 2.5D 场景:渲染器/相机/灯下/地面/环形布点 + 领地平台 + 频道名牌;
 *  - 每个 Agent → 一个 3D 角色 Group(模型 Mesh + 同频道色环 + 头顶名字 Sprite);
 *  - 模型绑定:modelRef → GLTFLoader 加载 .glb(GLTF/GLB),归一化 scale/锚点贴地,
 *    有 animation clip 则 AnimationMixer 播 idle/walk,否则静态;
 *  - 复用决策层:eventToBubble/mapEnvelopeToIntent/parseActionFromEnvelope/stepToward;
 *  - 行为 FSM(idle/roam/approach/wait/returnHome)在 x/z 平面复刻;
 *  - `getDebugState()/getMinimapState()/getRecentActivity()` 与 2D 同构,供 HUD/E2E。
 *
 * 与 TownView 的分发:默认挂载本场景,`?render=2d` 回退 Phaser TownScene。
 * 公开接口与 2D 镜像,让 TownView 无感切换(经最小公共接口 TownViewScene 约束)。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { mapEnvelopeToIntent, type TownBubbleKind } from '#shared/town-protocol'
import { parseActionFromEnvelope, stepToward, type ActionKind, type ActionContext } from '#shared/town-behavior'

/** 场景 → Vue HUD 事件(TownEventMap 与 2D 同构) */
export type TownEventMap = {
  ready: boolean
  fps: number
  agentCount: number
  blockCount: number
  lastActivity: { channelId: string, agentName: string, text: string } | null
  behavior: { agentName: string, action: string, targetName: string | null } | null
  /** 选中 Agent/设备(供 Vue 弹缩放/旋转滑杆);null 取消选中 */
  select: { kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null
  /** 选中频道(供 Vue 边界编辑面板);null 取消 */
  selectChannel: string | null
  /** 频道布局被拖拽/手柄调整(供 Vue 刷新边界面板草稿);null 取消 */
  channelResized: { channelId: string, layout: ChannelLayout } | null
  /** Agent 活动范围被框选绘制/拖移/手柄调整/清除(供 Vue 刷新对象面板草稿);null 取消 */
  agentRangeChanged: { agentId: string } | null
  /** 动画状态切换(数据驱动:Agent 在 idle/walk 之间切换时广播);null 表示无 */
  motion: { agentName: string, anim: 'idle' | 'walk', at: number } | null
  /** 场景保存状态(设备/角色布局持久化进度) */
  saveState: { state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at: number } | null
}

/** 编辑 / 浏览模式:浏览只读(相机+点选),编辑可拖拽设备/调整角色落点 */
export type TownScene3DMode = 'browse' | 'edit'

/** 设备 transform 补丁(拖拽/滑杆结束防抖保存) */
export interface DeviceTransformPatch {
  posX?: number
  posZ?: number
  rotationY?: number
  scale?: number
}

/** syncDevices 输入:与 useDeviceTwins.DeviceTwinView 同构的子集 */
export interface DeviceTwinSync {
  id: string
  name: string
  modelRef: string
  state?: 'idle' | 'running' | 'offline' | 'alarm'
  telemetry?: Record<string, number | string | boolean>
  posX?: number
  posZ?: number
  rotationY?: number
  scale?: number
}

/** 场景内可缩放目标(Agent 或设备节点) */
interface ScaledTarget {
  kind: 'agent' | 'device'
  id: string
  /** 用户缩放倍率(1 = 默认归一化尺寸) */
  userScale: number
  /** 模型子节点(缩放施加于此) */
  holder: THREE.Group
}

/** 与 2D TownEntityInput 同构的实体基线 */
export interface TownEntityInput {
  channelId: string
  channelName: string
  agents: Array<{
    agentId: string
    name: string
    role: 'lead' | 'worker'
    harness: string
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId?: string | null
    currentTaskTitle?: string | null
    currentTaskProgress?: number | null
    modelRef?: string | null
    /** 管理员布局落点(来自 config.homeX/homeZ;缺省 = 领地环形排布) */
    homeX?: number | null
    homeZ?: number | null
    /** 管理员布局活动范围(来自 config.range;缺省 = 沿用频道边界) */
    range?: AgentRangeLayout | null
  }>
}

/** 频道布局(3D 小镇放置):与共享 AepSceneLayout/useSceneLayouts 同构 */
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

/** 频道领地 3D 实例(面向对象:持有布局/网格/成员,封装移动/边界/成员钳制等行为)。
 *  数据来自 scene-layouts 持久化,由场景按数据库元数据实例化,并注入宿主控制器。 */
class Block3D {
  channelId!: string
  name!: string
  x!: number
  z!: number
  radiusX!: number
  radiusZ!: number
  shape!: 'ellipse' | 'rect'
  rotationY!: number
  color!: number
  platform!: THREE.Mesh
  /** 活动边界(编辑高亮) */
  boundary!: THREE.LineLoop
  label!: THREE.Sprite
  /** 本频道的 Agent3D 成员实例(面向对象聚合) */
  members: Agent3D[] = []
  /** 宿主场景控制器(实例化后注入;提供跨实体服务) */
  host!: TownScene3D

  constructor(init: {
    channelId: string
    name: string
    x: number
    z: number
    radiusX: number
    radiusZ: number
    shape: 'ellipse' | 'rect'
    rotationY: number
    color: number
    platform: THREE.Mesh
    boundary: THREE.LineLoop
    label: THREE.Sprite
  }) {
    Object.assign(this, init)
  }

  /** 当前布局(与共享 ChannelLayout 同构;供边界面板/落库/E2E) */
  layout(): ChannelLayout {
    return { channelId: this.channelId, x: this.x, z: this.z, radiusX: this.radiusX, radiusZ: this.radiusZ, shape: this.shape, rotationY: this.rotationY }
  }

  /** 归一化布局(radius 钳制下限) */
  normLayout(): ChannelLayout {
    return normLayout(this.layout())
  }

  /** 边界手柄本地坐标(矩形四角 / 椭圆轴向四点,按当前形状) */
  handlePoints(): Array<[number, number]> {
    if (this.shape === 'rect') {
      const hx = this.radiusX / 2
      const hz = this.radiusZ / 2
      return [[hx, hz], [-hx, hz], [-hx, -hz], [hx, -hz]]
    }
    return [[this.radiusX, 0], [-this.radiusX, 0], [0, this.radiusZ], [0, -this.radiusZ]]
  }

  /** 世界点是否落在领地边界内(点选/命中判定) */
  pointIn(x: number, z: number): boolean {
    return pointInBoundary(this.layout(), x, z)
  }

  /** 整体平移:更新中心、平台/边界/名牌网格,并携带全部成员落点与各自活动范围(行为内聚) */
  moveBy(dx: number, dz: number): void {
    this.x += dx
    this.z += dz
    this.platform.position.set(this.x, 0.16, this.z)
    this.boundary.position.set(this.x, 0.3, this.z)
    this.boundary.rotation.y = this.rotationY * Math.PI / 180
    this.label.position.set(this.x, 30, this.z)
    for (const a of this.members) {
      a.root.position.x += dx
      a.root.position.z += dz
      a.homeX += dx
      a.homeZ += dz
      if (a.range) {
        a.range.x += dx
        a.range.z += dz
        a.renderRangeLine()
      }
    }
    this.host.trackLayout(this)
  }

  /** 按补丁更新布局字段(边界编辑;钳制下限由宿主统一保证) */
  applyPatch(patch: Partial<ChannelLayout>): void {
    if (patch.x !== undefined) this.x = patch.x
    if (patch.z !== undefined) this.z = patch.z
    if (patch.radiusX !== undefined) this.radiusX = patch.radiusX
    if (patch.radiusZ !== undefined) this.radiusZ = patch.radiusZ
    if (patch.shape !== undefined) this.shape = patch.shape
    if (patch.rotationY !== undefined) this.rotationY = patch.rotationY
  }

  /** 把成员落点与各自活动范围收进当前频道边界(边界缩放/整体移动后调用) */
  clampMembersAndRanges(): void {
    const layout = this.layout()
    for (const a of this.members) {
      const c = clampToBoundary(layout, a.root.position.x, a.root.position.z, 16)
      a.root.position.x = c.x
      a.root.position.z = c.z
      a.homeX = c.x
      a.homeZ = c.z
      if (a.range) {
        a.range = clampRangeToLayout(layout, a.range)
        a.renderRangeLine()
        const cc = clampToAgentRange(a.range, a.homeX, a.homeZ, 0)
        if (cc.x !== a.homeX || cc.z !== a.homeZ) {
          a.homeX = cc.x
          a.homeZ = cc.z
          a.root.position.x = cc.x
          a.root.position.z = cc.z
        }
      }
    }
    this.host.markDirty()
  }
}

/** 边界几何体:椭圆/矩形线框,弯折朝向 rotationY(度) */
function makeBoundary(shape: 'ellipse' | 'rect', rx: number, rz: number, color: number): THREE.LineLoop {
  const pts: THREE.Vector3[] = []
  const seg = 48
  if (shape === 'rect') {
    const hx = rx / 2
    const hz = rz / 2
    pts.push(new THREE.Vector3(-hx, 0, -hz), new THREE.Vector3(hx, 0, -hz), new THREE.Vector3(hx, 0, hz), new THREE.Vector3(-hx, 0, hz))
  }
  else {
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * Math.PI * 2
      pts.push(new THREE.Vector3(Math.cos(t) * rx, 0, Math.sin(t) * rz))
    }
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts)
  const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false }))
  return line
}

/** 归一化边界(radius 钳制下限;rect 用半宽) */
function normLayout(l: ChannelLayout): ChannelLayout {
  return {
    channelId: l.channelId,
    x: l.x,
    z: l.z,
    radiusX: Math.max(60, l.radiusX),
    radiusZ: Math.max(40, l.radiusZ),
    shape: l.shape === 'rect' ? 'rect' : 'ellipse',
    rotationY: l.rotationY || 0,
  }
}

/** 把点钳制到频道边界内(带内缩 margin;旋转边界用逆变换求局部坐标) */
function clampToBoundary(layout: ChannelLayout, x: number, z: number, margin = 0): { x: number, z: number } {
  const l = normLayout(layout)
  // 旋转回局部坐标
  const rad = -l.rotationY * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = x - l.x
  const dz = z - l.z
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos
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
  // 旋回世界坐标
  const wrad = l.rotationY * Math.PI / 180
  const wcos = Math.cos(wrad)
  const wsin = Math.sin(wrad)
  return { x: l.x + cx * wcos - cz * wsin, z: l.z + cx * wsin + cz * wcos }
}

/** 点到边界内判定(与 clampToBoundary 同旋转约定;纯函数,供工具与场景共用) */
function pointInBoundary(layout: ChannelLayout, x: number, z: number): boolean {
  const l = normLayout(layout)
  const rad = -l.rotationY * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = x - l.x
  const dz = z - l.z
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos
  if (l.shape === 'rect') return Math.abs(lx) <= l.radiusX / 2 && Math.abs(lz) <= l.radiusZ / 2
  const nx = lx / l.radiusX
  const nz = lz / l.radiusZ
  return nx * nx + nz * nz <= 1
}

/** 边界/范围的极值点(矩形四角 / 椭圆轴向四点;世界坐标,含 rotationY) */
function boundaryExtremePoints(layout: { x: number, z: number, radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect', rotationY: number }, margin = 0): Array<[number, number]> {
  const rx = Math.max(0, layout.radiusX - margin)
  const rz = Math.max(0, layout.radiusZ - margin)
  const local: Array<[number, number]> = layout.shape === 'rect'
    ? [[rx, rz], [-rx, rz], [-rx, -rz], [rx, -rz]]
    : [[rx, 0], [-rx, 0], [0, rz], [0, -rz]]
  const rot = layout.rotationY * Math.PI / 180
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  return local.map(([lx, lz]) => [layout.x + lx * cos - lz * sin, layout.z + lx * sin + lz * cos])
}

/** 把 Agent 活动范围整体收进频道边界:中心钳入 + 半径收缩使极值点全部在边界内 */
function clampRangeToLayout(layout: ChannelLayout, range: AgentRangeLayout): AgentRangeLayout {
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

/** 把点钳制到 Agent 自己活动范围内(带内缩 margin;旋转边界用逆变换求局部坐标) */
function clampToAgentRange(range: AgentRangeLayout, x: number, z: number, margin = 0): { x: number, z: number } {
  const rad = -range.rotationY * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = x - range.x
  const dz = z - range.z
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos
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
  const wrad = range.rotationY * Math.PI / 180
  const wcos = Math.cos(wrad)
  const wsin = Math.sin(wrad)
  return { x: range.x + cx * wcos - cz * wsin, z: range.z + cx * wsin + cz * wcos }
}

/** 世界点到活动范围边界线的最近距离(矩形 4 边带 / 椭圆等距采样;供「拖边界整框平移」命中) */
function distToRangeBoundary(range: AgentRangeLayout, x: number, z: number): number {
  const rad = -range.rotationY * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = x - range.x
  const dz = z - range.z
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos
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

/** 角色 3D 实例(面向对象:持有模型/状态/行为,封装漫游 FSM、移动钳制、动画、活动范围)。
 *  由场景按 entities/数据库元数据(home/range/modelRef)实例化并注入宿主;动画状态驱动 motion 事件。 */
class Agent3D {
  channelId!: string
  agentId!: string
  name!: string
  role!: 'lead' | 'worker'
  /** 根 Group(位置=落地点,脚底) */
  root!: THREE.Group
  /** 模型子节点(换模型时替换) —— 始终存在(空组占位) */
  model!: THREE.Group
  mixer!: THREE.AnimationMixer | null
  /** 当前模型动画 clip(若有) */
  clips!: THREE.AnimationClip[]
  /** 脚下同频道色环 */
  aura!: THREE.Mesh
  /** 头顶名字 Sprite */
  nameSprite!: THREE.Sprite
  /** 当前气泡 */
  bubble!: THREE.Sprite | null
  /** 当前头顶聊天气泡文本(调试/HUD 用;null = 无气泡) */
  bubbleText!: string | null
  bubbleTimer!: ReturnType<typeof setTimeout> | null
  /** 状态/进度/行为 */
  state!: 'idle' | 'busy' | 'stopped'
  progress!: number | null
  /** 行为 FSM */
  behavior!: BehaviorState
  /** 用户拖动中 */
  dragging!: boolean
  /** home(行为结束后回归) */
  homeX!: number
  homeZ!: number
  /** 独立活动范围(编辑模式框选/手柄;null = 沿用频道边界) */
  range!: AgentRangeLayout | null
  /** 活动范围线框(随 range 渲染;清除/重建时移除) */
  rangeLine!: THREE.LineLoop | null
  textureKey!: string
  modelRef!: string
  /** 当前动画状态(数据驱动模型:idle/walk;经宿主 motion 事件监听) */
  animState: 'idle' | 'walk' = 'idle'
  /** 宿主场景控制器(实例化后注入) */
  host!: TownScene3D
  /** 本帧是否在移动(update 结束时驱动动画) */
  private moving = false

  constructor(init: {
    channelId: string
    agentId: string
    name: string
    role: 'lead' | 'worker'
    root: THREE.Group
    model: THREE.Group
    mixer: THREE.AnimationMixer | null
    clips: THREE.AnimationClip[]
    aura: THREE.Mesh
    nameSprite: THREE.Sprite
    bubble: THREE.Sprite | null
    bubbleText: string | null
    bubbleTimer: ReturnType<typeof setTimeout> | null
    state: 'idle' | 'busy' | 'stopped'
    progress: number | null
    behavior: BehaviorState
    dragging: boolean
    homeX: number
    homeZ: number
    range: AgentRangeLayout | null
    rangeLine: THREE.LineLoop | null
    textureKey: string
    modelRef: string
  }) {
    Object.assign(this, init)
  }

  /** 到达判定 */
  reached(target: { x: number, z: number }): boolean {
    return Math.hypot(this.root.position.x - target.x, this.root.position.z - target.z) <= ARRIVE
  }

  /** 朝目标匀速走一步(按自身活动范围/频道边界钳制;驱动朝向与动画) */
  driveToward(target: { x: number, z: number }, speed: number, dt: number): void {
    this.moving = true
    const cur = { x: this.root.position.x, z: this.root.position.z }
    const next = stepToward({ x: cur.x, y: cur.z }, { x: target.x, y: target.z }, speed, dt)
    let nx = next.x
    let nz = next.y
    if (this.range) {
      const clamped = clampToAgentRange(this.range, nx, nz, 6)
      nx = clamped.x
      nz = clamped.z
    }
    else {
      const layout = this.host.blockLayoutOf(this.channelId)
      if (layout) {
        const clamped = clampToBoundary(layout, nx, nz, 6)
        nx = clamped.x
        nz = clamped.z
      }
    }
    this.root.position.x = nx
    this.root.position.z = nz
    const dir = next.dir
    if (dir === 'left') this.root.rotation.y = Math.PI
    else if (dir === 'right') this.root.rotation.y = 0
    void dt
  }

  /** 行为 FSM(idle/roam/approach/wait/returnHome);由渲染循环每帧驱动,动画随移动状态切换 */
  update(dt: number): void {
    this.moving = false
    try {
      this.updateBehavior(dt)
    }
    finally {
      this.playWalkAnim(this.moving)
    }
  }

  private updateBehavior(dt: number): void {
    const b = this.behavior
    if (b.mode === 'idle' || b.mode === 'roam') {
      if (b.engaged || this.dragging) return
      b.mode = 'roam'
      if (!b.roamTarget) {
        // 到达后就地停顿片刻:保持 idle 动画,营造走走停停的闲逛节奏(并产生 motion 事件)
        if (performance.now() < b.pauseUntil) return
        // 漫游目标:有独立活动范围 → 在自身范围内取点;否则沿用频道边界内取点
        const layout = this.host.blockLayoutOf(this.channelId)
        let tx: number
        let tz: number
        if (this.range) {
          tx = this.homeX + (Math.random() * 2 - 1) * this.range.radiusX * 0.9
          tz = this.homeZ + (Math.random() * 2 - 1) * this.range.radiusZ * 0.9
          const clamped = clampToAgentRange(this.range, tx, tz, 8)
          tx = clamped.x
          tz = clamped.z
        }
        else {
          const range = layout ? Math.min(layout.radiusX, layout.radiusZ) * 0.45 : 80
          tx = this.homeX + (Math.random() * 2 - 1) * range
          tz = this.homeZ + (Math.random() * 2 - 1) * range * 0.6
          if (layout) {
            const clamped = clampToBoundary(layout, tx, tz, 16)
            tx = clamped.x
            tz = clamped.z
          }
        }
        b.roamTarget = { x: tx, z: tz }
      }
      this.driveToward(b.roamTarget, AGENT_SPEED * 0.5, dt)
      if (this.reached(b.roamTarget)) {
        b.roamTarget = null
        b.pauseUntil = performance.now() + 350 + Math.random() * 900
      }
      return
    }
    if (b.mode === 'approach') {
      const target = b.targetId ? this.host.getAgent(b.targetId) : undefined
      if (!target) {
        b.mode = 'idle'
        return
      }
      let pos = { x: target.root.position.x, z: target.root.position.z }
      // 目标在自身活动范围外 → 逼近到自身范围边界(送达交接在边界处完成)
      if (this.range) {
        const c = clampToAgentRange(this.range, pos.x, pos.z, 8)
        pos = { x: c.x, z: c.z }
      }
      this.driveToward(pos, AGENT_SPEED, dt)
      if (this.reached(pos)) {
        this.host.deliverBehavior(this, target)
        if (b.action?.requireReply) {
          b.mode = 'wait'
          b.waitUntil = performance.now() + WAIT_MS
        }
        else {
          b.mode = 'returnHome'
          this.host.releaseEngaged(this)
          b.targetId = null
        }
      }
      return
    }
    if (b.mode === 'wait') {
      if (this.dragging) return
      const target = b.targetId ? this.host.getAgent(b.targetId) : undefined
      if (target && !target.dragging) {
        const stand = { x: target.root.position.x + 28, z: target.root.position.z + 8 }
        this.driveToward(stand, AGENT_SPEED * 0.6, dt)
      }
      if (performance.now() >= b.waitUntil) {
        b.mode = 'returnHome'
        this.host.releaseEngaged(this)
      }
      return
    }
    if (b.mode === 'returnHome') {
      if (this.dragging) return
      const home = { x: this.homeX, z: this.homeZ }
      this.driveToward(home, AGENT_SPEED * 0.7, dt)
      if (this.reached(home)) {
        this.root.position.set(this.homeX, GROUND_Y, this.homeZ)
        b.mode = 'idle'
        b.targetId = null
        b.action = undefined
      }
    }
  }

  /** 动画状态切换(有 clip: idle/walk 动作;无 clip: 上下浮动 bob);切换时经宿主广播 motion 事件 */
  playWalkAnim(moving: boolean): void {
    const next = moving ? 'walk' : 'idle'
    if (this.animState !== next) {
      this.animState = next
      this.host.notifyMotion(this)
    }
    if (this.clips.length === 0) {
      // 无动画 → 轻微上下浮动(bob)
      this.root.position.y = GROUND_Y + (moving ? Math.abs(Math.sin(performance.now() * 0.004)) * 4 : 0)
      return
    }
    // 有动画 clip:idle(0)/walk(1),按移动切换(缺省则用 clip[0])
    if (!this.mixer) return
    const idx = moving ? (this.clips.length > 1 ? 1 : 0) : 0
    const clip = this.clips[idx]
    if (!clip) return
    const action = this.mixer.clipAction(clip)
    action.play()
    action.timeScale = moving ? 1.3 : 0.9
  }

  /** 更新 home 落点(行为结束后回归点;含拖拽/范围位移后落库路径) */
  setHome(x: number, z: number): void {
    this.homeX = x
    this.homeZ = z
  }

  /** 渲染/刷新活动范围线框(数据驱动:range 变更 → 线框重建)+ 可见性 */
  renderRangeLine(): void {
    if (this.rangeLine) {
      this.host.threeScene.remove(this.rangeLine)
      this.rangeLine = null
    }
    if (!this.range) return
    const color = this.range.shape === 'rect' ? 0x9fe8d4 : 0x8fb7ff
    const line = makeBoundary(this.range.shape, this.range.radiusX, this.range.radiusZ, color)
    // 虚线描边(与频道实线边界区分;2.5D 可读性)
    line.material = new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.75, depthTest: false, dashSize: 14, gapSize: 9 })
    line.computeLineDistances()
    line.position.set(this.range.x, 0.5, this.range.z)
    line.rotation.y = this.range.rotationY * Math.PI / 180
    line.visible = this.host.rangeLineVisibleFor(this)
    this.host.threeScene.add(line)
    this.rangeLine = line
    this.host.markDirty()
  }

  /** 挂气泡(替换旧气泡;宿主完成纹理渲染) */
  attachBubble(sprite: THREE.Sprite, text: string): void {
    if (this.bubble) {
      this.host.threeScene.remove(this.bubble)
      this.bubbleText = null
    }
    this.bubble = sprite
    this.bubbleText = text
  }

  /** 移除气泡(宿主负责从场景摘除) */
  clearBubble(): void {
    if (!this.bubble) return
    this.host.threeScene.remove(this.bubble)
    this.bubble = null
    this.bubbleText = null
  }
}

type BehaviorMode
  = 'idle'
    | 'roam'
    | 'approach'
    | 'wait'
    | 'returnHome'

/** 数字孪生设备 3D 实例(面向对象:持有节点网格/状态/遥测,封装讑生同步、状态环、模型重挂、transform 记忆)。
 *  由场景按 device-twins 数据库元数据实例化;state/telemetry 数据驱动渲染。 */
class DeviceNode {
  twinId!: string
  name!: string
  modelRef!: string
  root!: THREE.Group
  /** 模型挂载组(换模型时 clear 重挂;缩放施加于此) */
  holder!: THREE.Group
  ring!: THREE.Mesh
  label!: THREE.Sprite
  state!: 'idle' | 'running' | 'offline' | 'alarm'
  telemetry!: Record<string, number | string | boolean>
  /** 宿主场景控制器(实例化后注入) */
  host!: TownScene3D

  constructor(init: {
    twinId: string
    name: string
    modelRef: string
    root: THREE.Group
    holder: THREE.Group
    ring: THREE.Mesh
    label: THREE.Sprite
    state: 'idle' | 'running' | 'offline' | 'alarm'
    telemetry: Record<string, number | string | boolean>
  }) {
    Object.assign(this, init)
  }

  /** 状态环颜色(数据驱动:state → 环色) */
  updateRing(): void {
    const color = this.state === 'alarm' ? 0xff6b6b : this.state === 'offline' ? 0x9aa4ae : this.state === 'running' ? 0x8fe8d4 : 0xf0c05a
    ;(this.ring.material as THREE.MeshBasicMaterial).color.setHex(color)
  }

  /** 与数据库讑生记录收敛(状态/遥测/名称/模型;宿主完成名牌与模型重挂) */
  applyTwin(t: DeviceTwinSync): void {
    if (t.state) this.state = t.state
    if (t.telemetry) this.telemetry = { ...this.telemetry, ...t.telemetry }
    if (t.name && t.name !== this.name) this.host.renameDeviceSprite(this, t.name)
    if (t.modelRef && t.modelRef !== this.modelRef) this.host.swapDeviceModelSprite(this, t.modelRef)
    this.updateRing()
    this.host.markDirty()
  }

  /** 记录当前 transform(供防抖落库快照) */
  rememberTransform(): { posX: number, posZ: number, rotationY: number } {
    return {
      posX: Math.round(this.root.position.x * 10) / 10,
      posZ: Math.round(this.root.position.z * 10) / 10,
      rotationY: Math.round(THREE.MathUtils.radToDeg(this.root.rotation.y) * 10) / 10,
    }
  }
}

interface BehaviorState {
  mode: BehaviorMode
  roamTarget: { x: number, z: number } | null
  targetId: string | null
  waitUntil: number
  /** 漫游到达后就地停顿至该时刻(idle 动画;营造走走停停的闲逛节奏,驱动 motion 事件) */
  pauseUntil: number
  action?: { kind: ActionKind, taskKind?: string, requireReply: boolean, text: string }
  engaged: boolean
}

/** 信息接收器队列中的一条消息(按频道 FIFO 逐条消费) */
interface BubbleMsg {
  /** 说话 Agent(null = 频道级/系统气泡) */
  agentId: string | null
  kind: TownBubbleKind
  text: string
  ttlMs: number
}

/** 每个实例化 Channel 的信息接收器:WS 实时信息经 handleTownEvent 入队,FIFO 逐条消费渲染到对应 Agent 头顶 */
interface ChannelMessageReceiver {
  channelId: string
  queue: BubbleMsg[]
  current: BubbleMsg | null
  currentUntil: number
}

// ---- 世界尺度(与 2D 对齐:3200×2400,3D 用 x/z 平面,y 向上) ----
const WORLD_W = 3200
const WORLD_H = 2400
const WORLD_CX = WORLD_W / 2
const WORLD_CZ = WORLD_H / 2
/** 地面 y=0,Agent 站立于其上 */
const GROUND_Y = 0
/** GLB 归一化到该高度(世界单位,角色要清晰可读) */
const UNITS = 120
const AGENT_SPEED = 96
const WAIT_MS = 2600
const ARRIVE = 48
/** 编辑拖拽网格吸附粒度(世界单位) */
const SNAP_SIZE = 16
/** 聊天气泡悬挂高度(世界单位;角色头顶名牌上方,随模型缩放微调) */
const BUBBLE_Y = 86

/** 角色模型来源登记(registerModelsFromList) */
interface ModelInfo { id: string, file: string, name: string, kind?: string }

/** FIFO 下每条气泡的展示时长:短句快速切换、长句稍长,营造对话节奏(1.4s~3.4s) */
function bubbleDisplayMs(text: string): number {
  return Math.min(3400, Math.max(1400, 1200 + text.length * 26))
}

function hashHue(id: string): number {
  if (!id) return 200
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
function channelColorNum(channelId: string): number {
  const c = hslToRgb(hashHue(channelId) / 360, 0.58, 0.6)
  return (c.r << 16) | (c.g << 8) | c.b
}
function hslToRgb(h: number, s: number, l: number): { r: number, g: number, b: number } {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255)
  }
  return { r: f(0), g: f(8), b: f(4) }
}

export class TownScene3D {
  private renderer!: THREE.WebGLRenderer
  private camera!: THREE.PerspectiveCamera
  /** 相机注视目标(拖拽平移它,zoom 微调距离) */
  private camTarget = new THREE.Vector3(WORLD_CX, 20, WORLD_CZ)
  private scene!: THREE.Scene
  private ground!: THREE.Mesh
  private blocks = new Map<string, Block3D>()
  private agents = new Map<string, Agent3D>()
  /** 数字孪生设备节点(twinId → node) */
  private deviceNodes = new Map<string, DeviceNode>()
  /** 场景内可缩放目标(Agent 或设备) */
  private scalables = new Map<string, ScaledTarget>()
  /** 当前选中(kind:id) */
  private selected: { kind: 'agent' | 'device', id: string } | null = null
  /** 已登记模型(id → file) */
  private modelsById = new Map<string, ModelInfo>()
  /** GLTF 缓存(避免重复加载) */
  private gltfCache = new Map<string, { file: string, scene: THREE.Group, height: number }>()
  private gltfLoader = new GLTFLoader()
  private el: HTMLDivElement
  private raf = 0
  private clock = new THREE.Clock()
  private frameCount = 0
  private fpsAccum = 0
  private dirty = true
  /** 频道旗缓存(任务状态) */
  private flagBy = new Map<string, THREE.Mesh>()
  private disposed = false
  /** 当前相机缩放(滚轮;作用于 dolly 距离) */
  private dolly = 1.0
  /** 编辑 / 浏览模式(浏览只读:设备/角色不可拖,仅点选) */
  private mode: TownScene3DMode = 'browse'
  /** 正在拖曳的场景对象(编辑模式):设备 / 角色落点 / 频道整体 / 边界手柄 / Agent 活动范围 */
  private pointerDrag:
    | { kind: 'device', id: string }
    | { kind: 'agent', id: string }
    | { kind: 'channel', id: string, dx: number, dz: number }
    | { kind: 'resize', id: string, handle: number }
    | { kind: 'rangeDraw', id: string, x0: number, z0: number }
    | { kind: 'agentRange', id: string, dx: number, dz: number }
    | { kind: 'agentRangeResize', id: string, handle: number }
    | null = null

  /** 网格吸附(编辑拖拽落点对齐 16 单位网格) */
  private snapEnabled = true
  /** 选中高亮环(编辑模式,跟随当前选中设备/角色) */
  private selRing: THREE.Mesh | null = null
  /** 边界缩放手柄(编辑模式选中频道时显示;拖拽手柄调整 radiusX/radiusZ) */
  private resizeHandles: Array<{ mesh: THREE.Mesh, cid: string, handle: number }> = []
  /** Agent 活动范围缩放手柄(编辑模式选中带范围角色时显示;拖拽调整该 Agent 范围大小) */
  private agentRangeHandles: Array<{ mesh: THREE.Mesh, agentId: string, handle: number }> = []
  /** 框选绘制预览线框(rangeDraw 模式;松开后变为正式范围) */
  private rangeDrawLine: THREE.LineLoop | null = null
  /** 框选绘制目标 agent(非空 = 编辑模式正在为该角色拉动矩形框) */
  private rangeDrawAgent: string | null = null
  /** 框选绘制当前对角(供 endPointerDrag 生成范围) */
  private rangeDrawPreviewState: { x0: number, z0: number, x1: number, z1: number } | null = null
  /** setAgentRangeScene 中因范围收缩而位移的 home(面板提交时一并落库) */
  private rangeHomeMoved: { agentId: string, x: number, z: number } | null = null
  private lastActivity: { channelId: string, agentName: string, text: string } | null = null
  private recentActivity: Array<{ channelId: string, agentName: string, text: string }> = []
  private dbgBubbles: Array<{ text: string, at: number }> = []
  /** 频道信息接收器(channelId → FIFO 队列;实时信息经 handleTownEvent 入队,渲染循环逐条消费) */
  private receivers = new Map<string, ChannelMessageReceiver>()
  readonly container: HTMLDivElement

  /** 任务 ID → assignee 反查 */
  resolveTaskAssignee: ((taskId: string) => string | null) | null = null
  /** 数字孪生设备 API(由 TownView 注入 useDeviceTwins 适配器;拖 dev 模型进场景时创建设备) */
  devices: {
    create(input: { name: string, modelRef?: string, kind?: string, controls?: string[], posX?: number, posZ?: number, scale?: number }): Promise<{ id: string }>
    update(id: string, patch: DeviceTransformPatch): Promise<unknown>
    remove?(id: string): Promise<unknown>
    control(id: string, command: string, args?: Record<string, unknown>): Promise<unknown>
  } | null = null

  /** 管理员布局:保存 Agent 落点(由 TownView 注入;经既有 channel_agents.config 持久化) */
  agentApi: {
    updateHome(agentId: string, x: number, z: number): Promise<unknown>
    /** 保存 Agent 独立活动范围(经 config.range 持久化;null 清除回退频道边界) */
    updateRange(agentId: string, range: AgentRangeLayout | null): Promise<unknown>
  } | null = null

  /** 频道布局持久化(由 TownView 注入;频道拖拽移动/边界拖拽调整后落库) */
  channelApi: {
    save(channelId: string, layout: ChannelLayout): Promise<unknown>
  } | null = null

  private readonly busHandlers = new Map<string, (e: unknown) => void>()

  constructor(seed: TownEntityInput[], el: HTMLDivElement) {
    this.el = el
    this.container = el
    this.initRenderer()
    this.buildBlocks(seed)
  }

  // ================================================================
  // 初始化(渲染器/相机/灯光/地面)
  // ================================================================

  private initRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(this.el.clientWidth || 1100, this.el.clientHeight || 700)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.el.appendChild(this.renderer.domElement)
    // 选中:点击 Agent/设备 → 弹缩放/旋转滑杆(经 on('select') 通知 Vue);拖拽释放不触发
    this.renderer.domElement.addEventListener('pointerup', (e: PointerEvent) => {
      if (e.button !== 0 || this.pointerDrag) return
      const w = this.screenToWorld(e.clientX, e.clientY)
      const hit = this.pickAt(w.x, w.z)
      if (hit) {
        this.setSelected(hit)
        // 点中角色/设备时清除频道选中(避免与边界面板混用)
        if (this.selectedChannel) this.selectChannel(null)
        return
      }
      // 未命中 agent/设备 → 尝试点选频道领地(打开边界编辑面板)
      const cid = this.pickChannel(w.x, w.z)
      this.setSelected(null)
      if (cid && this.mode === 'edit') this.selectChannel(cid)
    })

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x101826)

    // 边界缩放手柄(编辑模式选中频道时显示;4 个:椭圆轴点 / 矩形角点)
    for (let i = 0; i < 4; i++) {
      const h = new THREE.Mesh(
        new THREE.TorusGeometry(13, 5, 8, 20),
        new THREE.MeshBasicMaterial({ color: 0xffd27f, transparent: true, opacity: 0.95, depthTest: false }),
      )
      h.rotation.x = Math.PI / 2
      h.position.y = 1.4
      h.visible = false
      this.scene.add(h)
      this.resizeHandles.push({ mesh: h, cid: '', handle: i })
    }
    // Agent 活动范围缩放手柄(编辑模式选中带范围角色时显示;4 个:椭圆轴点 / 矩形角点)
    for (let i = 0; i < 4; i++) {
      const h = new THREE.Mesh(
        new THREE.TorusGeometry(10, 4, 8, 16),
        new THREE.MeshBasicMaterial({ color: 0x9fe8d4, transparent: true, opacity: 0.95, depthTest: false }),
      )
      h.rotation.x = Math.PI / 2
      h.position.y = 1.2
      h.visible = false
      this.scene.add(h)
      this.agentRangeHandles.push({ mesh: h, agentId: '', handle: i })
    }

    // 相机:斜俯视 2.5D
    this.camera = new THREE.PerspectiveCamera(50, (this.el.clientWidth || 1100) / (this.el.clientHeight || 700), 1, 12000)
    this.camera.position.set(WORLD_CX, 620, WORLD_CZ + 720)
    this.camera.lookAt(WORLD_CX, 20, WORLD_CZ)

    // 灯光:环境 + 主方向光(带阴影) + 补光 —— 调亮,保证角色/平台清晰
    this.scene.add(new THREE.AmbientLight(0xd0e4ee, 1.1))
    const key = new THREE.DirectionalLight(0xfff4e0, 2.2)
    key.position.set(WORLD_CX + 500, 900, WORLD_CZ + 300)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -1400
    key.shadow.camera.right = 1400
    key.shadow.camera.top = 2000
    key.shadow.camera.bottom = -2000
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0x88bbff, 0.4)
    fill.position.set(WORLD_CX - 1200, 900, WORLD_CZ - 800)
    this.scene.add(fill)

    // 地面(大平面)
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x4d7468, roughness: 0.95 })
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W * 1.5, WORLD_H * 1.5), groundMat)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.scene.add(this.ground)
    // 网格辅助(轻微,暗示地表)
    const grid = new THREE.GridHelper(WORLD_W * 1.2, 40, 0x2f4a42, 0x3a554a)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.25
    grid.position.y = 0.1
    this.scene.add(grid)

    this.applyGroundTexture()

    this.loop()
  }

  /** 赛博小镇背景贴图 → 地面材质(重复平铺;加载失败保持纯色,永不报错) */
  private applyGroundTexture(): void {
    try {
      const loader = new THREE.TextureLoader()
      loader.load(
        '/scene/background/cyber-town-background.svg',
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace
          tex.wrapS = THREE.RepeatWrapping
          tex.wrapT = THREE.RepeatWrapping
          tex.repeat.set(2, 2)
          tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy())
          const mat = this.ground.material as THREE.MeshStandardMaterial
          mat.map = tex
          mat.color.set(0xffffff)
          mat.roughness = 0.96
          mat.needsUpdate = true
          this.dirty = true
        },
        undefined,
        () => { /* SVG 不可用:保持纯色地面 */ },
      )
    }
    catch { /* TextureLoader 不可用:保持纯色地面 */ }
  }

  // ================================================================
  // 事件总线(与 2D 同构)
  // ================================================================

  on<K extends keyof TownEventMap>(event: K, fn: (e: TownEventMap[K]) => void): () => void {
    this.busHandlers.set(event, fn as (e: unknown) => void)
    return () => this.busHandlers.delete(event)
  }

  private emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void {
    const fn = this.busHandlers.get(event)
    if (fn) fn(e)
  }

  // ================================================================
  // 实体基线构建(布局驱动放置:只呈现「已放置」的频道;未放置不进场景)
  // ================================================================

  /**
   * 用频道实体基线同步领地/角色。仅放置已保存布局的频道(布局来自 useSceneLayouts,
   * 经 applySceneLayouts 注入);未放置频道只出现在频道坞,不进 3D。
   */
  private buildBlocks(seeds: TownEntityInput[]): void {
    this.entityIndex.clear()
    for (const ch of seeds) {
      this.entityIndex.set(ch.channelId, ch)
      const layout = this.layouts.get(ch.channelId)
      if (!layout) continue
      this.placeChannel(ch, layout)
    }
    this.emit('blockCount', this.blocks.size)
    this.emit('agentCount', this.agents.size)
  }

  /** 按布局放置一个频道领地(面向对象:Block3D 实例)+ 在其边界内铺放全部 Agent */
  private placeChannel(ch: TownEntityInput, rawLayout: ChannelLayout): void {
    const layout = normLayout(rawLayout)
    const color = channelColorNum(ch.channelId)
    const block = new Block3D({
      channelId: ch.channelId, name: ch.channelName,
      x: layout.x, z: layout.z,
      radiusX: layout.radiusX, radiusZ: layout.radiusZ,
      shape: layout.shape, rotationY: layout.rotationY,
      color,
      platform: this.makeBlock(ch.channelName, color, layout),
      boundary: makeBoundary(layout.shape, layout.radiusX, layout.radiusZ, color),
      label: this.makeLabel(ch.channelName, layout.x, 30, layout.z),
    })
    block.host = this
    block.boundary.position.set(layout.x, 0.3, layout.z)
    block.boundary.rotation.y = layout.rotationY * Math.PI / 180
    this.scene.add(block.boundary)
    this.blocks.set(ch.channelId, block)
    // 在边界内铺放该频道的全部 Agent(lead 居中心,worker 左右展开;钳在边界内)
    this.layoutAgentsInBlock(ch, block)
    // 面向对象聚合:把该频道全部成员挂到 Block3D.members(供整体移动/边界钳制批量处理)
    for (const a of this.agents.values()) {
      if (a.channelId === ch.channelId && !block.members.includes(a)) block.members.push(a)
    }
  }

  /** 在频道领地里铺放全部 Agent(按边界内分布;客户自定 home 优先) */
  private layoutAgentsInBlock(ch: TownEntityInput, block: Block3D): void {
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
      this.ensureAgent({ ...a, channelId: ch.channelId }, px, pz, block.color)
    })
  }

  /** 领地:地面色平台 + 名牌(边界线框由 makeBoundary 另行添加) */
  private makeBlock(name: string, color: number, layout: ChannelLayout): THREE.Mesh {
    const platform = new THREE.Mesh(
      new THREE.CircleGeometry(Math.max(layout.radiusX, layout.radiusZ) * 0.9, 40),
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.24, roughness: 0.9, side: THREE.DoubleSide }),
    )
    platform.rotation.x = -Math.PI / 2
    platform.position.set(layout.x, 0.16, layout.z)
    platform.scale.set(layout.radiusX / Math.max(layout.radiusX, layout.radiusZ), 1, layout.radiusZ / Math.max(layout.radiusX, layout.radiusZ))
    platform.receiveShadow = true
    this.scene.add(platform)
    void name
    return platform
  }

  /** 文本 Sprite(名牌/名字) */
  private makeLabel(text: string, x: number, y: number, z: number): THREE.Sprite {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'rgba(18,20,30,0.72)'
    const w = Math.max(120, ctx.measureText(text).width + 20)
    ctx.fillRect(0, 0, w, 64)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 22px Geist, PingFang SC, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, w / 2, 34)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
    sprite.scale.set(w / 8, 8, 1)
    sprite.position.set(x, y, z)
    this.scene.add(sprite)
    return sprite
  }

  // ================================================================
  // Agent(3D 角色:根 Group + 模型 + 同频道色环 + 名字)
  // ================================================================

  private ensureAgent(a: TownEntityInput['agents'][number] & { channelId: string }, cx: number, cz: number, color: number): void {
    const key = a.agentId
    if (this.agents.has(key)) return
    // 管理员布局落点(来自 config.homeX/homeZ)优先;缺省按领地内排布;整体钳制在频道边界内
    const layout = this.blockLayout(a.channelId)
    let homeX = a.homeX ?? cx
    let homeZ = a.homeZ ?? cz
    if (layout) {
      const clamped = clampToBoundary(layout, homeX, homeZ, 20)
      homeX = clamped.x
      homeZ = clamped.z
    }
    // 管理员布局活动范围(来自 config.range;缺省 null = 沿用频道边界);收进频道边界
    let range: AgentRangeLayout | null = null
    if (a.range && layout) range = clampRangeToLayout(layout, a.range)
    const root = new THREE.Group()
    root.position.set(homeX, GROUND_Y, homeZ)
    // 脚下同频道色环
    const aura = new THREE.Mesh(
      new THREE.RingGeometry(10, 16, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    )
    aura.rotation.x = -Math.PI / 2
    aura.position.y = 0.22
    root.add(aura)
    const nameSprite = this.makeLabel(a.name, homeX, 48, homeZ)
    // 默认模型(内置 hero-3d)
    const texKey = a.modelRef || 'hero-3d'
    const model = new THREE.Group()
    root.add(model)
    this.scene.add(root)
    const agent = new Agent3D({
      channelId: a.channelId,
      agentId: key,
      name: a.name,
      role: a.role,
      root,
      model,
      mixer: null,
      clips: [],
      aura,
      nameSprite,
      bubble: null,
      bubbleText: null,
      bubbleTimer: null,
      state: a.state,
      progress: a.currentTaskProgress ?? null,
      dragging: false,
      homeX,
      homeZ,
      range,
      rangeLine: null,
      textureKey: texKey,
      modelRef: a.modelRef ?? '',
      behavior: { mode: 'idle', roamTarget: null, targetId: null, waitUntil: 0, pauseUntil: 0, engaged: false },
    })
    agent.host = this
    this.agents.set(key, agent)
    // 载入模型(GLB)
    const info = this.modelsById.get(texKey) ?? { id: 'hero-3d', file: '/assets/game/character/hero-3d.glb', name: '共鸣精魂' }
    void this.mountModel(agent, info.file, info.name)
    agent.renderRangeLine()
    this.emit('agentCount', this.agents.size)
  }

  /**
   * 绑定模型到 Agent(GLTFLoader 加载 → 归一化 scale/锚点贴地 → 若有动画则 mixer)。
   * 缺失/失败 → 回退内置 hero-3d,永不白屏。
   */
  private async mountModel(asp: Agent3D, file: string, name: string): Promise<void> {
    const cached = this.gltfCache.get(file)
    let loaded: THREE.Group
    let height: number
    if (cached) {
      loaded = cached.scene.clone(true)
      height = cached.height
    }
    else {
      try {
        const gltf = await this.loadGltf(file)
        loaded = gltf.scene
        const box = new THREE.Box3().setFromObject(loaded)
        height = Math.max(0.5, box.max.y - box.min.y)
        this.gltfCache.set(file, { file, scene: loaded, height })
        // 缓存动画 clip(供 mixer 状态切换)
        this.agentAnimClips.set(file, (gltf as unknown as { animations?: THREE.AnimationClip[] }).animations ?? [])
      }
      catch {
        // 加载失败回退空占位,用默认高度
        loaded = new THREE.Group()
        height = 1.4
      }
    }
    // 归一化 scale(使模型高度≈UNITS 世界单位)并贴地(模型大小自适应)
    loaded.position.y = 0
    loaded.scale.setScalar(UNITS / height)
    // 清掉旧模型子节点与 mixer
    asp.model.clear()
    asp.model.add(loaded)
    // 客制化:注册可缩放目标并恢复用户缩放(套在 asp.model 上,作为自适应之上的倍率层)
    this.registerScalable('agent', asp.agentId, asp.model)
    asp.mixer = null
    const clips = this.agentAnimClips.get(file) ?? []
    const firstClip = clips[0]
    if (firstClip) {
      asp.mixer = new THREE.AnimationMixer(loaded)
      asp.clips = clips
      asp.mixer.clipAction(firstClip).play()
    }
    void name
    this.dirty = true
  }

  private agentAnimClips = new Map<string, THREE.AnimationClip[]>()

  private loadGltf(file: string): Promise<{ scene: THREE.Group }> {
    return new Promise((resolve, reject) => {
      this.gltfLoader.load(file, gltf => resolve({ scene: gltf.scene as THREE.Group }), undefined, reject)
    })
  }

  /** 注册模型清单(供 mountModel 查 file) */
  registerModelsFromList(list: Array<{ id: string, file: string, name: string, kind?: string }>): void {
    for (const m of list) if (!this.modelsById.has(m.id)) this.modelsById.set(m.id, m)
  }

  // ================================================================
  // 布局注入 / 重建 / 聚焦 / 事件入口(公开面与 2D 镜像)
  // ================================================================

  /**
   * 注入频道领地布局(来自 useSceneLayouts)。构建场景前必须调用;
   * 未放置的频道会在 rebuild 时被跳过(只停留在频道坞)。
   */
  applySceneLayouts(layouts: ChannelLayout[]): void {
    this.layouts.clear()
    for (const l of layouts) {
      const n = normLayout(l)
      this.layouts.set(n.channelId, n)
    }
  }

  /** 频道是否已放入场景(供频道坞标记已放置/未放置) */
  hasChannel(channelId: string): boolean {
    return this.blocks.has(channelId)
  }

  /** 频道当前布局(供边界约束;未放置返回空) */
  private blockLayout(channelId: string): ChannelLayout | null {
    const b = this.blocks.get(channelId)
    return b ? b.layout() : null
  }

  /** 已放入场景的频道集(供频道坞/选中面板) */
  placedChannels(): string[] {
    return [...this.blocks.keys()]
  }

  /** 频道当前布局(供边界编辑面板初始化) */
  getChannelLayout(channelId: string): ChannelLayout | null {
    const b = this.blocks.get(channelId)
    return b ? b.layout() : null
  }

  // ================================================================
  // 控制器公开面(供实体 class 反向调用:场景图/脏标记/布局表/设备名牌与模型)
  // ================================================================

  /** THREE 场景图(实体渲染线框/气泡时访问) */
  get threeScene(): THREE.Scene {
    return this.scene
  }

  /** 标记场景需重渲染(滚动/交互后由实体行为调用) */
  markDirty(): void {
    this.dirty = true
  }

  /** 记录频道当前布局到场景布局表(移动/缩放后由 Block3D 调用) */
  trackLayout(b: Block3D): void {
    this.layouts.set(b.channelId, b.normLayout())
  }

  /** 设备改名:重建名牌 Sprite(由 DeviceNode.applyTwin 委托) */
  renameDeviceSprite(dev: DeviceNode, name: string): void {
    dev.name = name.trim()
    this.scene.remove(dev.label)
    dev.label = this.makeLabel(`⚙ ${dev.name}`, dev.root.position.x, 60, dev.root.position.z)
    this.dirty = true
  }

  /** 设备换模型:按 modelRef 重挂 GLB 到 holder(由 DeviceNode.applyTwin 委托) */
  swapDeviceModelSprite(dev: DeviceNode, modelRef: string): void {
    const info = this.modelsById.get(modelRef)
    if (!info || !info.file || modelRef === dev.modelRef) return
    dev.modelRef = modelRef
    dev.holder.clear()
    void this.loadGltfToGroup(info.file, dev.holder, UNITS * 1.6)
    this.dirty = true
  }

  /** 统一实例化入口:按数据库元数据(布局/实体/设备孪生)实例化并初始化场景内全部实例 */
  hydrate(channels: TownEntityInput[], layouts: ChannelLayout[], devices: DeviceTwinSync[]): void {
    this.applySceneLayouts(layouts)
    this.rebuild(channels)
    this.syncDevices(devices)
    this.emit('blockCount', this.blocks.size)
    this.emit('agentCount', this.agents.size)
  }

  rebuild(channels: TownEntityInput[]): void {
    this.resetAll()
    this.buildBlocks(channels)
    this.emit('blockCount', this.blocks.size)
    this.emit('agentCount', this.agents.size)
  }

  focusChannel(channelId: string): void {
    const b = this.blocks.get(channelId)
    if (!b) return
    this.focusTo(b.x, b.z)
  }

  // ================================================================
  // 频道放置(drop 入口)+ 活动边界编辑
  // ================================================================

  /**
   * 频道拖入场景:在落点建领地 + 铺放其全部 Agent(钳在边界内)。
   * 频道 id 需已在实体基线中;返回落点世界坐标(供 HUD 提示)。
   */
  dropChannelOnWorld(x: number, z: number, channelId: string, channelName: string, agentCount: number): { x: number, z: number, channelId: string, name: string } {
    const existing = this.blocks.get(channelId)
    if (existing) {
      this.focusTo(existing.x, existing.z)
      return { x: Math.round(existing.x), z: Math.round(existing.z), channelId, name: existing.name }
    }
    // 缺省布局:以落点为中心、与 Agent 数匹配的边界
    const rx = Math.max(120, 110 + agentCount * 18)
    const rz = Math.max(80, 70 + agentCount * 14)
    const layout: ChannelLayout = { channelId, x, z, radiusX: rx, radiusZ: rz, shape: 'ellipse', rotationY: 0 }
    this.layouts.set(channelId, normLayout(layout))
    // 从实体基线取该频道 agents(由 TownView ensureChannelPresent 提前放置)
    const seed = this.entityIndex.get(channelId)
    if (seed) {
      this.placeChannel(seed, layout)
    }
    else {
      // 无实体基线(频道坞拖入,数据尚未到达):只建空领地占位
      const color = channelColorNum(channelId)
      const block = new Block3D({
        channelId, name: channelName, x, z,
        radiusX: layout.radiusX, radiusZ: layout.radiusZ,
        shape: layout.shape, rotationY: layout.rotationY, color,
        platform: this.makeBlock(channelName, color, layout),
        boundary: makeBoundary(layout.shape, layout.radiusX, layout.radiusZ, color),
        label: this.makeLabel(channelName, x, 30, z),
      })
      block.host = this
      block.boundary.position.set(x, 0.3, z)
      this.scene.add(block.boundary)
      this.blocks.set(channelId, block)
    }
    this.emit('blockCount', this.blocks.size)
    this.emit('agentCount', this.agents.size)
    return { x: Math.round(x), z: Math.round(z), channelId, name: channelName }
  }

  /** 更新频道布局(编辑边界后本地即时生效;持久化由 TownView 经 useSceneLayouts.save 落库) */
  updateChannelLayout(channelId: string, patch: Partial<ChannelLayout>): void {
    const b = this.blocks.get(channelId)
    if (!b) return
    if (patch.x !== undefined) b.x = patch.x
    if (patch.z !== undefined) b.z = patch.z
    if (patch.radiusX !== undefined) b.radiusX = Math.max(60, patch.radiusX)
    if (patch.radiusZ !== undefined) b.radiusZ = Math.max(40, patch.radiusZ)
    if (patch.shape !== undefined) b.shape = patch.shape
    if (patch.rotationY !== undefined) b.rotationY = patch.rotationY
    const layout = normLayout({ channelId, x: b.x, z: b.z, radiusX: b.radiusX, radiusZ: b.radiusZ, shape: b.shape, rotationY: b.rotationY })
    this.layouts.set(channelId, layout)
    // 重建领地平台/边界/名牌
    this.scene.remove(b.boundary)
    b.platform.scale.set(layout.radiusX / Math.max(layout.radiusX, layout.radiusZ), 1, layout.radiusZ / Math.max(layout.radiusX, layout.radiusZ))
    b.boundary = makeBoundary(layout.shape, layout.radiusX, layout.radiusZ, b.color)
    b.boundary.position.set(layout.x, 0.3, layout.z)
    b.boundary.rotation.y = layout.rotationY * Math.PI / 180
    this.scene.add(b.boundary)
    // 频道边界变化后把成员活动范围一并收进新边界(面板滑杆编辑路径)
    this.clampAgentsToBoundary(channelId)
    this.dirty = true
  }

  /** 移除频道放置(从场景撤走领地及其 Agent) */
  removeChannel(channelId: string): void {
    const b = this.blocks.get(channelId)
    if (!b) return
    this.scene.remove(b.platform)
    if (b.boundary) this.scene.remove(b.boundary)
    this.scene.remove(b.label)
    for (const [aid, a] of [...this.agents.entries()]) {
      if (a.channelId === channelId) {
        this.scene.remove(a.root)
        if (a.nameSprite) this.scene.remove(a.nameSprite)
        if (a.bubble) this.scene.remove(a.bubble)
        if (a.rangeLine) this.scene.remove(a.rangeLine)
        this.agents.delete(aid)
      }
    }
    if (this.rangeDrawAgent && this.agents.get(this.rangeDrawAgent) === undefined) this.cancelRangeDraw()
    this.blocks.delete(channelId)
    this.layouts.delete(channelId)
    this.receivers.delete(channelId)
    for (const hl of this.resizeHandles) hl.mesh.visible = false
    for (const hl of this.agentRangeHandles) hl.mesh.visible = false
    if (this.selectedChannel === channelId) {
      this.selectedChannel = null
      this.emit('selectChannel', null)
    }
    this.emit('blockCount', this.blocks.size)
    this.emit('agentCount', this.agents.size)
    this.dirty = true
  }

  // ================================================================
  // 频道整体拖拽 / 边界手柄缩放(编辑模式;用户自定义布局)
  // ================================================================

  /** 把频道地块整体平移(委托 Block3D.moveBy:平台/边界/名牌/成员落点与各自范围一并位移) */
  private applyBlockMove(b: Block3D, nx: number, nz: number): void {
    b.moveBy(nx - b.x, nz - b.z)
    this.refreshAgentRangeHandles()
    this.dirty = true
  }

  /** 按当前 Block 字段重建领地几何(平台刻度/边界线框/朝向),供缩放与移动共用 */
  private applyLayoutToBlock(b: Block3D): void {
    const layout = { channelId: b.channelId, x: b.x, z: b.z, radiusX: b.radiusX, radiusZ: b.radiusZ, shape: b.shape, rotationY: b.rotationY }
    this.layouts.set(b.channelId, normLayout(layout))
    b.platform.position.set(b.x, 0.16, b.z)
    b.platform.scale.set(b.radiusX / Math.max(b.radiusX, b.radiusZ), 1, b.radiusZ / Math.max(b.radiusX, b.radiusZ))
    if (b.boundary) this.scene.remove(b.boundary)
    b.boundary = makeBoundary(b.shape, b.radiusX, b.radiusZ, b.color)
    b.boundary.position.set(b.x, 0.3, b.z)
    b.boundary.rotation.y = b.rotationY * Math.PI / 180
    this.scene.add(b.boundary)
    this.dirty = true
  }

  /** 边界手柄本地坐标(椭圆:轴向四点;矩形:四角),按当前形状生成 */
  private boundaryHandlePoints(layout: { radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' }): Array<[number, number]> {
    if (layout.shape === 'rect') {
      const hx = layout.radiusX / 2
      const hz = layout.radiusZ / 2
      return [[hx, hz], [-hx, hz], [-hx, -hz], [hx, -hz]]
    }
    return [[layout.radiusX, 0], [-layout.radiusX, 0], [0, layout.radiusZ], [0, -layout.radiusZ]]
  }

  /** 刷新边界手柄位置/可见性(编辑模式选中频道时显示;其余隐藏) */
  private refreshChannelHandles(): void {
    for (const hl of this.resizeHandles) hl.mesh.visible = false
    if (this.mode !== 'edit' || !this.selectedChannel) return
    const b = this.blocks.get(this.selectedChannel)
    if (!b) return
    const rot = b.rotationY * Math.PI / 180
    const pts = this.boundaryHandlePoints(b)
    for (let i = 0; i < this.resizeHandles.length && i < pts.length; i++) {
      const [lx, lz] = pts[i]!
      const wx = b.x + lx * Math.cos(rot) - lz * Math.sin(rot)
      const wz = b.z + lx * Math.sin(rot) + lz * Math.cos(rot)
      this.resizeHandles[i]!.cid = b.channelId
      this.resizeHandles[i]!.mesh.position.set(wx, 1.4, wz)
      this.resizeHandles[i]!.mesh.visible = true
    }
  }

  /** 命中边界手柄(仅编辑模式;返回频道 id + 手柄号) */
  private pickResizeHandle(x: number, z: number): { cid: string, handle: number } | null {
    if (this.mode !== 'edit') return null
    for (const hl of this.resizeHandles) {
      if (!hl.mesh.visible) continue
      if (Math.hypot(hl.mesh.position.x - x, hl.mesh.position.z - z) < 46) return { cid: hl.cid, handle: hl.handle }
    }
    return null
  }

  /** 拖拽手柄 → 实时调整 radiusX/radiusZ(矩形:角点双轴;椭圆:对应轴向轴点) */
  private applyResize(b: Block3D, handle: number, wx: number, wz: number): void {
    const rad = -b.rotationY * Math.PI / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const dx = wx - b.x
    const dz = wz - b.z
    const lx = dx * cos - dz * sin
    const lz = dx * sin + dz * cos
    if (b.shape === 'rect') {
      // 四角:中心不动,拖拽角到中心距离 ×2 = 新半径
      b.radiusX = Math.max(60, Math.min(1000, Math.abs(lx) * 2))
      b.radiusZ = Math.max(40, Math.min(900, Math.abs(lz) * 2))
    }
    else {
      if (handle === 0 || handle === 1) b.radiusX = Math.max(60, Math.min(1000, Math.abs(lx)))
      else b.radiusZ = Math.max(40, Math.min(900, Math.abs(lz)))
    }
    this.applyLayoutToBlock(b)
    this.refreshChannelHandles()
    this.dirty = true
  }

  /** 缩放/移动结束后把该频道成员落点与活动范围钳回新边界内(委托 Block3D) */
  private clampAgentsToBoundary(channelId: string): void {
    const b = this.blocks.get(channelId)
    if (!b) return
    b.clampMembersAndRanges()
    this.dirty = true
  }

  /** 频道是否在场景内且被选中(供边界编辑面板) */
  getSelectedChannel(): string | null {
    return this.selectedChannel
  }

  /** 点选频道(供频道坞/边界编辑面板打开) */
  selectChannel(channelId: string | null): void {
    this.selectedChannel = channelId
    this.emit('selectChannel', channelId)
    this.refreshChannelHandles()
    this.cancelRangeDraw()
    this.refreshAgentRangeHandles()
    // 选中频道边界高亮勾边(取消时恢复频道本色)
    for (const bb of this.blocks.values()) {
      const m = bb.boundary.material as THREE.LineBasicMaterial
      m.color.setHex(bb.channelId === channelId ? 0xffd27f : bb.color)
      m.opacity = bb.channelId === channelId ? 1 : 0.75
    }
    // 拖拽中不聚焦(避免拖频道/手柄时相机被拽走导致落点错乱)
    if (channelId && !this.pointerDrag) this.focusTo(this.blocks.get(channelId)?.x ?? WORLD_CX, this.blocks.get(channelId)?.z ?? WORLD_CZ)
  }

  /** 当前场景内全部频道布局(供「保存全部布局」/E2E) */
  getAllChannelLayouts(): ChannelLayout[] {
    return [...this.blocks.values()].map(b => ({
      channelId: b.channelId, x: b.x, z: b.z,
      radiusX: b.radiusX, radiusZ: b.radiusZ,
      shape: b.shape, rotationY: b.rotationY,
    }))
  }

  handleTownEvent(e: AepEnvelope): void {
    if (e.type === 'channel.snapshot') return
    // 频道布局事件:本地已放同一频道则即时应用(他人编辑边界/移入场景 → 本端同步)
    if (e.type === 'scene.layout.saved') {
      const l = e.payload as ChannelLayout
      if (this.blocks.has(l.channelId)) {
        this.applySceneLayouts([...(this.layouts.values()), l])
        // 更新对应领地几何
        const cur = this.getChannelLayout(l.channelId)
        if (cur) this.updateChannelLayout(l.channelId, l)
      }
      return
    }
    if (e.type === 'scene.layout.removed') {
      const { channelId } = e.payload as { channelId: string }
      this.removeChannel(channelId)
      return
    }
    const intent = mapEnvelopeToIntent(e)
    if (!intent) return
    if (intent.agentId) {
      const asp = this.agents.get(intent.agentId)
      if (asp) {
        if (e.type === 'agent.status') {
          asp.state = (e.payload as { state: 'idle' | 'busy' | 'stopped' }).state
          if (asp.state !== 'busy') asp.progress = null
        }
        if (e.type === 'task.progress') asp.progress = (e.payload as { progress: number }).progress
        this.dirty = true
      }
    }
    if (intent.bubble) this.enqueueBubble(intent.bubble.channelId, intent.bubble.agentId, intent.bubble.kind, intent.bubble.text, intent.bubble.ttlMs)
    this.emitResonance(e)
    const action = parseActionFromEnvelope(e, { resolveTaskAssignee: this.resolveTaskAssignee ?? undefined })
    if (action) this.startBehavior(action)
  }

  // ================================================================
  // 行为 FSM(3D x/z 平面,复刻 2D 逻辑)
  // ================================================================

  private startBehavior(action: ActionContext): void {
    const from = this.agents.get(action.fromId)
    const to = this.agents.get(action.toId)
    if (!from || !to || from.dragging) return
    from.behavior.mode = 'approach'
    from.behavior.targetId = to.agentId
    from.behavior.action = action
    if (!to.dragging) {
      to.behavior.engaged = true
      to.behavior.roamTarget = null
    }
    this.emit('behavior', { agentName: from.name, action: this.behaviorActionLabel(action.kind), targetName: to.name })
  }

  private behaviorActionLabel(kind: ActionKind): string {
    return kind === 'task' ? '下发任务' : '回复'
  }

  /** 动画状态切换广播(数据驱动模型 → HUD/E2E 观察) */
  notifyMotion(asp: Agent3D): void {
    this.emit('motion', { agentName: asp.name, anim: asp.animState, at: Date.now() })
  }

  /** 送达交接:文本入接收器(FIFO 气泡)+ 行为事件广播(公众面供 Agent3D 调用) */
  deliverBehavior(asp: Agent3D, target: Agent3D): void {
    const text = asp.behavior.action?.text ?? ''
    // 送达文本挂在说话者头顶(经接收器 FIFO,与对话消息同节奏)
    if (text) this.enqueueBubble(asp.channelId, asp.agentId, 'info', text, 2600)
    this.emit('behavior', { agentName: asp.name, action: this.behaviorActionLabel(asp.behavior.action?.kind ?? 'message'), targetName: target.name })
  }

  /** 解除对方 engaged(交接/等待结束) */
  releaseEngaged(asp: Agent3D): void {
    const target = asp.behavior.targetId ? this.agents.get(asp.behavior.targetId) : undefined
    if (target) target.behavior.engaged = false
  }

  /** 按 agentId 取场景内 Agent3D 实例(实体间互访服务) */
  getAgent(agentId: string): Agent3D | undefined {
    return this.agents.get(agentId)
  }

  /** 频道当前布局(实体钳制服务;未放置返回 null) */
  blockLayoutOf(channelId: string): ChannelLayout | null {
    return this.blockLayout(channelId)
  }

  private resolveFile(id: string): string {
    return this.modelsById.get(id)?.file ?? ''
  }

  /** 相机注视目标(供频道坞首放落点/聚焦) */
  getCameraTarget(): { x: number, z: number } {
    return { x: Math.round(this.camTarget.x), z: Math.round(this.camTarget.z) }
  }

  /** 为指定角色换装模型(选择器绑定;要求实体已在场景,否则仅记录) */
  swapAgentModel(agentId: string, modelRef: string): void {
    const asp = this.agents.get(agentId)
    if (!asp) return
    const info = this.modelsById.get(modelRef)
    const file = info?.file ?? '/assets/game/character/hero-3d.glb'
    asp.modelRef = modelRef
    asp.textureKey = modelRef
    void this.mountModel(asp, file, info?.name ?? modelRef)
  }

  // ================================================================
  // 事件共鸣(说话/完成/错误/旗) —— 3D 圆环/光柱
  // ================================================================

  private emitResonance(e: AepEnvelope): void {
    const b = this.blocks.get(e.channelId)
    const asp = e.agentId ? this.agents.get(e.agentId) : undefined
    const x = asp?.root.position.x ?? b?.x
    const z = asp?.root.position.z ?? b?.z
    if (x === undefined || z === undefined) return
    if (e.type === 'agent.message' || e.type === 'agent.status.message' || e.type === 'a2a.message') {
      this.pulseRing(x, z, asp ? 0x9fe8d4 : (b?.color ?? 0xffffff))
    }
    else if (e.type === 'error' || (e.type === 'task.status' && ((e.payload as { state?: string }).state === 'failed' || (e.payload as { state?: string }).state === 'canceled'))) {
      this.pulseRing(x, z, 0xff6b6b)
    }
    else if (e.type === 'task.status' && (e.payload as { state?: string }).state === 'completed') {
      this.lightColumn(x, z, 0xd8fff2)
    }
  }

  private pulseRing(x: number, z: number, color: number): void {
    const ring = new THREE.Mesh(new THREE.RingGeometry(10, 22, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }))
    ring.rotation.x = -Math.PI / 2
    ring.position.set(x, 0.4, z)
    this.scene.add(ring)
    let s = 1
    const step = () => {
      s += 0.05
      ring.scale.setScalar(s)
      ;(ring.material as THREE.MeshBasicMaterial).opacity -= 0.03
      if ((ring.material as THREE.MeshBasicMaterial).opacity <= 0) {
        this.scene.remove(ring)
        return
      }
      this.rafAnims.push(step)
    }
    this.rafAnims.push(step)
  }

  private lightColumn(x: number, z: number, color: number): void {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(6, 12, 0, 16), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }))
    beam.position.set(x, 60, z)
    beam.scale.y = 0.01
    this.scene.add(beam)
    let h = 0.01
    const step = () => {
      h += 2
      beam.scale.y = h / 60
      ;(beam.material as THREE.MeshBasicMaterial).opacity -= 0.02
      if ((beam.material as THREE.MeshBasicMaterial).opacity <= 0) {
        this.scene.remove(beam)
        return
      }
      this.rafAnims.push(step)
    }
    this.rafAnims.push(step)
  }

  private rafAnims: Array<() => void> = []

  /** 频道领地布局(channelId → 放置);由 applySceneLayouts 注入,驱动 buildBlocks/边界约束 */
  private layouts = new Map<string, ChannelLayout>()
  /** 频道实体基线(channelId → seed;供 dropChannelOnWorld 即时铺放) */
  private entityIndex = new Map<string, TownEntityInput>()
  /** 当前选中频道(供边界编辑面板) */
  private selectedChannel: string | null = null

  // ================================================================
  // 信息接收器 + 聊天气泡(每个实例化 Channel 一个接收器:FIFO 逐条消费,
  // WS 实时信息经 townBus → handleTownEvent 入队,渲染到对应 Agent 头顶,像真实对话)
  // ================================================================

  /** 实时信息(讲话/交付/错误)入队到目标频道的信息接收器;系统指标即时更新,3D 展示按 FIFO 消费 */
  private enqueueBubble(channelId: string, agentId: string | undefined, kind: TownBubbleKind, text: string, ttlMs: number): void {
    // 事件流 / 最近活动 / 调试气泡即时更新(展示延迟只作用于 3D 气泡)
    this.dbgBubbles.push({ text, at: Date.now() })
    const speaker = agentId ? this.agents.get(agentId)?.name : undefined
    this.lastActivity = { channelId, agentName: speaker ?? this.blocks.get(channelId)?.name ?? '系统', text }
    this.recentActivity.push(this.lastActivity)
    if (this.recentActivity.length > 6) this.recentActivity.splice(0, this.recentActivity.length - 6)
    this.emit('lastActivity', this.lastActivity)
    // 入队(FIFO;超长队列丢最旧,防止异常风暴撑爆内存)
    let rec = this.receivers.get(channelId)
    if (!rec) {
      rec = { channelId, queue: [], current: null, currentUntil: 0 }
      this.receivers.set(channelId, rec)
    }
    if (rec.queue.length >= 24) rec.queue.splice(0, rec.queue.length - 24)
    rec.queue.push({ agentId: agentId ?? null, kind, text, ttlMs })
    this.dirty = true
  }

  /** 各频道接收器 FIFO 消费:当前条目展示期满 → 清理其气泡并取下一条实时渲染(渲染循环每帧调用) */
  private drainReceivers(now: number): void {
    for (const rec of this.receivers.values()) {
      if (rec.current) {
        if (now < rec.currentUntil) continue
        this.clearReceiverBubble(rec.channelId, rec.current)
        rec.current = null
      }
      const msg = rec.queue.shift()
      if (!msg) continue
      rec.current = msg
      rec.currentUntil = now + bubbleDisplayMs(msg.text)
      this.renderReceiverBubble(rec.channelId, msg)
    }
  }

  /** 清除接收器条目对应的场景气泡(不同说话人衔接时避免叠泡) */
  private clearReceiverBubble(channelId: string, msg: BubbleMsg): void {
    if (!msg.agentId) return
    const asp = this.agents.get(msg.agentId)
    if (asp?.bubble) {
      this.scene.remove(asp.bubble)
      asp.bubble = null
      asp.bubbleText = null
      if (asp.bubbleTimer) {
        clearTimeout(asp.bubbleTimer)
        asp.bubbleTimer = null
      }
    }
  }

  /** 将接收器消息渲染为 2.5D 聊天气泡(说话 Agent 头顶;无对应用户则挂频道名牌上方) */
  private renderReceiverBubble(channelId: string, msg: BubbleMsg): void {
    const asp = msg.agentId ? this.agents.get(msg.agentId) : undefined
    const b = this.blocks.get(channelId)
    // 频道未放置且无对应用户 → 暂不渲染(队列保留,放置/用户出现后补显)
    if (!asp && !b) return
    const name = asp?.name ?? b?.name ?? '系统'
    const accent = asp
      ? (asp.aura.material as THREE.MeshBasicMaterial).color.getHex()
      : (b?.color ?? 0x9fe8d4)
    const text = (msg.kind === 'artifact' && !msg.text.startsWith('📦') ? `📦 ${msg.text}` : msg.text) || '…'
    const sprite = this.makeChatBubble(text, name, accent, msg.kind)
    const x = asp?.root.position.x ?? b!.x
    const z = asp?.root.position.z ?? b!.z
    sprite.position.set(x, asp ? BUBBLE_Y + Math.max(0, asp.model.scale.y - 1) * 22 : 56, z)
    this.scene.add(sprite)
    if (!asp) {
      // 频道级(系统)气泡:展示期满自行移除
      window.setTimeout(() => {
        this.scene.remove(sprite)
      }, bubbleDisplayMs(msg.text) + 500)
      return
    }
    if (asp.bubble) {
      this.scene.remove(asp.bubble)
      asp.bubbleText = null
    }
    asp.bubble = sprite
    asp.bubbleText = text
    this.popInSprite(sprite)
    this.dirty = true
  }

  /** 2.5D 聊天气泡:圆角矩形 + 向下尾角 + 身份色名牌头 + 多行换行文本 + 投影描边 */
  private makeChatBubble(text: string, name: string, accent: number, kind: TownBubbleKind): THREE.Sprite {
    const accentHex = `#${accent.toString(16).padStart(6, '0')}`
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    const bodyFont = '14px Geist, "PingFang SC", sans-serif'
    const headFont = 'bold 11px Geist, "PingFang SC", sans-serif'
    const maxTextW = 268
    const padX = 14
    const padY = 9
    const nameH = 21
    const lineH = 19
    const tailH = 11
    ctx.font = bodyFont
    const lines = this.wrapBubbleLines(ctx, text.replace(/\s+/g, ' ').trim() || '…', maxTextW, 3)
    const textW = Math.max(...lines.map(l => ctx.measureText(l).width))
    const bw = Math.min(360, Math.max(100, Math.ceil(textW) + padX * 2))
    const bodyH = nameH + lines.length * lineH + padY * 2
    const bh = bodyH + tailH
    canvas.width = bw
    canvas.height = bh
    ctx.clearRect(0, 0, bw, bh)
    // 圆角矩形 + 底部中央尾角(指向说话人)
    const r = 10
    const cx = bw / 2
    const t = Math.min(24, bw * 0.32)
    const path = () => {
      ctx.beginPath()
      ctx.moveTo(r, 0)
      ctx.lineTo(bw - r, 0)
      ctx.quadraticCurveTo(bw, 0, bw, r)
      ctx.lineTo(bw, bodyH - r)
      ctx.quadraticCurveTo(bw, bodyH, bw - r, bodyH)
      ctx.lineTo(cx + t / 2, bodyH)
      ctx.lineTo(cx, bodyH + tailH)
      ctx.lineTo(cx - t / 2, bodyH)
      ctx.lineTo(r, bodyH)
      ctx.quadraticCurveTo(0, bodyH, 0, bodyH - r)
      ctx.lineTo(0, r)
      ctx.quadraticCurveTo(0, 0, r, 0)
      ctx.closePath()
    }
    // 柔和投影 → 底色
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = 12
    ctx.shadowOffsetY = 4
    path()
    ctx.fillStyle = 'rgba(15,17,28,0.92)'
    ctx.fill()
    ctx.restore()
    // 身份色描边
    path()
    ctx.lineWidth = 1.6
    ctx.strokeStyle = `${accentHex}cc`
    ctx.stroke()
    // 名牌头:身份色名字 + 细分隔线
    ctx.font = headFont
    ctx.fillStyle = accentHex
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(name, padX, padY + 10)
    ctx.globalAlpha = 0.32
    ctx.fillStyle = '#fff'
    ctx.fillRect(padX, padY + 18, bw - padX * 2, 1)
    ctx.globalAlpha = 1
    // 正文(错误微红)
    ctx.font = bodyFont
    ctx.fillStyle = kind === 'error' ? '#ff9d9d' : '#eef2fb'
    lines.forEach((l, i) => ctx.fillText(l, padX, padY + nameH + 10 + i * lineH))
    // Sprite(纹理按 1/3.2 缩放到世界单位)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }))
    const k = 3.2
    sprite.scale.set(bw / k, bh / k, 1)
    return sprite
  }

  /** 气泡弹入动画:0.62 → 1.0 缓出(180ms,2.5D 手感) */
  private popInSprite(sprite: THREE.Sprite): void {
    const tx = sprite.scale.x
    const ty = sprite.scale.y
    sprite.scale.set(tx * 0.62, ty * 0.62, 1)
    const start = performance.now()
    const dur = 180
    const step = () => {
      if (this.disposed) return
      const t = Math.min(1, (performance.now() - start) / dur)
      const s = 0.62 + 0.38 * (1 - Math.pow(1 - t, 3))
      sprite.scale.set(tx * s, ty * s, 1)
      if (t < 1) this.rafAnims.push(step)
    }
    this.rafAnims.push(step)
  }

  /** 按宽度逐字符换行(兼容中英混排);超 maxLines 行末加省略号 */
  private wrapBubbleLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
    const lines: string[] = []
    let line = ''
    for (const ch of text) {
      if (ctx.measureText(line + ch).width > maxW && line) {
        lines.push(line)
        line = ch
        if (lines.length >= maxLines) {
          lines[maxLines - 1] = `${lines[maxLines - 1] ?? ''}…`
          return lines
        }
      }
      else {
        line += ch
      }
    }
    if (line) lines.push(line)
    if (lines.length === 0) lines.push('…')
    return lines
  }

  // ================================================================
  // 相机 / 交互(拖拽平移、滚轮缩放、点选聚焦) —— 供 TownView 调用
  // ================================================================

  /** 暴露 canvas 供 TownView 绑定 pointer 事件 */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  /** 页面坐标 → 世界 xz(经 canvas rect + 相机射线打在 y=0 平面) */
  screenToWorld(clientX: number, clientY: number): { x: number, z: number } {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const pt = new THREE.Vector3()
    raycaster.ray.intersectPlane(plane, pt)
    return pt ? { x: pt.x, z: pt.z } : { x: this.camera.position.x, z: this.camera.position.z }
  }

  /** 平移相机(拖拽):移动 camTarget(相机位置由 loop 据 target+dolly 推导) */
  panBy(dxWorld: number, dzWorld: number): void {
    this.camTarget.x -= dxWorld
    this.camTarget.z -= dzWorld
  }

  /** 滚轮缩放(改变 dolly 距离) */
  zoomBy(f: number): void {
    this.dolly = Math.min(2.2, Math.max(0.55, this.dolly + f))
  }

  /** 缓动聚焦某世界点(移动 camTarget) */
  /** 缓动聚焦某世界点(移动 camTarget) */
  focusTo(x: number, z: number): void {
    this.tweenCamTo(x, z)
  }

  private tweenCamTo(x: number, z: number): void {
    const start = performance.now()
    const sx = this.camTarget.x
    const sz = this.camTarget.z
    const dur = 600
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / dur)
      const e = 1 - Math.pow(1 - t, 3)
      this.camTarget.x = sx + (x - sx) * e
      this.camTarget.z = sz + (z - sz) * e
      if (t < 1) this.rafAnims.push(step)
    }
    this.rafAnims.push(step)
  }

  // ================================================================
  // 拖拽换装 / 生成居民(drop 入口)
  // ================================================================

  dropModelOnWorld(x: number, z: number, assetId: string): { mode: 'rebind' | 'spawn', agentId?: string, textureKey: string, x: number, y: number } {
    const near = this.nearestAgent(x, z, 80)
    const model = this.modelsById.get(assetId)
    const texKey = model?.id ?? assetId
    // 数字孪生实体模型(kind=dev):拖入场景生成"设备节点" + 绑定 device twin
    if (model?.kind === 'dev') {
      const twinId = this.spawnDeviceNode(x, z, texKey, model.file, model.name)
      return { mode: 'spawn', agentId: twinId, textureKey: texKey, x: Math.round(x), y: Math.round(z) }
    }
    if (near) {
      this.swapTexture(near, texKey)
      this.enqueueBubble(near.channelId, near.agentId, 'info', `换装 → ${model?.name ?? assetId}`, 2200)
      return { mode: 'rebind', agentId: near.agentId, textureKey: texKey, x: Math.round(near.root.position.x), y: Math.round(near.root.position.z) }
    }
    // 落点生成居民
    const info = model ?? { id: assetId, file: '', name: assetId }
    this.spawnResident(x, z, texKey, info.name)
    return { mode: 'spawn', textureKey: texKey, x: Math.round(x), y: Math.round(z) }
  }

  private nearestAgent(x: number, z: number, maxDist: number): Agent3D | undefined {
    let best: Agent3D | undefined
    let bestD = maxDist
    for (const a of this.agents.values()) {
      const d = Math.hypot(a.root.position.x - x, a.root.position.z - z)
      if (d < bestD) {
        best = a
        bestD = d
      }
    }
    return best
  }

  private swapTexture(asp: Agent3D, texKey: string): void {
    const info = this.modelsById.get(texKey)
    const file = info?.file ?? this.resolveFile(texKey) ?? '/assets/game/character/hero-3d.glb'
    asp.modelRef = texKey
    asp.textureKey = texKey
    void this.mountModel(asp, file, info?.name ?? texKey)
  }

  private spawnResident(x: number, z: number, texKey: string, name: string): void {
    const root = new THREE.Group()
    root.position.set(x, GROUND_Y, z)
    const aura = new THREE.Mesh(new THREE.RingGeometry(10, 16, 24), new THREE.MeshBasicMaterial({ color: 0xffe9c4, transparent: true, opacity: 0.6, side: THREE.DoubleSide }))
    aura.rotation.x = -Math.PI / 2
    aura.position.y = 0.22
    root.add(aura)
    const model = new THREE.Group()
    root.add(model)
    const nameSprite = this.makeLabel(name, x, 48, z)
    this.scene.add(root)
    const resident = new Agent3D({
      channelId: '', agentId: `resident-${Date.now().toString(36)}`, name,
      role: 'worker', root, model, mixer: null, clips: [], aura, nameSprite,
      bubble: null, bubbleText: null, bubbleTimer: null, state: 'idle', progress: null,
      dragging: false, homeX: x, homeZ: z, range: null, rangeLine: null, textureKey: texKey, modelRef: texKey,
      behavior: { mode: 'idle', roamTarget: null, targetId: null, waitUntil: 0, pauseUntil: 0, engaged: false },
    })
    resident.host = this
    this.agents.set(resident.agentId, resident)
    const info = this.modelsById.get(texKey)
    void this.mountModel(resident, info?.file ?? '/assets/game/character/hero-3d.glb', info?.name ?? name)
  }

  /**
   * 数字孪生设备节点:拖 dev 模型进场景生成。
   * - 3D:挂 device GLB + 设备名牌 + 状态环(telemetry 驱动颜色);
   * - 数据:经 devices.create 落一个 device twin,与 modelRef 绑定;
   * - state 驱动:alarm→红环,running→青环,offline→灰环,idle→亮环。
   */
  private spawnDeviceNode(x: number, z: number, texKey: string, file: string, name: string): string {
    const twinId = `dev-${Date.now().toString(36)}`
    const root = new THREE.Group()
    root.position.set(x, GROUND_Y, z)
    // 设备底座光环(状态环)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(20, 26, 32),
      new THREE.MeshBasicMaterial({ color: 0x8fe8d4, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.3
    root.add(ring)
    // 设备模型
    const holder = new THREE.Group()
    root.add(holder)
    const label = this.makeLabel(`⚙ ${name}`, x, 60, z)
    this.scene.add(root)
    // 绑定 device twin(携带落点与缩放 → 刷新/他人客户端即可恢复与同步)
    const twin = new DeviceNode({ twinId, name, modelRef: texKey, root, holder, ring, label, state: 'idle', telemetry: {} })
    twin.host = this
    this.deviceNodes.set(twinId, twin)
    // 客制化:注册设备可缩放目标(twinId 为临时 id;REST 返回真实 id 后更新 key)
    this.registerScalable('device', twinId, holder)
    // 加载模型(GLB)
    void this.loadGltfToGroup(file, holder, UNITS * 1.6)
    // 创建设备(异步;失败则仅本地节点)
    const st = this.scalables.get(`device:${twinId}`)
    void this.devices?.create({
      name, modelRef: texKey, kind: 'device', controls: ['power_on', 'power_off', 'set_speed'],
      posX: Math.round(x * 10) / 10,
      posZ: Math.round(z * 10) / 10,
      scale: st ? Math.round(st.userScale * 100) / 100 : 1,
    })
      .then((d) => {
        if (this.disposed) return
        twin.twinId = d.id
        // 把可缩放目标从临时 id 迁移到真实 id(保留缩放%)
        const saved = this.scalables.get(`device:${twinId}`)
        this.scalables.delete(`device:${twinId}`)
        if (saved) this.scalables.set(`device:${d.id}`, saved)
        // 若选中临时节点,迁移选中到真实 id
        if (this.selected?.kind === 'device' && this.selected.id === twinId) {
          this.selected = { kind: 'device', id: d.id }
        }
      })
      .catch(() => {})
    return twinId
  }

  /** 将 GLB 加载进 Group(按高度归一化 scale) */
  private async loadGltfToGroup(file: string, group: THREE.Group, targetH: number): Promise<void> {
    try {
      const gltf = await this.loadGltf(file)
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const h = Math.max(0.5, box.max.y - box.min.y)
      const scale = targetH / h
      gltf.scene.scale.setScalar(scale)
      gltf.scene.position.y = 0
      group.add(gltf.scene)
    }
    catch {
      // 加载失败:空 Group,静默(节点仍存在,只是无网格)
    }
  }

  // ================================================================
  // 调试 / HUD 数据
  // ================================================================

  getDebugState(): {
    blocks: number
    agents: Array<{ agentId: string, name: string, role: string, channelId: string, state: string, progress: number | null, x: number, y: number, visible: boolean, draggable: boolean, auraColor: number, behavior: string, targetId: string | null, homeX: number, homeY: number, textureKey: string, modelRef: string, decorated: boolean, range: { x: number, z: number, radiusX: number, radiusZ: number, shape: string } | null, bubbleText: string | null, anim: string }>
    bubbles: Array<{ text: string, at: number }>
    activity: { channelId: string, agentName: string, text: string } | null
    player: { x: number, y: number }
  } {
    return {
      blocks: this.blocks.size,
      agents: [...this.agents.values()].map(a => ({
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        channelId: a.channelId,
        state: a.state,
        progress: a.progress,
        x: Math.round(a.root.position.x),
        y: Math.round(a.root.position.z),
        visible: true,
        draggable: true,
        auraColor: (a.aura.material as THREE.MeshBasicMaterial).color.getHex() ?? 0,
        behavior: a.behavior.mode,
        targetId: a.behavior.targetId,
        homeX: Math.round(a.homeX),
        homeY: Math.round(a.homeZ),
        textureKey: a.textureKey,
        modelRef: a.modelRef,
        decorated: !a.channelId,
        range: a.range
          ? { x: Math.round(a.range.x), z: Math.round(a.range.z), radiusX: Math.round(a.range.radiusX), radiusZ: Math.round(a.range.radiusZ), shape: a.range.shape }
          : null,
        bubbleText: a.bubbleText,
        anim: a.animState,
      })),
      bubbles: this.dbgBubbles.slice(-8),
      activity: this.lastActivity,
      player: { x: Math.round(this.camera.position.x), y: Math.round(this.camera.position.z) },
    }
  }

  getMinimapState(): {
    world: { w: number, h: number }
    blocks: Array<{ x: number, y: number, color: number, name: string }>
    agents: Array<{ x: number, y: number, color: number, busy: boolean }>
    player: { x: number, y: number }
  } {
    return {
      world: { w: WORLD_W, h: WORLD_H },
      blocks: [...this.blocks.values()].map(b => ({ x: b.x / WORLD_W, y: b.z / WORLD_H, color: b.color, name: b.name })),
      agents: [...this.agents.values()].map(a => ({ x: a.root.position.x / WORLD_W, y: a.root.position.z / WORLD_H, color: (a.aura.material as THREE.MeshBasicMaterial).color.getHex() ?? 0, busy: a.state === 'busy' })),
      player: { x: this.camera.position.x / WORLD_W, y: this.camera.position.z / WORLD_H },
    }
  }

  getRecentActivity(): Array<{ channelId: string, agentName: string, text: string }> {
    return [...this.recentActivity]
  }

  /** 更新设备节点状态/遥测(由 useDeviceTwins 轮询或控制反馈驱动;数据驱动渲染状态环) */
  updateDeviceNode(twinId: string, state: DeviceNode['state'], telemetry?: Record<string, number | string | boolean>): void {
    const dev = this.deviceNodes.get(twinId)
    if (!dev) return
    if (state) {
      dev.state = state
      dev.updateRing()
    }
    if (telemetry) dev.telemetry = { ...dev.telemetry, ...telemetry }
    this.dirty = true
  }

  /** 设备改名(重建名牌 Sprite + 落库由 TownView 走 devices.update) */
  renameDevice(id: string, name: string): void {
    const dev = this.deviceNodes.get(id)
    if (!dev || !name.trim() || name.trim() === dev.name) return
    this.renameDeviceSprite(dev, name)
  }

  /** 设备换模型(按 modelRef 重挂 GLB 到 holder;持久化由 TownView 走 devices.update) */
  swapDeviceModel(id: string, modelRef: string): void {
    const dev = this.deviceNodes.get(id)
    if (!dev) return
    this.swapDeviceModelSprite(dev, modelRef)
  }

  /** 设备当前名称(供属性面板初始化) */
  getDeviceName(id: string): string {
    return this.deviceNodes.get(id)?.name ?? ''
  }

  /** 设备当前绑定模型 id(供模型下拉高亮) */
  getDeviceModelRef(id: string): string {
    return this.deviceNodes.get(id)?.modelRef ?? ''
  }

  /** 删除设备实例:落库删除 + 移除场景节点(由 TownView 触发;失败仅移除本地节点) */
  async removeDevice(id: string): Promise<void> {
    const dev = this.deviceNodes.get(id)
    if (!dev) return
    try {
      await this.devices?.remove?.(id)
    }
    catch { /* 服务端失败仍移除本地节点(尽力同步) */ }
    this.removeDeviceNode(id)
  }

  /** 设备节点列表(供 HUD/E2E) */
  getDeviceNodes(): Array<{ twinId: string, name: string, x: number, z: number, state: string, telemetry: Record<string, number | string | boolean> }> {
    return [...this.deviceNodes.values()].map(d => ({
      twinId: d.twinId,
      name: d.name,
      x: Math.round(d.root.position.x),
      z: Math.round(d.root.position.z),
      state: d.state,
      telemetry: d.telemetry,
    }))
  }

  /** 动作绑定:为某 Agent 指定动画 clip(按名称 idle/walk/work 或索引)。供 AssetLibrary 选择动作后调用。 */
  setAnimPref(agentId: string, clipName: string): void {
    const asp = this.agents.get(agentId)
    if (!asp || asp.clips.length === 0 || !asp.mixer) return
    // 解析:优先名称匹配,否则 idle→0/walk→1/work→末帧
    let idx = asp.clips.findIndex(c => c.name.toLowerCase().includes(clipName.toLowerCase()))
    if (idx < 0) idx = clipName === 'work' ? asp.clips.length - 1 : clipName === 'walk' ? Math.min(1, asp.clips.length - 1) : 0
    const clip = asp.clips[idx]
    if (!clip) return
    asp.mixer.stopAllAction()
    asp.mixer.clipAction(clip).reset().play()
  }

  /** 角色当前绑定模型 id(供模型选择器高亮) */
  getAgentModel(agentId: string): string | null {
    const asp = this.agents.get(agentId)
    return asp?.modelRef ?? null
  }

  /** 角色名字(供模型选择器标题) */
  getAgentName(agentId: string): string {
    return this.agents.get(agentId)?.name ?? agentId.slice(0, 8)
  }

  /** 角色动画 clip 名列表(供 UI 展示可绑定动作;无则空) */
  getAgentClips(agentId: string): Array<{ name: string, duration: number }> {
    const asp = this.agents.get(agentId)
    if (!asp) return []
    return asp.clips.map(c => ({ name: c.name, duration: Math.round(c.duration * 10) / 10 }))
  }

  // ================================================================
  // 选中 + 缩放(客制化:场景内点选 Agent/设备 → 弹滑杆调大小)
  // ================================================================

  /** 以世界坐标 hit 一个 Agent 或设备节点(近似距离阈值;供点击选中) */
  private pickAt(x: number, z: number): { kind: 'agent' | 'device', id: string } | null {
    let best: { kind: 'agent' | 'device', id: string, d: number } | null = null
    for (const a of this.agents.values()) {
      const d = Math.hypot(a.root.position.x - x, a.root.position.z - z)
      if (d < 90 && (!best || d < best.d)) best = { kind: 'agent', id: a.agentId, d }
    }
    for (const dev of this.deviceNodes.values()) {
      const d = Math.hypot(dev.root.position.x - x, dev.root.position.z - z)
      if (d < 90 && (!best || d < best.d)) best = { kind: 'device', id: dev.twinId, d }
    }
    return best ? { kind: best.kind, id: best.id } : null
  }

  /** 点选频道:返回包含该点的频道 id(边界内;供编辑模式打开边界编辑面板) */
  private pickChannel(x: number, z: number): string | null {
    for (const b of this.blocks.values()) {
      const layout: ChannelLayout = {
        channelId: b.channelId, x: b.x, z: b.z,
        radiusX: b.radiusX, radiusZ: b.radiusZ,
        shape: b.shape, rotationY: b.rotationY,
      }
      if (pointInBoundary(layout, x, z)) return b.channelId
    }
    return null
  }

  /** 设置选中(点击后由 Vue 弹缩放/旋转滑杆) */
  private setSelected(sel: { kind: 'agent' | 'device', id: string } | null): void {
    // 选中切换/取消 → 退出框选绘制(清理预览)
    if (!sel || sel.kind !== 'agent' || sel.id !== this.rangeDrawAgent) this.cancelRangeDraw()
    this.selected = sel
    this.refreshAgentRangeLines()
    this.refreshAgentRangeHandles()
    if (!sel) {
      this.showSelectionRing(null)
      this.emit('select', null)
      return
    }
    const st = this.scalables.get(`${sel.kind}:${sel.id}`)
    if (st) {
      this.emit('select', {
        kind: sel.kind,
        id: sel.id,
        scale: st.userScale,
        rotation: Math.round(this.getModelRotation(sel.id, sel.kind) * 10) / 10,
      })
    }
  }

  /** 场景内缩放:为 Agent(id)或设备(id)设定用户缩放倍率(0.2~5;1=默认归一化) */
  setModelScale(id: string, scale: number, kind?: 'agent' | 'device'): void {
    const k = kind ?? (this.scalables.has(`device:${id}`) ? 'device' : 'agent')
    const key = `${k}:${id}`
    const st = this.scalables.get(key)
    if (!st) return
    st.userScale = scale
    // 施加于模型 holder(相对已归一化的默认尺寸)
    st.holder.scale.setScalar(st.userScale)
    this.dirty = true
  }

  /** 当前选中对象(供 Vue/滑杆初始化) */
  getSelectedScale(): { kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null {
    if (!this.selected) return null
    const st = this.scalables.get(`${this.selected.kind}:${this.selected.id}`)
    if (!st) return null
    return {
      kind: this.selected.kind,
      id: this.selected.id,
      scale: st.userScale,
      rotation: Math.round(this.getModelRotation(this.selected.id, this.selected.kind) * 10) / 10,
    }
  }

  /** 组装可缩放目标并恢复初始化缩放(initialScale 优先=服务端持久化;否则 localStorage) */
  private registerScalable(kind: 'agent' | 'device', id: string, holder: THREE.Group, initialScale?: number): void {
    const saved = initialScale !== undefined
      ? initialScale
      : (typeof localStorage !== 'undefined' ? Number(localStorage.getItem(`town.scale.${kind}:${id}`) ?? 1) : 1)
    const userScale = Number.isFinite(saved) && saved > 0 ? saved : 1
    this.scalables.set(`${kind}:${id}`, { kind, id, userScale, holder })
    holder.scale.setScalar(userScale)
  }

  /** 持久化指定对象的缩放(滑杆松手时调用;设备同时落库,角色仅本地) */
  persistScale(kind: 'agent' | 'device', id: string): void {
    const st = this.scalables.get(`${kind}:${id}`)
    if (!st || typeof localStorage === 'undefined') return
    localStorage.setItem(`town.scale.${kind}:${id}`, String(st.userScale))
    if (kind === 'device') this.persistDeviceTransform(id)
  }

  // ================================================================
  // 编辑/浏览模式 + 场景对象拖拽(设备↔地面,角色↔落点)
  // ================================================================

  /** 模式切换:浏览(只读:相机+点选) / 编辑(可拖拽设备/调整角色落点/旋转/频道整体移动/边界手柄/Agent 活动范围) */
  setMode(mode: TownScene3DMode): void {
    if (this.mode === mode) return
    this.mode = mode
    if (mode === 'browse') {
      if (this.pointerDrag) this.endPointerDrag()
      this.cancelRangeDraw()
      this.setSelected(null)
      this.refreshChannelHandles()
    }
    else if (this.selected) {
      this.showSelectionRing(this.selected)
    }
    this.refreshChannelHandles()
    this.refreshAgentRangeHandles()
    // 编辑模式范围线框可见性(range 线框在编辑模式全部显示,浏览模式仅选中显示)
    for (const a of this.agents.values()) a.renderRangeLine()
    this.dirty = true
  }

  getMode(): TownScene3DMode {
    return this.mode
  }

  /** 网格吸附开关(编辑拖拽落点;默认开) */
  setSnap(enabled: boolean): void {
    this.snapEnabled = enabled
  }

  getSnap(): boolean {
    return this.snapEnabled
  }

  /**
   * 尝试开始场景拖拽(编辑模式;指针按下命中设备/角色 → 占用该手势)。
   * 返回 true 表示场景已接管指针(调用方应跳过相机平移)。
   */
  tryStartPointerDrag(clientX: number, clientY: number): boolean {
    if (this.mode !== 'edit') return false
    const w = this.screenToWorld(clientX, clientY)
    // 1) Agent 活动范围手柄(编辑模式选中带范围角色时 → 拖拽调整该 Agent 范围大小)
    const ar = this.pickAgentRangeHandle(w.x, w.z)
    if (ar) {
      this.pointerDrag = { kind: 'agentRangeResize', id: ar.agentId, handle: ar.handle }
      this.emitSaveState('dirty')
      return true
    }
    // 2) 边界缩放手柄(编辑模式选中频道的 4 个手柄 → 调整频道范围大小)
    const h = this.pickResizeHandle(w.x, w.z)
    if (h) {
      this.pointerDrag = { kind: 'resize', id: h.cid, handle: h.handle }
      this.setSelected(null)
      this.emitSaveState('dirty')
      return true
    }
    // 3) 框选绘制:rangeDraw 模式激活 → 以按下点为框角拉动(优先于点选,便于从角色身上起手)
    if (this.rangeDrawAgent) {
      this.pointerDrag = { kind: 'rangeDraw', id: this.rangeDrawAgent, x0: w.x, z0: w.z }
      this.rangeDrawPreviewState = null
      return true
    }
    // 4) 设备 / 角色
    const hit = this.pickAt(w.x, w.z)
    if (hit) {
      if (hit.kind === 'device') {
        if (!this.deviceNodes.has(hit.id)) return false
        this.pointerDrag = hit
        this.setSelected(hit)
        this.showSelectionRing(hit)
        this.emitSaveState('dirty')
        return true
      }
      // 角色:仅频道角色可调整落点(装饰居民不持久化、不可布局)
      const asp = this.agents.get(hit.id)
      if (!asp || !asp.channelId) return false
      if (asp.bubbleTimer) {
        clearTimeout(asp.bubbleTimer)
        asp.bubbleTimer = null
      }
      asp.dragging = true
      asp.behavior.mode = 'idle'
      asp.behavior.targetId = null
      this.pointerDrag = hit
      this.setSelected(hit)
      this.showSelectionRing(hit)
      this.emitSaveState('dirty')
      return true
    }
    // 5) 拖某成员活动范围边界线 → 整框平移(频道整体移动之前;频道移动先排除已按范围接管)
    const rangeHit = this.hitAgentRangeBoundary(w.x, w.z)
    if (rangeHit && rangeHit.range) {
      this.pointerDrag = { kind: 'agentRange', id: rangeHit.agentId, dx: rangeHit.range.x - w.x, dz: rangeHit.range.z - w.z }
      this.setSelected({ kind: 'agent', id: rangeHit.agentId })
      this.emitSaveState('dirty')
      return true
    }
    // 6) 频道领地整体拖拽:点中领地空白处 → 平移整个频道(平台/边界/名牌/成员落点)
    const cid = this.pickChannel(w.x, w.z)
    if (cid) {
      const b = this.blocks.get(cid)
      if (!b) return false
      this.pointerDrag = { kind: 'channel', id: cid, dx: b.x - w.x, dz: b.z - w.z }
      this.setSelected(null)
      this.selectChannel(cid)
      this.emitSaveState('dirty')
      return true
    }
    return false
  }

  isPointerDragging(): boolean {
    return this.pointerDrag !== null
  }

  private snapWorld(v: number): number {
    return this.snapEnabled ? Math.round(v / SNAP_SIZE) * SNAP_SIZE : Math.round(v * 10) / 10
  }

  /** 拖拽中:对象跟随指针指向的 xz 平面(仅改内存;落库在 endPointerDrag) */
  movePointerDrag(clientX: number, clientY: number): void {
    if (!this.pointerDrag) return
    const w = this.screenToWorld(clientX, clientY)
    const x = Math.min(WORLD_W, Math.max(0, this.snapWorld(w.x)))
    const z = Math.min(WORLD_H, Math.max(0, this.snapWorld(w.z)))
    const pd = this.pointerDrag
    if (pd.kind === 'device') {
      const dev = this.deviceNodes.get(pd.id)
      if (dev) {
        dev.root.position.x = x
        dev.root.position.z = z
        this.dirty = true
      }
    }
    else if (pd.kind === 'agent') {
      const asp = this.agents.get(pd.id)
      if (asp) {
        // 频道角色落点钳制在所属领地边界内(不可拖出频道)
        let px = x
        let pz = z
        const layout = this.blockLayout(asp.channelId)
        if (layout) {
          const clamped = clampToBoundary(layout, x, z, 20)
          px = clamped.x
          pz = clamped.z
        }
        asp.root.position.x = px
        asp.root.position.z = pz
        this.dirty = true
      }
    }
    else if (pd.kind === 'rangeDraw') {
      // 框选绘制:当前点为对角终点(钳入频道边界),实时更新预览矩形
      const asp = this.agents.get(pd.id)
      if (!asp) return
      const layout = this.blockLayout(asp.channelId)
      let cx = w.x
      let cz = w.z
      if (layout) {
        const clamped = clampToBoundary(layout, cx, cz, 12)
        cx = clamped.x
        cz = clamped.z
      }
      this.rangeDrawPreviewState = { x0: pd.x0, z0: pd.z0, x1: cx, z1: cz }
      this.updateRangeDrawPreview(pd.x0, pd.z0, cx, cz)
      this.dirty = true
    }
    else if (pd.kind === 'agentRange') {
      // 拖 Agent 活动范围边界 → 整框平移(钳入频道边界;范围线框/手柄跟随)
      const asp = this.agents.get(pd.id)
      if (!asp || !asp.range) return
      const layout = this.blockLayout(asp.channelId)
      if (!layout) return
      const nx = Math.min(WORLD_W, Math.max(0, x + pd.dx))
      const nz = Math.min(WORLD_H, Math.max(0, z + pd.dz))
      asp.range = clampRangeToLayout(layout, { ...asp.range, x: nx, z: nz })
      asp.renderRangeLine()
      this.refreshAgentRangeHandles()
      this.dirty = true
    }
    else if (pd.kind === 'agentRangeResize') {
      // 拖 Agent 范围手柄 → 实时调整 radiusX/radiusZ(矩形角点双轴 / 椭圆轴向轴点)
      const asp = this.agents.get(pd.id)
      if (!asp || !asp.range) return
      const layout = this.blockLayout(asp.channelId)
      if (!layout) return
      asp.range = this.applyAgentRangeResize(asp.range, pd.handle, w.x, w.z, layout)
      asp.renderRangeLine()
      this.refreshAgentRangeHandles()
      this.dirty = true
    }
    else if (pd.kind === 'channel') {
      const b = this.blocks.get(pd.id)
      if (b) this.applyBlockMove(b, Math.min(WORLD_W, Math.max(0, x + pd.dx)), Math.min(WORLD_H, Math.max(0, z + pd.dz)))
    }
    else if (pd.kind === 'resize') {
      const b = this.blocks.get(pd.id)
      if (b) this.applyResize(b, pd.handle, w.x, w.z)
    }
  }

  /** 拖拽结束:设备 → 防抖落库;角色 → home 更新 + 持久化;频道 → 布局落库 */
  endPointerDrag(): void {
    if (!this.pointerDrag) return
    const pd = this.pointerDrag
    this.pointerDrag = null
    if (pd.kind === 'device') {
      const dev = this.deviceNodes.get(pd.id)
      if (dev) this.persistDeviceTransform(pd.id)
    }
    else if (pd.kind === 'agent') {
      const asp = this.agents.get(pd.id)
      if (asp) {
        asp.homeX = asp.root.position.x
        asp.homeZ = asp.root.position.z
        asp.dragging = false
        this.emitSaveState('saving')
        void this.agentApi?.updateHome(pd.id, asp.homeX, asp.homeZ)
          .then(() => this.emitSaveState('saved', Date.now()))
          .catch(() => this.emitSaveState('error'))
      }
    }
    else if (pd.kind === 'rangeDraw') {
      // 框选结束:以拖框中点为中心、半宽为半径生成矩形范围(过小拖动视为取消)
      const asp = this.agents.get(pd.id)
      if (asp && this.rangeDrawPreviewState) {
        const layout = this.blockLayout(asp.channelId)
        const d = this.rangeDrawPreviewState
        const range: AgentRangeLayout = {
          x: (d.x0 + d.x1) / 2,
          z: (d.z0 + d.z1) / 2,
          radiusX: Math.abs(d.x1 - d.x0) / 2,
          radiusZ: Math.abs(d.z1 - d.z0) / 2,
          shape: 'rect',
          rotationY: 0,
        }
        if (layout && range.radiusX >= 40 && range.radiusZ >= 40) {
          asp.range = clampRangeToLayout(layout, range)
          asp.renderRangeLine()
          // 把角色落点收进新范围(home 若在范围外会导致回归/漫游卡死)
          const c = clampToAgentRange(asp.range, asp.homeX, asp.homeZ, 0)
          if (c.x !== asp.homeX || c.z !== asp.homeZ) {
            asp.homeX = c.x
            asp.homeZ = c.z
            asp.root.position.x = c.x
            asp.root.position.z = c.z
            void this.agentApi?.updateHome(pd.id, c.x, c.z).catch(() => {})
          }
          this.emitSaveState('saving')
          void this.agentApi?.updateRange(pd.id, asp.range)
            .then(() => this.emitSaveState('saved', Date.now()))
            .catch(() => this.emitSaveState('error'))
        }
      }
      this.cancelRangeDraw()
      this.refreshAgentRangeHandles()
      this.emitAgentRangeChanged(pd.id)
    }
    else if (pd.kind === 'agentRange' || pd.kind === 'agentRangeResize') {
      // 拖范围整框 / 拖范围手柄结束 → 落库 config.range
      const asp = this.agents.get(pd.id)
      if (asp && asp.range) {
        this.emitSaveState('saving')
        void this.agentApi?.updateRange(pd.id, asp.range)
          .then(() => this.emitSaveState('saved', Date.now()))
          .catch(() => this.emitSaveState('error'))
      }
      this.refreshAgentRangeHandles()
      this.emitAgentRangeChanged(pd.id)
    }
    else {
      // channel / resize:把成员钳回新边界 + 布局落库 + 通知 Vue 刷新边界面板草稿
      const b = this.blocks.get(pd.id)
      if (b) {
        this.clampAgentsToBoundary(pd.id)
        this.refreshChannelHandles()
        const layout = this.getChannelLayout(pd.id)
        if (layout) {
          this.emitSaveState('saving')
          void this.channelApi?.save(pd.id, layout)
            .then(() => this.emitSaveState('saved', Date.now()))
            .catch(() => this.emitSaveState('error'))
          this.emit('channelResized', { channelId: pd.id, layout })
        }
      }
    }
    this.showSelectionRing(this.selected)
  }

  // ================================================================
  // Agent 独立活动范围(编辑模式:框选绘制 / 整框平移 / 手柄收缩扩张)
  // ================================================================

  /** 活动范围线框可见性:编辑模式全部显示;浏览模式仅选中角色的范围显示 */
  private rangeLineVisible(asp: Agent3D): boolean {
    if (this.mode === 'edit') return true
    return this.selected?.kind === 'agent' && this.selected.id === asp.agentId
  }

  /** 通知 Vue 对象面板刷新活动范围草稿 */
  private emitAgentRangeChanged(agentId: string): void {
    this.emit('agentRangeChanged', { agentId })
  }

  /** 同步全部范围线框可见性(选中/模式切换后调用) */
  private refreshAgentRangeLines(): void {
    for (const a of this.agents.values()) {
      if (a.rangeLine) a.rangeLine.visible = this.rangeLineVisibleFor(a)
    }
  }

  /** 活动范围线框可见性(公众面,供 Agent3D.renderRangeLine):编辑模式全部显示;浏览模式仅选中显示 */
  rangeLineVisibleFor(asp: Agent3D): boolean {
    if (this.mode === 'edit') return true
    return this.selected?.kind === 'agent' && this.selected.id === asp.agentId
  }

  /** 刷新 Agent 活动范围手柄(编辑模式 + 选中带范围角色时显示;矩形四角 / 椭圆轴向四点) */
  private refreshAgentRangeHandles(): void {
    for (const hl of this.agentRangeHandles) hl.mesh.visible = false
    if (this.mode !== 'edit' || !this.selected || this.selected.kind !== 'agent') return
    const asp = this.agents.get(this.selected.id)
    if (!asp || !asp.range) return
    const rot = asp.range.rotationY * Math.PI / 180
    const pts = this.boundaryHandlePoints(asp.range)
    for (let i = 0; i < this.agentRangeHandles.length && i < pts.length; i++) {
      const [lx, lz] = pts[i]!
      const wx = asp.range.x + lx * Math.cos(rot) - lz * Math.sin(rot)
      const wz = asp.range.z + lx * Math.sin(rot) + lz * Math.cos(rot)
      this.agentRangeHandles[i]!.agentId = asp.agentId
      this.agentRangeHandles[i]!.mesh.position.set(wx, 1.2, wz)
      this.agentRangeHandles[i]!.mesh.visible = true
    }
  }

  /** 命中选中 Agent 的活动范围手柄(编辑模式;返回 agentId + 手柄号) */
  private pickAgentRangeHandle(x: number, z: number): { agentId: string, handle: number } | null {
    if (this.mode !== 'edit') return null
    for (const hl of this.agentRangeHandles) {
      if (!hl.mesh.visible) continue
      if (Math.hypot(hl.mesh.position.x - x, hl.mesh.position.z - z) < 40) return { agentId: hl.agentId, handle: hl.handle }
    }
    return null
  }

  /** 命中某成员活动范围边界线(供整框拖移;编辑模式;26 单位内视为命中) */
  private hitAgentRangeBoundary(x: number, z: number): Agent3D | undefined {
    if (this.mode !== 'edit') return undefined
    for (const a of this.agents.values()) {
      if (!a.range || !a.channelId) continue
      if (distToRangeBoundary(a.range, x, z) < 26) return a
    }
    return undefined
  }

  /** 拖范围手柄 → 实时调整 radiusX/radiusZ(矩形:角点双轴;椭圆:对应轴向轴点),并收进频道边界 */
  private applyAgentRangeResize(range: AgentRangeLayout, handle: number, wx: number, wz: number, layout: ChannelLayout): AgentRangeLayout {
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
    return clampRangeToLayout(layout, next)
  }

  /** 框选预览:以 (x0,z0)-(x1,z1) 为对角生成矩形线框(实时跟随指针) */
  private updateRangeDrawPreview(x0: number, z0: number, x1: number, z1: number): void {
    const lx = Math.min(x0, x1)
    const hx = Math.max(x0, x1)
    const lz = Math.min(z0, z1)
    const hz = Math.max(z0, z1)
    const cx = (lx + hx) / 2
    const cz = (lz + hz) / 2
    const rx = Math.max(8, (hx - lx) / 2)
    const rz = Math.max(8, (hz - lz) / 2)
    if (!this.rangeDrawLine) {
      const line = makeBoundary('rect', 1, 1, 0x9fe8d4)
      ;(line.material as THREE.LineBasicMaterial).opacity = 0.95
      line.position.y = 0.5
      this.scene.add(line)
      this.rangeDrawLine = line
    }
    this.rangeDrawLine.position.set(cx, 0.5, cz)
    this.rangeDrawLine.rotation.y = 0
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-rx, 0, -rz), new THREE.Vector3(rx, 0, -rz),
      new THREE.Vector3(rx, 0, rz), new THREE.Vector3(-rx, 0, rz),
    ])
    this.rangeDrawLine.geometry.dispose()
    this.rangeDrawLine.geometry = geo
  }

  /** 退出框选绘制模式(清理预览与状态) */
  cancelRangeDraw(): void {
    if (this.rangeDrawAgent === null && !this.rangeDrawLine) return
    this.rangeDrawAgent = null
    this.rangeDrawPreviewState = null
    if (this.rangeDrawLine) {
      this.scene.remove(this.rangeDrawLine)
      this.rangeDrawLine = null
    }
    this.dirty = true
  }

  /** 进入「框选绘制」模式:为该角色拉动矩形框生成活动范围(编辑模式) */
  startRangeDraw(agentId: string): void {
    const asp = this.agents.get(agentId)
    if (!asp || !asp.channelId || this.mode !== 'edit') return
    this.setSelected({ kind: 'agent', id: agentId })
    this.cancelRangeDraw()
    this.rangeDrawAgent = agentId
    this.rangeDrawPreviewState = null
    this.refreshAgentRangeHandles()
    this.dirty = true
  }

  /** 当前是否正在为某角色框选绘制 */
  isRangeDrawing(agentId?: string): boolean {
    if (!this.rangeDrawAgent) return false
    return agentId === undefined || this.rangeDrawAgent === agentId
  }

  /** E2E/调试:强制某频道接收器跳过当前条目,立即消费下一条(FIFO 顺序断言用) */
  debugAdvanceReceiver(channelId: string): void {
    const rec = this.receivers.get(channelId)
    if (rec) rec.currentUntil = 0
  }

  /** Agent 当前活动范围(供面板初始化;未设置返回 null) */
  getAgentRange(agentId: string): AgentRangeLayout | null {
    return this.agents.get(agentId)?.range ?? null
  }

  /** 面板滑杆/形状即时调整:局部更新范围(钳入频道) + 线框/手柄刷新;home 被迫位移时记档待提交 */
  setAgentRangeScene(agentId: string, patch: Partial<AgentRangeLayout>): void {
    const asp = this.agents.get(agentId)
    if (!asp) return
    const layout = this.blockLayout(asp.channelId)
    if (!asp.range) {
      // 尚无范围:以落点为中心、频道半径 1/4 起手(面板直接给值时)
      asp.range = { x: asp.homeX, z: asp.homeZ, radiusX: 120, radiusZ: 90, shape: 'ellipse', rotationY: 0 }
    }
    const next = { ...asp.range, ...patch }
    asp.range = layout ? clampRangeToLayout(layout, next) : next
    // 范围收缩致 home 越界 → 落点收进范围(提交时随 updateRange 一并落库)
    const c = clampToAgentRange(asp.range, asp.homeX, asp.homeZ, 0)
    if (c.x !== asp.homeX || c.z !== asp.homeZ) {
      asp.homeX = c.x
      asp.homeZ = c.z
      asp.root.position.x = c.x
      asp.root.position.z = c.z
      this.rangeHomeMoved = { agentId, x: c.x, z: c.z }
    }
    asp.renderRangeLine()
    this.refreshAgentRangeHandles()
    this.dirty = true
  }

  /** 面板提交:落库范围(updateRange);home 若被迫位移一并落库(updateHome) */
  commitAgentRange(agentId: string): void {
    const asp = this.agents.get(agentId)
    if (!asp) return
    if (this.rangeHomeMoved?.agentId === agentId) {
      const { x, z } = this.rangeHomeMoved
      this.rangeHomeMoved = null
      void this.agentApi?.updateHome(agentId, x, z).catch(() => {})
    }
    this.emitSaveState('saving')
    void this.agentApi?.updateRange(agentId, asp.range)
      .then(() => this.emitSaveState('saved', Date.now()))
      .catch(() => this.emitSaveState('error'))
    this.emitAgentRangeChanged(agentId)
  }

  /** 清除角色活动范围(局部 + 落库 null;回退频道边界) */
  clearAgentRange(agentId: string): void {
    const asp = this.agents.get(agentId)
    if (!asp) return
    if (asp.rangeLine) {
      this.scene.remove(asp.rangeLine)
      asp.rangeLine = null
    }
    asp.range = null
    this.rangeHomeMoved = null
    this.refreshAgentRangeHandles()
    this.emitSaveState('saving')
    void this.agentApi?.updateRange(agentId, null)
      .then(() => this.emitSaveState('saved', Date.now()))
      .catch(() => this.emitSaveState('error'))
    this.emitAgentRangeChanged(agentId)
    this.dirty = true
  }

  /** 对象朝向(度;编辑模式旋转滑杆实时) */
  setModelRotation(id: string, deg: number, kind?: 'agent' | 'device'): void {
    const k = kind ?? (this.deviceNodes.has(id) ? 'device' : 'agent')
    if (k === 'device') {
      const dev = this.deviceNodes.get(id)
      if (!dev) return
      dev.root.rotation.y = deg * Math.PI / 180
    }
    else {
      const asp = this.agents.get(id)
      if (!asp) return
      asp.root.rotation.y = deg * Math.PI / 180
    }
    this.dirty = true
  }

  getModelRotation(id: string, kind?: 'agent' | 'device'): number {
    const k = kind ?? (this.deviceNodes.has(id) ? 'device' : 'agent')
    if (k === 'device') {
      const dev = this.deviceNodes.get(id)
      return dev ? THREE.MathUtils.radToDeg(dev.root.rotation.y) : 0
    }
    const asp = this.agents.get(id)
    return asp ? THREE.MathUtils.radToDeg(asp.root.rotation.y) : 0
  }

  // ================================================================
  // 场景保存状态(未保存/保存中/已保存/失败)+ 设备 transform 防抖落库
  // ================================================================

  private emitSaveState(state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at = Date.now()): void {
    this.emit('saveState', { state, at })
  }

  /** 持久化设备 transform(位置/朝向/缩放一次写入;防抖 350ms,不逐帧写库) */
  persistDeviceTransform(id: string): void {
    const dev = this.deviceNodes.get(id)
    if (!dev || !this.devices?.update) return
    const st = this.scalables.get(`device:${id}`)
    const prev = this.pendingSaveTimers.get(id)
    if (prev) clearTimeout(prev)
    this.pendingSaveTimers.set(id, setTimeout(() => {
      this.pendingSaveTimers.delete(id)
      this.emitSaveState('saving')
      void this.devices!.update(id, {
        posX: Math.round(dev.root.position.x * 10) / 10,
        posZ: Math.round(dev.root.position.z * 10) / 10,
        rotationY: Math.round(THREE.MathUtils.radToDeg(dev.root.rotation.y) * 10) / 10,
        scale: st ? Math.round(st.userScale * 100) / 100 : undefined,
      })
        .then(() => this.emitSaveState('saved', Date.now()))
        .catch(() => this.emitSaveState('error'))
    }, 350))
    this.emitSaveState('dirty')
  }

  /** 保存全部设备节点(「保存布局」按钮:强制全量落库) */
  persistAllDevices(): void {
    for (const id of [...this.deviceNodes.keys()]) this.persistDeviceTransform(id)
  }

  private pendingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ================================================================
  // 设备场景实例同步(服务端设备孪生 → 本地节点;多客户端一致)
  // ================================================================

  /**
   * 与设备孪生清单对齐:
   *  - 服务端有落点且本地无节点 → 按保存的 transform 重建节点(刷新后恢复);
   *  - 已存在 → 收敛状态/遥测,并在未拖拽时收敛 transform(他人编辑即时跟随);
   *  - 服务端已删除 → 移除本地节点。
   * TownView 在 device.* 事件与轮询时调用;轮询兜底多客户端同步。
   */
  syncDevices(twins: DeviceTwinSync[]): void {
    const serverIds = new Set(twins.map(t => t.id))
    for (const id of [...this.deviceNodes.keys()]) {
      if (!serverIds.has(id)) this.removeDeviceNode(id)
    }
    for (const t of twins) {
      const existing = this.deviceNodes.get(t.id)
      if (!existing) {
        if (typeof t.posX === 'number' && typeof t.posZ === 'number') this.recreateDeviceNode(t)
        continue
      }
      // 状态/遥测/名称/模型 → 委托 DeviceNode.applyTwin(数据驱动:孪生记录 → 节点)
      existing.applyTwin(t)
      if (this.pointerDrag?.id !== t.id) {
        const moved = (typeof t.posX === 'number' && t.posX !== existing.root.position.x)
          || (typeof t.posZ === 'number' && t.posZ !== existing.root.position.z)
        if (typeof t.posX === 'number') existing.root.position.x = t.posX
        if (typeof t.posZ === 'number') existing.root.position.z = t.posZ
        if (typeof t.rotationY === 'number') existing.root.rotation.y = t.rotationY * Math.PI / 180
        const st = this.scalables.get(`device:${t.id}`)
        if (typeof t.scale === 'number' && st) {
          st.userScale = t.scale
          st.holder.scale.setScalar(t.scale)
        }
        if (moved) this.dirty = true
      }
      this.dirty = true
    }
    if (this.selected && this.selRing?.visible) this.showSelectionRing(this.selected)
  }

  /** 按设备孪生记录重建场景节点(持久化恢复:pos/rotation/scale;模型缺失则跳过) */
  private recreateDeviceNode(t: DeviceTwinSync): void {
    const model = this.modelsById.get(t.modelRef)
    const file = model?.file ?? ''
    if (!file) return
    const x = typeof t.posX === 'number' ? t.posX : WORLD_CX
    const z = typeof t.posZ === 'number' ? t.posZ : WORLD_CZ
    const root = new THREE.Group()
    root.position.set(x, GROUND_Y, z)
    root.rotation.y = typeof t.rotationY === 'number' ? t.rotationY * Math.PI / 180 : 0
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(20, 26, 32),
      new THREE.MeshBasicMaterial({ color: 0x8fe8d4, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.3
    root.add(ring)
    const holder = new THREE.Group()
    root.add(holder)
    const label = this.makeLabel(`⚙ ${t.name}`, x, 60, z)
    this.scene.add(root)
    const twin = new DeviceNode({ twinId: t.id, name: t.name, modelRef: t.modelRef, root, holder, ring, label, state: t.state ?? 'idle', telemetry: t.telemetry ?? {} })
    twin.host = this
    this.deviceNodes.set(t.id, twin)
    // 服务端缩放优先(持久化恢复);缺省回退 localStorage
    this.registerScalable('device', t.id, holder, typeof t.scale === 'number' ? t.scale : undefined)
    void this.loadGltfToGroup(file, holder, UNITS * 1.6)
    this.dirty = true
  }

  /** 移除设备场景节点(服务端记录被删/本地重建清理) */
  private removeDeviceNode(id: string): void {
    const dev = this.deviceNodes.get(id)
    if (!dev) return
    this.scene.remove(dev.root)
    this.scene.remove(dev.label)
    if (this.selected?.kind === 'device' && this.selected.id === id) this.setSelected(null)
    this.scalables.delete(`device:${id}`)
    this.deviceNodes.delete(id)
    this.dirty = true
  }

  /** 选中高亮环(编辑模式;跟随选中设备/角色) */
  private showSelectionRing(hit: { kind: 'agent' | 'device', id: string } | null): void {
    if (!this.selRing) {
      this.selRing = new THREE.Mesh(
        new THREE.RingGeometry(34, 42, 48),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthTest: false }),
      )
      this.selRing.rotation.x = -Math.PI / 2
      this.selRing.position.y = 0.42
      this.selRing.visible = false
      this.scene.add(this.selRing)
    }
    if (!hit || this.mode !== 'edit') {
      this.selRing.visible = false
      return
    }
    const obj = hit.kind === 'device' ? this.deviceNodes.get(hit.id)?.root : this.agents.get(hit.id)?.root
    if (!obj) {
      this.selRing.visible = false
      return
    }
    this.selRing.position.x = obj.position.x
    this.selRing.position.z = obj.position.z
    this.selRing.visible = true
  }

  // ================================================================
  // 生命周期 / 渲染循环
  // ================================================================

  private loop(): void {
    const animate = () => {
      if (this.disposed) return
      this.raf = requestAnimationFrame(animate)
      const dt = this.clock.getDelta()
      // 频道信息接收器:FIFO 逐条消费实时消息(每帧检查,展示期满取下一条)
      this.drainReceivers(performance.now())
      // 行为 FSM
      for (const asp of this.agents.values()) {
        if (asp.state !== 'stopped' && !asp.dragging) asp.update(dt)
      }
      // mixer 更新
      for (const asp of this.agents.values()) {
        if (asp.mixer) asp.mixer.update(dt)
      }
      // 名字/环/气泡跟随 + 逐帧动画(脉冲/光柱/缓动)
      for (const asp of this.agents.values()) {
        asp.nameSprite.position.set(asp.root.position.x, 48, asp.root.position.z)
        asp.aura.position.set(asp.root.position.x, 0.22, asp.root.position.z)
        if (asp.bubble) {
          asp.bubble.position.set(asp.root.position.x, BUBBLE_Y + Math.max(0, asp.model.scale.y - 1) * 22, asp.root.position.z)
        }
      }
      // 设备节点:状态环颜色驱动 + 名牌跟随(数据驱动:state → 环色)
      for (const dev of this.deviceNodes.values()) {
        dev.ring.position.set(dev.root.position.x, 0.3, dev.root.position.z)
        dev.label.position.set(dev.root.position.x, 60, dev.root.position.z)
        dev.updateRing()
      }
      // 选中高亮环跟随(编辑模式)
      if (this.selRing?.visible && this.selected) {
        const obj = this.selected.kind === 'device'
          ? this.deviceNodes.get(this.selected.id)?.root
          : this.agents.get(this.selected.id)?.root
        if (obj) {
          this.selRing.position.x = obj.position.x
          this.selRing.position.z = obj.position.z
        }
      }
      const anims = this.rafAnims
      this.rafAnims = []
      for (const f of anims) f()
      // 相机:围绕 camTarget 按 dolly 距离摆放(拖拽平移 camTarget,滚轮调 dolly,tween 平移 camTarget)
      const dist = 940 * this.dolly
      this.camera.position.set(this.camTarget.x, 620 * this.dolly, this.camTarget.z + dist * 0.76)
      this.camera.lookAt(this.camTarget.x, 20, this.camTarget.z)
      this.renderer.render(this.scene, this.camera)
      // FPS
      this.frameCount += 1
      this.fpsAccum += dt * 1000
      if (this.fpsAccum >= 1000) {
        this.emit('fps', this.frameCount)
        this.frameCount = 0
        this.fpsAccum = 0
      }
    }
    animate()
  }

  /** 重置全部(rebuild 用) */
  private resetAll(): void {
    for (const a of this.agents.values()) {
      this.scene.remove(a.root)
      if (a.nameSprite) this.scene.remove(a.nameSprite)
      if (a.bubble) this.scene.remove(a.bubble)
      if (a.rangeLine) this.scene.remove(a.rangeLine)
    }
    for (const b of this.blocks.values()) {
      this.scene.remove(b.platform)
      this.scene.remove(b.boundary)
      this.scene.remove(b.label)
    }
    for (const dev of this.deviceNodes.values()) {
      this.scene.remove(dev.root)
      this.scene.remove(dev.label)
    }
    this.deviceNodes.clear()
    this.scalables.clear()
    this.receivers.clear()
    this.pointerDrag = null
    this.cancelRangeDraw()
    this.selected = null
    this.selectedChannel = null
    for (const hl of this.resizeHandles) hl.mesh.visible = false
    for (const hl of this.agentRangeHandles) hl.mesh.visible = false
    this.showSelectionRing(null)
    this.agents.clear()
    this.blocks.clear()
  }

  /** 销毁(卸载时由 TownView 调用) */
  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    for (const t of this.pendingSaveTimers.values()) clearTimeout(t)
    this.pendingSaveTimers.clear()
    this.receivers.clear()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.el) this.renderer.domElement.remove()
  }
}
