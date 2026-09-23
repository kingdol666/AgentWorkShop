/**
 * 小镇视图共享类型集合。
 *
 * 自 TownView.vue 抽出(纯类型搬移:原文件局部 interface/type 原样迁入,零运行时状态),
 * 供 TownView 与其拆分出的子组件 / 组合式函数共用同一份声明,避免类型重复定义漂移。
 */
/** 频道坞已放置/未放置标记行 */
export interface DockChannelRow {
  channelId: string
  name: string
  agentCount: number
  placed: boolean
  color: string
}
/** 领地块(2D 场景无形状数据 → 回退圆) */
export interface MiniBlock { x: number, y: number, color: number, name: string, shape?: 'ellipse' | 'rect', rx?: number, rz?: number, rot?: number }
export interface MiniState {
  world: { w: number, h: number }
  blocks: MiniBlock[]
  agents: Array<{ x: number, y: number, color: number, busy: boolean }>
  devices: Array<{ x: number, y: number, color: number, state: string, twinId?: string, daq?: boolean, bound?: boolean }>
  player: { x: number, y: number }
}
/** Agent 会话台消息行(历史与实时同构) */
export interface ChatEntry {
  id: string
  agentId: string
  text: string
  kind: string
  at: number
  live: boolean
}
/** 左轨叶子状态点(与孪生投影同一状态语义:绿 运行/黄 预警/红 告警/空心=离线) */
export type RailLeafState = 'running' | 'warn' | 'alarm' | 'offline'
/** 左轨数采模板目录项(server 权威:内置 + 自定义随 REST/WS 收敛;字段名兼容既有通道模板标记) */
export interface DaqTemplate {
  id: string
  name: string
  code: string
  /** 通道语义(如 熔体压力/膜张力;bind-row 与 callout 主标题) */
  ch: string
  unit: string
  base: number
  amp: number
  min: number
  max: number
  decimals: number
  /** 图标(设计稿 ICONS 键) */
  icon: string
}
/** 智控模板目录项(与 DaqTemplate 同构投影) */
export interface DcwTemplate {
  id: string
  name: string
  code: string
  ch: string
  unit: string
  min: number
  max: number
  decimals: number
  icon: string
}
export interface DaqSimState { value: number, hist: number[], phase: number, tpl: DaqTemplate, alarm?: boolean }
export interface RtcPoint { value: number, state: string, atMs: number }
/** Agent ↔ 工业节点绑定行 */
export interface AgentNodeBindingRow {
  id: string
  agentId: string
  nodeId: string
  kind: 'dcw' | 'daq'
  mode: 'auto' | 'manual'
}
/** 手动确认审批行 */
export interface ToolApprovalRow {
  id: string
  agentId: string
  kind: string
  detail: string
  createdAt: string
  expiresAt: string
  status: string
}
/** bind-pop 待绑定通道选择项 */
export interface RailBindChoice { id: string, name: string, tpl: { icon: string }, devName: string | null, placed: boolean }
/** 设备面板:智控绑定行(三段式仪表卡数据) */
export interface DcwBoundRow {
  dcwId: string
  name: string
  ch: string
  unit: string
  icon: string
  value: number | null
  state: string
  decimals: number
  /** 节点全局量程(连接期设定) */
  gMin: number
  gMax: number
  /** 活动配方工艺窗口(产线运行中且配方命中;null = 未限定) */
  rMin: number | null
  rMax: number | null
}
/** 设备面板:智控实时行(twinId → 该设备绑定的全部智控通道) */
export interface DcwLiveRow {
  id: string
  ch: string
  name: string
  unit: string
  value: number | null
  /** PLC 当前读数(读写集成:周期读/手动读回填的物理值) */
  readValue: number | null
  lastReadAt: string | null
  decimals: number
  lo: number
  hi: number
  src: 'recipe' | 'global'
}
/** 告警面板行 */
export interface AlarmItem { id: number, txt: string, src: string, time: string, state: 0 | 1 | 2, level: 'warn' | 'crit' | 'info' }
/** 舞台标注层行(靠近浮现:callout + 引线 + 锚点) */
export interface CalloutRow {
  id: string
  x: number
  y: number
  label: string
  value: string
  unit: string
  lo: number
  hi: number
  warn: boolean
  near: boolean
  leader: boolean
}
/** 频道成员行(频道管理 · 成员 tab) */
export interface TownMemberRow {
  agentId: string
  name: string
  role: string
  modelRef?: string | null
}
/** 模型下拉行(角色/设备模型选项) */
export interface TownModelRow {
  id: string
  name: string
  kind?: string
}
