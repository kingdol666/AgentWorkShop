/**
 * AgentTeam RPG 小镇(2D Phaser 渲染器)— 类型、世界常量与频道配色纯函数。
 *
 * 从 TownScene.ts 抽出,只承载「零行为」的声明:
 *  - 场景 → Vue HUD 事件映射 / 实体基线输入(TownEventMap / TownEntityInput);
 *  - 渲染态结构(TownBlockDef / AgentSprite / BehaviorState);
 *  - 世界尺度、角色速度、气泡配色等常量;
 *  - 频道共鸣色(稳定哈希,与 shared/town-scene-math 同源)。
 *
 * 不依赖 Phaser.Scene 实例,便于单独测试与复用。
 */
import * as Phaser from 'phaser'
import type { TownBubbleKind } from '#shared/town-protocol'
import type { ActionKind } from '#shared/town-behavior'

/** 场景 → Vue HUD 事件 */
export type TownEventMap = {
  ready: boolean
  fps: number
  agentCount: number
  blockCount: number
  /** 最后一个气泡(去重去抖动):HUD 显示"此刻谁在说话" */
  lastActivity: { channelId: string, agentName: string, text: string } | null
  /** 行为动作日志(供调试/E2E 断言"角色跑去下发任务") */
  behavior: { agentName: string, action: string, targetName: string | null } | null
}

/** 由 Vue entities store 传入的初始实体基线 */
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
    /** 用户给该角色绑定的自定义模型(assetId;缺省用内置员工模型) */
    modelRef?: string | null
  }>
}

/** 频道共鸣领地渲染态 */
export interface TownBlockDef {
  channelId: string
  name: string
  centerX: number
  centerY: number
  radius: number
  /** 频道共鸣色(number,供 tint) */
  colorNum: number
  /** 频道共鸣色(css rgba,供名字牌) */
  rgba: string
}

/** 角色 sprite 渲染态 */
export interface AgentSprite {
  channelId: string
  agentId: string
  name: string
  role: 'lead' | 'worker'
  sprite: Phaser.Physics.Arcade.Sprite
  /** 脚下共鸣灵光(同频道同色) */
  aura: Phaser.GameObjects.Image
  /** 状态环(头顶) */
  statusRing: Phaser.GameObjects.Graphics
  /** 名字标签(头顶) */
  nameLabel: Phaser.GameObjects.Text
  /** 进度标签(busy 时) */
  progressLabel: Phaser.GameObjects.Text
  /** 当前气泡(每 agent 至多一个) */
  bubble: Phaser.GameObjects.Container | null
  bubbleTimer: Phaser.Time.TimerEvent | null
  state: 'idle' | 'busy' | 'stopped'
  progress: number | null
  /** 行为状态机 */
  behavior: BehaviorState
  /** 用户正在拖动此 sprite(拖动期间暂停自动行为) */
  dragging: boolean
  /** 初始身位(成员原生位置,行为结束后回归;用户拖动后更新为落点) */
  homeX: number
  homeY: number
  /** 当前渲染纹理 key(内置 wu-* 或自定义模型) */
  textureKey: string
  /** 用户绑定的自定义模型 id(缺省空字符串=内置) */
  modelRef: string
}

/** 行为状态机(标准 AI 控制:事件→决策→动作) */
export type BehaviorMode
  = | 'idle' // 待机(位于 home)
    | 'roam' // 在领地内/附近游走(来回移动)
    | 'approach' // 跑去目标(下发任务/通信)
    | 'wait' // 在目标附近等待回复/执行结果
    | 'returnHome' // 事毕回归出生位

export interface BehaviorState {
  mode: BehaviorMode
  /** 游走目标点(来回移动端点) */
  roamTarget: { x: number, y: number } | null
  /** 目标角色(跑去下发/通信对象) */
  targetId: string | null
  /** 等待计时(到点返回) */
  waitUntil: number
  /** 行为动作日志(调试) */
  action?: { kind: ActionKind, taskKind?: string, requireReply: boolean, text: string }
  /** 是否正被他人「跑来下发/通信」(被 approach 或 wait)中 —— 暂停自身游走,驻足配合 */
  engaged: boolean
}

// ---- 世界尺度(大坐标世界:3200×2400) ----
export const WORLD_W = 3200
export const WORLD_H = 2400
/** 领地带基线(台地可立足区) */
export const FIELD_Y = 1760
/** 环形大道布点:街区围绕世界中心围成一圈 */
export const WORLD_CX = WORLD_W / 2
export const WORLD_CY = FIELD_Y
export const RING_RADIUS_X = 980
export const RING_RADIUS_Y = 560

/** worker sprite 图集候选(按 agentId 哈希选长相;均为员工形象) */
export const WORKER_SHEETS = ['wu-worker-0', 'wu-worker-1', 'wu-worker-2'] as const
export const LEAD_SHEET = 'wu-lead'
export const WALK_SPEED = 150

/** 角色行为运动速度(下发任务跑动 / 游走) */
export const AGENT_SPEED = 96
/** 等待回复/执行结果时长(ms) */
export const WAIT_MS = 2600

/** 气泡配色 */
export const BUBBLE_STYLE: Record<TownBubbleKind, { bg: number, fg: string }> = {
  info: { bg: 0x1c1917, fg: '#ffffff' },
  artifact: { bg: 0x1c1917, fg: '#9ecb7a' },
  error: { bg: 0x3a1d1c, fg: '#ff9e9e' },
  system: { bg: 0x1c1917, fg: '#c9c4bd' },
}

// ---- 频道共鸣色(稳定,同频道同色;色相桶与 shared/town-scene-math 同源) ----
const CHANNEL_HUES = [16, 40, 158, 178, 195, 212, 235, 262] as const
export function channelHue(id: string): number {
  if (!id) return 212
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return CHANNEL_HUES[h % CHANNEL_HUES.length]!
}
export function channelColorNum(channelId: string): number {
  const c = Phaser.Display.Color.HSLToColor(channelHue(channelId) / 360, 0.52, 0.6)
  return c.color
}
export function channelRGBA(channelId: string, alpha = 1): string {
  const c = Phaser.Display.Color.HSLToColor(channelHue(channelId) / 360, 0.52, 0.6)
  return `rgba(${c.red},${c.green},${c.blue},${alpha})`
}
