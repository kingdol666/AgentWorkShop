/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 面向对象节点。
 *
 * 自 TownScene3D.ts 抽出:三类「场景实体实例」的封装,只通过宿主契约
 * (BlockHost / AgentHost / DeviceHost,见 town-scene3d-types.ts)回调场景,
 * 不直接依赖 TownScene3D 的其余实现。
 *
 *  - Block3D:频道领地(布局/网格/成员,封装移动/边界/成员钳制);
 *  - Agent3D:角色(模型/状态/行为 FSM/动画/活动范围);
 *  - DeviceNode:数字孪生设备(节点网格/状态/遥测/状态环/transform 记忆)。
 */
import * as THREE from 'three'
import {
  AGENT_SPEED, ARRIVE, GROUND_Y, WAIT_MS,
  boundaryPoints, clampToAgentRange, clampToBoundary, normLayout, pointInBoundary,
  type AgentRangeLayout, type ChannelLayout,
} from '#shared/town-scene-math'
import { stepToward } from '#shared/town-behavior'
import type {
  AgentHost, BlockHost, BehaviorState, DeviceHost, DeviceTwinSync,
} from './town-scene3d-types'

/** 边界几何体:椭圆/矩形线框,弯折朝向 rotationY(度)。
 *  轮廓点来自 #shared/town-scene-math.boundaryPoints(纯几何,场景只做渲染)。 */
export function makeBoundary(shape: 'ellipse' | 'rect', rx: number, rz: number, color: number): THREE.LineLoop {
  const pts = boundaryPoints(shape, rx, rz, 48).map(([x, z]) => new THREE.Vector3(x, 0, z))
  const geo = new THREE.BufferGeometry().setFromPoints(pts)
  const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false }))
  return line
}

/** 频道领地 3D 实例(面向对象:持有布局/网格/成员,封装移动/边界/成员钳制等行为)。
 *  数据来自 scene-layouts 持久化,由场景按数据库元数据实例化,并注入宿主控制器。 */
export class Block3D {
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
  host!: BlockHost

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

/** 角色 3D 实例(面向对象:持有模型/状态/行为,封装漫游 FSM、移动钳制、动画、活动范围)。
 *  由场景按 entities/数据库元数据(home/range/modelRef)实例化并注入宿主;动画状态驱动 motion 事件。 */
export class Agent3D {
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
  host!: AgentHost
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
    const bob = () => {
      // 程序化动作绑定(model 局部,色环/名牌保持贴地稳定):
      //  待机呼吸浮动 + 行走跳跃颠簸 + 行走左右微摆
      const t = performance.now()
      const breathe = 1.2 + Math.sin(t * 0.0016) * 1.6
      const hop = Math.abs(Math.sin(t * 0.005)) * 6
      this.model.position.y = moving ? hop : breathe
      const swayTarget = moving ? Math.sin(t * 0.006) * 0.07 : 0
      this.model.rotation.z += (swayTarget - this.model.rotation.z) * 0.12
    }
    if (this.clips.length === 0) {
      bob()
      return
    }
    // 有动画 clip:名字感知选择(剪辑命名各异:WALK/Walk、idle/stand/breath...),
    // 先按语义匹配,找不到回退索引(idle→0,walk→1);仅含走路剪辑的模型待机时
    // 回退程序化 bob,避免原地播放走路。crossfade 平滑过渡(避免双 action 叠加)。
    if (!this.mixer) return
    const lower = (c: THREE.AnimationClip) => c.name.toLowerCase()
    const clip = moving
      ? (this.clips.find(c => /walk|run|move/.test(lower(c))) ?? this.clips[Math.min(1, this.clips.length - 1)])
      : (this.clips.find(c => /idle|stand|breath/.test(lower(c))) ?? (this.clips.length > 1 ? this.clips[0] : null))
    if (!clip) {
      if (this.activeAction) {
        this.activeAction.fadeOut(0.15)
        this.activeAction = null
      }
      bob()
      return
    }
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

/** 数字孪生设备 3D 实例(面向对象:持有节点网格/状态/遥测,封装讑生同步、状态环、模型重挂、transform 记忆)。
 *  由场景按 device-twins 数据库元数据实例化;state/telemetry 数据驱动渲染。 */
export class DeviceNode {
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
  host!: DeviceHost

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
