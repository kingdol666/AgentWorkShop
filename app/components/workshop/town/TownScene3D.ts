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

/** 领地渲染态(边界由 channelLayout 驱动;未放置频道不进入场景) */
interface Block3D {
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
  /** 活动边界(编辑高亮) */
  boundary: THREE.LineLoop
  label: THREE.Sprite
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

/** 角色 3D 渲染态 */
interface Agent3D {
  channelId: string
  agentId: string
  name: string
  role: 'lead' | 'worker'
  /** 根 Group(位置=落地点,脚底) */
  root: THREE.Group
  /** 模型子节点(mountModel 时替换) —— 始终存在(空组占位) */
  model: THREE.Group
  mixer: THREE.AnimationMixer | null
  /** 当前模型动画 clip(若有) */
  clips: THREE.AnimationClip[]
  /** 脚下同频道色环 */
  aura: THREE.Mesh
  /** 头顶名字 Sprite */
  nameSprite: THREE.Sprite
  /** 当前气泡 */
  bubble: THREE.Sprite | null
  bubbleTimer: ReturnType<typeof setTimeout> | null
  /** 状态/进度/行为 */
  state: 'idle' | 'busy' | 'stopped'
  progress: number | null
  /** 行为 FSM */
  behavior: BehaviorState
  /** 用户拖动中 */
  dragging: boolean
  /** home(行为结束后回归) */
  homeX: number
  homeZ: number
  textureKey: string
  modelRef: string
}

type BehaviorMode
  = 'idle'
    | 'roam'
    | 'approach'
    | 'wait'
    | 'returnHome'

/** 数字孪生设备节点(拖入场景的实体模型) */
interface DeviceNode {
  twinId: string
  name: string
  modelRef: string
  root: THREE.Group
  /** 模型挂载组(换模型时 clear 重挂;缩放施加于此) */
  holder: THREE.Group
  ring: THREE.Mesh
  label: THREE.Sprite
  state: 'idle' | 'running' | 'offline' | 'alarm'
  telemetry: Record<string, number | string | boolean>
}

interface BehaviorState {
  mode: BehaviorMode
  roamTarget: { x: number, z: number } | null
  targetId: string | null
  waitUntil: number
  action?: { kind: ActionKind, taskKind?: string, requireReply: boolean, text: string }
  engaged: boolean
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

/** 角色模型来源登记(registerModelsFromList) */
interface ModelInfo { id: string, file: string, name: string, kind?: string }

const BUBBLE_STYLE: Record<TownBubbleKind, { color: number }> = {
  info: { color: 0x1c1917 },
  artifact: { color: 0x1c1917 },
  error: { color: 0x3a1d1c },
  system: { color: 0x1c1917 },
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
  /** 正在拖曳的场景对象(编辑模式):设备 / 角色落点 / 频道整体 / 边界手柄 */
  private pointerDrag:
    | { kind: 'device', id: string }
    | { kind: 'agent', id: string }
    | { kind: 'channel', id: string, dx: number, dz: number }
    | { kind: 'resize', id: string, handle: number }
    | null = null

  /** 网格吸附(编辑拖拽落点对齐 16 单位网格) */
  private snapEnabled = true
  /** 选中高亮环(编辑模式,跟随当前选中设备/角色) */
  private selRing: THREE.Mesh | null = null
  /** 边界缩放手柄(编辑模式选中频道时显示;拖拽手柄调整 radiusX/radiusZ) */
  private resizeHandles: Array<{ mesh: THREE.Mesh, cid: string, handle: number }> = []
  private lastActivity: { channelId: string, agentName: string, text: string } | null = null
  private recentActivity: Array<{ channelId: string, agentName: string, text: string }> = []
  private dbgBubbles: Array<{ text: string, at: number }> = []
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

  /** 按布局放置一个频道领地 + 在其边界内铺放全部 Agent */
  private placeChannel(ch: TownEntityInput, rawLayout: ChannelLayout): void {
    const layout = normLayout(rawLayout)
    const color = channelColorNum(ch.channelId)
    const platform = this.makeBlock(ch.channelName, color, layout)
    const block: Block3D = {
      channelId: ch.channelId, name: ch.channelName,
      x: layout.x, z: layout.z,
      radiusX: layout.radiusX, radiusZ: layout.radiusZ,
      shape: layout.shape, rotationY: layout.rotationY,
      color,
      platform,
      boundary: makeBoundary(layout.shape, layout.radiusX, layout.radiusZ, color),
      label: this.makeLabel(ch.channelName, layout.x, 30, layout.z),
    }
    block.boundary.position.set(layout.x, 0.3, layout.z)
    block.boundary.rotation.y = layout.rotationY * Math.PI / 180
    this.scene.add(block.boundary)
    this.blocks.set(ch.channelId, block)
    // 在边界内铺放该频道的全部 Agent(lead 居中心,worker 左右展开;钳在边界内)
    this.layoutAgentsInBlock(ch, block)
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
    this.agents.set(key, {
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
      bubbleTimer: null,
      state: a.state,
      progress: a.currentTaskProgress ?? null,
      dragging: false,
      homeX,
      homeZ,
      textureKey: texKey,
      modelRef: a.modelRef ?? '',
      behavior: { mode: 'idle', roamTarget: null, targetId: null, waitUntil: 0, engaged: false },
    })
    // 载入模型(GLB)
    const info = this.modelsById.get(texKey) ?? { id: 'hero-3d', file: '/assets/game/character/hero-3d.glb', name: '共鸣精魂' }
    void this.mountModel(this.agents.get(key)!, info.file, info.name)
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
    if (!b) return null
    return {
      channelId, x: b.x, z: b.z,
      radiusX: b.radiusX, radiusZ: b.radiusZ,
      shape: b.shape, rotationY: b.rotationY,
    }
  }

  /** 已放入场景的频道集(供频道坞/选中面板) */
  placedChannels(): string[] {
    return [...this.blocks.keys()]
  }

  /** 频道当前布局(供边界编辑面板初始化) */
  getChannelLayout(channelId: string): ChannelLayout | null {
    const b = this.blocks.get(channelId)
    if (!b) return null
    return {
      channelId, x: b.x, z: b.z,
      radiusX: b.radiusX, radiusZ: b.radiusZ,
      shape: b.shape, rotationY: b.rotationY,
    }
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
      const platform = this.makeBlock(channelName, color, layout)
      const block: Block3D = {
        channelId, name: channelName, x, z,
        radiusX: layout.radiusX, radiusZ: layout.radiusZ,
        shape: layout.shape, rotationY: layout.rotationY, color,
        platform,
        boundary: makeBoundary(layout.shape, layout.radiusX, layout.radiusZ, color),
        label: this.makeLabel(channelName, x, 30, z),
      }
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
        this.agents.delete(aid)
      }
    }
    this.blocks.delete(channelId)
    this.layouts.delete(channelId)
    for (const hl of this.resizeHandles) hl.mesh.visible = false
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

  /** 把频道地块整体平移(平台/边界/名牌/成员落点一并位移) */
  private applyBlockMove(b: Block3D, nx: number, nz: number): void {
    const dx = nx - b.x
    const dz = nz - b.z
    b.x = nx
    b.z = nz
    b.platform.position.set(nx, 0.16, nz)
    b.boundary.position.set(nx, 0.3, nz)
    b.boundary.rotation.y = b.rotationY * Math.PI / 180
    b.label.position.set(nx, 30, nz)
    for (const a of this.agents.values()) {
      if (a.channelId !== b.channelId) continue
      a.root.position.x += dx
      a.root.position.z += dz
      a.homeX += dx
      a.homeZ += dz
    }
    this.layouts.set(b.channelId, normLayout({ channelId: b.channelId, x: b.x, z: b.z, radiusX: b.radiusX, radiusZ: b.radiusZ, shape: b.shape, rotationY: b.rotationY }))
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

  /** 缩放/移动结束后把该频道成员落点钳回新边界内 */
  private clampAgentsToBoundary(channelId: string): void {
    const layout = this.blockLayout(channelId)
    if (!layout) return
    for (const a of this.agents.values()) {
      if (a.channelId !== channelId) continue
      const c = clampToBoundary(layout, a.root.position.x, a.root.position.z, 16)
      a.root.position.x = c.x
      a.root.position.z = c.z
      a.homeX = c.x
      a.homeZ = c.z
    }
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
    if (channelId) this.focusTo(this.blocks.get(channelId)?.x ?? WORLD_CX, this.blocks.get(channelId)?.z ?? WORLD_CZ)
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
    if (intent.bubble) this.showBubble(intent.bubble.channelId, intent.bubble.agentId, intent.bubble.kind, intent.bubble.text, intent.bubble.ttlMs)
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

  private runBehavior(asp: Agent3D, dt: number): void {
    const b = asp.behavior
    if (b.mode === 'idle' || b.mode === 'roam') {
      if (asp.behavior.engaged || asp.dragging) {
        return
      }
      b.mode = 'roam'
      if (!b.roamTarget) {
        const layout = this.blockLayout(asp.channelId)
        const range = layout ? Math.min(layout.radiusX, layout.radiusZ) * 0.45 : 80
        let tx = asp.homeX + (Math.random() * 2 - 1) * range
        let tz = asp.homeZ + (Math.random() * 2 - 1) * range * 0.6
        if (layout) {
          const clamped = clampToBoundary(layout, tx, tz, 16)
          tx = clamped.x
          tz = clamped.z
        }
        b.roamTarget = { x: tx, z: tz }
      }
      this.driveToward(asp, b.roamTarget, AGENT_SPEED * 0.5, dt)
      if (this.reached(asp, b.roamTarget)) b.roamTarget = null
      return
    }
    if (b.mode === 'approach') {
      const target = b.targetId ? this.agents.get(b.targetId) : undefined
      if (!target) {
        b.mode = 'idle'
        return
      }
      const pos = { x: target.root.position.x, z: target.root.position.z }
      this.driveToward(asp, pos, AGENT_SPEED, dt)
      if (this.reached(asp, pos)) {
        this.behaviorDeliver(asp, target)
        if (b.action?.requireReply) {
          b.mode = 'wait'
          b.waitUntil = performance.now() + WAIT_MS
        }
        else {
          b.mode = 'returnHome'
          this.releaseEngaged(asp)
          b.targetId = null
        }
      }
      return
    }
    if (b.mode === 'wait') {
      if (asp.dragging) return
      const target = b.targetId ? this.agents.get(b.targetId) : undefined
      if (target && !target.dragging) {
        const stand = { x: target.root.position.x + 28, z: target.root.position.z + 8 }
        this.driveToward(asp, stand, AGENT_SPEED * 0.6, dt)
      }
      if (performance.now() >= b.waitUntil) {
        b.mode = 'returnHome'
        this.releaseEngaged(asp)
      }
      return
    }
    if (b.mode === 'returnHome') {
      if (asp.dragging) return
      const home = { x: asp.homeX, z: asp.homeZ }
      this.driveToward(asp, home, AGENT_SPEED * 0.7, dt)
      if (this.reached(asp, home)) {
        asp.root.position.set(asp.homeX, GROUND_Y, asp.homeZ)
        b.mode = 'idle'
        b.targetId = null
        b.action = undefined
      }
      return
    }
  }

  private releaseEngaged(asp: Agent3D): void {
    const target = asp.behavior.targetId ? this.agents.get(asp.behavior.targetId) : undefined
    if (target) target.behavior.engaged = false
  }

  private behaviorDeliver(asp: Agent3D, target: Agent3D): void {
    const text = asp.behavior.action?.text ?? ''
    if (text) this.showBubble(asp.channelId, target.agentId, 'info', text, 2600)
    this.emit('behavior', { agentName: asp.name, action: this.behaviorActionLabel(asp.behavior.action?.kind ?? 'message'), targetName: target.name })
  }

  private driveToward(asp: Agent3D, target: { x: number, z: number }, speed: number, dt: number): void {
    const cur = { x: asp.root.position.x, z: asp.root.position.z }
    const next = stepToward({ x: cur.x, y: cur.z }, { x: target.x, y: target.z }, speed, dt)
    // 边界约束:频道角色不得越出其领地活动边界
    let nx = next.x
    let nz = next.y
    const layout = this.blockLayout(asp.channelId)
    if (layout) {
      const clamped = clampToBoundary(layout, nx, nz, 6)
      nx = clamped.x
      nz = clamped.z
    }
    asp.root.position.x = nx
    asp.root.position.z = nz
    // 朝向
    const dir = next.dir
    if (dir === 'left') asp.root.rotation.y = Math.PI
    else if (dir === 'right') asp.root.rotation.y = 0
    this.playWalkAnim(asp, true)
    void dt
  }

  private reached(asp: Agent3D, target: { x: number, z: number }): boolean {
    return Math.hypot(asp.root.position.x - target.x, asp.root.position.z - target.z) <= ARRIVE
  }

  private playWalkAnim(asp: Agent3D, moving: boolean): void {
    if (asp.clips.length === 0) {
      // 无动画 → 轻微上下浮动(bob)
      asp.root.position.y = GROUND_Y + (moving ? Math.abs(Math.sin(performance.now() * 0.004)) * 4 : 0)
      return
    }
    // 有动画 clip:idle(0)/walk(1),按移动切换(缺省则用 clip[0])
    if (!asp.mixer) return
    const idx = moving ? (asp.clips.length > 1 ? 1 : 0) : 0
    const clip = asp.clips[idx]
    if (!clip) return
    const action = asp.mixer.clipAction(clip)
    action.play()
    // 移动快、静止慢
    action.timeScale = moving ? 1.3 : 0.9
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
  // 气泡(头顶 Sprite)
  // ================================================================

  private showBubble(channelId: string, agentId: string | undefined, kind: TownBubbleKind, text: string, ttlMs: number): void {
    const asp = agentId ? this.agents.get(agentId) : undefined
    const b = this.blocks.get(channelId)
    const x = asp?.root.position.x ?? b?.x ?? WORLD_CX
    const z = asp?.root.position.z ?? b?.z ?? WORLD_CZ
    const y = asp ? 70 : 40
    const color = BUBBLE_STYLE[kind]?.color ?? 0x1c1917
    // 画气泡 Canvas
    const canvas = document.createElement('canvas')
    canvas.width = Math.min(360, 60 + text.length * 12)
    canvas.height = 60
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`
    ctx.fillRect(4, 4, canvas.width - 8, canvas.height - 8)
    ctx.fillStyle = '#fff'
    ctx.font = '15px Geist, PingFang SC, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text.slice(0, 28), canvas.width / 2, 32)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }))
    sprite.scale.set(canvas.width / 8, canvas.height / 8, 1)
    sprite.position.set(x, y, z)
    this.scene.add(sprite)
    if (asp) {
      if (asp.bubble) this.scene.remove(asp.bubble)
      asp.bubble = sprite
      if (asp.bubbleTimer) clearTimeout(asp.bubbleTimer)
      asp.bubbleTimer = setTimeout(() => {
        this.scene.remove(sprite)
        if (asp.bubble === sprite) asp.bubble = null
      }, ttlMs)
    }
    else {
      setTimeout(() => this.scene.remove(sprite), ttlMs)
    }
    this.dbgBubbles.push({ text, at: Date.now() })
    this.lastActivity = { channelId, agentName: asp?.name ?? b?.name ?? '系统', text }
    this.recentActivity.push({ channelId, agentName: asp?.name ?? b?.name ?? '系统', text })
    if (this.recentActivity.length > 6) this.recentActivity.splice(0, this.recentActivity.length - 6)
    this.emit('lastActivity', this.lastActivity)
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
      this.showBubble(near.channelId, near.agentId, 'info', `换装 → ${model?.name ?? assetId}`, 2200)
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
    const resident: Agent3D = {
      channelId: '', agentId: `resident-${Date.now().toString(36)}`, name,
      role: 'worker', root, model, mixer: null, clips: [], aura, nameSprite,
      bubble: null, bubbleTimer: null, state: 'idle', progress: null,
      dragging: false, homeX: x, homeZ: z, textureKey: texKey, modelRef: texKey,
      behavior: { mode: 'idle', roamTarget: null, targetId: null, waitUntil: 0, engaged: false },
    }
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
    const twin: DeviceNode = { twinId, name, modelRef: texKey, root, holder, ring, label, state: 'idle', telemetry: {} }
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
    agents: Array<{ agentId: string, name: string, role: string, channelId: string, state: string, progress: number | null, x: number, y: number, visible: boolean, draggable: boolean, auraColor: number, behavior: string, targetId: string | null, homeX: number, homeY: number, textureKey: string, modelRef: string, decorated: boolean }>
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

  /** 更新设备节点状态/遥测(由 useDeviceTwins 轮询或控制反馈驱动) */
  updateDeviceNode(twinId: string, state: DeviceNode['state'], telemetry?: Record<string, number | string | boolean>): void {
    const dev = this.deviceNodes.get(twinId)
    if (!dev) return
    dev.state = state
    if (telemetry) dev.telemetry = { ...dev.telemetry, ...telemetry }
  }

  /** 设备改名(重建名牌 Sprite;持久化由 TownView 走 devices.update) */
  renameDevice(id: string, name: string): void {
    const dev = this.deviceNodes.get(id)
    if (!dev || !name.trim() || name.trim() === dev.name) return
    dev.name = name.trim()
    this.scene.remove(dev.label)
    dev.label = this.makeLabel(`⚙ ${dev.name}`, dev.root.position.x, 60, dev.root.position.z)
    this.dirty = true
  }

  /** 设备换模型(按 modelRef 重挂 GLB 到 holder;持久化由 TownView 走 devices.update) */
  swapDeviceModel(id: string, modelRef: string): void {
    const dev = this.deviceNodes.get(id)
    const info = this.modelsById.get(modelRef)
    if (!dev || !info || !info.file || modelRef === dev.modelRef) return
    dev.modelRef = modelRef
    dev.holder.clear()
    void this.loadGltfToGroup(info.file, dev.holder, UNITS * 1.6)
    this.dirty = true
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
      if (this.pointInBoundary(layout, x, z)) return b.channelId
    }
    return null
  }

  /** 点到边界内判定(解析闭合;互斥命中最靠近中心的频道) */
  private pointInBoundary(layout: ChannelLayout, x: number, z: number): boolean {
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

  /** 设置选中(点击后由 Vue 弹缩放/旋转滑杆) */
  private setSelected(sel: { kind: 'agent' | 'device', id: string } | null): void {
    this.selected = sel
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

  /** 模式切换:浏览(只读:相机+点选) / 编辑(可拖拽设备/调整角色落点/旋转/频道整体移动/边界手柄) */
  setMode(mode: TownScene3DMode): void {
    if (this.mode === mode) return
    this.mode = mode
    if (mode === 'browse') {
      if (this.pointerDrag) this.endPointerDrag()
      this.setSelected(null)
      this.refreshChannelHandles()
    }
    else if (this.selected) {
      this.showSelectionRing(this.selected)
    }
    this.refreshChannelHandles()
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
    // 1) 边界缩放手柄优先(编辑模式选中频道的 4 个手柄 → 调整范围大小)
    const h = this.pickResizeHandle(w.x, w.z)
    if (h) {
      this.pointerDrag = { kind: 'resize', id: h.cid, handle: h.handle }
      this.setSelected(null)
      this.emitSaveState('dirty')
      return true
    }
    // 2) 设备 / 角色
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
    // 3) 频道领地整体拖拽:点中领地空白处 → 平移整个频道(平台/边界/名牌/成员落点)
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
    else if (pd.kind === 'channel') {
      const b = this.blocks.get(pd.id)
      if (b) this.applyBlockMove(b, x + pd.dx, z + pd.dz)
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
      if (t.state) existing.state = t.state
      if (t.telemetry) existing.telemetry = { ...existing.telemetry, ...t.telemetry }
      // 名称/模型变更(他人改名/换模 → 即时收敛场景节点)
      if (t.name && t.name !== existing.name) this.renameDevice(t.id, t.name)
      if (t.modelRef && t.modelRef !== existing.modelRef) this.swapDeviceModel(t.id, t.modelRef)
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
    const twin: DeviceNode = { twinId: t.id, name: t.name, modelRef: t.modelRef, root, holder, ring, label, state: t.state ?? 'idle', telemetry: t.telemetry ?? {} }
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
      // 行为 FSM
      for (const asp of this.agents.values()) {
        if (asp.state !== 'stopped' && !asp.dragging) this.runBehavior(asp, dt)
      }
      // mixer 更新
      for (const asp of this.agents.values()) {
        if (asp.mixer) asp.mixer.update(dt)
      }
      // 名字/环跟随 + 逐帧动画(脉冲/光柱/缓动)
      for (const asp of this.agents.values()) {
        asp.nameSprite.position.set(asp.root.position.x, 48, asp.root.position.z)
        asp.aura.position.set(asp.root.position.x, 0.22, asp.root.position.z)
      }
      // 设备节点:状态环颜色驱动 + 名牌跟随
      for (const dev of this.deviceNodes.values()) {
        dev.ring.position.set(dev.root.position.x, 0.3, dev.root.position.z)
        dev.label.position.set(dev.root.position.x, 60, dev.root.position.z)
        const color = dev.state === 'alarm' ? 0xff6b6b : dev.state === 'offline' ? 0x9aa4ae : dev.state === 'running' ? 0x8fe8d4 : 0xf0c05a
        ;(dev.ring.material as THREE.MeshBasicMaterial).color.setHex(color)
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
    this.pointerDrag = null
    this.selected = null
    this.selectedChannel = null
    for (const hl of this.resizeHandles) hl.mesh.visible = false
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
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.el) this.renderer.domElement.remove()
  }
}
