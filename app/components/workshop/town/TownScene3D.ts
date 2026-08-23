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
  /** 选中 Agent/设备(供 Vue 弹缩放滑杆);null 取消选中 */
  select: { kind: 'agent' | 'device', id: string, scale: number } | null
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
  }>
}

/** 领地渲染态 */
interface Block3D {
  channelId: string
  name: string
  x: number
  z: number
  radius: number
  color: number
  platform: THREE.Mesh
  ring: THREE.Mesh
  label: THREE.Sprite
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
const RING_RX = 980
const RING_RZ = 560
/** 地面 y=0,Agent 站立于其上 */
const GROUND_Y = 0
/** GLB 归一化到该高度(世界单位,角色要清晰可读) */
const UNITS = 120
const AGENT_SPEED = 96
const WAIT_MS = 2600
const ARRIVE = 48

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
  private lastActivity: { channelId: string, agentName: string, text: string } | null = null
  private recentActivity: Array<{ channelId: string, agentName: string, text: string }> = []
  private dbgBubbles: Array<{ text: string, at: number }> = []
  readonly container: HTMLDivElement

  /** 任务 ID → assignee 反查 */
  resolveTaskAssignee: ((taskId: string) => string | null) | null = null
  /** 数字孪生设备 API(由 TownView 注入 useDeviceTwins 适配器;拖 dev 模型进场景时创建设备) */
  devices: {
    create(input: { name: string, modelRef?: string, kind?: string, controls?: string[] }): Promise<{ id: string }>
    control(id: string, command: string, args?: Record<string, unknown>): Promise<unknown>
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
    // 选中:点击 Agent/设备 → 弹缩放滑杆(经 on('select') 通知 Vue)
    this.renderer.domElement.addEventListener('pointerup', (e: PointerEvent) => {
      if (e.button !== 0) return
      const w = this.screenToWorld(e.clientX, e.clientY)
      const hit = this.pickAt(w.x, w.z)
      this.setSelected(hit)
    })

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x101826)

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

    this.loop()
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
  // 实体基线构建(环形布点 + 领地平台 + 名牌)
  // ================================================================

  private buildBlocks(seeds: TownEntityInput[]): void {
    const count = Math.max(1, seeds.length)
    const radius = count <= 1 ? 210 : Math.min(210, 300 - count * 8)
    seeds.forEach((ch, i) => {
      const ang = i === 0 ? -Math.PI / 2 : -Math.PI / 2 + (i * 2 * Math.PI) / count
      const x = Math.round(WORLD_CX + Math.cos(ang) * RING_RX)
      const z = Math.round(WORLD_CZ + Math.sin(ang) * RING_RZ)
      const color = channelColorNum(ch.channelId)
      const platform = this.makeBlock(color, x, z, radius)
      const block: Block3D = { channelId: ch.channelId, name: ch.channelName, x, z, radius, color, platform, ring: platform, label: this.makeLabel(ch.channelName, x, 30, z) }
      this.blocks.set(ch.channelId, block)
      for (const a of ch.agents) this.ensureAgent({ ...a, channelId: ch.channelId }, x, z, color)
    })
    this.emit('blockCount', this.blocks.size)
    this.emit('agentCount', this.agents.size)
  }

  /** 领地:地面色环 + 光晕平台 + 名牌 */
  private makeBlock(color: number, x: number, z: number, r: number): THREE.Mesh {
    const platform = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.9, 40),
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.28, roughness: 0.9, side: THREE.DoubleSide }),
    )
    platform.rotation.x = -Math.PI / 2
    platform.position.set(x, 0.16, z)
    platform.receiveShadow = true
    this.scene.add(platform)
    // 外环描边
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.9, r * 0.98, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.set(x, 0.2, z)
    this.scene.add(ring)
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
    const root = new THREE.Group()
    root.position.set(cx, GROUND_Y, cz)
    // 脚下同频道色环
    const aura = new THREE.Mesh(
      new THREE.RingGeometry(10, 16, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    )
    aura.rotation.x = -Math.PI / 2
    aura.position.y = 0.22
    root.add(aura)
    const nameSprite = this.makeLabel(a.name, cx, 48, cz)
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
      homeX: cx,
      homeZ: cz,
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
  // 重建 / 聚焦 / 事件入口(公开面与 2D 镜像)
  // ================================================================

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

  handleTownEvent(e: AepEnvelope): void {
    if (e.type === 'channel.snapshot') return
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
        const def = this.blocks.get(asp.channelId)
        const range = def?.radius ? def.radius * 0.5 : 80
        b.roamTarget = { x: asp.homeX + (Math.random() * 2 - 1) * range, z: asp.homeZ + (Math.random() * 2 - 1) * range * 0.6 }
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
    asp.root.position.x = next.x
    asp.root.position.z = next.y
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
    const model = new THREE.Group()
    root.add(model)
    const label = this.makeLabel(`⚙ ${name}`, x, 60, z)
    this.scene.add(root)
    // 绑定 device twin
    const twin: DeviceNode = { twinId, name, modelRef: texKey, root, ring, label, state: 'idle', telemetry: {} }
    this.deviceNodes.set(twinId, twin)
    // 客制化:注册设备可缩放目标(twinId 为临时 id;REST 返回真实 id 后更新 key)
    this.registerScalable('device', twinId, model)
    // 加载模型(GLB)
    void this.loadGltfToGroup(file, model, UNITS * 1.6)
    // 创建设备(异步;失败则仅本地节点)
    void this.devices?.create({ name, modelRef: texKey, kind: 'device', controls: ['power_on', 'power_off', 'set_speed'] })
      .then((d) => {
        twin.twinId = d.id
        // 把可缩放目标从临时 id 迁移到真实 id(保留缩放%)
        const saved = this.scalables.get(`device:${twinId}`)
        this.scalables.delete(`device:${twinId}`)
        if (saved) this.scalables.set(`device:${d.id}`, saved)
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

  /** 设置选中(点击后由 Vue 弹缩放滑杆) */
  private setSelected(sel: { kind: 'agent' | 'device', id: string } | null): void {
    this.selected = sel
    if (!sel) {
      this.emit('select', null)
      return
    }
    const st = this.scalables.get(`${sel.kind}:${sel.id}`)
    if (st) this.emit('select', { kind: sel.kind, id: sel.id, scale: st.userScale })
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
  getSelectedScale(): { kind: 'agent' | 'device', id: string, scale: number } | null {
    if (!this.selected) return null
    const st = this.scalables.get(`${this.selected.kind}:${this.selected.id}`)
    if (!st) return null
    return { kind: this.selected.kind, id: this.selected.id, scale: st.userScale }
  }

  /** 组装可缩放目标并恢复持久化缩放(load from localStorage 'town.scale.<kind:id>') */
  private registerScalable(kind: 'agent' | 'device', id: string, holder: THREE.Group): void {
    const saved = typeof localStorage !== 'undefined' ? Number(localStorage.getItem(`town.scale.${kind}:${id}`) ?? 1) : 1
    const userScale = Number.isFinite(saved) && saved > 0 ? saved : 1
    this.scalables.set(`${kind}:${id}`, { kind, id, userScale, holder })
    holder.scale.setScalar(userScale)
  }

  /** 持久化指定对象的缩放(滑杆松手时调用) */
  persistScale(kind: 'agent' | 'device', id: string): void {
    const st = this.scalables.get(`${kind}:${id}`)
    if (!st || typeof localStorage === 'undefined') return
    localStorage.setItem(`town.scale.${kind}:${id}`, String(st.userScale))
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
      this.scene.remove(b.label)
    }
    this.agents.clear()
    this.blocks.clear()
  }

  /** 销毁(卸载时由 TownView 调用) */
  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.el) this.renderer.domElement.remove()
  }
}
