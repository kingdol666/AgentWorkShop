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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { mapEnvelopeToIntent, type TownBubbleKind } from '#shared/town-protocol'
import { parseActionFromEnvelope, stepToward, type ActionKind, type ActionContext } from '#shared/town-behavior'
// 纯几何/色彩/尺度决策层(与测试共用,零渲染依赖)
import {
  AGENT_SPEED, ARRIVE, BUBBLE_Y, GROUND_Y, SNAP_SIZE, UNITS, WAIT_MS,
  WORLD_CX, WORLD_CZ, WORLD_H, WORLD_W,
  boundaryPoints, bubbleDisplayMs, channelColorNum, drainDisplayMs,
  clampToAgentRange, clampToBoundary, distToRangeBoundary,
  normLayout, pointInBoundary, toLocal,
  type AgentRangeLayout, type ChannelLayout,
} from '#shared/town-scene-math'

export type { AgentRangeLayout, ChannelLayout } from '#shared/town-scene-math'

/** 场景 → Vue HUD 事件(TownEventMap 与 2D 同构) */
export type TownEventMap = {
  ready: boolean
  fps: number
  agentCount: number
  blockCount: number
  lastActivity: { channelId: string, agentName: string, text: string, at?: number } | null
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
  /** 实体类别:'device' 常规设备(GLB) / 'daq' 数采节点(程序化网格);后端为宽 string */
  kind?: string
  state?: 'idle' | 'running' | 'offline' | 'alarm'
  telemetry?: Record<string, number | string | boolean>
  posX?: number
  posZ?: number
  rotationY?: number
  scale?: number
  /** 所属产线(场景光晕分色依据) */
  lineId?: string
  /** 产线光晕色(Hex;同产线节点同色光环) */
  lineColor?: string
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

/** 频道布局(3D 小镇放置):与共享 AepSceneLayout/useSceneLayouts 同构 —— 定义见 #shared/town-scene-math */

/** Agent 独立活动范围(编辑模式框选绘制/手柄调整;经 config.range 持久化)。
 *  缺省(null)= 未设置,该 Agent 沿用频道边界活动。 —— 定义见 #shared/town-scene-math */

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
  /** 领地边缘发光环(工业孪生边界告示;随平台移动) */
  padRing!: THREE.Mesh
  /** 中央信标(HMI 定位销:点击 → 定位频道中心 + 唤醒边界编辑) */
  beacon!: THREE.Group
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
    padRing: THREE.Mesh
    beacon: THREE.Group
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

  /** 边界手柄本地坐标(矩形四角 / 椭圆轴向四点;radius 是半轴或半宽)。 */
  handlePoints(): Array<[number, number]> {
    if (this.shape === 'rect') return [[this.radiusX, this.radiusZ], [-this.radiusX, this.radiusZ], [-this.radiusX, -this.radiusZ], [this.radiusX, -this.radiusZ]]
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
    this.padRing.position.set(this.x, 0.32, this.z)
    this.beacon.position.set(this.x, 0, this.z)
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

/** 边界几何体:椭圆/矩形线框,弯折朝向 rotationY(度)。
 *  轮廓点来自 #shared/town-scene-math.boundaryPoints(纯几何,场景只做渲染)。 */
function makeBoundary(shape: 'ellipse' | 'rect', rx: number, rz: number, color: number): THREE.LineLoop {
  const pts = boundaryPoints(shape, rx, rz, 48).map(([x, z]) => new THREE.Vector3(x, 0, z))
  const geo = new THREE.BufferGeometry().setFromPoints(pts)
  const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false }))
  return line
}

/** 归一化边界(radius 钳制下限;rect 用半宽) —— 定义见 #shared/town-scene-math */

/** 把点钳制到频道边界内 —— 定义见 #shared/town-scene-math */

/** 点到边界内判定 —— 定义见 #shared/town-scene-math */

/** 边界/范围的极值点(矩形四角 / 椭圆轴向四点;世界坐标,含 rotationY) —— 定义见 #shared/town-scene-math */

/** 把 Agent 活动范围整体收进频道边界 —— 定义见 #shared/town-scene-math */

/** 把点钳制到 Agent 自己活动范围内 —— 定义见 #shared/town-scene-math */

/** 世界点到活动范围边界线的最近距离 —— 定义见 #shared/town-scene-math */

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
  /** 身份色(频道哈希色;气泡/小地图等取色数据源) */
  colorNum!: number
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
  /** 当前 mixer action(crossfade 切换用;null = 未开始) */
  activeAction: THREE.AnimationAction | null = null
  /** 宿主场景控制器(实例化后注入) */
  host!: TownScene3D
  /** 本帧是否在移动(update 结束时驱动动画) */
  private moving = false
  /** 脚下光环组(频道色身份标识;root 子节点,随移动跟随,零每帧定位成本) */
  aura: THREE.Group | null = null
  /** 光环材质(渲染循环呼吸;userData.baseOp 存基准透明度) */
  auraMats: THREE.MeshBasicMaterial[] = []
  /** 呼吸相位(每实例随机,避免全场同频闪烁) */
  auraPhase = 0

  /** 挂脚下光环(频道色,与领地同源;lead 加外环 —— 角色身份一眼可辨) */
  attachAura(color: number, role: 'lead' | 'worker'): void {
    const g = new THREE.Group()
    const mats: THREE.MeshBasicMaterial[] = []
    const mk = (r0: number, r1: number, y: number, op: number): void => {
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
      m.userData.baseOp = op
      mats.push(m)
      const mesh = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 44), m)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.y = y
      g.add(mesh)
    }
    mk(34, 40, 0.36, 0.26)
    if (role === 'lead') mk(46, 50, 0.42, 0.2)
    this.root.add(g)
    this.aura = g
    this.auraMats = mats
    this.auraPhase = Math.random() * Math.PI * 2
  }

  constructor(init: {
    channelId: string
    agentId: string
    name: string
    role: 'lead' | 'worker'
    root: THREE.Group
    model: THREE.Group
    mixer: THREE.AnimationMixer | null
    clips: THREE.AnimationClip[]
    colorNum: number
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
    // 朝向平滑:朝移动方向插值转动(左/右两态,不用瞬间 snap,2.5D 行走更顺)
    const dir = next.dir
    const targetY = dir === 'left' ? Math.PI : 0
    const curY = this.root.rotation.y
    // 最短角差插值(0 ↔ π 之间取捷径;步长限速防抖)
    let d = targetY - curY
    if (d > Math.PI) d -= Math.PI * 2
    else if (d < -Math.PI) d += Math.PI * 2
    const maxStep = dt * 3.2
    this.root.rotation.y = curY + Math.max(-maxStep, Math.min(maxStep, d))
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
      // 无动画 clip → 程序化动作绑定(model 局部,色环/名牌保持贴地稳定):
      //  待机呼吸浮动 + 行走跳跃颠簸 + 行走左右微摆
      const t = performance.now()
      const breathe = 1.2 + Math.sin(t * 0.0016) * 1.6
      const hop = Math.abs(Math.sin(t * 0.005)) * 6
      this.model.position.y = moving ? hop : breathe
      const swayTarget = moving ? Math.sin(t * 0.006) * 0.07 : 0
      this.model.rotation.z += (swayTarget - this.model.rotation.z) * 0.12
      return
    }
    // 有动画 clip:按移动状态切换 idle/walk,crossfade 平滑过渡(避免双 action 叠加)
    if (!this.mixer) return
    const idx = moving ? (this.clips.length > 1 ? 1 : 0) : 0
    const clip = this.clips[idx]
    if (!clip) return
    const nextAction = this.mixer.clipAction(clip)
    if (this.activeAction === nextAction) {
      nextAction.timeScale = moving ? 1.3 : 0.9
      return
    }
    nextAction.reset().setEffectiveTimeScale(moving ? 1.3 : 0.9).fadeIn(0.15).play()
    if (this.activeAction) this.activeAction.fadeOut(0.15)
    this.activeAction = nextAction
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
    const color = 0x41c8f4
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
  /** 运行态动效弧(仅 running 可见;渲染循环缓转 —— 语义动效:设备在转 = 在产) */
  arc: THREE.Mesh | null = null
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

  /** 模型顶面世界高度缓存(HUD/callout 每帧读取;缩放变更时失效) */
  topYCache: number | null = null
  /** 当前产线光晕色(空 = 未分配) */
  lineColor = ''
  /** 产线换色回调(recreateDaqNode 装配;applyTwin 检测变化时重 tint) */
  applyLine: ((color: string) => void) | null = null

  /** 状态环颜色(数据驱动:状态变化/产线换色时调用,渲染循环不再每帧重刷)。
   *  分配了产线的节点(数采)环随产线色 —— 状态生命感已由 LED 呼吸环表达;常规设备环 = 状态色。 */
  updateRing(): void {
    const mat = this.ring.material as THREE.MeshBasicMaterial
    if (this.lineColor) mat.color.set(this.lineColor)
    else mat.color.setHex(this.state === 'alarm' ? 0xff6b6b : this.state === 'offline' ? 0x8496a5 : this.state === 'running' ? 0x35e0a0 : 0xf6c453)
    if (this.arc) this.arc.visible = this.state === 'running'
  }

  /** 与数据库讑生记录收敛(状态/遥测/名称/模型/产线光晕;宿主完成名牌与模型重挂) */
  applyTwin(t: DeviceTwinSync): void {
    if (t.state) this.state = t.state
    if (t.telemetry) this.telemetry = { ...this.telemetry, ...t.telemetry }
    if (t.name && t.name !== this.name) this.host.renameDeviceSprite(this, t.name)
    if (t.modelRef && t.modelRef !== this.modelRef) this.host.swapDeviceModelSprite(this, t.modelRef)
    if ((t.lineColor ?? '') !== this.lineColor) {
      this.lineColor = t.lineColor ?? ''
      this.applyLine?.(this.lineColor)
    }
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

/** 世界尺度/速度/身份色等纯常量与函数集中定义于 #shared/town-scene-math(与 2D/测试共用) */

/** 角色模型来源登记(registerModelsFromList) */
interface ModelInfo { id: string, file: string, name: string, kind?: string, hFactor?: number }

export class TownScene3D {
  private renderer!: THREE.WebGLRenderer
  /** 后处理管线:Render → Bloom(夜航辉光)→ Output(tone mapping + sRGB;曝光经 setExposure 仍实时生效) */
  private composer!: EffectComposer
  private camera!: THREE.PerspectiveCamera
  /** 相机注视目标(拖拽平移它,zoom 微调距离) */
  private camTarget = new THREE.Vector3(WORLD_CX, 20, WORLD_CZ)
  /** 主方向光(阴影相机范围随 dolly 扩,大领地投影不消失) */
  private keyLight!: THREE.DirectionalLight
  private scene!: THREE.Scene
  private ground!: THREE.Mesh
  /** 穹顶天幕(随镜头平移,保证无限视野观感) */
  private skyDome: THREE.Mesh | null = null
  private blocks = new Map<string, Block3D>()
  private agents = new Map<string, Agent3D>()
  /** 数字孪生设备节点(twinId → node) */
  private deviceNodes = new Map<string, DeviceNode>()
  /** 数采节点顶端 LED 环(twinId → 环;渲染循环缓转呼吸) */
  private daqLedRings = new Map<string, THREE.Mesh>()
  /** 数采→设备 绑定链路(虚线贝塞尔 + 流动脉冲;syncDaqLinks 维护) */
  private daqLinkGroup = new THREE.Group()
  private daqLinks: Array<{ daqId: string, deviceId: string, line: THREE.Line, pulse: THREE.Mesh, curve: THREE.QuadraticBezierCurve3, pt: number, ptSig: string }> = []

  // ===== 投影/拾取 scratch 单例(热路径零分配) =====
  private static readonly _wDir = new THREE.Vector3()
  private static readonly _wRel = new THREE.Vector3()
  private static readonly _wVec = new THREE.Vector3()
  private static readonly _wVec2 = new THREE.Vector2()
  private static readonly _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private static readonly _raycaster = new THREE.Raycaster()
  private daqLinkSig = ''
  /** 期望链路(TownView 传入;设备节点晚到时由 syncDevices 末尾重仲裁) */
  private daqLinksWanted: Array<{ daqId: string, deviceId: string }> = []
  /** 薄膜 web(产线设备之间的半透明膜;按 X 序连接挤出→流延→MD→TD→收卷) */
  private filmWebGroup = new THREE.Group()
  private filmWebSig = ''
  private filmWebMat: THREE.MeshStandardMaterial | null = null
  /** 服务端已有但模型资产尚未注册的设备孪生，资产到达后补建节点。 */
  private pendingDeviceTwins = new Map<string, DeviceTwinSync>()
  /** 尚未取得服务端 ID 的本地设备节点(临时 ID → 创建请求初始状态)。 */
  private pendingDeviceCreates = new Map<string, { name: string, modelRef: string, posX: number, posZ: number }>()
  /** 用户在创建设备完成前删除的临时节点，创建完成后补偿删除服务端记录。 */
  private cancelledDeviceCreates = new Set<string>()
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
  /** 帧预算(ms):渲染节流上限;0 = 不限制。数据消费不走此门控(帧到达即入实时缓冲) */
  private frameBudgetMs = 1000 / 40

  /** 用户帧率选择(60/120/0=不限制):只影响渲染节流,与数据消费频率无关 */
  setFpsCap(fps: number): void {
    this.frameBudgetMs = fps > 0 ? 1000 / fps : 0
    this.frameAcc = 0
  }

  private frameAcc = 0
  /** 动态分辨率基准(初始 dpr):实测帧率过低时降,富余时回升 */
  private baseDpr = Math.min(window.devicePixelRatio, 2)
  private dirty = true
  /** 频道旗缓存(任务状态) */
  private flagBy = new Map<string, THREE.Mesh>()
  private disposed = false
  /** 当前相机缩放(滚轮;作用于 dolly 距离) */
  private dolly = 1.0
  /** 轨道相机状态机(Blender 规范):yaw 方位角 / pitch 仰角 / radius 半径。
   *  viewTarget 供预设平滑趋近;左键环绕直接改双值(即时跟手)。 */
  private autoOrbit = false
  private viewCur = { yaw: 0, pitch: 0.7, radius: 1178 }
  private viewTarget = { yaw: 0, pitch: 0.7, radius: 1178 }
  /** Blender 式变换手柄(选中设备;G 移动 / R 旋转 / S 缩放) */
  private tControls: TransformControls | null = null
  /** 舞台尺寸观察器 */
  private resizeOb: ResizeObserver | null = null
  /** 编辑 / 浏览模式(浏览只读:设备/角色不可拖,仅点选) */
  private mode: TownScene3DMode = 'browse'
  /** 正在拖曳的场景对象(编辑模式):设备 / 角色落点 / 频道整体 / 边界手柄 / Agent 活动范围 */
  private pointerDrag:
    | { kind: 'device', id: string }
    | { kind: 'agent', id: string }
    | { kind: 'channel', id: string, dx: number, dz: number }
    | { kind: 'resize', id: string, handle: number }
    | { kind: 'channelEdge', id: string, rx0: number, rz0: number, rd0: number }
    | { kind: 'rangeDraw', id: string, x0: number, z0: number }
    | { kind: 'agentRange', id: string, dx: number, dz: number }
    | { kind: 'agentRangeResize', id: string, handle: number }
    | null = null

  /** 网格吸附(编辑拖拽落点对齐 16 单位网格) */
  private snapEnabled = true
  /** 选中高亮环(琥珀色动效环,跟随当前选中设备/角色;渲染循环驱动) */
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
  private lastActivity: { channelId: string, agentName: string, text: string, at?: number } | null = null
  private recentActivity: Array<{ channelId: string, agentName: string, text: string, at?: number }> = []
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
    updateHome(agentId: string, channelId: string, x: number, z: number): Promise<unknown>
    /** 保存 Agent 独立活动范围(经 config.range 持久化;null 清除回退频道边界) */
    updateRange(agentId: string, channelId: string, range: AgentRangeLayout | null): Promise<unknown>
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
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(this.el.clientWidth || 1100, this.el.clientHeight || 700)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // 阴影按需重绘:渲染循环里仅场景内容变化(dirty)或角色动画在跑时置 needsUpdate,
    // 静态场景(总览/无动画)不再每帧全量重绘阴影贴图(2048² PCFSoft 是最大单项 GPU 开销)
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // 电影级色调映射:高光滚降 + 中间调层次,GLB 材质不再"平板曝光"
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.12
    this.el.appendChild(this.renderer.domElement)
    // 舞台尺寸跟随宿主(网格布局/抽屉/全屏切换都会改变宿主尺寸)
    this.resizeOb = new ResizeObserver(() => {
      const w = this.el.clientWidth
      const h = this.el.clientHeight
      if (w < 2 || h < 2) return
      this.renderer.setSize(w, h)
      this.composer.setSize(w, h)
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
      this.dirty = true
    })
    this.resizeOb.observe(this.el)
    // 选中:点击 Agent/设备 → 弹缩放/旋转滑杆(经 on('select') 通知 Vue);拖拽释放不触发
    // 点击语义守卫:记录按下位置;松手位移大 = 相机平移手势 → 不触发点选(含信标)
    let clickDownAt: { x: number, y: number } | null = null
    this.renderer.domElement.addEventListener('pointerdown', (e: PointerEvent) => {
      clickDownAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
    })
    this.renderer.domElement.addEventListener('pointerup', (e: PointerEvent) => {
      if (e.button !== 0 || this.pointerDrag || this.tControls?.dragging) return
      // 平移手势(按下后移动超 8px)→ 不作点选
      if (clickDownAt && Math.hypot(e.clientX - clickDownAt.x, e.clientY - clickDownAt.y) > 8) {
        clickDownAt = null
        return
      }
      clickDownAt = null
      const w = this.screenToWorld(e.clientX, e.clientY)
      // 频道信标优先(领队驻扎中心与信标重叠;中心 ±34 内点=信标,按住拖=Agent:
      // 拖拽手势在 pointerup 时因 pointerDrag 存在提前返回,不会误触信标)
      const beacon = this.pickBeacon(w.x, w.z)
      if (beacon) {
        this.setSelected(null)
        this.selectChannel(beacon.cid)
        this.focusTo(beacon.x, beacon.z)
        return
      }
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
    // 双击 Agent/设备:缓动聚焦(指挥官镜头;不打断选择语义)
    this.renderer.domElement.addEventListener('dblclick', (e: MouseEvent) => {
      if (this.pointerDrag) return
      const w = this.screenToWorld(e.clientX, e.clientY)
      const hit = this.pickAt(w.x, w.z)
      if (hit?.kind === 'agent') {
        const a = this.agents.get(hit.id)
        if (a) this.focusTo(a.root.position.x, a.root.position.z)
      }
      else if (hit?.kind === 'device') {
        const d = this.deviceNodes.get(hit.id)
        if (d) this.focusTo(d.root.position.x, d.root.position.z)
      }
      else {
        // 双击领地(非 Agent/设备落点)→ 对焦该 Channel 中心并选中
        // (浏览模式:边界面板即刻可用调节范围;编辑模式:缩放手柄同时显示,可拖拽控制)
        const cid = this.pickChannel(w.x, w.z)
        const b = cid ? this.blocks.get(cid) : undefined
        if (b) {
          this.selectChannel(cid)
          this.focusTo(b.x, b.z)
        }
      }
    })

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0a0f18)
    // 大气纵深:雾把远处柔化进夜色,2.5D 场景立刻有工业孪生的空间感
    this.scene.fog = new THREE.Fog(0x1b2836, 1400, 8800)
    // PBR 环境光照:PMREM 室内环境 → 金属/粗糙 GLB 材质获得真实反射与 specular 生命;
    // 低强度保留夜景工业气氛(只在材质细节里"呼吸",不提亮全场)
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer)
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
      this.scene.environmentIntensity = 0.42
      pmrem.dispose()
    }
    catch { /* 环境贴图失败:退回纯灯光方案 */ }

    // 穹顶渐变天幕(深空蓝黑 → 地平线工业暖灰;BackSide 大球,随镜头平移)
    this.skyDome = this.makeSkyDome()
    this.scene.add(this.skyDome)

    // 边界缩放手柄(编辑模式选中频道时显示;4 个:椭圆轴点 / 矩形角点)
    for (let i = 0; i < 4; i++) {
      const h = new THREE.Mesh(
        new THREE.TorusGeometry(16, 6, 8, 20),
        new THREE.MeshBasicMaterial({ color: 0xf6c453, transparent: true, opacity: 0.95, depthTest: false }),
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
        new THREE.MeshBasicMaterial({ color: 0x41c8f4, transparent: true, opacity: 0.95, depthTest: false }),
      )
      h.rotation.x = Math.PI / 2
      h.position.y = 1.2
      h.visible = false
      this.scene.add(h)
      this.agentRangeHandles.push({ mesh: h, agentId: '', handle: i })
    }

    // 选中高亮环:单位几何 + 每帧按目标缩放(琥珀 #f6c453,加性发光,慢转活性)
    const selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1.0, 56),
      new THREE.MeshBasicMaterial({ color: 0xf6c453, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    )
    selRing.rotation.x = -Math.PI / 2
    selRing.position.y = 0.5
    selRing.visible = false
    selRing.renderOrder = 5
    this.scene.add(selRing)
    this.selRing = selRing

    // 相机:斜俯视 2.5D(FOV 55 + 远距框景,整个园区一块入画)
    this.camera = new THREE.PerspectiveCamera(55, (this.el.clientWidth || 1100) / (this.el.clientHeight || 700), 1, 12000)
    this.camera.position.set(WORLD_CX, 760, WORLD_CZ + 900)
    this.camera.lookAt(WORLD_CX, 20, WORLD_CZ)

    // Blender 式变换手柄:选中设备时出现(移动 G / 旋转 R / 缩放 S;UI 分段钮 + 键盘同源)
    const tc = new TransformControls(this.camera, this.renderer.domElement)
    tc.size = 0.85
    tc.setMode('translate')
    tc.showY = false
    tc.addEventListener('dragging-changed', (e) => {
      // 手柄拖拽期间压制场景点选/相机平移;松手后设备 transform 落库
      if (!e.value) {
        const sel = this.selected
        if (sel?.kind === 'device' && this.deviceNodes.has(sel.id)) this.persistDeviceTransform(sel.id)
      }
    })
    tc.addEventListener('objectChange', () => {
      const sel = this.selected
      if (!sel || sel.kind !== 'device') return
      const dev = this.deviceNodes.get(sel.id)
      if (!dev) return
      // 缩放转移:gizmo 对 root 的缩放倍率转移到模型 holder(免得环/铭牌跟着变大),root 复位
      if (tc.mode === 'scale' && Math.abs(dev.root.scale.x - 1) > 1e-4) {
        const reg = this.scalables.get(`device:${sel.id}`)
        const cur = reg?.userScale ?? 1
        this.setModelScale(sel.id, Math.min(50, Math.max(0.02, cur * dev.root.scale.x)), 'device')
        dev.root.scale.set(1, 1, 1)
      }
      this.dirty = true
    })
    this.tControls = tc
    this.scene.add(tc.getHelper())

    // 灯光:为 ACES 配平(整体提亮补偿 filmic 滚降;normalBias 消除模型自阴影痤疮)
    this.scene.add(new THREE.AmbientLight(0xd0e4ee, 1.6))
    const hemi = new THREE.HemisphereLight(0x9fc7e8, 0x3a2f25, 0.7)
    this.scene.add(hemi)
    const key = new THREE.DirectionalLight(0xfff4e0, 3.2)
    key.position.set(WORLD_CX + 500, 900, WORLD_CZ + 300)
    key.castShadow = true
    this.keyLight = key
    // 高分辨率软影:2048 map + 大 radius(PCSS 观感),贴地阴影是真实感的核心来源
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -1400
    key.shadow.camera.right = 1400
    key.shadow.camera.top = 2000
    key.shadow.camera.bottom = -2000
    key.shadow.normalBias = 2
    key.shadow.bias = -0.0002
    key.shadow.radius = 6
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0x88bbff, 0.75)
    fill.position.set(WORLD_CX - 1200, 900, WORLD_CZ - 800)
    this.scene.add(fill)
    // 设计稿光系补光:青色轮廓光(金属切边高光)+ 绿色低位补光(孪生绿氛围)
    const rim = new THREE.DirectionalLight(0x41c8f4, 1.4)
    rim.position.set(WORLD_CX - 1400, 620, WORLD_CZ - 1000)
    this.scene.add(rim)
    const green = new THREE.DirectionalLight(0x35e0a0, 0.4)
    green.position.set(WORLD_CX + 700, 380, WORLD_CZ + 900)
    this.scene.add(green)

    // 地面(大平面,无限观感:7× 世界尺寸 + 高重复贴图)——夜航深蓝地坪;低反射让网格退为纹理
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.3, envMapIntensity: 0.42 })
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W * 16, WORLD_H * 16), groundMat)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    // 绑定链路层 + 薄膜 web 层(syncDaqLinks / 产线设备增删移动时重建)
    this.scene.add(this.daqLinkGroup, this.filmWebGroup)

    // 后处理:RenderPass → UnrealBloom(夜航辉光只作用于 HDR 顶端:阈值 3.0 =
    // 本灯光系下漫反射亮面(2~2.5 线性)不起晕,只留指示灯/金属高光;LED 等指示件
    // 已按 ×4.5~6 提为 HDR)→ OutputPass(tone mapping + sRGB 收尾;setExposure
    // 经 OutputPass 透传仍实时生效)。MSAA 目标保住抗锯齿(EffectComposer 默认无 MSAA)。
    const bloomTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(this.renderer, bloomTarget)
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.composer.setSize(this.el.clientWidth || 1100, this.el.clientHeight || 700)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.el.clientWidth || 1100, this.el.clientHeight || 700), 0.32, 0.35, 3.0))
    this.composer.addPass(new OutputPass())

    this.applyGroundTexture()

    // E2E/性能探针钩子:真值验证用(渲染帧计数/质量档/pixelRatio),dispose 时清除
    ;(globalThis as { __townScene3d?: TownScene3D }).__townScene3d = this
    this.loop()
  }

  /** 工业孪生地面贴图(程序化 Canvas:深色混凝土地基 + 分块拼缝 + 细网格导引线 + 噪点)。
   *  一次性生成并缓存;SVG 背景贴图仅作历史兼容,优先使用本贴图。 */
  private makeIndustrialGroundTexture(): THREE.CanvasTexture {
    const size = 1024
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    // 深色混凝土地基(微渐变)+ 分块拼缝 + 细网格导引线 —— 夜航深蓝基调(设计稿 #131f36 系)
    const grad = ctx.createLinearGradient(0, 0, size, size)
    grad.addColorStop(0, '#151f36')
    grad.addColorStop(0.5, '#101a2d')
    grad.addColorStop(1, '#131c31')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    // 分块拼缝(工业板格 8×8;低调度 —— 地面是舞台,不是主角)
    ctx.strokeStyle = 'rgba(42,63,102,0.32)'
    ctx.lineWidth = 2
    for (let i = 0; i <= 8; i++) {
      const p = (i / 8) * size
      ctx.beginPath()
      ctx.moveTo(p, 0)
      ctx.lineTo(p, size)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, p)
      ctx.lineTo(size, p)
      ctx.stroke()
    }
    // 细网格导引线(设计稿 GridHelper 主色 0x2a3f66;压暗让设备读第一眼)
    ctx.strokeStyle = 'rgba(42,63,102,0.2)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 32; i++) {
      const p = (i / 32) * size
      ctx.beginPath()
      ctx.moveTo(p, 0)
      ctx.lineTo(p, size)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, p)
      ctx.lineTo(size, p)
      ctx.stroke()
    }
    // 噪点(亚光粗糙感;伪随机但确定性)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    for (let i = 0; i < 900; i++) {
      const x = (i * 733) % size
      const y = (i * 151) % size
      ctx.fillRect(x, y, 2, 2)
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(23, 17)
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    return tex
  }

  /** 穹顶天幕:垂直渐变(顶部深空 → 地平线工业暖灰)+ 顶半球星野 + 底部更亮一点,覆盖整球 */
  private makeSkyDome(): THREE.Mesh {
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 256
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, '#080d16') // 天顶:近黑夜空
    grad.addColorStop(0.40, '#121b27')
    grad.addColorStop(0.64, '#22303e') // 中段石墨蓝(提前起坡,渐变带更长)
    grad.addColorStop(0.84, '#3b4b5b') // 地平线:钢色微光(与雾同族)
    grad.addColorStop(1, '#2a3644') // 地平线下收暗(下半球)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // 星野(顶部 45%:确定性伪随机,数据青/冷白微点,越靠天顶越密 —— 夜航纵深,低调度不抢戏)
    let seed = 20260831
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 220; i++) {
      const x = rnd() * canvas.width
      const y = rnd() * rnd() * 118
      const r = rnd() < 0.88 ? 1 : 2
      const a = 0.12 + rnd() * 0.5
      ctx.fillStyle = rnd() < 0.24 ? `rgba(160,220,255,${a.toFixed(2)})` : `rgba(232,240,250,${a.toFixed(2)})`
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const geo = new THREE.SphereGeometry(5600, 24, 16)
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
    const dome = new THREE.Mesh(geo, mat)
    dome.position.set(WORLD_CX, 0, WORLD_CZ)
    dome.renderOrder = -10
    return dome
  }

  /** 赛博小镇背景贴图 → 地面材质(优先程序化工业贴图;SVG 兼容保留) */
  private applyGroundTexture(): void {
    try {
      const mat = this.ground.material as THREE.MeshStandardMaterial
      // 工业孪生贴图为主(SVG 历史贴图只在程序化不可用时兜底)
      mat.map = this.makeIndustrialGroundTexture()
      mat.color.set(0xffffff)
      mat.roughness = 0.94
      mat.metalness = 0.06
      // 环境反射压低:沥青地面保持亚光,反射生命留给金属设备/角色模型
      mat.envMapIntensity = 0.28
      mat.needsUpdate = true
      this.dirty = true
    }
    catch { /* Canvas 不可用:保持纯色地面 */ }
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
    const pad = this.makeBlock(ch.channelName, color, layout)
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

  /** 领地底盘 = 按真实形状的平台(染色层) + 同形边框环(边界告示);所见即用户设置 */
  private makeBlock(name: string, color: number, layout: ChannelLayout): { platform: THREE.Mesh, padRing: THREE.Mesh, beacon: THREE.Group } {
    const rotY = layout.rotationY * Math.PI / 180
    // 平台:按真实半轴构建(与边框环同一构建路径,无单位几何、无 scale 传递 —— 杜绝缩放残留)
    const platform = new THREE.Mesh(
      this.makePadShapeGeometry(layout.shape, layout.radiusX, layout.radiusZ),
      new THREE.MeshStandardMaterial({
        color, transparent: true, opacity: 0.24, roughness: 0.85, metalness: 0.12,
        emissive: color, emissiveIntensity: 0.12, side: THREE.DoubleSide,
      }),
    )
    // 几何已烘焙放平(XY→XZ 无镜像),网格仅做 Y 旋转(与边界线同语义),不再有任何 scale
    platform.rotation.set(0, rotY, 0)
    platform.position.set(layout.x, 0.16, layout.z)
    platform.receiveShadow = false
    this.scene.add(platform)
    // 边框环:实际尺寸外形挖去内缩内形(恒定 13 单位线宽,随形状变化重建)
    const padRing = new THREE.Mesh(
      this.makePadRingGeometry(layout.shape, layout.radiusX, layout.radiusZ),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.52, side: THREE.DoubleSide, depthWrite: false }),
    )
    padRing.rotation.set(0, rotY, 0)
    padRing.position.set(layout.x, 0.34, layout.z)
    this.scene.add(padRing)
    // 中央信标(HMI 定位销):底座 + 立杆 + 频道色菱形顶标(顶标随渲染循环缓转)
    const beacon = this.makeBeacon(color)
    beacon.position.set(layout.x, 0, layout.z)
    this.scene.add(beacon)
    void name
    return { platform, padRing, beacon }
  }

  /** 频道中心信标(HMI 定位销):点击 → pickBeacon 定位中心 + 唤醒边界编辑 */
  private makeBeacon(color: number): THREE.Group {
    const g = new THREE.Group()
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a3542, roughness: 0.45, metalness: 0.65 })
    const base = new THREE.Mesh(new THREE.CylinderGeometry(7, 9, 5, 12), metal)
    base.position.y = 2.5
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 30, 8), metal)
    pole.position.y = 18
    const tip = new THREE.Mesh(new THREE.OctahedronGeometry(6.5), new THREE.MeshBasicMaterial({ color }))
    // HDR 亮度:信标顶标是 HMI 定位销的"灯",bloom 起晕(seleRing/边界保持 LDR 不起晕)
    ;(tip.material as THREE.MeshBasicMaterial).color.multiplyScalar(4.5)
    tip.position.y = 37
    g.add(base, pole, tip)
    return g
  }

  /** 命中频道信标(中心 ±34 单位;点击信标 = 定位中心 + 唤醒边界编辑,任何模式) */
  private pickBeacon(x: number, z: number): { cid: string, x: number, z: number } | null {
    for (const b of this.blocks.values()) {
      if (Math.hypot(b.x - x, b.z - z) < 34) return { cid: b.channelId, x: b.x, z: b.z }
    }
    return null
  }

  /** 领地平台面几何:按真实半轴的外形(椭圆/矩形);放平烘焙进顶点(XY→XZ,无镜像),
   *  网格仅需 rotation.y —— 与边界线同一旋转语义,任意朝向严格贴合 */
  private makePadShapeGeometry(shape: 'ellipse' | 'rect', radiusX: number, radiusZ: number): THREE.ShapeGeometry {
    const shp = new THREE.Shape()
    if (shape === 'rect') {
      shp.moveTo(-radiusX, -radiusZ)
      shp.lineTo(radiusX, -radiusZ)
      shp.lineTo(radiusX, radiusZ)
      shp.lineTo(-radiusX, radiusZ)
      shp.closePath()
    }
    else {
      shp.absellipse(0, 0, radiusX, radiusZ, 0, Math.PI * 2)
    }
    const geo = new THREE.ShapeGeometry(shp, shape === 'rect' ? 1 : 56)
    geo.rotateX(Math.PI / 2)
    return geo
  }

  /** 领地边框几何:外形挖去内缩 ringW 的同形内形(椭圆/矩形;恒定世界线宽) */
  private makePadRingGeometry(shape: 'ellipse' | 'rect', radiusX: number, radiusZ: number, ringW = 13): THREE.ShapeGeometry {
    const irx = Math.max(4, radiusX - ringW)
    const irz = Math.max(4, radiusZ - ringW)
    const outer = new THREE.Shape()
    const inner = new THREE.Path()
    if (shape === 'rect') {
      outer.moveTo(-radiusX, -radiusZ)
      outer.lineTo(radiusX, -radiusZ)
      outer.lineTo(radiusX, radiusZ)
      outer.lineTo(-radiusX, radiusZ)
      outer.closePath()
      inner.moveTo(-irx, -irz)
      inner.lineTo(irx, -irz)
      inner.lineTo(irx, irz)
      inner.lineTo(-irx, irz)
      inner.closePath()
    }
    else {
      outer.absellipse(0, 0, radiusX, radiusZ, 0, Math.PI * 2)
      inner.absellipse(0, 0, irx, irz, 0, Math.PI * 2)
    }
    outer.holes.push(inner)
    const geo = new THREE.ShapeGeometry(outer, shape === 'rect' ? 1 : 56)
    geo.rotateX(Math.PI / 2)
    return geo
  }

  /** 平台/边框贴形(半径或形状变化后):平台与边框几何都按真实尺寸重建;同步朝向 */
  private applyPadToBlock(b: Block3D): void {
    const rotY = b.rotationY * Math.PI / 180
    b.platform.rotation.set(0, rotY, 0)
    b.padRing.rotation.set(0, rotY, 0)
    const oldP = b.platform.geometry
    b.platform.geometry = this.makePadShapeGeometry(b.shape, b.radiusX, b.radiusZ)
    oldP.dispose()
    const old = b.padRing.geometry
    b.padRing.geometry = this.makePadRingGeometry(b.shape, b.radiusX, b.radiusZ)
    old.dispose()
  }

  /** 文本 Sprite(名牌/名字)—— HMI 铭牌:深底 + 发丝描边 + 左缘数据条 + 等宽字。
   *  accent: 左缘数据条与描边 tint 的身份色(Agent 铭牌传所属频道哈希色 → 归属一眼可辨)。 */
  private makeLabel(text: string, x: number, y: number, z: number, accent = '#41c8f4'): THREE.Sprite {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    const font = '600 21px "Geist Mono", Geist, "PingFang SC", monospace'
    ctx.font = font
    const padL = 26
    const padR = 14
    const w = Math.max(104, Math.ceil(ctx.measureText(text).width) + padL + padR)
    const h = 48
    canvas.width = w
    canvas.height = h
    ctx.font = font
    // 深色铭牌底 + 半透明度(不遮场景,只提字)
    ctx.fillStyle = 'rgba(10,14,20,0.8)'
    ctx.fillRect(0, 0, w, h)
    // 发丝描边(身份色轻 tint)+ 左缘数据条(身份色)
    ctx.strokeStyle = `${accent}66`
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
    ctx.fillStyle = accent
    ctx.fillRect(0, 0, 3, h)
    ctx.fillStyle = '#dce7f0'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, padL, h / 2 + 1)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
    sprite.scale.set(w / 6, h / 6, 1)
    sprite.position.set(x, y, z)
    this.scene.add(sprite)
    return sprite
  }

  /** int 颜色 → CSS hex(铭牌身份色用) */
  private hexOf(color: number): string {
    return `#${color.toString(16).padStart(6, '0')}`
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
    const range: AgentRangeLayout | null = a.range ?? null
    const root = new THREE.Group()
    root.position.set(homeX, GROUND_Y, homeZ)
    const nameSprite = this.makeLabel(a.name, homeX, 48, homeZ, this.hexOf(color))
    // 默认模型(内置二次元角色 hero-anime-1「樱叶少女」;模型库换装可覆盖)
    const texKey = a.modelRef || 'hero-anime-1'
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
      colorNum: color,
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
    agent.attachAura(color, a.role)
    this.agents.set(key, agent)
    // 载入模型(GLB);模型库注册先于/晚于挂载都能正确解析(内置二次元角色按 id 直取文件)
    const info = this.modelsById.get(texKey)
      ?? (texKey.startsWith('hero-anime-')
        ? { id: texKey, file: `/assets/game/character/${texKey}.glb`, name: '二次元角色' }
        : (this.modelsById.get('hero-3d') ?? { id: 'hero-3d', file: '/assets/game/character/hero-3d.glb', name: '标准员工模型' }))
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
        // 缓存动画 clip(供 mixer 状态切换;GLTFLoader 动画必须在解析层保留)
        this.agentAnimClips.set(file, gltf.animations)
      }
      catch {
        // 加载失败回退程序化「孪生机器人」(胶囊躯干 + 发光核心 + 天线),角色永不隐形
        loaded = this.makeFallbackBot()
        height = 1.4
      }
    }
    // 归一化 scale(使模型高度≈UNITS 世界单位)并贴地(模型大小自适应)
    loaded.position.y = 0
    loaded.scale.setScalar(UNITS / height)
    // 真实投影 + PBR 增强:模型网格 cast/receiveShadow(体积感) + 分级环境反射(角色质感)
    loaded.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true
    })
    this.enhancePbrMaterials(loaded, 'character')
    // 清掉旧模型子节点与 mixer
    asp.model.clear()
    asp.model.add(loaded)
    // 客制化:注册可缩放目标并恢复用户缩放(套在 asp.model 上,作为自适应之上的倍率层)
    this.registerScalable('agent', asp.agentId, asp.model)
    asp.mixer = null
    asp.activeAction = null
    const clips = this.agentAnimClips.get(file) ?? []
    const firstClip = clips[0]
    if (firstClip) {
      asp.mixer = new THREE.AnimationMixer(loaded)
      asp.clips = clips
      const firstAction = asp.mixer.clipAction(firstClip)
      firstAction.play()
      asp.activeAction = firstAction
    }
    void name
    this.dirty = true
  }

  private agentAnimClips = new Map<string, THREE.AnimationClip[]>()

  private loadGltf(file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
    return new Promise((resolve, reject) => {
      this.gltfLoader.load(file, gltf => resolve({ scene: gltf.scene as THREE.Group, animations: gltf.animations ?? [] }), undefined, reject)
    })
  }

  /**
   * 程序化「孪生机器人」兜底模型:GLB 缺失/加载失败时使用,保证 Agent 永远可见。
   * 结构:胶囊躯干 + 头部 + 发光核心胸灯 + 天线信号球 + 悬浮底盘;中性工业灰 + 青蓝核心。
   */
  private makeFallbackBot(): THREE.Group {
    const bot = new THREE.Group()
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a3542, roughness: 0.42, metalness: 0.62 })
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x141b24, roughness: 0.6, metalness: 0.4 })
    const coreMat = new THREE.MeshBasicMaterial({ color: 0x41c8f4 })
    // 躯干(胶囊)
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.62, 8, 16), bodyMat)
    body.position.y = 0.86
    // 头部
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), bodyMat)
    head.position.y = 1.62
    // 面窗(发光条带,数字孪生眼)
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.12), coreMat)
    visor.position.set(0, 1.66, 0.27)
    // 发光核心胸灯
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), coreMat)
    core.position.set(0, 1.1, 0.36)
    // 悬浮底盘
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 0.26, 16), darkMat)
    base.position.y = 0.16
    // 天线 + 信号球
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6), darkMat)
    antenna.position.set(0, 2.04, 0)
    const signal = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), coreMat)
    signal.position.set(0, 2.34, 0)
    bot.add(body, head, visor, core, base, antenna, signal)
    return bot
  }

  /** 注册模型清单，并将晚到资产挂载到已存在的 Agent/设备。 */
  registerModelsFromList(list: Array<{ id: string, file: string, name: string, kind?: string, hFactor?: number }>): void {
    if (this.disposed) return
    const changed = new Set<string>()
    for (const model of list) {
      const previous = this.modelsById.get(model.id)
      if (!previous || previous.file !== model.file || previous.name !== model.name || previous.kind !== model.kind || previous.hFactor !== (model.hFactor ?? 1)) {
        this.modelsById.set(model.id, { ...model, hFactor: model.hFactor ?? 1 })
        changed.add(model.id)
      }
    }
    if (changed.size > 0) {
      for (const agent of this.agents.values()) {
        if (!agent.modelRef || !changed.has(agent.modelRef)) continue
        const model = this.modelsById.get(agent.modelRef)
        if (model) void this.mountModel(agent, model.file, model.name)
      }
      for (const device of this.deviceNodes.values()) {
        if (changed.has(device.modelRef)) this.swapDeviceModelSprite(device, device.modelRef)
      }
    }
    for (const twin of [...this.pendingDeviceTwins.values()]) {
      const isDaq = twin.kind === 'daq' || (twin.modelRef ?? '').startsWith('daq-')
      if (!isDaq && !this.modelsById.get(twin.modelRef)?.file) continue
      this.pendingDeviceTwins.delete(twin.id)
      this.recreateDeviceNode(twin)
    }
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

  /** 设备换模型:按 modelRef 重挂 GLB 到 holder(由 DeviceNode.applyTwin 委托)。 */
  swapDeviceModelSprite(dev: DeviceNode, modelRef: string): void {
    const info = this.modelsById.get(modelRef)
    if (!info?.file) return
    if (dev.modelRef === modelRef && dev.holder.userData.modelFile === info.file) return
    dev.modelRef = modelRef
    dev.holder.clear()
    dev.holder.userData.modelFile = info.file
    void this.loadGltfToGroup(info.file, dev.holder, UNITS * 1.6)
    this.dirty = true
  }

  /** 统一实例化入口:按数据库元数据(布局/实体/设备孪生)实例化并初始化场景内全部实例。 */
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
      const pad = this.makeBlock(channelName, color, layout)
      const block = new Block3D({
        channelId, name: channelName, x, z,
        radiusX: layout.radiusX, radiusZ: layout.radiusZ,
        shape: layout.shape, rotationY: layout.rotationY, color,
        platform: pad.platform,
        padRing: pad.padRing,
        beacon: pad.beacon,
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
    this.applyPadToBlock(b)
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
    this.scene.remove(b.padRing)
    this.scene.remove(b.beacon)
    if (b.boundary) this.scene.remove(b.boundary)
    this.scene.remove(b.label)
    for (const [aid, a] of [...this.agents.entries()]) {
      if (a.channelId === channelId) {
        this.scene.remove(a.root)
        if (a.nameSprite) this.scene.remove(a.nameSprite)
        if (a.bubble) this.scene.remove(a.bubble)
        if (a.rangeLine) this.scene.remove(a.rangeLine)
        this.disposeAgentAssets(a)
        this.agents.delete(aid)
      }
    }
    if (b.label) this.disposeCanvasTextures(b.label)
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
    b.padRing.position.set(b.x, 0.34, b.z)
    this.applyPadToBlock(b)
    if (b.boundary) this.scene.remove(b.boundary)
    b.boundary = makeBoundary(b.shape, b.radiusX, b.radiusZ, b.color)
    b.boundary.position.set(b.x, 0.3, b.z)
    b.boundary.rotation.y = b.rotationY * Math.PI / 180
    this.scene.add(b.boundary)
    this.dirty = true
  }

  /** 边界手柄本地坐标(椭圆:轴向四点;矩形:四角;radius 是半轴或半宽)。 */
  private boundaryHandlePoints(layout: { radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' }): Array<[number, number]> {
    if (layout.shape === 'rect') return [[layout.radiusX, layout.radiusZ], [-layout.radiusX, layout.radiusZ], [-layout.radiusX, -layout.radiusZ], [layout.radiusX, -layout.radiusZ]]
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
      if (Math.hypot(hl.mesh.position.x - x, hl.mesh.position.z - z) < 90) return { cid: hl.cid, handle: hl.handle }
    }
    return null
  }

  /** 拖拽手柄 → 实时调整 radiusX/radiusZ(矩形:角点双轴;椭圆:对应轴向轴点)。 */
  private applyResize(b: Block3D, handle: number, wx: number, wz: number): void {
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
    this.applyLayoutToBlock(b)
    this.refreshChannelHandles()
    this.autoFrameTo(b.radiusX, b.radiusZ)
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
      m.color.setHex(bb.channelId === channelId ? 0xf6c453 : bb.color)
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
      this.pulseRing(x, z, asp ? 0x41c8f4 : (b?.color ?? 0x41c8f4))
    }
    else if (e.type === 'error' || (e.type === 'task.status' && ((e.payload as { state?: string }).state === 'failed' || (e.payload as { state?: string }).state === 'canceled'))) {
      this.pulseRing(x, z, 0xff6b6b)
    }
    else if (e.type === 'task.status' && (e.payload as { state?: string }).state === 'completed') {
      this.lightColumn(x, z, 0x35e0a0)
    }
  }

  /** 事件共鸣扩散环(时间基:800ms 缓出扩散 + 淡出;帧率无关,结束即释放资源) */
  private pulseRing(x: number, z: number, color: number): void {
    const ring = new THREE.Mesh(new THREE.RingGeometry(10, 22, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }))
    ring.rotation.x = -Math.PI / 2
    ring.position.set(x, 0.4, z)
    this.scene.add(ring)
    const start = performance.now()
    const dur = 800
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / dur)
      const e = 1 - Math.pow(1 - k, 3)
      ring.scale.setScalar(1 + e * 1.6)
      ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - e)
      if (k >= 1) {
        this.scene.remove(ring)
        ring.geometry.dispose()
        ;(ring.material as THREE.MeshBasicMaterial).dispose()
        return
      }
      this.rafAnims.push(step)
    }
    this.rafAnims.push(step)
  }

  /** 交付光柱(时间基:底部锚定向上生长 + 淡出;几何上移锚定,修复旧零高度柱不可见的缺陷) */
  private lightColumn(x: number, z: number, color: number): void {
    const geo = new THREE.CylinderGeometry(6, 12, 120, 16)
    geo.translate(0, 60, 0)
    const beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }))
    beam.position.set(x, 0, z)
    beam.scale.y = 0.01
    this.scene.add(beam)
    const start = performance.now()
    const dur = 900
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / dur)
      const e = 1 - Math.pow(1 - k, 2)
      beam.scale.y = 0.01 + e * 0.99
      ;(beam.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k)
      if (k >= 1) {
        this.scene.remove(beam)
        beam.geometry.dispose()
        ;(beam.material as THREE.MeshBasicMaterial).dispose()
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
    if (this.dbgBubbles.length > 30) this.dbgBubbles.splice(0, this.dbgBubbles.length - 30)
    const speaker = agentId ? this.agents.get(agentId)?.name : undefined
    this.lastActivity = { channelId, agentName: speaker ?? this.blocks.get(channelId)?.name ?? '系统', text, at: Date.now() }
    this.recentActivity.push(this.lastActivity)
    if (this.recentActivity.length > 30) this.recentActivity.splice(0, this.recentActivity.length - 30)
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

  /** 各频道接收器 FIFO 消费:当前条目展示期满 → 清理其气泡并取下一条实时渲染(渲染循环每帧调用)。
   *  队列积压时按 drainDisplayMs 压缩单条时长,让爆发期消息尽快追平。 */
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
      rec.currentUntil = now + drainDisplayMs(msg.text, rec.queue.length)
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
      ? asp.colorNum
      : (b?.color ?? 0x41c8f4)
    const text = (msg.kind === 'artifact' && !msg.text.startsWith('📦') ? `📦 ${msg.text}` : msg.text) || '…'
    const sprite = this.makeChatBubble(text, name, accent, msg.kind)
    const x = asp?.root.position.x ?? b!.x
    const z = asp?.root.position.z ?? b!.z
    // 放大气泡后锚点整体抬升(避免压到 48 处名牌)
    sprite.position.set(x, asp ? BUBBLE_Y + 22 + Math.max(0, asp.model.scale.y - 1) * 22 : 64, z)
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
      this.disposeCanvasTextures(asp.bubble)
      asp.bubbleText = null
    }
    asp.bubble = sprite
    asp.bubbleText = text
    this.popInSprite(sprite)
    this.dirty = true
  }

  /** 2.5D 聊天气泡:工业 HMI 风格 —— 头部身份条(等宽名牌 + 类型印章)+ 多行正文 + 尾角 */
  private makeChatBubble(text: string, name: string, accent: number, kind: TownBubbleKind): THREE.Sprite {
    const accentHex = `#${accent.toString(16).padStart(6, '0')}`
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    // 超大字号会话气泡:正文 18px / 头名 13px / 最多 6 行 / 宽 ≤ 680px —— 实时信息一眼可读
    const bodyFont = '18px Geist, "PingFang SC", sans-serif'
    const headFont = '600 13px "Geist Mono", Geist, "PingFang SC", monospace'
    const tagFont = '600 10px "Geist Mono", Geist, monospace'
    const maxTextW = 470
    const padX = 18
    const padY = 12
    const nameH = 26
    const lineH = 24
    const tailH = 13
    ctx.font = bodyFont
    const lines = this.wrapBubbleLines(ctx, text.replace(/\s+/g, ' ').trim() || '…', maxTextW, 6)
    const textW = Math.max(...lines.map(l => ctx.measureText(l).width))
    const bw = Math.min(680, Math.max(140, Math.ceil(textW) + padX * 2))
    const bodyH = nameH + lines.length * lineH + padY * 2
    const bh = bodyH + tailH
    canvas.width = bw
    canvas.height = bh
    ctx.clearRect(0, 0, bw, bh)
    // 方角矩形 + 底部中央尾角(指向说话人;HMI 直角配方)
    const r = 4
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
    // 柔和投影 → 深色面板底
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.55)'
    ctx.shadowBlur = 14
    ctx.shadowOffsetY = 4
    path()
    ctx.fillStyle = 'rgba(14,18,27,0.94)'
    ctx.fill()
    ctx.restore()
    // 头部数据带(轻微抬升 + 发丝底边)
    ctx.save()
    path()
    ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.045)'
    ctx.fillRect(0, 0, bw, padY + nameH)
    ctx.restore()
    ctx.globalAlpha = 0.28
    ctx.fillStyle = '#fff'
    ctx.fillRect(padX, padY + 18, bw - padX * 2, 1)
    ctx.globalAlpha = 1
    // 发丝描边 + 左缘身份色数据条
    path()
    ctx.lineWidth = 1.2
    ctx.strokeStyle = 'rgba(140,170,195,0.4)'
    ctx.stroke()
    ctx.save()
    path()
    ctx.clip()
    ctx.fillStyle = accentHex
    ctx.fillRect(0, 0, 3, bodyH)
    ctx.restore()
    // 头牌:等宽名牌(身份色)+ 右侧类型印章(交付/异常)
    ctx.font = headFont
    ctx.fillStyle = accentHex
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(name, padX, padY + 10)
    const tag = kind === 'artifact' ? 'ARTIFACT' : kind === 'error' ? 'FAULT' : ''
    if (tag) {
      const tw = ctx.measureText(tag).width + 12
      ctx.font = tagFont
      ctx.fillStyle = kind === 'error' ? '#ff8d80' : '#9fc3e8'
      ctx.strokeStyle = kind === 'error' ? 'rgba(255,141,128,0.55)' : 'rgba(159,195,232,0.45)'
      ctx.lineWidth = 1
      const tx = bw - padX - tw
      const ty = padY + 2
      const th = 16
      ctx.beginPath()
      ctx.rect(tx, ty, tw, th)
      ctx.fill()
      ctx.stroke()
      ctx.textAlign = 'center'
      ctx.fillText(tag, tx + tw / 2, ty + th / 2 + 0.5)
    }
    // 正文(错误微红)
    ctx.font = bodyFont
    ctx.fillStyle = kind === 'error' ? '#ff9d9d' : '#eef2fb'
    ctx.textAlign = 'left'
    lines.forEach((l, i) => ctx.fillText(l, padX, padY + nameH + 10 + i * lineH))
    // Sprite(纹理按 1/2.4 缩放到世界单位 —— 放大气泡后保持更大可见尺度)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }))
    const k = 2.4
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

  /** 世界坐标 → 屏幕像素(数据标注/悬浮 callout 投影;返回 null = 在相机背后) */
  worldToScreen(x: number, y: number, z: number): { x: number, y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    // 相机背后的点 project() 会按负 w 翻转到错误的屏幕位置 → 先用前向点积剔除
    const dir = TownScene3D._wDir
    this.camera.getWorldDirection(dir)
    const rel = TownScene3D._wRel.set(x - this.camera.position.x, y - this.camera.position.y, z - this.camera.position.z)
    if (rel.dot(dir) <= 0.1) return null
    const v = TownScene3D._wVec.set(x, y, z).project(this.camera)
    if (v.z > 1) return null
    // 视锥外过远(NDC ±1.6)的点投影无意义(可能落到数千 px 外)→ 剔除;边缘 ±1 内保留供夹取
    if (Math.abs(v.x) > 1.6 || Math.abs(v.y) > 1.6) return null
    return {
      x: rect.left + (v.x + 1) / 2 * rect.width,
      y: rect.top + (1 - v.y) / 2 * rect.height,
    }
  }

  /** 页面坐标 → 世界 xz(经 canvas rect + 相机射线打在 y=0 平面) */
  screenToWorld(clientX: number, clientY: number): { x: number, z: number } {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1
    const raycaster = TownScene3D._raycaster
    raycaster.setFromCamera(TownScene3D._wVec2.set(ndcX, ndcY), this.camera)
    const pt = TownScene3D._wVec
    raycaster.ray.intersectPlane(TownScene3D._groundPlane, pt)
    return pt ? { x: pt.x, z: pt.z } : { x: this.camera.position.x, z: this.camera.position.z }
  }

  /** 平移相机(拖拽):移动 camTarget(相机位置由 loop 据 target+dolly 推导) */
  panBy(dxWorld: number, dzWorld: number): void {
    this.camTarget.x -= dxWorld
    this.camTarget.z -= dzWorld
  }

  /** 自动取景目标 dolly(缩放拖拽期间按范围尺寸计算;渲染循环平滑跟随,拖拽结束清除) */
  private autoDolly: number | null = null

  /** 范围半轴 → 容纳它的 dolly(基线几何:水平半幅 ≈ 613*aspect*d,地面纵深 ≈ 950*d) */
  private fitDollyFor(rx: number, rz: number): number {
    const aspect = this.camera.aspect || 1.6
    return Math.max(rx / (0.82 * 613 * aspect), rz / (0.82 * 950))
  }

  /** 缩放过程中调用:范围超出当前视野 → 相机自动拉远(只放大不缩小,收敛于拖拽结束) */
  private autoFrameTo(rx: number, rz: number): void {
    const fit = this.fitDollyFor(rx, rz)
    if (fit > this.dolly) this.autoDolly = Math.min(40, fit * 1.18)
  }

  /** 变换模式(Blender 规范):translate=移动 G / rotate=旋转 R / scale=缩放 S。
   *  轴约束:移动仅 XZ(模型贴地),旋转仅 Y(2.5D 朝向),缩放 XYZ。 */
  setTransformMode(mode: 'translate' | 'rotate' | 'scale'): void {
    if (!this.tControls) return
    this.tControls.setMode(mode)
    this.tControls.showX = mode !== 'rotate'
    this.tControls.showY = mode !== 'translate'
    this.tControls.showZ = mode !== 'rotate'
  }

  /** 手柄是否悬停/拖拽中(调用方应让出相机平移与点选) */
  isGizmoBusy(): boolean {
    return !!this.tControls && (this.tControls.dragging || !!this.tControls.axis)
  }

  /** 滚轮缩放(改变 dolly 距离) */
  /** 视角预设(设计稿 angle-chip):std 标准 / top 俯视 / front 前视 / side 侧视。
   *  轨道参数:yaw 方位 / pitch 仰角(rad) / radius 半径(再乘 dolly)。 */
  setViewPreset(p: 'std' | 'top' | 'front' | 'side'): void {
    const presets: Record<string, { yaw: number, pitch: number, radius: number }> = {
      std: { yaw: 0, pitch: 0.70, radius: 1178 },
      top: { yaw: 0, pitch: 1.51, radius: 2400 },
      front: { yaw: 0, pitch: 0.09, radius: 1510 },
      side: { yaw: Math.PI / 2, pitch: 0.33, radius: 1320 },
    }
    const t = presets[p] ?? presets.std!
    this.viewTarget = { ...t }
    // 预设切换走平滑趋近;环绕拖拽则是即时双写
  }

  /** 左键环绕(设计稿 OrbitLite 语义):theta -= dx·0.0052(拖右=场景右转,内容跟手不反向);
   *  phi -= dy·0.0052(拖上=压低视角看地平,拖下=抬升俯视),夹在仰角安全区间 */
  /** 环绕(设计稿 OrbitLite 1:1):theta -= dx·0.0052;仰角 += dy·0.0052
   *  (设计稿 phi -= dy·0.0052,phi 为极角 → 仰角随 dy 增大:往下拖 = 相机升向俯视) */
  orbitBy(dxPx: number, dyPx: number): void {
    const yaw = this.viewCur.yaw - dxPx * 0.0052
    const pitch = Math.min(1.52, Math.max(0.06, this.viewCur.pitch + dyPx * 0.0052))
    this.viewCur = { yaw, pitch, radius: this.viewCur.radius }
    this.viewTarget = { ...this.viewCur }
    this.dirty = true
  }

  /** 自动环绕(设计稿 tOrbit):渲染循环缓转 yaw;orbitBy 拖拽时暂停 */
  setAutoOrbit(on: boolean): void {
    this.autoOrbit = on
  }

  getAutoOrbit(): boolean {
    return this.autoOrbit
  }

  /** 滚轮缩放(改变 dolly 距离) */

  /** 平移(设计稿 OrbitLite 1:1):target += (−right·dx + up·dy)·s。
   *  right=(cosY,0,−sinY),up 地面分量 = −sinP·(sinY,cosY);panBy 内部取负 → 注视点
   *  拖右时沿 −right 移动 = 相机左扫 = 内容跟随光标(抓取语义,与设计稿逐项一致)。 */
  panByScreen(dxPx: number, dyPx: number): void {
    const r = this.viewCur.radius * this.dolly
    const k = r * 0.0011
    const sinY = Math.sin(this.viewCur.yaw)
    const cosY = Math.cos(this.viewCur.yaw)
    const sinP = Math.sin(this.viewCur.pitch)
    const dxw = (cosY * dxPx + sinP * sinY * dyPx) * k
    const dzw = (-sinY * dxPx + sinP * cosY * dyPx) * k
    this.panBy(dxw, dzw)
  }

  /** 飞往预设视角(平滑;设计稿 flyTo) */
  flyToPreset(p: 'std' | 'top' | 'front' | 'side', _dur = 900): void {
    this.setViewPreset(p)
  }

  /** 相机即时状态(导航地图/callout 距离显隐;世界坐标) */
  getCameraPose(): { pos: { x: number, y: number, z: number }, target: { x: number, z: number }, yaw: number, dolly: number } {
    return {
      pos: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      target: { x: this.camTarget.x, z: this.camTarget.z },
      yaw: this.viewCur.yaw,
      dolly: this.dolly,
    }
  }

  /** 导航地图拖拽平移:世界位移直接作用于注视点与相机位置(设计稿 minimap drag) */
  panWorldBy(dxw: number, dzw: number): void {
    this.camTarget.x -= dxw
    this.camTarget.z -= dzw
    this.camera.position.x -= dxw
    this.camera.position.z -= dzw
    this.dirty = true
  }

  /** 渲染曝光(场景控制坞"环境光照";0.2~2.2) */
  setExposure(v: number): void {
    this.renderer.toneMappingExposure = Math.min(2.2, Math.max(0.2, v))
  }

  /** 领地染色浓度(平台透明度系数;0.05~1) */
  setTerritoryOpacity(v: number): void {
    const o = Math.min(1, Math.max(0.05, v))
    for (const b of this.blocks.values()) {
      ;(b.platform.material as THREE.MeshStandardMaterial).opacity = 0.24 * o
    }
    this.dirty = true
  }

  /** 重置视角(注视世界中心,标准轨道,基准 dolly) */
  resetView(): void {
    this.dolly = 1
    this.autoDolly = null
    this.tweenCamTo(WORLD_CX, WORLD_CZ)
    this.setViewPreset('std')
  }

  zoomBy(f: number): void {
    this.autoDolly = null
    this.dolly = Math.min(1000, Math.max(0.001, this.dolly + f))
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
    const model = new THREE.Group()
    root.add(model)
    const nameSprite = this.makeLabel(name, x, 48, z, this.hexOf(0xffe9c4))
    this.scene.add(root)
    const resident = new Agent3D({
      channelId: '', agentId: `resident-${Date.now().toString(36)}`, name,
      role: 'worker', root, model, mixer: null, clips: [], colorNum: 0xffe9c4, nameSprite,
      bubble: null, bubbleText: null, bubbleTimer: null, state: 'idle', progress: null,
      dragging: false, homeX: x, homeZ: z, range: null, rangeLine: null, textureKey: texKey, modelRef: texKey,
      behavior: { mode: 'idle', roamTarget: null, targetId: null, waitUntil: 0, pauseUntil: 0, engaged: false },
    })
    resident.host = this
    resident.attachAura(0xffe9c4, 'worker')
    this.agents.set(resident.agentId, resident)
    const info = this.modelsById.get(texKey)
    void this.mountModel(resident, info?.file ?? '/assets/game/character/hero-3d.glb', info?.name ?? name)
  }

  /** 设备状态环 + 运行态动效弧(局部坐标一次定位随 root 移动 —— 修复曾被每帧写成世界坐标导致环 2× 漂移的缺陷)。
   *  颜色/显隐由 DeviceNode.updateRing 数据驱动,渲染循环只负责弧的缓转。 */
  private makeDeviceRing(): { ring: THREE.Mesh, arc: THREE.Mesh } {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(20, 26, 32),
      new THREE.MeshBasicMaterial({ color: 0xf6c453, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.3
    const arc = new THREE.Mesh(
      new THREE.RingGeometry(20, 26, 32, 1, 0, Math.PI * 1.5),
      new THREE.MeshBasicMaterial({ color: 0x35e0a0, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    )
    arc.rotation.x = -Math.PI / 2
    arc.position.y = 0.34
    arc.visible = false
    return { ring, arc }
  }

  /**
   * 数字孪生设备节点:拖 dev 模型进场景生成。
   * - 3D:挂 device GLB + 设备名牌 + 状态环(telemetry 驱动颜色);
   * - 数据:经 devices.create 落一个 device twin,与 modelRef 绑定;
   * - state 驱动:alarm→红环,running→青环,offline→灰环,idle→亮环。
   */
  private spawnDeviceNode(x: number, z: number, texKey: string, file: string, name: string): string {
    const tempId = `dev-${Date.now().toString(36)}`
    const root = new THREE.Group()
    root.position.set(x, GROUND_Y, z)
    const { ring, arc } = this.makeDeviceRing()
    root.add(ring, arc)
    const holder = new THREE.Group()
    root.add(holder)
    holder.userData.modelFile = file
    const label = this.makeLabel(`⚙ ${name}`, x, 60, z)
    this.scene.add(root)
    const twin = new DeviceNode({ twinId: tempId, name, modelRef: texKey, root, holder, ring, label, state: 'idle', telemetry: {} })
    twin.host = this
    twin.arc = arc
    twin.updateRing()
    this.deviceNodes.set(tempId, twin)
    this.registerScalable('device', tempId, holder)
    void this.loadGltfToGroup(file, holder, UNITS * 1.6)
    const st = this.scalables.get(`device:${tempId}`)
    const createPromise = this.devices?.create({
      name, modelRef: texKey, kind: 'device', controls: ['power_on', 'power_off', 'set_speed'],
      posX: Math.round(x * 10) / 10,
      posZ: Math.round(z * 10) / 10,
      scale: st ? Math.round(st.userScale * 100) / 100 : 1,
    })
    if (!createPromise) return tempId
    this.pendingDeviceCreates.set(tempId, { name, modelRef: texKey, posX: x, posZ: z })
    void createPromise
      .then((created) => {
        const cancelled = this.cancelledDeviceCreates.delete(tempId)
        this.pendingDeviceCreates.delete(tempId)
        if (cancelled) {
          void this.devices?.remove?.(created.id).catch(() => {})
          return
        }
        if (this.disposed) return
        this.adoptDeviceNode(tempId, created.id)
      })
      .catch(() => {
        this.cancelledDeviceCreates.delete(tempId)
        this.pendingDeviceCreates.delete(tempId)
      })
    return tempId
  }

  /** 将本地临时设备原子迁移到服务端 ID，避免后续更新/删除命中旧键。 */
  private adoptDeviceNode(tempId: string, realId: string): void {
    this.pendingDeviceCreates.delete(tempId)
    const node = this.deviceNodes.get(tempId)
    if (!node) return
    const duplicate = this.deviceNodes.get(realId)
    if (duplicate && duplicate !== node) {
      this.removeDeviceNode(tempId)
      if (this.selected?.kind === 'device' && this.selected.id === tempId) this.setSelected({ kind: 'device', id: realId })
      return
    }
    this.deviceNodes.delete(tempId)
    node.twinId = realId
    this.deviceNodes.set(realId, node)
    const scalable = this.scalables.get(`device:${tempId}`)
    this.scalables.delete(`device:${tempId}`)
    if (scalable) {
      scalable.id = realId
      this.scalables.set(`device:${realId}`, scalable)
    }
    const timer = this.pendingSaveTimers.get(tempId)
    this.pendingSaveTimers.delete(tempId)
    if (timer) this.pendingSaveTimers.set(realId, timer)
    if (this.pointerDrag?.kind === 'device' && this.pointerDrag.id === tempId) this.pointerDrag.id = realId
    if (this.selected?.kind === 'device' && this.selected.id === tempId) this.setSelected({ kind: 'device', id: realId })
    this.persistDeviceTransform(realId)
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
      // 真实投影 + PBR 材质增强(设备:金属机身材质反射拉满,像真实工业设备)
      gltf.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true
      })
      this.enhancePbrMaterials(gltf.scene, 'device')
      group.add(gltf.scene)
    }
    catch {
      // 加载失败:空 Group,静默(节点仍存在,只是无网格)
    }
  }

  /**
   * 模型 PBR 材质增强(放入场景后的渲染优化;设备/角色分治)。
   * 根因修复:角色与产线设备 GLB 大量使用 KHR_materials_unlit(three 加载为
   * MeshBasicMaterial),不受灯光/阴影约束,夜景里像自发光贴片 —— 这既是
   * 「角色过亮」也是设备「假金属光泽」的来源。统一就地转标准材质接入光照
   * 体系,再分级调参:
   * - 角色:哑光 + 极轻环境反射(无清漆/自发光,保持原作贴图观感);
   * - 设备:LED 指示灯保持无光照语义并提 HDR(bloom 起晕,幂等防重);
   *   透光件微自发光 / 金属件适度镜面(0.85,克制)/ 烤漆件轻清漆。
   */
  private enhancePbrMaterials(root: THREE.Object3D, kind: 'device' | 'character'): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.receiveShadow = true
      const tune = (raw: THREE.Material): THREE.Material => {
        const b = raw as THREE.MeshBasicMaterial & { isMeshBasicMaterial?: boolean }
        let m: THREE.MeshStandardMaterial
        if (b?.isMeshBasicMaterial) {
          if (kind === 'device' && /led|lamp|light/i.test(b.name ?? '')) {
            // 设备指示灯:保持无光照语义;提为 HDR(bloom 起晕)。clone 共享同一材质,
            // userData 幂等护桥避免多实例挂载时倍率叠乘。
            const flag = (b.userData ?? (b.userData = {})) as { hdrBoost?: boolean }
            if (!flag.hdrBoost) {
              b.color.multiplyScalar(4.5)
              flag.hdrBoost = true
            }
            return b
          }
          m = new THREE.MeshStandardMaterial({
            map: b.map ?? null,
            // unlit 贴图按"全亮"绘制,直接接入 ~8 倍总光的灯光系会过曝成白炽;
            // 反照率按类型压暗:角色 0.4 / 设备 0.55(ACES 肩部回落到合理亮度)
            color: b.color.clone().multiplyScalar(kind === 'character' ? 0.38 : 0.5),
            transparent: b.transparent,
            opacity: b.opacity,
            alphaTest: b.alphaTest,
            side: b.side,
            roughness: kind === 'character' ? 0.92 : 0.6,
            metalness: kind === 'character' ? 0 : 0.25,
          })
          m.name = b.name ?? ''
          b.dispose()
        }
        else {
          const s = raw as THREE.MeshStandardMaterial
          if (!s || !('envMapIntensity' in s)) return raw
          m = s
        }
        if (kind === 'character') {
          // 角色:哑光 + 极轻环境反射(曾因 emissive 底光 + 清漆层整体过亮)
          m.envMapIntensity = 0.45
          if (m.metalness > 0.3) m.metalness = 0
          return m
        }
        // 设备分级
        if (m.transparent) {
          // 灯罩/屏幕/指示窗:轻微自发光,像通电的设备部件
          m.envMapIntensity = 0.42
          if (m.emissive) m.emissive.setScalar(Math.max(m.emissive.r, 0.06))
          return m
        }
        if (m.metalness >= 0.5) {
          m.envMapIntensity = 0.85 // 金属机身:适可而止的镜面(1.35 曾过亮)
          return m
        }
        // 涂装/塑料外壳 → 物理材质轻清漆层(已是物理材质只调参,避免 clone 共享材质重复替换)
        if ((m as unknown as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial) {
          const p = m as THREE.MeshPhysicalMaterial
          p.clearcoat = 0.35
          p.clearcoatRoughness = 0.4
          p.envMapIntensity = 0.7
          p.needsUpdate = true
          return p
        }
        const p = new THREE.MeshPhysicalMaterial({
          color: m.color,
          map: m.map,
          normalMap: m.normalMap,
          roughnessMap: m.roughnessMap,
          aoMap: m.aoMap,
          emissive: m.emissive,
          emissiveMap: m.emissiveMap,
          emissiveIntensity: m.emissiveIntensity,
          roughness: Math.min(m.roughness, 0.55),
          metalness: m.metalness,
          clearcoat: 0.35,
          clearcoatRoughness: 0.4,
        })
        p.name = m.name
        p.side = m.side
        m.dispose()
        return p
      }
      if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(tune)
      else mesh.material = tune(mesh.material)
    })
    this.dirty = true
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
        auraColor: a.colorNum,
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
    blocks: Array<{ x: number, y: number, color: number, name: string, shape?: 'ellipse' | 'rect', rx?: number, rz?: number, rot?: number }>
    agents: Array<{ x: number, y: number, color: number, busy: boolean }>
    devices: Array<{ x: number, y: number, color: number, state: string }>
    player: { x: number, y: number }
  } {
    const stateColor = (state: 'idle' | 'running' | 'offline' | 'alarm'): number =>
      state === 'alarm' ? 0xff6b6b : state === 'offline' ? 0x8496a5 : state === 'running' ? 0x35e0a0 : 0xf6c453
    return {
      world: { w: WORLD_W, h: WORLD_H },
      // 领地含真实形状/半轴/朝向(归一化;镜头居中小地图按形状绘制)
      blocks: [...this.blocks.values()].map(b => ({
        x: b.x / WORLD_W,
        y: b.z / WORLD_H,
        color: b.color,
        name: b.name,
        shape: b.shape,
        rx: b.radiusX / WORLD_W,
        rz: b.radiusZ / WORLD_H,
        rot: b.rotationY,
      })),
      agents: [...this.agents.values()].map(a => ({ x: a.root.position.x / WORLD_W, y: a.root.position.z / WORLD_H, color: a.colorNum, busy: a.state === 'busy' })),
      devices: [...this.deviceNodes.values()].map(d => ({
        twinId: d.twinId,
        x: d.root.position.x / WORLD_W,
        y: d.root.position.z / WORLD_H,
        color: stateColor(d.state),
        state: d.state,
        daq: d.modelRef.startsWith('daq-') || d.modelRef.includes('daq'),
        bound: false,
      })),
      // 镜头 = camTarget(画面注视中心;小地图准星锚点)
      player: { x: this.camTarget.x / WORLD_W, y: this.camTarget.z / WORLD_H },
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

  /** 删除设备实例:落库删除 + 移除场景节点(由 TownView 触发;失败仅移除本地节点)。 */
  async removeDevice(id: string): Promise<void> {
    const dev = this.deviceNodes.get(id)
    if (!dev) return
    if (this.pendingDeviceCreates.has(id)) {
      this.cancelledDeviceCreates.add(id)
      this.removeDeviceNode(id)
      return
    }
    try {
      await this.devices?.remove?.(id)
    }
    catch { /* 服务端失败仍移除本地节点(尽力同步) */ }
    this.removeDeviceNode(id)
  }

  /** 设备节点列表(供 HUD/E2E;topY = 模型顶面世界高度,callout 锚定用) */
  getDeviceNodes(): Array<{ twinId: string, name: string, x: number, z: number, topY: number, state: string, telemetry: Record<string, number | string | boolean> }> {
    return [...this.deviceNodes.values()].map(d => ({
      twinId: d.twinId,
      name: d.name,
      x: Math.round(d.root.position.x),
      z: Math.round(d.root.position.z),
      topY: Math.round(this.deviceTopY(d)),
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

  /** 命中频道边界线(世界点落在某领地边界带 ±42 单位内 → 边界拖拽等比缩放)。 */
  private pickChannelEdge(x: number, z: number): { cid: string, rx0: number, rz0: number, rd0: number } | null {
    for (const b of this.blocks.values()) {
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
  private setSelected(sel: { kind: 'agent' | 'device', id: string } | null): void {
    // 选中切换/取消 → 退出框选绘制(清理预览)
    if (!sel || sel.kind !== 'agent' || sel.id !== this.rangeDrawAgent) this.cancelRangeDraw()
    this.selected = sel
    // 变换手柄跟随选中设备(Blender 规范:选中即出手柄;运行模式只读 → 不出手柄)
    if (this.tControls) {
      if (sel?.kind === 'device' && this.mode === 'edit' && this.deviceNodes.has(sel.id)) this.tControls.attach(this.deviceNodes.get(sel.id)!.root)
      else this.tControls.detach()
    }
    this.refreshAgentRangeLines()
    this.refreshAgentRangeHandles()
    if (!sel) {
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
    if (k === 'device') {
      const dev = this.deviceNodes.get(id)
      if (dev) dev.topYCache = null
    }
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
    if (kind === 'device') {
      const dev = this.deviceNodes.get(id)
      if (dev) dev.topYCache = null
    }
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
      // 运行模式只读:收起变换手柄(拖拽已在 tryStartPointerDrag 门禁)
      this.tControls?.detach()
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
    if (this.mode !== 'edit' || this.isGizmoBusy()) return false
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
    // 6) 频道边界线拖拽:抓住边界附近 → 整体等比缩放(手柄之外,自由拉边调节范围)
    const edge = this.pickChannelEdge(w.x, w.z)
    if (edge) {
      this.pointerDrag = { kind: 'channelEdge', id: edge.cid, rx0: edge.rx0, rz0: edge.rz0, rd0: edge.rd0 }
      this.setSelected(null)
      this.selectChannel(edge.cid)
      this.emitSaveState('dirty')
      return true
    }
    // 7) 频道信标:非拖拽目标(点击定位语义交给 pointerup;避免编辑模式下点信标变成整体拖动)
    if (this.pickBeacon(w.x, w.z)) return false
    // 8) 频道领地整体拖拽:点中领地空白处 → 平移整个频道(平台/边界/名牌/成员落点)
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
    // 无边界画布:仅网格吸附,不钳制世界范围(模型可摆放到任意位置)
    const x = this.snapWorld(w.x)
    const z = this.snapWorld(w.z)
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
      const nx = x + pd.dx
      const nz = z + pd.dz
      asp.range = { ...asp.range, x: nx, z: nz }
      asp.renderRangeLine()
      this.refreshAgentRangeHandles()
      this.dirty = true
    }
    else if (pd.kind === 'agentRangeResize') {
      // 拖 Agent 范围手柄 → 实时调整 radiusX/radiusZ(矩形角点双轴 / 椭圆轴向轴点)
      const asp = this.agents.get(pd.id)
      if (!asp || !asp.range) return
      asp.range = this.applyAgentRangeResize(asp.range, pd.handle, w.x, w.z)
      asp.renderRangeLine()
      this.refreshAgentRangeHandles()
      this.autoFrameTo(asp.range.radiusX, asp.range.radiusZ)
      this.dirty = true
    }
    else if (pd.kind === 'channel') {
      const b = this.blocks.get(pd.id)
      if (b) this.applyBlockMove(b, x + pd.dx, z + pd.dz)
    }
    else if (pd.kind === 'resize') {
      const b = this.blocks.get(pd.id)
      if (b) this.applyResize(b, pd.handle, w.x, w.z)
    }
    else if (pd.kind === 'channelEdge') {
      // 边界线等比缩放:指针沿"中心→边界"射线的归一化距离比例 → 双轴同倍率
      const b = this.blocks.get(pd.id)
      if (b) {
        const lxz = toLocal(b, x, z)
        const rd = Math.hypot(lxz.x / pd.rx0, lxz.z / pd.rz0)
        const factor = pd.rd0 > 0.05 ? rd / pd.rd0 : 1
        b.radiusX = Math.max(60, Math.round(pd.rx0 * factor))
        b.radiusZ = Math.max(40, Math.round(pd.rz0 * factor))
        this.applyLayoutToBlock(b)
        this.autoFrameTo(b.radiusX, b.radiusZ)
      }
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
        void this.agentApi?.updateHome(pd.id, asp.channelId, asp.homeX, asp.homeZ)
          .then(() => this.emitSaveState('saved', Date.now()))
          .catch(() => this.emitSaveState('error'))
      }
    }
    else if (pd.kind === 'rangeDraw') {
      // 框选结束:以拖框中点为中心、半宽为半径生成矩形范围(过小拖动视为取消)
      const asp = this.agents.get(pd.id)
      if (asp && this.rangeDrawPreviewState) {
        const d = this.rangeDrawPreviewState
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
            void this.agentApi?.updateHome(pd.id, asp.channelId, c.x, c.z).catch(() => {})
          }
          this.emitSaveState('saving')
          void this.agentApi?.updateRange(pd.id, asp.channelId, asp.range)
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
        void this.agentApi?.updateRange(pd.id, asp.channelId, asp.range)
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
  private applyAgentRangeResize(range: AgentRangeLayout, handle: number, wx: number, wz: number): AgentRangeLayout {
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
      const line = makeBoundary('rect', 1, 1, 0x41c8f4)
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

  /** 面板滑杆/形状即时调整:局部更新范围(无上限,信任用户设定) + 线框/手柄刷新;home 被迫位移时记档待提交 */
  setAgentRangeScene(agentId: string, patch: Partial<AgentRangeLayout>): void {
    const asp = this.agents.get(agentId)
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
      void this.agentApi?.updateHome(agentId, asp.channelId, x, z).catch(() => {})
    }
    this.emitSaveState('saving')
    void this.agentApi?.updateRange(agentId, asp.channelId, asp.range)
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
    void this.agentApi?.updateRange(agentId, asp.channelId, null)
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
    if (!dev || !this.devices?.update || this.pendingDeviceCreates.has(id)) return
    const st = this.scalables.get(`device:${id}`)
    const prev = this.pendingSaveTimers.get(id)
    if (prev) clearTimeout(prev)
    this.pendingSaveTimers.set(id, setTimeout(() => {
      this.pendingSaveTimers.delete(id)
      if (this.disposed || this.pendingDeviceCreates.has(id)) return
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
      if (!serverIds.has(id) && !this.pendingDeviceCreates.has(id)) this.removeDeviceNode(id)
    }
    for (const t of twins) {
      let existing = this.deviceNodes.get(t.id)
      if (!existing) {
        const pending = [...this.pendingDeviceCreates.entries()].find(([, p]) =>
          p.name === t.name && p.modelRef === t.modelRef,
        )
        if (pending) {
          this.adoptDeviceNode(pending[0], t.id)
          existing = this.deviceNodes.get(t.id)
        }
      }
      if (!existing) {
        // 数采/智控节点走程序化路径(无 GLB 也可实例化);设备需模型可解析 + 已入场景
        const isDaq = t.kind === 'daq' || (t.modelRef ?? '').startsWith('daq-') || (t.modelRef ?? '').startsWith('dcw-')
        const resolvable = isDaq || !!this.resolveDeviceModel(t.modelRef)?.file
        if (resolvable && typeof t.posX === 'number' && typeof t.posZ === 'number') this.recreateDeviceNode(t)
        else this.pendingDeviceTwins.set(t.id, t)
        continue
      }
      this.pendingDeviceTwins.delete(t.id)
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
    // 设备节点就位后重仲裁绑定链路(链路期望先于节点到达的时序兜底)
    if (this.daqLinksWanted.length) this.syncDaqLinks(this.daqLinksWanted)
    for (const id of [...this.pendingDeviceTwins.keys()]) {
      if (!serverIds.has(id)) this.pendingDeviceTwins.delete(id)
    }
  }

  /** 按设备孪生记录重建场景节点(持久化恢复:pos/rotation/scale;模型缺失则跳过) */
  /** 设备模型解析:精确 id → `dev-folder-<ref>` 前缀 → `-<ref>` 后缀(兼容旧数据短 modelRef) */
  private resolveDeviceModel(ref: string): { id: string, file: string, hFactor: number } | null {
    const direct = this.modelsById.get(ref)
    if (direct?.file) return { id: direct.id, file: direct.file, hFactor: direct.hFactor ?? 1 }
    for (const [id, m] of this.modelsById) {
      if (m.kind !== 'dev' || !m.file) continue
      if (id === `dev-folder-${ref}` || id.endsWith(`-${ref}`)) return { id, file: m.file, hFactor: m.hFactor ?? 1 }
    }
    return null
  }

  private recreateDeviceNode(t: DeviceTwinSync): void {
    // 数采/智控节点:程序化传感网格(基座 + 传感头 + 信号环),不依赖 GLB 资产
    // (modelRef 前缀兜底:旧数据 kind 落成 'device' 的数采实例同样走程序化路径)
    if (t.kind === 'daq' || (t.modelRef ?? '').startsWith('daq-') || (t.modelRef ?? '').startsWith('dcw-')) {
      this.recreateDaqNode(t)
      return
    }
    const model = this.resolveDeviceModel(t.modelRef)
    const file = model?.file ?? ''
    if (!file) return
    const x = typeof t.posX === 'number' ? t.posX : WORLD_CX
    const z = typeof t.posZ === 'number' ? t.posZ : WORLD_CZ
    const root = new THREE.Group()
    root.position.set(x, GROUND_Y, z)
    root.rotation.y = typeof t.rotationY === 'number' ? t.rotationY * Math.PI / 180 : 0
    const { ring, arc } = this.makeDeviceRing()
    root.add(ring, arc)
    const holder = new THREE.Group()
    root.add(holder)
    const label = this.makeLabel(`⚙ ${t.name}`, x, 60, z)
    holder.userData.modelFile = file
    this.scene.add(root)
    const twin = new DeviceNode({ twinId: t.id, name: t.name, modelRef: t.modelRef, root, holder, ring, label, state: t.state ?? 'idle', telemetry: t.telemetry ?? {} })
    twin.host = this
    twin.arc = arc
    twin.updateRing()
    this.deviceNodes.set(t.id, twin)
    // 服务端缩放优先(持久化恢复);缺省回退 localStorage
    this.registerScalable('device', t.id, holder, typeof t.scale === 'number' ? t.scale : undefined)
    // 高度系数:产线设备按设计稿比例错落(基准高 × 模型系数),未知模型维持 1
    void this.loadGltfToGroup(file, holder, UNITS * 1.6 * (model?.hFactor ?? 1))
    this.dirty = true
  }

  /** 数采节点传感头(设计稿 DAQ 预制件 1:1 移植,×34 世界单位):
   *  立杆基座 + 顶端 LED 环 + 每模板独立传感形态 —— 温度计/压力表/张力辊/编码盘/相机/电参天线。 */
  private makeDaqMesh(modelRef: string): { group: THREE.Group, ledRing: THREE.Mesh } {
    const S = 34
    const g = new THREE.Group()
    const steel = new THREE.MeshStandardMaterial({ color: 0x9fb2c8, metalness: 0.85, roughness: 0.32 })
    const body = new THREE.MeshStandardMaterial({ color: 0x74869c, metalness: 0.35, roughness: 0.5 })
    const body2 = new THREE.MeshStandardMaterial({ color: 0x55647a, metalness: 0.4, roughness: 0.55 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b3442, metalness: 0.7, roughness: 0.45 })
    const chrome = new THREE.MeshStandardMaterial({ color: 0xdfe8f2, metalness: 1, roughness: 0.14 })
    const copper = new THREE.MeshStandardMaterial({ color: 0xc57a45, metalness: 0.9, roughness: 0.35 })
    const glow = new THREE.MeshBasicMaterial({ color: 0x41c8f4 })
    glow.color.multiplyScalar(5)
    const B = (w: number, h: number, d: number, m: THREE.Material): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w * S, h * S, d * S), m)
      mesh.castShadow = true
      return mesh
    }
    const Cyl = (rt: number, rb: number, h: number, m: THREE.Material, seg = 20): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt * S, rb * S, h * S, seg), m)
      mesh.castShadow = true
      return mesh
    }
    const at = (m: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh => {
      m.position.set(x * S, y * S, z * S)
      g.add(m)
      return m
    }
    // 立杆基座(设计稿 daqPole)
    at(Cyl(0.17, 0.22, 0.09, dark), 0, 0.045, 0)
    at(Cyl(0.028, 0.028, 0.95, steel, 10), 0, 0.55, 0)
    const ledRing = new THREE.Mesh(new THREE.TorusGeometry(0.09 * S, 0.02 * S, 10, 28), new THREE.MeshBasicMaterial({ color: 0x35e0a0 }))
    // HDR 亮度:LED 环(及其复用材质的 halo/iris/tip)提到阈值之上,"真发光"元件(bloom 起晕)
    ;(ledRing.material as THREE.MeshBasicMaterial).color.multiplyScalar(6)
    ledRing.rotation.x = Math.PI / 2
    g.add(ledRing)
    ledRing.position.y = 1.02 * S
    // 每模板传感头(modelRef = `daq-<tplId>`)
    if (modelRef.endsWith('temp-tc')) {
      at(B(0.24, 0.32, 0.24, body), 0, 1.2, 0)
      const probe = at(Cyl(0.014, 0.014, 0.4, steel, 8), 0.14, 0.85, 0)
      probe.rotation.z = -0.5
    }
    else if (modelRef.endsWith('pressure-tx')) {
      at(Cyl(0.13, 0.16, 0.3, steel), 0, 1.22, 0)
      at(Cyl(0.12, 0.12, 0.05, dark), 0, 1.4, 0)
      at(B(0.05, 0.05, 0.2, copper), 0, 1.1, 0.2)
    }
    else if (modelRef.endsWith('tension-cell')) {
      at(B(0.34, 0.2, 0.2, body), 0, 1.25, 0)
      for (const x of [-0.11, 0.11]) {
        const roll = at(Cyl(0.06, 0.06, 0.26, chrome), x, 1.25, 0)
        roll.rotation.x = Math.PI / 2
      }
    }
    else if (modelRef.endsWith('line-encoder')) {
      at(B(0.34, 0.05, 0.05, steel), 0.14, 1.28, 0)
      const disc = at(Cyl(0.16, 0.16, 0.05, dark), 0.32, 1.28, 0)
      disc.rotation.z = Math.PI / 2
      const halo = new THREE.Mesh(new THREE.TorusGeometry(0.1 * S, 0.015 * S, 10, 26), ledRing.material as THREE.Material)
      at(halo, 0.35, 1.28, 0)
    }
    else if (modelRef.endsWith('vision-cam')) {
      at(B(0.28, 0.2, 0.36, body2), 0, 1.3, 0)
      const lens = at(Cyl(0.07, 0.09, 0.14, dark), 0, 1.3, 0.24)
      lens.rotation.x = Math.PI / 2
      const iris = new THREE.Mesh(new THREE.TorusGeometry(0.075 * S, 0.012 * S, 10, 24), ledRing.material as THREE.Material)
      at(iris, 0, 1.3, 0.3)
    }
    else if (modelRef.endsWith('power-meter')) {
      at(B(0.32, 0.42, 0.18, body), 0, 1.3, 0)
      at(Cyl(0.012, 0.012, 0.42, steel, 8), 0.1, 1.7, 0)
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.028 * S, 10, 8), ledRing.material as THREE.Material)
      at(tip, 0.1, 1.92, 0)
      at(B(0.2, 0.06, 0.02, glow), 0, 1.42, 0.1)
    }
    return { group: g, ledRing }
  }

  /** 数采/智控节点(程序化):模板分化传感网格 + **产线光晕**(同产线同色光环)+ 名牌 */
  private recreateDaqNode(t: DeviceTwinSync): void {
    const x = typeof t.posX === 'number' ? t.posX : WORLD_CX
    const z = typeof t.posZ === 'number' ? t.posZ : WORLD_CZ
    const root = new THREE.Group()
    root.position.set(x, GROUND_Y, z)
    root.rotation.y = typeof t.rotationY === 'number' ? t.rotationY * Math.PI / 180 : 0
    const { group: sensor, ledRing } = this.makeDaqMesh(t.modelRef)
    root.add(sensor)
    const sigRing = new THREE.Mesh(
      new THREE.RingGeometry(16, 21, 36),
      new THREE.MeshBasicMaterial({ color: 0x35e0a0, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
    )
    sigRing.rotation.x = -Math.PI / 2
    sigRing.position.y = 0.35
    root.add(sigRing)
    // 产线光晕:外圈加性光环(soft) + 内圈亮环;未分配 = 缺省绿
    const haloOuter = new THREE.Mesh(
      new THREE.RingGeometry(24, 34, 48),
      new THREE.MeshBasicMaterial({ color: 0x35e0a0, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    )
    haloOuter.rotation.x = -Math.PI / 2
    haloOuter.position.y = 0.28
    root.add(haloOuter)
    const accent = t.lineColor || '#35e0a0'
    const label = this.makeLabel(t.name, x, 62, z, accent)
    this.scene.add(root)
    const node = new DeviceNode({
      twinId: t.id, name: t.name, modelRef: t.modelRef,
      root, holder: root, ring: sigRing, label,
      state: t.state ?? 'running', telemetry: t.telemetry ?? {},
    })
    node.host = this
    node.lineColor = t.lineColor ?? ''
    // 换产线/换色:重 tint 光环 + LED 环 + 名牌(applyTwin 检测 lineColor 变化时触发)
    node.applyLine = (color: string) => {
      const c = new THREE.Color(color || '#35e0a0')
      ;(sigRing.material as THREE.MeshBasicMaterial).color.copy(c)
      ;(haloOuter.material as THREE.MeshBasicMaterial).color.copy(c)
      ;(ledRing.material as THREE.MeshBasicMaterial).color.copy(c).multiplyScalar(6) // 保持 HDR(LED 起晕)
      this.scene.remove(label)
      label.material.dispose()
      const fresh = this.makeLabel(node.name, root.position.x, 62, root.position.z, color || '#35e0a0')
      node.label = fresh
      this.scene.add(fresh)
      this.dirty = true
    }
    if (t.lineColor) node.applyLine(t.lineColor)
    node.updateRing()
    this.deviceNodes.set(t.id, node)
    this.daqLedRings.set(t.id, ledRing)
    this.registerScalable('device', t.id, root, typeof t.scale === 'number' ? t.scale : undefined)
    this.dirty = true
  }

  /** 移除设备场景节点(服务端记录被删/本地重建清理) */
  private removeDeviceNode(id: string): void {
    const dev = this.deviceNodes.get(id)
    if (!dev) return
    this.scene.remove(dev.root)
    this.scene.remove(dev.label)
    this.disposeDeviceAssets(dev)
    if (this.selected?.kind === 'device' && this.selected.id === id) this.setSelected(null)
    this.scalables.delete(`device:${id}`)
    this.deviceNodes.delete(id)
    this.daqLedRings.delete(id)
    this.daqLinkSig = ''
    this.filmWebSig = ''
    this.dirty = true
  }

  // ================================================================
  // 数采绑定链路 + 薄膜 web(设计稿 buildChanLine / rebuildWeb 移植)
  // ================================================================

  /** 设备顶端世界高度(holder 包围盒;链路/膜 web 的挂点)。
   *  缓存优先:Box3.setFromObject 遍历整个 GLB 子树,原每帧每设备全量计算是 HUD 最大热点;
   *  设备贴地 y=0,高度只随缩放变化 → setModelScale/registerScalable 时失效即可。 */
  private deviceTopY(dev: DeviceNode): number {
    if (dev.topYCache != null) return dev.topYCache
    const box = new THREE.Box3().setFromObject(dev.holder)
    const y = Number.isFinite(box.max.y) ? Math.max(40, box.max.y) : 64
    dev.topYCache = y
    return y
  }

  /** 同步数采→设备绑定链路(TownView 传入 [{daqId, deviceId}];端点移动时逐帧跟随重建) */
  syncDaqLinks(links: Array<{ daqId: string, deviceId: string }>): void {
    this.daqLinksWanted = links
    // 签名按"成功建链"的链路计算:节点未就绪被跳过的链路不计入 → 设备节点晚到时 syncDevices 末尾重仲裁补链
    const built = links.filter(l => this.deviceNodes.has(l.daqId) && this.deviceNodes.has(l.deviceId))
    const sig = built.map(l => `${l.daqId}>${l.deviceId}`).sort().join('|')
    if (sig === this.daqLinkSig) return
    this.daqLinkSig = sig
    for (const l of this.daqLinks) {
      this.daqLinkGroup.remove(l.line)
      this.daqLinkGroup.remove(l.pulse)
      l.line.geometry.dispose()
    }
    this.daqLinks = []
    for (const l of built) {
      const daq = this.deviceNodes.get(l.daqId)!
      const dev = this.deviceNodes.get(l.deviceId)!
      const a = new THREE.Vector3(daq.root.position.x, 42, daq.root.position.z)
      const b = new THREE.Vector3(dev.root.position.x, this.deviceTopY(dev) + 6, dev.root.position.z)
      const mid = a.clone().add(b).multiplyScalar(0.5)
      mid.y = Math.max(a.y, b.y) + 42
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b)
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28))
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x35e0a0, transparent: true, opacity: 0.55, dashSize: 8, gapSize: 5 }))
      line.computeLineDistances()
      const pulse = new THREE.Mesh(new THREE.SphereGeometry(2.6, 10, 8), new THREE.MeshBasicMaterial({ color: 0x41c8f4 }))
      ;(pulse.material as THREE.MeshBasicMaterial).color.multiplyScalar(5) // HDR:链路数据脉冲起晕
      this.daqLinkGroup.add(line, pulse)
      this.daqLinks.push({ ...l, line, pulse, curve, pt: Math.random(), ptSig: '' })
    }
    this.dirty = true
  }

  /** 端点跟随:任一端点位移超阈值 → 重建该链路曲线(拖拽设备/数采时虚线实时跟随) */
  /** 链路端点 scratch(逐帧跟随用;免每帧 3 次分配) */
  private static readonly _lkA = new THREE.Vector3()
  private static readonly _lkB = new THREE.Vector3()
  private static readonly _lkM = new THREE.Vector3()

  private refreshDaqLinks(): void {
    for (const l of this.daqLinks) {
      const daq = this.deviceNodes.get(l.daqId)
      const dev = this.deviceNodes.get(l.deviceId)
      if (!daq || !dev) continue
      const topY = this.deviceTopY(dev) + 6
      const sig = `${Math.round(daq.root.position.x)},${Math.round(daq.root.position.z)},${Math.round(dev.root.position.x)},${Math.round(dev.root.position.z)},${Math.round(topY)}`
      if (sig === l.ptSig) continue // 端点未动:曲线/geometry 不重建(脉冲仍逐帧走)
      l.ptSig = sig
      const a = TownScene3D._lkA.set(daq.root.position.x, 42, daq.root.position.z)
      const b = TownScene3D._lkB.set(dev.root.position.x, topY, dev.root.position.z)
      const mid = TownScene3D._lkM.copy(a).add(b).multiplyScalar(0.5)
      mid.y = Math.max(a.y, b.y) + 42
      l.curve.v0.copy(a)
      l.curve.v1.copy(mid)
      l.curve.v2.copy(b)
      const pts = l.curve.getPoints(28)
      l.line.geometry.setFromPoints(pts)
      l.line.computeLineDistances()
    }
  }

  /** 产线设备型号识别(modelRef 含产线关键字 → 薄膜 web 连线成员) */
  private isLineDevice(modelRef: string): boolean {
    const ref = modelRef.toLowerCase()
    return /extruder|caster|mdo|tdo|winder/.test(ref)
  }

  /** 薄膜 web:按 X 序连接产线设备(挤出→流延→MD→TD→收卷),半透明膜面 —— 产线工艺连续性可视化 */
  private rebuildFilmWeb(): void {
    const list = [...this.deviceNodes.values()]
      .filter(d => this.isLineDevice(d.modelRef) && !d.modelRef.startsWith('daq-'))
      .sort((a, b) => a.root.position.x - b.root.position.x)
    const sig = list.map(d => `${d.twinId}:${Math.round(d.root.position.x)},${Math.round(d.root.position.z)}`).join('|')
    if (sig === this.filmWebSig) return
    this.filmWebSig = sig
    while (this.filmWebGroup.children.length) {
      const c = this.filmWebGroup.children[0] as THREE.Mesh
      this.filmWebGroup.remove(c)
      c.geometry.dispose()
    }
    if (!this.filmWebMat) {
      this.filmWebMat = new THREE.MeshStandardMaterial({
        color: 0xaad8ff, metalness: 0.1, roughness: 0.35, transparent: true, opacity: 0.28,
        emissive: 0x2b6b8f, emissiveIntensity: 0.25, side: THREE.DoubleSide, depthWrite: false,
      })
    }
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]!.root.position
      const b = list[i + 1]!.root.position
      const len = Math.abs(b.x - a.x) - 110
      if (len < 30) continue
      const web = new THREE.Mesh(new THREE.BoxGeometry(len, 1.2, 46), this.filmWebMat)
      web.position.set((a.x + b.x) / 2, 48, (a.z + b.z) / 2)
      this.filmWebGroup.add(web)
    }
    this.dirty = true
  }

  // ================================================================
  // 生命周期 / 渲染循环
  // ================================================================

  private loop(): void {
    const animate = () => {
      if (this.disposed) return
      this.raf = requestAnimationFrame(animate)
      const rawDt = this.clock.getDelta()
      // 帧预算门控:数据消费与帧率解耦 —— WS 帧直写实时缓冲(消费层,不受此门控),
      // 渲染循环每帧只取「当前最新值」上屏(展示层);budget 0 = 不限制(用户可选 60/120/∞)。
      // 后台标签页 rAF 自动停摆;回前台 rawDt 巨大 → 钳制单步 ≤100ms 防动画跳变
      if (this.frameBudgetMs > 0) {
        this.frameAcc += rawDt * 1000
        if (this.frameAcc < this.frameBudgetMs - 0.5) return
        this.frameAcc = 0
      }
      const dt = Math.min(rawDt, 0.1)
      const t = this.clock.elapsedTime
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
      // 频道信标缓转(顶标菱形旋转,中心定位销的生命感)
      for (const b of this.blocks.values()) b.beacon.rotation.y += dt * 0.4
      // 名字/气泡跟随 + 光环呼吸 + 逐帧动画(脉冲/光柱/缓动)
      for (const asp of this.agents.values()) {
        asp.nameSprite.position.set(asp.root.position.x, 48, asp.root.position.z)
        if (asp.bubble) {
          asp.bubble.position.set(asp.root.position.x, BUBBLE_Y + 22 + Math.max(0, asp.model.scale.y - 1) * 22, asp.root.position.z)
        }
        if (asp.auraMats.length) {
          const br = 0.8 + 0.2 * Math.sin(t * 2.2 + asp.auraPhase)
          for (const m of asp.auraMats) m.opacity = (m.userData.baseOp as number) * br
        }
      }
      // 设备节点:名牌跟随(状态环是 root 子节点自动跟随;颜色由 updateRing 在状态变化时刷新)+ 运行弧缓转
      for (const dev of this.deviceNodes.values()) {
        dev.label.position.set(dev.root.position.x, 60, dev.root.position.z)
        if (dev.arc?.visible) dev.arc.rotation.z += dt * 1.6
      }
      // 数采节点 LED 环:缓转 + 呼吸(绑定链路的信号生命感)
      for (const ring of this.daqLedRings.values()) {
        ring.rotation.z += dt * 1.2
        const s = 1 + Math.sin(t * 3.2) * 0.08
        ring.scale.setScalar(s)
      }
      // 绑定链路:端点位移时重建曲线(dirty 门控;脉冲仍逐帧行走)
      if (this.daqLinks.length) {
        if (this.dirty) this.refreshDaqLinks()
        for (const l of this.daqLinks) {
          l.pt = (l.pt + dt * 0.3) % 1
          l.pulse.position.copy(l.curve.getPoint(l.pt))
        }
      }
      // 薄膜 web:产线设备增删/移动时重建(dirty 门控;免每帧签名字符串分配)
      if (this.dirty) this.rebuildFilmWeb()
      // 选中高亮环:跟随选中目标(角色按用户缩放、设备按顶高定半径;慢转活性)
      if (this.selRing) {
        const sel = this.selected
        let sx = 0
        let sz = 0
        let sr = 0
        if (sel?.kind === 'agent') {
          const a = this.agents.get(sel.id)
          if (a) {
            sx = a.root.position.x
            sz = a.root.position.z
            sr = 46 * Math.max(0.6, a.model.scale.y)
          }
        }
        else if (sel?.kind === 'device') {
          const d = this.deviceNodes.get(sel.id)
          if (d) {
            sx = d.root.position.x
            sz = d.root.position.z
            sr = Math.max(34, this.deviceTopY(d) * 0.42)
          }
        }
        this.selRing.visible = sr > 0
        if (sr > 0) {
          this.selRing.position.set(sx, 0.5, sz)
          this.selRing.scale.setScalar(sr)
          this.selRing.rotation.z += dt * 0.9
        }
      }
      const anims = this.rafAnims
      this.rafAnims = []
      for (const f of anims) f()
      // 相机:围绕 camTarget 按 dolly 距离摆放(拖拽平移 camTarget,滚轮调 dolly,tween 平移 camTarget);
      // 基线 1250/760 + FOV55 = 全园区电影化 2.5D 框景;穹顶随镜头平移(无限视野观感)
      // 指数阻尼(帧率无关:1-e^(-λ·dt);60fps 下与旧每帧系数 0.12/0.08 等效,高刷屏不再加速)
      const kDolly = 1 - Math.exp(-dt * 7.2)
      if (this.autoDolly !== null) {
        this.dolly += (this.autoDolly - this.dolly) * kDolly
        if (Math.abs(this.autoDolly - this.dolly) < 0.01) this.autoDolly = null
      }
      const kView = 1 - Math.exp(-dt * 4.8)
      for (const k of ['yaw', 'pitch', 'radius'] as const) {
        this.viewCur[k] += (this.viewTarget[k] - this.viewCur[k]) * kView
      }
      // 自动环绕(设计稿 tOrbit):缓转方位角(dt 基 ≈ 24s/圈;指针按住场景时暂停)
      if (this.autoOrbit && !this.pointerDrag) {
        this.viewCur.yaw -= dt * 0.156
        this.viewTarget.yaw = this.viewCur.yaw
      }
      const r = this.viewCur.radius * this.dolly
      const cp = Math.cos(this.viewCur.pitch)
      this.camera.position.set(
        this.camTarget.x + r * cp * Math.sin(this.viewCur.yaw),
        20 + r * Math.sin(this.viewCur.pitch),
        this.camTarget.z + r * cp * Math.cos(this.viewCur.yaw),
      )
      this.camera.lookAt(this.camTarget.x, 20, this.camTarget.z)
      // 无级缩放:近/远裁剪面随 dolly 伸缩(贴脸到星野全程不裁剪)
      const near = Math.max(0.05, 1.2 * this.dolly)
      const far = 16000 * this.dolly
      if (Math.abs(this.camera.near - near) > 0.005 || Math.abs(this.camera.far - far) > 1) {
        this.camera.near = near
        this.camera.far = far
        this.camera.updateProjectionMatrix()
      }
      if (this.skyDome) {
        this.skyDome.position.set(this.camTarget.x, 0, this.camTarget.z)
        // 穹顶随 dolly 缩放:高空拉远时相机始终在穹内,无硬地平线
        this.skyDome.scale.setScalar(Math.max(1, this.dolly * 1.3))
      }
      // 地面跟随镜头滑动(重复纹理 = 无限地面;高空不见地面边缘);
      // UV 偏移反向补偿平面位移 → 网格钉死世界坐标(否则纹理跟平面一起滑,平移时有"冰面漂移"感)
      this.ground.position.set(this.camTarget.x, 0, this.camTarget.z)
      const gmap = (this.ground.material as THREE.MeshStandardMaterial).map
      if (gmap) {
        gmap.offset.set(
          this.camTarget.x / ((WORLD_W * 16) / gmap.repeat.x),
          -this.camTarget.z / ((WORLD_H * 16) / gmap.repeat.y),
        )
      }
      // 雾距/阴影范围随 dolly 缩放:任意 zoom 层级下取景内容都不被雾吞、投影不消失
      const fog = this.scene.fog
      if (fog instanceof THREE.Fog) {
        fog.near = 1400 * this.dolly
        fog.far = 8800 * this.dolly
      }
      const sc = this.keyLight.shadow.camera
      const ext = 1600 * Math.max(1, this.dolly)
      if (Math.abs(sc.right - ext) > 1) {
        sc.left = -ext
        sc.right = ext
        sc.top = 2300 * Math.max(1, this.dolly)
        sc.bottom = -2300 * Math.max(1, this.dolly)
        sc.updateProjectionMatrix()
        this.renderer.shadowMap.needsUpdate = true
      }
      // 阴影按需:内容变化(dirty)或有动画角色(mixer 驱动蒙皮位移)才重绘阴影贴图
      let shadowAnimated = false
      for (const asp of this.agents.values()) {
        if (asp.mixer) {
          shadowAnimated = true
          break
        }
      }
      this.renderer.shadowMap.needsUpdate = this.dirty || shadowAnimated
      // 后处理管线出图(RenderPass → Bloom → OutputPass;替代直渲染)
      this.composer.render(dt)
      this.dirty = false
      // FPS
      this.frameCount += 1
      this.fpsAccum += dt * 1000
      if (this.fpsAccum >= 1000) {
        this.emit('fps', this.frameCount)
        this.adaptQuality(this.frameCount)
        this.frameCount = 0
        this.fpsAccum = 0
      }
    }
    animate()
  }

  /** 质量阶梯:实测 fps 连续 2s < 17 → 降一档;连续 4s ≥ 27(帧预算附近)→ 升一档。
   *  档位 = dprScale × 阴影贴图 × Bloom 开关的组合(Bloom+2048² 阴影是两大单项开销,
   *  重活机器 11fps = 每帧 ~90ms 主线程阻塞)。统一阶梯,避免多套自适应互相打架。 */
  private static readonly Q_TIERS = [
    { scale: 1.0, shadow: 2048, bloom: true },
    { scale: 0.8, shadow: 2048, bloom: true },
    { scale: 0.65, shadow: 1024, bloom: true },
    { scale: 0.55, shadow: 1024, bloom: false },
  ] as const

  private qTier = 0

  private qLowStreak = 0

  private qHighStreak = 0

  /** 画质模式:auto = 质量阶梯自适应;manual 三档由用户固定(渲染配置不再自动变动) */
  private qualityMode: 'auto' | 'normal' | 'hd' | 'ultra' = 'auto'

  /** 用户画质三档(超清 = WebGL 全配置:满 DPR/2048² 阴影/Bloom/最大各向异性) */
  private static readonly USER_QUALITY = {
    ultra: { scale: 1.0, shadow: 2048, bloom: true },
    hd: { scale: 0.8, shadow: 2048, bloom: true },
    normal: { scale: 0.6, shadow: 1024, bloom: true },
  } as const

  setQualityMode(mode: 'auto' | 'normal' | 'hd' | 'ultra'): void {
    this.qualityMode = mode
    if (mode === 'auto') {
      this.applyQuality()
      return
    }
    const q = TownScene3D.USER_QUALITY[mode]
    this.applyPixelRatio(Math.max(0.5, this.baseDpr * q.scale))
    const key = this.keyLight
    if ((key.shadow.mapSize.x ?? 0) !== q.shadow) {
      key.shadow.mapSize.set(q.shadow, q.shadow)
      key.shadow.map?.dispose()
      key.shadow.map = null
      this.renderer.shadowMap.needsUpdate = true
    }
    const bloomPass = this.composer.passes.find(p => p instanceof UnrealBloomPass)
    if (bloomPass) bloomPass.enabled = q.bloom
  }

  private adaptQuality(fps: number): void {
    if (this.qualityMode !== 'auto') return
    const maxTier = TownScene3D.Q_TIERS.length - 1
    if (fps < 17 && this.qTier < maxTier) {
      if (++this.qLowStreak >= 2) {
        this.qTier++
        this.applyQuality()
        this.qLowStreak = 0
        this.qHighStreak = 0
      }
    }
    else if (fps >= 27 && this.qTier > 0) {
      if (++this.qHighStreak >= 4) {
        this.qTier--
        this.applyQuality()
        this.qHighStreak = 0
        this.qLowStreak = 0
      }
    }
    else {
      this.qLowStreak = 0
      this.qHighStreak = 0
    }
  }

  private applyQuality(): void {
    const tier = TownScene3D.Q_TIERS[this.qTier]!
    this.applyPixelRatio(Math.max(0.5, this.baseDpr * tier.scale))
    // 阴影贴图缩容:置空 map 让 three 按新尺寸重分配(渲染循环按需重绘阴影)
    const key = this.keyLight
    if ((key.shadow.mapSize.x ?? 0) !== tier.shadow) {
      key.shadow.mapSize.set(tier.shadow, tier.shadow)
      key.shadow.map?.dispose()
      key.shadow.map = null
      this.renderer.shadowMap.needsUpdate = true
    }
    // Bloom 开关:Pass.enabled=false 跳过该 pass(RenderPass→OutputPass 直通)
    const bloomPass = this.composer.passes.find(p => p instanceof UnrealBloomPass)
    if (bloomPass) bloomPass.enabled = tier.bloom
  }

  private applyPixelRatio(next: number): void {
    this.renderer.setPixelRatio(next)
    this.composer.setPixelRatio(next)
    const w = this.el.clientWidth || 1100
    const h = this.el.clientHeight || 700
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
  }

  // ================================================================
  // 实例本地资源释放(防长会话 GPU 内存只涨不跌)
  // ================================================================
  // 注意:GLB 克隆(clone)与 gltfCache 原件**共享** geometry/material/纹理,
  // 其 GPU 资源归缓存原件管理 —— 释放路径绝不可碰 GLB 克隆内部,否则同模型
  // 其他活动实例会被连带摧毁。这里只释放每实例独占的资源:
  // 名牌/气泡的 CanvasTexture(材质 map)、状态环/链路等自建几何与材质。

  /** 释放对象树内所有 Canvas 纹理(名牌/气泡 sprite 的独占资源) */
  private disposeCanvasTextures(root: THREE.Object3D | null): void {
    if (!root) return
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : []
      for (const m of mats) {
        const std = m as THREE.Material & { map?: THREE.Texture | null }
        if (std.map && std.map.image instanceof HTMLCanvasElement) std.map.dispose()
        m.dispose()
      }
    })
  }

  /** 释放单个设备节点的实例资源(状态环 + 运行弧 + LED 环 + 名牌) */
  private disposeDeviceAssets(dev: DeviceNode): void {
    dev.ring.geometry.dispose()
    const rmat = dev.ring.material as THREE.Material & { map?: THREE.Texture | null }
    rmat.dispose()
    if (dev.arc) {
      dev.arc.geometry.dispose()
      ;(dev.arc.material as THREE.Material).dispose()
    }
    this.disposeCanvasTextures(dev.label)
  }

  /** 释放单个 agent 的实例资源(名牌/气泡纹理 + 光环 + 活动范围线几何;GLB 克隆不动) */
  private disposeAgentAssets(a: { nameSprite?: THREE.Sprite | null, bubble?: THREE.Sprite | null, rangeLine?: THREE.Line | null, aura?: THREE.Group | null }): void {
    this.disposeCanvasTextures(a.nameSprite ?? null)
    this.disposeCanvasTextures(a.bubble ?? null)
    a.rangeLine?.geometry.dispose()
    if (a.aura) {
      a.aura.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.geometry.dispose()
          ;(m.material as THREE.Material).dispose()
        }
      })
      a.aura = null
    }
  }

  /** 重置全部(rebuild 用) */
  private resetAll(): void {
    for (const a of this.agents.values()) {
      this.scene.remove(a.root)
      if (a.nameSprite) this.scene.remove(a.nameSprite)
      if (a.bubble) this.scene.remove(a.bubble)
      if (a.rangeLine) this.scene.remove(a.rangeLine)
      this.disposeAgentAssets(a)
    }
    for (const b of this.blocks.values()) {
      this.scene.remove(b.platform)
      this.scene.remove(b.padRing)
      this.scene.remove(b.beacon)
      this.scene.remove(b.boundary)
      this.scene.remove(b.label)
      this.disposeCanvasTextures(b.label)
    }
    for (const dev of this.deviceNodes.values()) {
      this.scene.remove(dev.root)
      this.scene.remove(dev.label)
      this.disposeDeviceAssets(dev)
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
    this.agents.clear()
    this.blocks.clear()
  }

  /** 销毁(卸载时由 TownView 调用) */
  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    delete (globalThis as { __townScene3d?: unknown }).__townScene3d
    for (const t of this.pendingSaveTimers.values()) clearTimeout(t)
    this.pendingSaveTimers.clear()
    this.receivers.clear()
    this.resizeOb?.disconnect()
    this.resizeOb = null
    this.tControls?.dispose()
    this.tControls = null
    this.composer?.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.el) this.renderer.domElement.remove()
  }
}
