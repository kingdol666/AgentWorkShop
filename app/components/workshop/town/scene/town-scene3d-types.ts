/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 类型契约与常量。
 *
 * 自 TownScene3D.ts 抽出,承载「零行为」的声明:
 *  - 场景 → Vue HUD 事件映射(TownEventMap)、编辑模式、设备 transform 补丁;
 *  - 实体基线 / 设备孪生同步输入(TownEntityInput / DeviceTwinSync);
 *  - 面向对象节点的宿主契约(TownSceneHost):Block3D / Agent3D / DeviceNode 只依赖此接口,
 *    由 TownScene3D 实现(方法级解耦,节点可在独立模块中实例化与测试)。
 */
import type * as THREE from 'three'
import type { AgentRangeLayout, ChannelLayout } from '#shared/town-scene-math'
import type { TownBubbleKind } from '#shared/town-protocol'
import type { ActionKind } from '#shared/town-behavior'

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
  /** 选中频道(供 Vue 边界面板);null 取消 */
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
export interface ScaledTarget {
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

/** 行为状态机(标准 AI 控制:事件→决策→动作) */
export type BehaviorMode
  = | 'idle'
    | 'roam'
    | 'approach'
    | 'wait'
    | 'returnHome'

export interface BehaviorState {
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
export interface BubbleMsg {
  /** 说话 Agent(null = 频道级/系统气泡) */
  agentId: string | null
  kind: TownBubbleKind
  text: string
  ttlMs: number
}

/** 每个实例化 Channel 的信息接收器:WS 实时信息经 handleTownEvent 入队,FIFO 逐条消费渲染到对应 Agent 头顶 */
export interface ChannelMessageReceiver {
  channelId: string
  queue: BubbleMsg[]
  current: BubbleMsg | null
  currentUntil: number
}

/** 世界尺度/速度/身份色等纯常量与函数集中定义于 #shared/town-scene-math(与 2D/测试共用) */

/** 角色模型来源登记(registerModelsFromList) */
export interface ModelInfo { id: string, file: string, name: string, kind?: string, hFactor?: number }

/** 频道领地布局最小形状(宿主 trackLayout 入参;Block3D 天然满足) */
export interface BlockLayoutCarrier {
  channelId: string
  x: number
  z: number
  radiusX: number
  radiusZ: number
  shape: 'ellipse' | 'rect'
  rotationY: number
}

/** 节点必须由宿主提供的服务(形状契约,避免 类型 ↔ 节点 循环依赖) */
export interface BlockHost {
  /** 场景根(节点挂载/摘除线框) */
  readonly threeScene: THREE.Scene
  /** 请求下一帧重绘 */
  markDirty(): void
  /** 登记频道布局变更(拖拽/边界调整后落库路径) */
  trackLayout(b: BlockLayoutCarrier): void
}

export interface AgentHost {
  /** 场景根(节点挂载/摘除线框与气泡) */
  readonly threeScene: THREE.Scene
  /** 请求下一帧重绘 */
  markDirty(): void
  /** 某频道的当前布局(未放置 = null);Agent 漫游/钳制的边界来源 */
  blockLayoutOf(channelId: string): ChannelLayout | null
  /** 按 agentId 取场景角色实例 */
  getAgent(agentId: string): AgentNodeHost | undefined
  /** 行为送达(在目标头顶弹气泡 + 广播行为日志) */
  deliverBehavior(asp: AgentNodeHost, target: AgentNodeHost): void
  /** 释放被本角色邀请(engaged)的目标 */
  releaseEngaged(asp: AgentNodeHost): void
  /** 动画状态切换广播(idle/walk) */
  notifyMotion(asp: AgentNodeHost): void
  /** 活动范围线框是否可见(范围绘制/选中的可见性策略) */
  rangeLineVisibleFor(asp: AgentNodeHost): boolean
}

export interface DeviceHost {
  /** 请求下一帧重绘 */
  markDirty(): void
  /** 设备名牌重建(改名) */
  renameDeviceSprite(dev: DeviceNodeLike, name: string): void
  /** 设备模型重挂(换模型) */
  swapDeviceModelSprite(dev: DeviceNodeLike, modelRef: string): void
}

/** Agent3D 最小形状(宿主行为回调需要读落点/名称/行为态) */
export interface AgentNodeHost {
  agentId: string
  name: string
  root: THREE.Group
  homeX: number
  homeZ: number
  channelId: string
  dragging: boolean
  behavior: BehaviorState
  range: AgentRangeLayout | null
  rangeLine: THREE.LineLoop | null
}

/** DeviceNode 最小形状(宿主名牌/模型重挂入参) */
export interface DeviceNodeLike {
  twinId: string
  name: string
  modelRef: string
  root: THREE.Group
  holder: THREE.Group
  ring: THREE.Mesh
  arc: THREE.Mesh | null
  state: 'idle' | 'running' | 'offline' | 'alarm'
}

/**
 * 场景宿主契约(节点侧聚合):TownScene3D 实现本接口,
 * 保证节点所依赖的服务齐备(缺一即编译期报错)。
 */
export interface TownSceneHost extends BlockHost, AgentHost, DeviceHost {}
