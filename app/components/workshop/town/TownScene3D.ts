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
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import type { AepEnvelope } from '#shared/workshop-protocol'
import type { TownBubbleKind } from '#shared/town-protocol'
import type { ActionKind, ActionContext } from '#shared/town-behavior'
// 纯几何/色彩/尺度决策层(与测试共用,零渲染依赖)
import {
  WORLD_CX, WORLD_CZ,
  type AgentRangeLayout, type ChannelLayout,
} from '#shared/town-scene-math'

// 轨道相机与相机交互自本文件抽出(见 scene/town-scene3d-camera.ts)
import {
  autoFrameTo, flyToPreset, focusTo, getAutoOrbit, getCameraPose, orbitBy, panBy, panByScreen,
  panWorldBy, resetView, screenToWorld, setAutoOrbit, setViewPreset, worldToScreen, zoomBy,
} from './scene/town-scene3d-camera'
// 渲染核心初始化自本文件抽出(见 scene/town-scene3d-renderer.ts)
import { initRendererCore } from './scene/town-scene3d-renderer'
// 类型契约 / 面向对象节点(Channel 领地 / 角色 / 数字孪生设备)自本文件抽出,
// 只通过宿主契约回调场景 —— 细节见 town-scene3d-types.ts 与 town-scene3d-nodes.ts
// 信息接收器 + 聊天气泡自本文件抽出(见 scene/town-scene3d-bubbles.ts)
import { drainReceivers, enqueueBubble } from './scene/town-scene3d-bubbles'
// 数采绑定链路 + 薄膜 web 自本文件抽出(见 scene/town-scene3d-links.ts)
import { deviceTopY, rebuildFilmWeb, refreshDaqLinks, syncDaqLinks } from './scene/town-scene3d-links'
// 事件共鸣 + 行为 FSM 入口 + WS 事件入口自本文件抽出(见 scene/town-scene3d-events.ts)
import { behaviorActionLabel, emitResonance, handleTownEvent, startBehavior } from './scene/town-scene3d-events'
// 调试 / HUD 数据面自本文件抽出(见 scene/town-scene3d-hud.ts)
import { getDebugState, getMinimapState, getRecentActivity } from './scene/town-scene3d-hud'
// 数字孪生设备节点层自本文件抽出(见 scene/town-scene3d-devices.ts)
import {
  getDeviceModelRef, getDeviceName, getDeviceNodes, persistAllDevices, persistDeviceTransform,
  recreateDeviceNode, removeDevice, renameDevice, renameDeviceSprite, spawnDeviceNode,
  swapDeviceModel, swapDeviceModelSprite, syncDevices, updateDeviceNode,
} from './scene/town-scene3d-devices'
// GLB 加载与 PBR 材质增强自本文件抽出(见 scene/town-scene3d-models.ts)
import { enhancePbrMaterials } from './scene/town-scene3d-models'
// 角色节点层 + 模型库挂载自本文件抽出(见 scene/town-scene3d-agents.ts)
import {
  dropModelOnWorld, ensureAgent, getAgentClips, getAgentModel, getAgentName,
  registerModelsFromList, setAnimPref, swapAgentModel,
} from './scene/town-scene3d-agents'
// 频道领地放置层自本文件抽出(见 scene/town-scene3d-blocks.ts)
import {
  applyLayoutToBlock, applySceneLayouts, blockLayout, buildBlocks, dropChannelOnWorld,
  getAllChannelLayouts, getCameraTarget, getChannelLayout, hasChannel, placedChannels,
  removeChannel, trackLayout, updateChannelLayout,
} from './scene/town-scene3d-blocks'
// 渲染循环 + 画质阶梯自本文件抽出(见 scene/town-scene3d-loop.ts)
import { adaptQuality, applyPixelRatio, applyQuality, setQualityMode, startRenderLoop } from './scene/town-scene3d-loop'
// 拾取 / 选中 / 缩放旋转自本文件抽出(见 scene/town-scene3d-selection.ts)
import {
  getModelRotation, getSelectedChannel, getSelectedScale, isGizmoBusy, persistScale, pickAt,
  pickBeacon, pickChannel, pickChannelEdge, registerScalable, selectChannel, setExposure,
  setModelRotation, setModelScale, setSelected, setTerritoryOpacity, setTransformMode,
} from './scene/town-scene3d-selection'
// 实例资源释放与整场重置自本文件抽出(见 scene/town-scene3d-lifecycle.ts)
import {
  dispose as disposeScene, disposeAgentAssets, disposeCanvasTextures, disposeDeviceAssets,
  resetAll as resetScene,
} from './scene/town-scene3d-lifecycle'
// 编辑/浏览模式 + 场景对象拖拽(设备/角色/频道/边界手柄)自本文件抽出(见 scene/town-scene3d-editing.ts)
import {
  applyBlockMove, applyResize, boundaryHandlePoints, clampAgentsToBoundary, endPointerDrag, getMode,
  getSnap, isPointerDragging, movePointerDrag, pickResizeHandle, refreshChannelHandles, setMode,
  setSnap, snapWorld, tryStartPointerDrag,
} from './scene/town-scene3d-editing'
// Agent 独立活动范围(框选绘制/整框平移/手柄缩放/面板读写)自本文件抽出(见 scene/town-scene3d-ranges.ts)
import {
  applyAgentRangeResize, cancelRangeDraw, clearAgentRange, commitAgentRange, emitAgentRangeChanged,
  getAgentRange, hitAgentRangeBoundary, isRangeDrawing, pickAgentRangeHandle, rangeLineVisible,
  rangeLineVisibleFor, refreshAgentRangeHandles, refreshAgentRangeLines, setAgentRangeScene,
  startRangeDraw, updateRangeDrawPreview,
} from './scene/town-scene3d-ranges'
import type { Agent3D, Block3D, DeviceNode } from './scene/town-scene3d-nodes'
import type {
  AgentHost, AgentRangeHandle, BlockHost, ChannelMessageReceiver, ChannelResizeHandle, DaqLink,
  DeviceApi, DeviceHost, DeviceTwinSync, ModelInfo, PointerDragState, ScaledTarget,
  SelectedTarget, TownEntityInput, TownEventMap, TownScene3DMode, TownSceneHost,
} from './scene/town-scene3d-types'

export type { AgentRangeLayout, ChannelLayout } from '#shared/town-scene-math'
export {
  Block3D, Agent3D, DeviceNode, makeBoundary,
} from './scene/town-scene3d-nodes'
export type {
  BehaviorState, BubbleMsg, ChannelMessageReceiver, DeviceTransformPatch,
  DeviceTwinSync, ModelInfo, ScaledTarget, TownEntityInput, TownEventMap, TownScene3DMode,
} from './scene/town-scene3d-types'

/** 频道布局(3D 小镇放置):与共享 AepSceneLayout/useSceneLayouts 同构 —— 定义见 #shared/town-scene-math */

/** Agent 独立活动范围(编辑模式框选绘制/手柄调整;经 config.range 持久化)。
 *  缺省(null)= 未设置,该 Agent 沿用频道边界活动。 —— 定义见 #shared/town-scene-math */

// 频道领地 / 角色 / 数字孪生设备节点与类型契约见 ./scene/town-scene3d-nodes.ts 与 ./scene/town-scene3d-types.ts

/** 世界尺度/速度/身份色等纯常量与函数集中定义于 #shared/town-scene-math(与 2D/测试共用) */

export class TownScene3D implements TownSceneHost {
  // ================================================================
  // 宿主契约面:下列成员被 scene/*.ts 抽出模块以「窄接口」直接读写
  // (每个模块只声明它真正触达的项,见各模块顶部的 XxxHost 接口)。
  // 为「方法簇 → 模块」的结构性拆分而公开,不改变任何运行时语义。
  // 其中 autoFrameTo / pickChannelEdge / boundaryHandlePoints 由 private 放宽为 public:
  // 原调用点全在本类内部(已随簇迁出),editing / ranges 模块经宿主契约回调,纯属可见性放宽。
  // ================================================================

  renderer!: THREE.WebGLRenderer
  /** 后处理管线:Render → Bloom(夜航辉光)→ Output(tone mapping + sRGB;曝光经 setExposure 仍实时生效) */
  composer!: EffectComposer
  camera!: THREE.PerspectiveCamera
  /** 相机注视目标(拖拽平移它,zoom 微调距离) */
  camTarget = new THREE.Vector3(WORLD_CX, 20, WORLD_CZ)
  /** 主方向光(阴影相机范围随 dolly 扩,大领地投影不消失) */
  keyLight!: THREE.DirectionalLight
  scene!: THREE.Scene
  ground!: THREE.Mesh
  /** 穹顶天幕(随镜头平移,保证无限视野观感) */
  skyDome: THREE.Mesh | null = null
  blocks = new Map<string, Block3D>()
  agents = new Map<string, Agent3D>()
  /** 数字孪生设备节点(twinId → node) */
  deviceNodes = new Map<string, DeviceNode>()
  /** 数采节点顶端 LED 环(twinId → 环;渲染循环缓转呼吸) */
  daqLedRings = new Map<string, THREE.Mesh>()
  /** 数采→设备 绑定链路(虚线贝塞尔 + 流动脉冲;syncDaqLinks 维护) */
  daqLinkGroup = new THREE.Group()
  daqLinks: DaqLink[] = []

  daqLinkSig = ''
  /** 期望链路(TownView 传入;设备节点晚到时由 syncDevices 末尾重仲裁) */
  daqLinksWanted: Array<{ daqId: string, deviceId: string }> = []
  /** 薄膜 web(产线设备之间的半透明膜;按 X 序连接挤出→流延→MD→TD→收卷) */
  filmWebGroup = new THREE.Group()
  filmWebSig = ''
  filmWebMat: THREE.MeshStandardMaterial | null = null
  /** 服务端已有但模型资产尚未注册的设备孪生，资产到达后补建节点。 */
  pendingDeviceTwins = new Map<string, DeviceTwinSync>()
  /** 尚未取得服务端 ID 的本地设备节点(临时 ID → 创建请求初始状态)。 */
  pendingDeviceCreates = new Map<string, { name: string, modelRef: string, posX: number, posZ: number }>()
  /** 用户在创建设备完成前删除的临时节点，创建完成后补偿删除服务端记录。 */
  cancelledDeviceCreates = new Set<string>()
  /** 场景内可缩放目标(Agent 或设备) */
  scalables = new Map<string, ScaledTarget>()
  /** 当前选中(kind:id) */
  selected: SelectedTarget | null = null
  /** 已登记模型(id → file) */
  modelsById = new Map<string, ModelInfo>()
  /** GLTF 缓存(避免重复加载) */
  gltfCache = new Map<string, { file: string, scene: THREE.Group, height: number }>()
  gltfLoader = new GLTFLoader()
  el: HTMLDivElement
  raf = 0
  clock = new THREE.Clock()
  frameCount = 0
  fpsAccum = 0
  /** 墙钟 FPS 窗口起点与 rAF 回调计数(徽标/自适应质量的真实输入;原 dt 累计会漂移) */
  fpsWinT0 = 0
  rafCount = 0
  /** 帧预算(ms):渲染节流上限;0 = 不限制。数据消费不走此门控(帧到达即入实时缓冲) */
  frameBudgetMs = 1000 / 40

  /** 用户帧率选择(60/120/0=不限制):只影响渲染节流,与数据消费频率无关 */
  setFpsCap(fps: number): void {
    this.frameBudgetMs = fps > 0 ? 1000 / fps : 0
    this.frameAcc = 0
  }

  frameAcc = 0
  /** 动态分辨率基准(初始 dpr):实测帧率过低时降,富余时回升 */
  baseDpr = Math.min(window.devicePixelRatio, 2)
  dirty = true
  /** 频道旗缓存(任务状态) */
  flagBy = new Map<string, THREE.Mesh>()
  disposed = false
  /** 当前相机缩放(滚轮;作用于 dolly 距离) */
  dolly = 1.0
  /** 轨道相机状态机(Blender 规范):yaw 方位角 / pitch 仰角 / radius 半径。
   *  viewTarget 供预设平滑趋近;左键环绕直接改双值(即时跟手)。 */
  autoOrbit = false
  viewCur = { yaw: 0, pitch: 0.7, radius: 1178 }
  viewTarget = { yaw: 0, pitch: 0.7, radius: 1178 }
  /** Blender 式变换手柄(选中设备;G 移动 / R 旋转 / S 缩放) */
  tControls: TransformControls | null = null
  /** 舞台尺寸观察器 */
  resizeOb: ResizeObserver | null = null
  /** 编辑 / 浏览模式(浏览只读:设备/角色不可拖,仅点选) */
  mode: TownScene3DMode = 'browse'
  /** 正在拖曳的场景对象(编辑模式):设备 / 角色落点 / 频道整体 / 边界手柄 / Agent 活动范围 */
  pointerDrag: PointerDragState = null

  /** 网格吸附(编辑拖拽落点对齐 16 单位网格) */
  snapEnabled = true
  /** 选中高亮环(琥珀色动效环,跟随当前选中设备/角色;渲染循环驱动) */
  selRing: THREE.Mesh | null = null
  /** 边界缩放手柄(编辑模式选中频道时显示;拖拽手柄调整 radiusX/radiusZ) */
  readonly resizeHandles: ChannelResizeHandle[] = []
  /** Agent 活动范围缩放手柄(编辑模式选中带范围角色时显示;拖拽调整该 Agent 范围大小) */
  readonly agentRangeHandles: AgentRangeHandle[] = []
  /** 框选绘制预览线框(rangeDraw 模式;松开后变为正式范围) */
  rangeDrawLine: THREE.LineLoop | null = null
  /** 框选绘制目标 agent(非空 = 编辑模式正在为该角色拉动矩形框) */
  rangeDrawAgent: string | null = null
  /** 框选绘制当前对角(供 endPointerDrag 生成范围) */
  rangeDrawPreviewState: { x0: number, z0: number, x1: number, z1: number } | null = null
  /** setAgentRangeScene 中因范围收缩而位移的 home(面板提交时一并落库) */
  rangeHomeMoved: { agentId: string, x: number, z: number } | null = null
  lastActivity: { channelId: string, agentName: string, text: string, at?: number } | null = null
  recentActivity: Array<{ channelId: string, agentName: string, text: string, at?: number }> = []
  dbgBubbles: Array<{ text: string, at: number }> = []
  /** 频道信息接收器(channelId → FIFO 队列;实时信息经 handleTownEvent 入队,渲染循环逐条消费) */
  receivers = new Map<string, ChannelMessageReceiver>()
  readonly container: HTMLDivElement

  /** 任务 ID → assignee 反查 */
  resolveTaskAssignee: ((taskId: string) => string | null) | null = null
  /** 数字孪生设备 API(由 TownView 注入 useDeviceTwins 适配器;拖 dev 模型进场景时创建设备) */
  devices: DeviceApi | null = null

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
  // 面向对象节点的宿主契约(Block3D / Agent3D / DeviceNode)
  // 节点只依赖 scene/town-scene3d-types 的最小接口,此处显式暴露宿主能力,
  // 保证「节点所需服务」在编译期可校验(缺一即报错)。
  // ================================================================

  /** 频道领地节点宿主(Block3D.host) */
  get blockHost(): BlockHost { return this }

  /** 角色节点宿主(Agent3D.host) */
  get agentHost(): AgentHost { return this }

  /** 设备节点宿主(DeviceNode.host) */
  get deviceHost(): DeviceHost { return this }

  // ================================================================
  // 初始化(渲染器/相机/灯光/地面)
  // ================================================================

  private initRenderer(): void {
    initRendererCore(this)
    // E2E/性能探针钩子:真值验证用(渲染帧计数/质量档/pixelRatio),dispose 时清除
    ;(globalThis as { __townScene3d?: TownScene3D }).__townScene3d = this
    this.loop()
  }

  // ================================================================
  // 事件总线(与 2D 同构)
  // ================================================================

  on<K extends keyof TownEventMap>(event: K, fn: (e: TownEventMap[K]) => void): () => void {
    this.busHandlers.set(event, fn as (e: unknown) => void)
    return () => this.busHandlers.delete(event)
  }

  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void {
    const fn = this.busHandlers.get(event)
    if (fn) fn(e)
  }

  // ================================================================
  // 实体基线构建(布局驱动放置:只呈现「已放置」的频道;未放置不进场景)
  // ================================================================

  /**
   * 用频道实体基线同步领地/角色。仅放置已保存布局的频道(布局来自 useSceneLayouts,
   * 经 applySceneLayouts 注入);未放置频道只出现在频道坞,不进 3D。
   * 实现见 scene/town-scene3d-blocks.ts。
   */
  buildBlocks(seeds: TownEntityInput[]): void { buildBlocks(this, seeds) }

  /** 命中频道信标(中心 ±34 单位;点击信标 = 定位中心 + 唤醒边界编辑,任何模式) */
  pickBeacon(x: number, z: number): { cid: string, x: number, z: number } | null { return pickBeacon(this, x, z) }

  // ================================================================
  // Agent(3D 角色:根 Group + 模型 + 同频道色环 + 名字;
  // 实现见 scene/town-scene3d-agents.ts)
  // ================================================================

  /** 按实体元数据实例化 Agent3D(落点钳制 / 活动范围 / 身份光环 / 名牌) */
  ensureAgent(a: TownEntityInput['agents'][number] & { channelId: string }, cx: number, cz: number, color: number): void {
    ensureAgent(this, a, cx, cz, color)
  }

  agentAnimClips = new Map<string, THREE.AnimationClip[]>()

  /** 注册模型清单，并将晚到资产挂载到已存在的 Agent/设备。 */
  registerModelsFromList(list: Array<{ id: string, file: string, name: string, kind?: string, hFactor?: number }>): void {
    registerModelsFromList(this, list)
  }

  // ================================================================
  // 布局注入 / 重建 / 聚焦 / 事件入口(公开面与 2D 镜像;
  // 领地层实现见 scene/town-scene3d-blocks.ts)
  // ================================================================

  /**
   * 注入频道领地布局(来自 useSceneLayouts)。构建场景前必须调用;
   * 未放置的频道会在 rebuild 时被跳过(只停留在频道坞)。
   */
  applySceneLayouts(layouts: ChannelLayout[]): void { applySceneLayouts(this, layouts) }

  /** 频道是否已放入场景(供频道坞标记已放置/未放置) */
  hasChannel(channelId: string): boolean { return hasChannel(this, channelId) }

  /** 频道当前布局(供边界约束;未放置返回空) */
  blockLayout(channelId: string): ChannelLayout | null { return blockLayout(this, channelId) }

  /** 已放入场景的频道集(供频道坞/选中面板) */
  placedChannels(): string[] { return placedChannels(this) }

  /** 频道当前布局(供边界编辑面板初始化) */
  getChannelLayout(channelId: string): ChannelLayout | null { return getChannelLayout(this, channelId) }

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
  trackLayout(b: Block3D): void { trackLayout(this, b) }

  /** 设备改名:重建名牌 Sprite(由 DeviceNode.applyTwin 委托;实现见 scene/town-scene3d-devices.ts) */
  renameDeviceSprite(dev: DeviceNode, name: string): void { renameDeviceSprite(this, dev, name) }

  /** 设备换模型:按 modelRef 重挂 GLB 到 holder(由 DeviceNode.applyTwin 委托) */
  swapDeviceModelSprite(dev: DeviceNode, modelRef: string): void { swapDeviceModelSprite(this, dev, modelRef) }

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
  // 频道放置(drop 入口)+ 活动边界编辑(实现见 scene/town-scene3d-blocks.ts)
  // ================================================================

  /**
   * 频道拖入场景:在落点建领地 + 铺放其全部 Agent(钳在边界内)。
   * 频道 id 需已在实体基线中;返回落点世界坐标(供 HUD 提示)。
   */
  dropChannelOnWorld(x: number, z: number, channelId: string, channelName: string, agentCount: number): { x: number, z: number, channelId: string, name: string } {
    return dropChannelOnWorld(this, x, z, channelId, channelName, agentCount)
  }

  /** 更新频道布局(编辑边界后本地即时生效;持久化由 TownView 经 useSceneLayouts.save 落库) */
  updateChannelLayout(channelId: string, patch: Partial<ChannelLayout>): void { updateChannelLayout(this, channelId, patch) }

  /** 移除频道放置(从场景撤走领地及其 Agent) */
  removeChannel(channelId: string): void { removeChannel(this, channelId) }

  // ================================================================
  // 频道整体拖拽 / 边界手柄缩放(编辑模式;用户自定义布局)
  // 实现见 scene/town-scene3d-editing.ts
  // ================================================================

  /** 把频道地块整体平移(委托 Block3D.moveBy:平台/边界/名牌/成员落点与各自范围一并位移) */
  applyBlockMove(b: Block3D, nx: number, nz: number): void { applyBlockMove(this, b, nx, nz) }

  /** 按当前 Block 字段重建领地几何(平台刻度/边界线框/朝向),供缩放与移动共用 */
  applyLayoutToBlock(b: Block3D): void { applyLayoutToBlock(this, b) }

  /** 边界手柄本地坐标(椭圆:轴向四点;矩形:四角;radius 是半轴或半宽)。宿主契约面:ranges 模块回调。 */
  boundaryHandlePoints(layout: { radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' }): Array<[number, number]> { return boundaryHandlePoints(layout) }

  /** 刷新边界手柄位置/可见性(编辑模式选中频道时显示;其余隐藏) */
  refreshChannelHandles(): void { refreshChannelHandles(this) }

  /** 命中边界手柄(仅编辑模式;返回频道 id + 手柄号) */
  pickResizeHandle(x: number, z: number): { cid: string, handle: number } | null { return pickResizeHandle(this, x, z) }

  /** 拖拽手柄 → 实时调整 radiusX/radiusZ(矩形:角点双轴;椭圆:对应轴向轴点)。 */
  applyResize(b: Block3D, handle: number, wx: number, wz: number): void { applyResize(this, b, handle, wx, wz) }

  /** 缩放/移动结束后把该频道成员落点与活动范围钳回新边界内(委托 Block3D) */
  clampAgentsToBoundary(channelId: string): void { clampAgentsToBoundary(this, channelId) }

  /** 频道是否在场景内且被选中(供边界编辑面板) */
  getSelectedChannel(): string | null { return getSelectedChannel(this) }

  /** 点选频道(供频道坞/边界编辑面板打开) */
  selectChannel(channelId: string | null): void { selectChannel(this, channelId) }

  /** 当前场景内全部频道布局(供「保存全部布局」/E2E) */
  getAllChannelLayouts(): ChannelLayout[] { return getAllChannelLayouts(this) }

  /** WS 事件入口(与 2D 同构):布局同步 / 状态收敛 / 气泡入队 / 共鸣 / 行为决策(实现见 scene/town-scene3d-events.ts) */
  handleTownEvent(e: AepEnvelope): void { handleTownEvent(this, e) }

  // ================================================================
  // 行为 FSM(3D x/z 平面,复刻 2D 逻辑;实现见 scene/town-scene3d-events.ts)
  // ================================================================

  /** 触发一次「跑去下发」行为:from 跑到 to 身边 */
  startBehavior(action: ActionContext): void { startBehavior(this, action) }

  behaviorActionLabel(kind: ActionKind): string { return behaviorActionLabel(kind) }

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

  /** 相机注视目标(供频道坞首放落点/聚焦) */
  getCameraTarget(): { x: number, z: number } { return getCameraTarget(this) }

  /** 为指定角色换装模型(选择器绑定;要求实体已在场景,否则仅记录) */
  swapAgentModel(agentId: string, modelRef: string): void { swapAgentModel(this, agentId, modelRef) }

  // ================================================================
  // 事件共鸣(说话/完成/错误/旗) —— 3D 圆环/光柱
  // 实现见 scene/town-scene3d-events.ts
  // ================================================================

  emitResonance(e: AepEnvelope): void { emitResonance(this, e) }

  rafAnims: Array<() => void> = []

  /** 频道领地布局(channelId → 放置);由 applySceneLayouts 注入,驱动 buildBlocks/边界约束 */
  layouts = new Map<string, ChannelLayout>()
  /** 频道实体基线(channelId → seed;供 dropChannelOnWorld 即时铺放) */
  entityIndex = new Map<string, TownEntityInput>()
  /** 当前选中频道(供边界编辑面板) */
  selectedChannel: string | null = null

  // ================================================================
  // 信息接收器 + 聊天气泡(每个实例化 Channel 一个接收器:FIFO 逐条消费,
  // WS 实时信息经 townBus → handleTownEvent 入队,渲染到对应 Agent 头顶,像真实对话)
  // 实现见 scene/town-scene3d-bubbles.ts
  // ================================================================

  /** 实时信息(讲话/交付/错误)入队到目标频道的信息接收器;系统指标即时更新,3D 展示按 FIFO 消费 */
  enqueueBubble(channelId: string, agentId: string | undefined, kind: TownBubbleKind, text: string, ttlMs: number): void {
    enqueueBubble(this, channelId, agentId, kind, text, ttlMs)
  }

  /** 各频道接收器 FIFO 消费:当前条目展示期满 → 清理其气泡并取下一条实时渲染(渲染循环每帧调用)。
   *  队列积压时按 drainDisplayMs 压缩单条时长,让爆发期消息尽快追平。 */
  drainReceivers(now: number): void {
    drainReceivers(this, now)
  }

  // ================================================================
  // 相机 / 交互(拖拽平移、滚轮缩放、点选聚焦) —— 供 TownView 调用
  // ================================================================

  /** 暴露 canvas 供 TownView 绑定 pointer 事件 */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  // ==== 相机公开面(实现见 scene/town-scene3d-camera.ts;薄壳保持签名与语义不变) ====

  /** 世界坐标 → 屏幕像素(数据标注/悬浮 callout 投影;返回 null = 在相机背后) */
  worldToScreen(x: number, y: number, z: number): { x: number, y: number } | null { return worldToScreen(this, x, y, z) }

  /** 页面坐标 → 世界 xz(经 canvas rect + 相机射线打在 y=0 平面) */
  screenToWorld(clientX: number, clientY: number): { x: number, z: number } { return screenToWorld(this, clientX, clientY) }

  /** 平移相机(拖拽):移动 camTarget(相机位置由 loop 据 target+dolly 推导) */
  panBy(dxWorld: number, dzWorld: number): void { panBy(this, dxWorld, dzWorld) }

  /** 缩放过程中调用:范围超出当前视野 → 相机自动拉远(只放大不缩小,收敛于拖拽结束)。宿主契约面:editing 模块回调。 */
  autoFrameTo(rx: number, rz: number): void { autoFrameTo(this, rx, rz) }

  /** 视角预设(设计稿 angle-chip):std 标准 / top 俯视 / front 前视 / side 侧视。 */
  setViewPreset(p: 'std' | 'top' | 'front' | 'side'): void { setViewPreset(this, p) }

  /** 环绕(设计稿 OrbitLite 1:1):左键拖拽即时改 yaw/pitch,夹在仰角安全区间 */
  orbitBy(dxPx: number, dyPx: number): void { orbitBy(this, dxPx, dyPx) }

  /** 自动环绕(设计稿 tOrbit):渲染循环缓转 yaw;orbitBy 拖拽时暂停 */
  setAutoOrbit(on: boolean): void { setAutoOrbit(this, on) }

  getAutoOrbit(): boolean { return getAutoOrbit(this) }

  /** 平移(设计稿 OrbitLite 1:1):target += (−right·dx + up·dy)·s */
  panByScreen(dxPx: number, dyPx: number): void { panByScreen(this, dxPx, dyPx) }

  /** 飞往预设视角(平滑;设计稿 flyTo) */
  flyToPreset(p: 'std' | 'top' | 'front' | 'side', dur = 900): void { flyToPreset(this, p, dur) }

  /** 相机即时状态(导航地图/callout 距离显隐;世界坐标) */
  getCameraPose(): { pos: { x: number, y: number, z: number }, target: { x: number, z: number }, yaw: number, dolly: number } { return getCameraPose(this) }

  /** 导航地图拖拽平移:世界位移直接作用于注视点与相机位置(设计稿 minimap drag) */
  panWorldBy(dxw: number, dzw: number): void { panWorldBy(this, dxw, dzw) }

  /** 重置视角(注视世界中心,标准轨道,基准 dolly) */
  resetView(): void { resetView(this) }

  zoomBy(f: number): void { zoomBy(this, f) }

  /** 缓动聚焦某世界点(移动 camTarget) */
  focusTo(x: number, z: number): void { focusTo(this, x, z) }

  /** 登记逐帧回调(渲染循环统一 flush;抽出模块经此驱动缓动/脉冲) */
  pushAnim(f: () => void): void { this.rafAnims.push(f) }

  /** 自动取景目标 dolly(缩放拖拽期间按范围尺寸计算;渲染循环平滑跟随,拖拽结束清除) */
  autoDolly: number | null = null
  /** 变换模式(Blender 规范):translate=移动 G / rotate=旋转 R / scale=缩放 S。
   *  轴约束:移动仅 XZ(模型贴地),旋转仅 Y(2.5D 朝向),缩放 XYZ。 */
  setTransformMode(mode: 'translate' | 'rotate' | 'scale'): void { setTransformMode(this, mode) }

  /** 手柄是否悬停/拖拽中(调用方应让出相机平移与点选) */
  isGizmoBusy(): boolean { return isGizmoBusy(this) }

  /** 渲染曝光(场景控制坞"环境光照";0.2~2.2) */
  setExposure(v: number): void { setExposure(this, v) }

  /** 领地染色浓度(平台透明度系数;0.05~1) */
  setTerritoryOpacity(v: number): void { setTerritoryOpacity(this, v) }

  // ================================================================
  // 拖拽换装 / 生成居民(drop 入口;实现见 scene/town-scene3d-agents.ts)
  // ================================================================

  dropModelOnWorld(x: number, z: number, assetId: string): { mode: 'rebind' | 'spawn', agentId?: string, textureKey: string, x: number, y: number } {
    return dropModelOnWorld(this, x, z, assetId)
  }

  /** 数字孪生设备节点:拖 dev 模型进场景生成(实现见 scene/town-scene3d-devices.ts) */
  spawnDeviceNode(x: number, z: number, texKey: string, file: string, name: string): string {
    return spawnDeviceNode(this, x, z, texKey, file, name)
  }

  /** 模型 PBR 材质增强(设备/角色分治;实现见 scene/town-scene3d-models.ts) */
  enhancePbrMaterials(root: THREE.Object3D, kind: 'device' | 'character'): void { enhancePbrMaterials(this, root, kind) }

  // ================================================================
  // 调试 / HUD 数据(实现见 scene/town-scene3d-hud.ts)
  // ================================================================

  getDebugState(): {
    blocks: number
    agents: Array<{ agentId: string, name: string, role: string, channelId: string, state: string, progress: number | null, x: number, y: number, visible: boolean, draggable: boolean, auraColor: number, behavior: string, targetId: string | null, homeX: number, homeY: number, textureKey: string, modelRef: string, decorated: boolean, range: { x: number, z: number, radiusX: number, radiusZ: number, shape: string } | null, bubbleText: string | null, anim: string }>
    bubbles: Array<{ text: string, at: number }>
    activity: { channelId: string, agentName: string, text: string } | null
    player: { x: number, y: number }
  } { return getDebugState(this) }

  getMinimapState(): {
    world: { w: number, h: number }
    blocks: Array<{ x: number, y: number, color: number, name: string, shape?: 'ellipse' | 'rect', rx?: number, rz?: number, rot?: number }>
    agents: Array<{ x: number, y: number, color: number, busy: boolean }>
    devices: Array<{ x: number, y: number, color: number, state: string }>
    player: { x: number, y: number }
  } { return getMinimapState(this) }

  getRecentActivity(): Array<{ channelId: string, agentName: string, text: string }> { return getRecentActivity(this) }

  /** 更新设备节点状态/遥测(数据驱动渲染状态环;实现见 scene/town-scene3d-devices.ts) */
  updateDeviceNode(twinId: string, state: DeviceNode['state'], telemetry?: Record<string, number | string | boolean>): void {
    updateDeviceNode(this, twinId, state, telemetry)
  }

  /** 设备改名(重建名牌 Sprite + 落库由 TownView 走 devices.update) */
  renameDevice(id: string, name: string): void { renameDevice(this, id, name) }

  /** 设备换模型(按 modelRef 重挂 GLB 到 holder;持久化由 TownView 走 devices.update) */
  swapDeviceModel(id: string, modelRef: string): void { swapDeviceModel(this, id, modelRef) }

  /** 设备当前名称(供属性面板初始化) */
  getDeviceName(id: string): string { return getDeviceName(this, id) }

  /** 设备当前绑定模型 id(供模型下拉高亮) */
  getDeviceModelRef(id: string): string { return getDeviceModelRef(this, id) }

  /** 删除设备实例:落库删除 + 移除场景节点(由 TownView 触发;失败仅移除本地节点)。 */
  async removeDevice(id: string): Promise<void> { await removeDevice(this, id) }

  /** 设备节点列表(供 HUD/E2E;topY = 模型顶面世界高度,callout 锚定用) */
  getDeviceNodes(): Array<{ twinId: string, name: string, x: number, z: number, topY: number, state: string, telemetry: Record<string, number | string | boolean> }> {
    return getDeviceNodes(this)
  }

  /** 动作绑定:为某 Agent 指定动画 clip(按名称 idle/walk/work 或索引)。供 AssetLibrary 选择动作后调用。 */
  setAnimPref(agentId: string, clipName: string): void { setAnimPref(this, agentId, clipName) }

  /** 角色当前绑定模型 id(供模型选择器高亮) */
  getAgentModel(agentId: string): string | null { return getAgentModel(this, agentId) }

  /** 角色名字(供模型选择器标题) */
  getAgentName(agentId: string): string { return getAgentName(this, agentId) }

  /** 角色动画 clip 名列表(供 UI 展示可绑定动作;无则空) */
  getAgentClips(agentId: string): Array<{ name: string, duration: number }> { return getAgentClips(this, agentId) }

  // ================================================================
  // 选中 + 缩放(客制化:场景内点选 Agent/设备 → 弹滑杆调大小)
  // ================================================================

  /** 以世界坐标 hit 一个 Agent 或设备节点(近似距离阈值;供点击选中) */
  pickAt(x: number, z: number): { kind: 'agent' | 'device', id: string } | null { return pickAt(this, x, z) }

  /** 点选频道:返回包含该点的频道 id(边界内;供编辑模式打开边界编辑面板) */
  pickChannel(x: number, z: number): string | null { return pickChannel(this, x, z) }

  /** 命中频道边界线(世界点落在某领地边界带 ±42 单位内 → 边界拖拽等比缩放)。宿主契约面:editing 模块回调。 */
  pickChannelEdge(x: number, z: number): { cid: string, rx0: number, rz0: number, rd0: number } | null { return pickChannelEdge(this, x, z) }

  /** 设置选中(点击后由 Vue 弹缩放/旋转滑杆) */
  setSelected(sel: { kind: 'agent' | 'device', id: string } | null): void { setSelected(this, sel) }

  /** 场景内缩放:为 Agent(id)或设备(id)设定用户缩放倍率(0.2~5;1=默认归一化) */
  setModelScale(id: string, scale: number, kind?: 'agent' | 'device'): void { setModelScale(this, id, scale, kind) }

  /** 当前选中对象(供 Vue/滑杆初始化) */
  getSelectedScale(): { kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null { return getSelectedScale(this) }

  /** 组装可缩放目标并恢复初始化缩放(initialScale 优先=服务端持久化;否则 localStorage) */
  registerScalable(kind: 'agent' | 'device', id: string, holder: THREE.Group, initialScale?: number): void { registerScalable(this, kind, id, holder, initialScale) }

  /** 持久化指定对象的缩放(滑杆松手时调用;设备同时落库,角色仅本地) */
  persistScale(kind: 'agent' | 'device', id: string): void { persistScale(this, kind, id) }

  // ================================================================
  // 编辑/浏览模式 + 场景对象拖拽(设备↔地面,角色↔落点)
  // 实现见 scene/town-scene3d-editing.ts
  // ================================================================

  /** 模式切换:浏览(只读:相机+点选) / 编辑(可拖拽设备/调整角色落点/旋转/频道整体移动/边界手柄/Agent 活动范围) */
  setMode(mode: TownScene3DMode): void { setMode(this, mode) }

  getMode(): TownScene3DMode { return getMode(this) }

  /** 网格吸附开关(编辑拖拽落点;默认开) */
  setSnap(enabled: boolean): void { setSnap(this, enabled) }

  getSnap(): boolean { return getSnap(this) }

  /**
   * 尝试开始场景拖拽(编辑模式;指针按下命中设备/角色 → 占用该手势)。
   * 返回 true 表示场景已接管指针(调用方应跳过相机平移)。
   */
  tryStartPointerDrag(clientX: number, clientY: number): boolean { return tryStartPointerDrag(this, clientX, clientY) }

  isPointerDragging(): boolean { return isPointerDragging(this) }

  snapWorld(v: number): number { return snapWorld(this, v) }

  /** 拖拽中:对象跟随指针指向的 xz 平面(仅改内存;落库在 endPointerDrag) */
  movePointerDrag(clientX: number, clientY: number): void { movePointerDrag(this, clientX, clientY) }

  /** 拖拽结束:设备 → 防抖落库;角色 → home 更新 + 持久化;频道 → 布局落库 */
  endPointerDrag(): void { endPointerDrag(this) }

  // ================================================================
  // Agent 独立活动范围(编辑模式:框选绘制 / 整框平移 / 手柄收缩扩张)
  // 实现见 scene/town-scene3d-ranges.ts
  // ================================================================

  /** 活动范围线框可见性:编辑模式全部显示;浏览模式仅选中角色的范围显示 */
  rangeLineVisible(asp: Agent3D): boolean { return rangeLineVisible(this, asp) }

  /** 通知 Vue 对象面板刷新活动范围草稿 */
  emitAgentRangeChanged(agentId: string): void { emitAgentRangeChanged(this, agentId) }

  /** 同步全部范围线框可见性(选中/模式切换后调用) */
  refreshAgentRangeLines(): void { refreshAgentRangeLines(this) }

  /** 活动范围线框可见性(公众面,供 Agent3D.renderRangeLine):编辑模式全部显示;浏览模式仅选中显示 */
  rangeLineVisibleFor(asp: Agent3D): boolean { return rangeLineVisibleFor(this, asp) }

  /** 刷新 Agent 活动范围手柄(编辑模式 + 选中带范围角色时显示;矩形四角 / 椭圆轴向四点) */
  refreshAgentRangeHandles(): void { refreshAgentRangeHandles(this) }

  /** 命中选中 Agent 的活动范围手柄(编辑模式;返回 agentId + 手柄号) */
  pickAgentRangeHandle(x: number, z: number): { agentId: string, handle: number } | null { return pickAgentRangeHandle(this, x, z) }

  /** 命中某成员活动范围边界线(供整框拖移;编辑模式;26 单位内视为命中) */
  hitAgentRangeBoundary(x: number, z: number): Agent3D | undefined { return hitAgentRangeBoundary(this, x, z) }

  /** 拖范围手柄 → 实时调整 radiusX/radiusZ(矩形:角点双轴;椭圆:对应轴向轴点),并收进频道边界 */
  applyAgentRangeResize(range: AgentRangeLayout, handle: number, wx: number, wz: number): AgentRangeLayout { return applyAgentRangeResize(range, handle, wx, wz) }

  /** 框选预览:以 (x0,z0)-(x1,z1) 为对角生成矩形线框(实时跟随指针) */
  updateRangeDrawPreview(x0: number, z0: number, x1: number, z1: number): void { updateRangeDrawPreview(this, x0, z0, x1, z1) }

  /** 退出框选绘制模式(清理预览与状态) */
  cancelRangeDraw(): void { cancelRangeDraw(this) }

  /** 进入「框选绘制」模式:为该角色拉动矩形框生成活动范围(编辑模式) */
  startRangeDraw(agentId: string): void { startRangeDraw(this, agentId) }

  /** 当前是否正在为某角色框选绘制 */
  isRangeDrawing(agentId?: string): boolean { return isRangeDrawing(this, agentId) }

  /** E2E/调试:强制某频道接收器跳过当前条目,立即消费下一条(FIFO 顺序断言用) */
  debugAdvanceReceiver(channelId: string): void {
    const rec = this.receivers.get(channelId)
    if (rec) rec.currentUntil = 0
  }

  /** Agent 当前活动范围(供面板初始化;未设置返回 null) */
  getAgentRange(agentId: string): AgentRangeLayout | null { return getAgentRange(this, agentId) }

  /** 面板滑杆/形状即时调整:局部更新范围(无上限,信任用户设定) + 线框/手柄刷新;home 被迫位移时记档待提交 */
  setAgentRangeScene(agentId: string, patch: Partial<AgentRangeLayout>): void { setAgentRangeScene(this, agentId, patch) }

  /** 面板提交:落库范围(updateRange);home 若被迫位移一并落库(updateHome) */
  commitAgentRange(agentId: string): void { commitAgentRange(this, agentId) }

  /** 清除角色活动范围(局部 + 落库 null;回退频道边界) */
  clearAgentRange(agentId: string): void { clearAgentRange(this, agentId) }

  /** 对象朝向(度;编辑模式旋转滑杆实时) */
  setModelRotation(id: string, deg: number, kind?: 'agent' | 'device'): void { setModelRotation(this, id, deg, kind) }

  getModelRotation(id: string, kind?: 'agent' | 'device'): number { return getModelRotation(this, id, kind) }

  // ================================================================
  // 场景保存状态(未保存/保存中/已保存/失败)+ 设备 transform 防抖落库
  // 实现见 scene/town-scene3d-devices.ts
  // ================================================================

  emitSaveState(state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at = Date.now()): void {
    this.emit('saveState', { state, at })
  }

  /** 持久化设备 transform(位置/朝向/缩放一次写入;防抖 350ms,不逐帧写库) */
  persistDeviceTransform(id: string): void { persistDeviceTransform(this, id) }

  /** 保存全部设备节点(「保存布局」按钮:强制全量落库) */
  persistAllDevices(): void { persistAllDevices(this) }

  pendingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ================================================================
  // 设备场景实例同步(服务端设备孪生 → 本地节点;多客户端一致;
  // 实现见 scene/town-scene3d-devices.ts)
  // ================================================================

  /**
   * 与设备孪生清单对齐:服务端有落点且本地无节点 → 重建;已存在 → 收敛状态/遥测/transform;
   * 服务端已删除 → 移除本地节点。TownView 在 device.* 事件与轮询时调用。
   */
  syncDevices(twins: DeviceTwinSync[]): void { syncDevices(this, twins) }

  /** 按设备孪生记录重建场景节点(持久化恢复:pos/rotation/scale;模型缺失则跳过) */
  recreateDeviceNode(t: DeviceTwinSync): void { recreateDeviceNode(this, t) }

  // ================================================================
  // 数采绑定链路 + 薄膜 web(设计稿 buildChanLine / rebuildWeb 移植;
  // 实现见 scene/town-scene3d-links.ts)
  // ================================================================

  /** 设备顶端世界高度(holder 包围盒;链路/膜 web 的挂点) */
  deviceTopY(dev: DeviceNode): number { return deviceTopY(dev) }

  /** 同步数采→设备绑定链路(TownView 传入 [{daqId, deviceId}];端点移动时逐帧跟随重建) */
  syncDaqLinks(links: Array<{ daqId: string, deviceId: string }>): void { syncDaqLinks(this, links) }

  /** 端点跟随:任一端点位移超阈值 → 重建该链路曲线(拖拽设备/数采时虚线实时跟随) */
  refreshDaqLinks(): void { refreshDaqLinks(this) }

  /** 薄膜 web:按 X 序连接产线设备(挤出→流延→MD→TD→收卷),半透明膜面 —— 产线工艺连续性可视化 */
  rebuildFilmWeb(): void { rebuildFilmWeb(this) }

  // ================================================================
  // 生命周期 / 渲染循环
  // ================================================================

  private loop(): void { startRenderLoop(this) }

  qTier = 0

  qLowStreak = 0

  qHighStreak = 0

  /** 画质模式:auto = 质量阶梯自适应;manual 三档由用户固定(渲染配置不再自动变动) */
  qualityMode: 'auto' | 'normal' | 'hd' | 'ultra' = 'auto'

  setQualityMode(mode: 'auto' | 'normal' | 'hd' | 'ultra'): void { setQualityMode(this, mode) }

  adaptQuality(fps: number): void { adaptQuality(this, fps) }

  applyQuality(): void { applyQuality(this) }

  applyPixelRatio(next: number): void { applyPixelRatio(this, next) }

  // ================================================================
  // 实例本地资源释放(防长会话 GPU 内存只涨不跌)
  // ================================================================
  // 注意:GLB 克隆(clone)与 gltfCache 原件**共享** geometry/material/纹理,
  // 其 GPU 资源归缓存原件管理 —— 释放路径绝不可碰 GLB 克隆内部,否则同模型
  // 其他活动实例会被连带摧毁。这里只释放每实例独占的资源:
  // 名牌/气泡的 CanvasTexture(材质 map)、状态环/链路等自建几何与材质。

  /** 释放对象树内所有 Canvas 纹理(名牌/气泡 sprite 的独占资源) */
  disposeCanvasTextures(root: THREE.Object3D | null): void { disposeCanvasTextures(root) }

  /** 释放单个设备节点的实例资源(状态环 + 运行弧 + LED 环 + 名牌) */
  disposeDeviceAssets(dev: DeviceNode): void { disposeDeviceAssets(dev) }

  /** 释放单个 agent 的实例资源(名牌/气泡纹理 + 光环 + 活动范围线几何;GLB 克隆不动) */
  disposeAgentAssets(a: { nameSprite?: THREE.Sprite | null, bubble?: THREE.Sprite | null, rangeLine?: THREE.Line | null, aura?: THREE.Group | null }): void { disposeAgentAssets(a) }

  /** 重置全部(rebuild 用) */
  resetAll(): void { resetScene(this) }

  /** 销毁(卸载时由 TownView 调用) */
  dispose(): void { disposeScene(this) }
}
