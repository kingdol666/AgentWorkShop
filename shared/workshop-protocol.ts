/**
 * Agent Event Protocol(AEP)v1 — Workshop 前后端统一事件协议。
 * 权威定义;前端经 `#shared/workshop-protocol` 引用,服务端 WS hub 按此装配信封。
 *
 * 信封:{ v, type, seq, at, channelId, agentId?, taskId?, payload }
 *  - seq:channel 内单调递增;断线续传游标(sub 时带 lastSeq 重放)
 *  - 兼容:字段 type/payload 与旧 hub 帧一致(api-live-e2e 等消费方不破坏)
 *
 * 事件目录:
 *  channel.snapshot    初始对齐{ channel, agents, tasks, queue, messages[50] }
 *  agent.status        { agentId, state, currentTaskId?, queued?, completed? }
*  agent.message       A2AMessage(harness message 事件;LLM 产出气泡)
 *  agent.delta         { delta }(LLM 流式增量;text_delta 50ms 批量,前端打字机)
 *  agent.status.message{ text }(工具标记 🔧 / 中间状态文本)
 *  task.status         { taskId, state, assigneeId?, agentId? }
 *  task.progress       { taskId, progress, agentId? }
 *  a2a.artifact        { taskId?, artifact }(任务交付物/工件)
 *  a2a.message         A2AMessage(channel 内新消息投递:assign/peer/inject)
 *  agent.member        { op: added/updated/removed, agent, by, reason? }(团队成员增改删;lead 或用户操作)
 *  memory.saved        { agentId, scope, title, dedupKey }
 *  device.created      { id, name, modelRef, kind, state, posX?, posZ?, rotationY?, scale?, ... }(3D 小镇设备入场景)
 *  device.updated      { ...同 device.created }(设备 transform/名称/状态变更;多客户端即时同步)
 *  device.deleted      { id, name }(设备被删除,客户端移除场景节点)
 *  scene.layout.saved  { channelId, x, z, radiusX, radiusZ, shape, rotationY }(频道领地放置/边界更新)
 *  scene.layout.removed{ channelId }(频道领地从场景移除;其 Agent 一并撤出)
 *  error               { code, message }
 *  pong                { t }
 *
 * 上行:{ type:'ping' } → pong;{ type:'sub', channelId, lastSeq? };{ type:'unsub', channelId }
 *
 * 说明:device.* 事件无 channel 归属(设备实例属 workspace),经广播直推任一已连 peer,
 * 信封 channelId='';不落 channel_events,客户端经 townBus 旁路消费。
 * scene.layout.* 走该频道频道流(仅订阅该频道的 peer 收到;小镇页订阅全部挂载频道 → 实时同步)。
 */
import type { A2AArtifact, A2AMessage } from '../server/services/workshop/types/a2a'
import type { WorkspaceTask } from '../server/services/workshop/types/task'
import type { AepDaqControllerState, AepDaqNodeChange, AepDaqReading, AepDaqTemplateChange } from './daq-protocol'
import type { AepDcwControllerState, AepDcwNodeChange, AepDcwWritten, AepDcwOptimizationChange } from './dcw-protocol'

export const AEP_VERSION = 1

/** channel.snapshot payload(agents 含队列上下文) */
export interface AepSnapshot {
  channelId: string
  channel: {
    id: string
    name: string
    description?: string
    leadAgentId: string | null
    workspace?: string
    enabled: number
  }
  agents: Array<{
    agentId: string
    name: string
    role: 'lead' | 'worker'
    harness: string
    /** 实例启停(1 启用 / 0 禁用) */
    enabled?: number
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId?: string | null
    queued?: number
    completed?: number
  }>
  tasks: WorkspaceTask[]
  queue: Array<{
    agentId: string
    name: string
    role: 'lead' | 'worker'
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId: string | null
    queuedCount: number
    completedCount: number
  }>
  messages: A2AMessage[]
}

/** agent.member payload:团队成员增/改/删(lead 执行中自主管理或用户 REST 操作;扁平结构与 ChannelBus 事件透传一致) */
export interface AepMemberEvent {
  op: 'added' | 'updated' | 'removed'
  agentId: string
  name: string
  role: 'lead' | 'worker'
  harness: string
  /** updated/remove 时:实例禁用状态 */
  enabled?: number
  /** 操作发起方:'lead:<agentId>'(agent 自主)或 'user'(REST 用户操作) */
  by: string
  reason?: string
}

/** device.* 事件 payload:数字孪生设备场景实例(3D 小镇同步) */
export interface AepDeviceEvent {
  id: string
  name: string
  modelRef: string
  kind: string
  state: string
  /** 场景落点 / 朝向 / 缩放(undefined = 未入场景) */
  posX?: number
  posZ?: number
  rotationY?: number
  scale?: number
  workspaceId?: string
  boundAgentId?: string | null
  telemetry?: Record<string, number | string | boolean>
  updatedAt?: string
}

/** scene.layout.saved payload:频道领地放置(3D 小镇自定义边界) */
export interface AepSceneLayout {
  channelId: string
  x: number
  z: number
  radiusX: number
  radiusZ: number
  shape: 'ellipse' | 'rect'
  rotationY: number
}

/**
 * hitl.request payload:待人工处理条目的统一视图。
 * kind:omp 对话框(rpc-ui ask)/ dcw 工具审批 / codex 命令与文件审批 /
 * opencode 权限与提问 / dsh 权限请求 / claude canUseTool / qwen 工具确认。
 */
export type AepHitlKind = 'omp-dialog' | 'dcw-approval' | 'codex-approval' | 'opencode-permission' | 'dsh-permission' | 'claude-permission' | 'qwen-permission' | 'hermes-permission'

/**
 * HITL 语义分类(v17,主计划 §8):
 * - 'question':引擎提问(自由文本 / 单选 / 多选),答案是**内容**;
 * - 'approval' :引擎请求授权,答案是**是否放行**。
 * 二者必须分开建模:拒绝/取消/超时**不得**被当作同意;自由文本也不得走 confirm 通道。
 */
export type AepHitlRequestType = 'question' | 'approval'

/** 单个提问(codex `tool/requestUserInput` / opencode `question` 的多问题原样承载) */
export interface AepHitlQuestion {
  /** 引擎侧问题 id(结构化答案按此回传;缺省 = 下标) */
  id: string
  /** 短标题(引擎 header) */
  header?: string
  /** 问题正文 */
  question: string
  /** 可选项(单选/多选);无 = 自由文本 */
  options?: Array<{ label: string, description?: string }>
  /** 是否多选 */
  multiSelect?: boolean
  /** 允许自由文本补充 */
  freeText?: boolean
}

/** HITL 持久化状态机(§13.4;与 AepHitlResolved.outcome 是三值投影) */
export type AepHitlStatus
  = 'pending'
    | 'resolving'
    | 'answered'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | 'expired'
    | 'failed'
    | 'delivery_unknown'
    | 'reconciling'

export interface AepHitlItem {
  kind: AepHitlKind
  /** omp:对话框 id;dcw:审批 id(ap-*);其余:引擎请求 id(应答路由用) */
  id: string
  channelId: string
  agentId: string
  agentName: string
  /** omp 子进程 pid(应答路由 respondTerminalUi 用) */
  pid?: number
  /** 对话框形态(codex requestUserInput/opencode question 为 input/select;权限类为 confirm) */
  method?: 'select' | 'confirm' | 'input' | 'editor'
  title: string
  /** dcw-approval 专属:人读摘要(节点/物理量/目标值);其余:命令/路径/权限详情 */
  detail?: string
  /** select 的选项列表 */
  options?: string[]
  message?: string
  createdAt: string
  /** park 截止时刻(omp 对话框零订阅倒计时;null = 有订阅者,计时暂停) */
  expiresAt?: string | null
  // ===== v17 增量(全部可选:旧消费者按原字段工作,不破坏兼容)=====
  /** question(提问) | approval(授权);缺省按 kind 推定 */
  requestType?: AepHitlRequestType
  /** 引擎原生 requestId(与 id 区分:omp 用 id,codex/opencode 另有 rpcId) */
  nativeRequestId?: string
  /** 引擎会话 id(重启恢复对账用) */
  sessionId?: string
  /** harness 标识(mock/omp/codex/opencode/dsh/claude/qwen/hermes) */
  harness?: string
  /** 结构化多问题(question 型;单选/多选/自由文本) */
  questions?: AepHitlQuestion[]
  /** 结构化应答 schema(引擎原生;有则按此校验) */
  schema?: Record<string, unknown>
  /** 持久化状态机当前态(缺省 pending) */
  status?: AepHitlStatus
  /** 生效的审批策略(owner_only | any_member) */
  policy?: string
  /** 策略版本(创建时快照;策略收紧不放宽已有请求) */
  approvalPolicyVersion?: number
  /** 通道乐观锁版本(HITL 通知需要过滤到正确成员集) */
  channelVersion?: number
}

/** hitl.resolved payload:待办落定(answered=已答复/cancelled=放弃或撤销/expired=超时) */
export interface AepHitlResolved {
  kind: AepHitlItem['kind']
  id: string
  channelId: string
  agentId: string
  outcome: 'answered' | 'cancelled' | 'expired'
  /** 落定方(user id / system) */
  by?: string
  /** v17:细粒度终态(answered 时的 approved/rejected,以及 failed/delivery_unknown) */
  status?: AepHitlStatus
  /** v17:引擎原生确认成功(§8 步骤 7:未确认不得标记 resolved) */
  nativeConfirmed?: boolean
}

// ============================================================================
// v17 群聊 / 用户通知(主计划 §5-§7)
// ============================================================================

/** 群聊 mention:稳定 ID(user id / agent instance id);禁止昵称匹配 */
export interface AepChatMention {
  type: 'user' | 'agent'
  id: string
  /** 展示名(服务端解析后回填;仅渲染用,不参与寻址) */
  label?: string
}

/** 群聊消息(chat.message payload;与 Agent mailbox 双轨但共享关联 ID) */
export interface AepChatMessage {
  id: string
  channelId: string
  senderType: 'user' | 'agent' | 'system'
  /** user: 全局用户 id;agent: channel_agents 实例 id;system: 'system' */
  senderId: string
  senderName: string
  text: string
  mentions: AepChatMention[]
  /** 回复的消息 id(引用链) */
  replyToId: string | null
  /** 触发本次 Agent 执行的提问者用户 id(该消息为 Agent 回复时非空) */
  requesterUserId: string | null
  /** Agent 回复所对应的原始群聊消息 id */
  sourceChatMessageId: string | null
  /** 客户端幂等键 */
  clientMessageId: string
  createdAt: string
}

/** chat.delivery.status payload:群聊 → Agent mailbox 投递状态 */
export interface AepChatDelivery {
  deliveryId: string
  chatMessageId: string
  channelId: string
  targetAgentId: string
  mailboxMessageId: string | null
  status: 'pending' | 'delivered' | 'consumed' | 'failed' | 'cancelled'
  error?: string
  updatedAt: string
}

/** user notification 类型(定向通知;必须按 recipientUserId 隔离) */
export type AepNotificationType = 'mention' | 'agent_reply' | 'hitl_request' | 'hitl_resolved' | 'member'

/** notification.created payload(user-scoped;eventId 为幂等键) */
export interface AepNotification {
  id: string
  recipientUserId: string
  channelId: string | null
  chatMessageId: string | null
  hitlKind: string | null
  hitlId: string | null
  eventId: string
  type: AepNotificationType
  title: string
  body: string
  payload: Record<string, unknown>
  createdAt: string
  readAt: string | null
}

/** notification.read payload(多标签页同步已读) */
export interface AepNotificationRead {
  recipientUserId: string
  /** 单条已读时给出;批量已读时为空 */
  id?: string
  /** 批量已读的频道范围(为空 = 全部) */
  channelId?: string
  /** 已读时间 */
  readAt: string
  /** 本次影响的条数 */
  count: number
}

/** 群成员投影(WS/REST 共用;不含 token / config / 工作目录) */
export interface AepChannelMember {
  userId: string
  displayName: string | null
  role: 'owner' | 'member'
  status: 'active' | 'pending' | 'left' | 'removed'
  joinedAt: string
  leftAt: string | null
}

/** Channel 群聊设置投影 */
export interface AepChannelChatSettings {
  id: string
  name: string
  description: string
  visibility: 'private' | 'public'
  joinPolicy: 'open' | 'owner_approve'
  approvalPolicy: 'owner_only' | 'any_member'
  chatEnabled: number
  version: number
  legacy: boolean
}

/** channel.snapshot 的群聊侧基线(成员视图;管理面字段仅在 canManage 时附带) */
export interface AepChatSnapshot {
  channel: AepChannelChatSettings
  members: AepChannelMember[]
  chatMessages: AepChatMessage[]
  canManage: boolean
  agents?: Array<{ agentId: string, name: string, role: 'lead' | 'worker', harness: string, enabled: number, state: 'idle' | 'busy' | 'stopped' }>
  /** 调用者自身能力(canPost/canInvokeAgent/canApprove;避免前端自行推断) */
  permissions?: {
    isOwner: boolean
    isMember: boolean
    isAdmin: boolean
    canJoin: boolean
    canPost: boolean
    canInvokeAgent: boolean
    canApprove: boolean
    canManage: boolean
  }
  /** 通知补发游标(该用户在该频道的最新通知 id;无 = null) */
  notificationCursor?: { createdAt: string, id: string } | null
}

export type AepEvent
  = | { type: 'channel.snapshot', payload: AepSnapshot }
    | { type: 'agent.status', payload: { agentId: string, state: 'idle' | 'busy' | 'stopped', currentTaskId?: string | null, queued?: number, completed?: number } }
    | { type: 'agent.message', payload: A2AMessage }
    | { type: 'agent.delta', payload: { delta: string } }
    | { type: 'agent.status.message', payload: { text: string } }
    | { type: 'task.status', payload: { taskId: string, state: string, assigneeId?: string, agentId?: string, title?: string, parentId?: string, progress?: number, routeReason?: string, createdAt?: string, artifacts?: number } }
    | { type: 'task.progress', payload: { taskId: string, progress: number, agentId?: string } }
    | { type: 'a2a.artifact', payload: { taskId?: string, artifact: A2AArtifact } }
    | { type: 'a2a.message', payload: A2AMessage }
    | { type: 'agent.member', payload: AepMemberEvent }
    | { type: 'memory.saved', payload: { agentId: string, scope: 'private' | 'shared', title: string, dedupKey: string } }
    | { type: 'device.created', payload: AepDeviceEvent }
    | { type: 'device.updated', payload: AepDeviceEvent }
    | { type: 'device.deleted', payload: { id: string, name: string } }
    | { type: 'scene.layout.saved', payload: AepSceneLayout }
    | { type: 'scene.layout.removed', payload: { channelId: string } }
    | { type: 'hitl.request', payload: AepHitlItem }
    | { type: 'hitl.resolved', payload: AepHitlResolved }
    | { type: 'chat.message', payload: AepChatMessage }
    | { type: 'chat.delivery.status', payload: AepChatDelivery }
    | { type: 'chat.member', payload: AepChannelMember & { op: 'joined' | 'left' | 'removed' | 'approved' | 'updated', by?: string } }
    | { type: 'chat.settings', payload: AepChannelChatSettings }
    | { type: 'notification.created', payload: AepNotification }
    | { type: 'notification.read', payload: AepNotificationRead }
    | { type: 'daq.reading', payload: AepDaqReading }
    | { type: 'daq.node.changed', payload: AepDaqNodeChange }
    | { type: 'daq.controller', payload: AepDaqControllerState }
    | { type: 'daq.template.changed', payload: AepDaqTemplateChange }
    | { type: 'daq.alarm', payload: { id: string, nodeId: string, nodeName: string, metric: string, value: number | null, rule: string, threshold: number | null, createdAt: string } }
    | { type: 'daq.alarm.changed', payload: { id: string, ackedBy?: string, ackedAt?: string, recovered?: boolean } }
    | { type: 'ops.log', payload: AepOpsLog }
    | { type: 'dcw.node.changed', payload: AepDcwNodeChange }
    | { type: 'dcw.written', payload: AepDcwWritten }
    | { type: 'dcw.controller', payload: AepDcwControllerState }
    | { type: 'dcw.optimization.changed', payload: AepDcwOptimizationChange }
    | { type: 'error', payload: { code: string, message: string } }
    | { type: 'pong', payload: { t: number } }

/** 运维日志实时帧(实时事件轨只渲染摘要;详情由 /logs 日志管理页按维度查询) */
export interface AepOpsLog {
  at: string
  actor: string
  actorName: string
  actorKind: 'user' | 'agent' | 'system'
  action: string
  kind: string
  summary: string
  targetKind: string
  targetId: string
  lineId: string
  productId: string
  recipeId: string
}

/** AEP 下行信封 */
export interface AepEnvelope<T = AepEvent['payload']> {
  v: number
  type: AepEvent['type'] | string
  seq: number
  at: string
  channelId: string
  agentId?: string
  taskId?: string
  payload: T
}

/** 上行帧 */
export type AepUplink
  = | { type: 'ping' }
    | { type: 'sub', channelId: string, lastSeq?: number }
    | { type: 'unsub', channelId: string }
    /** v17:订阅用户级通知(按 peer 认证身份绑定;携带游标补发;禁止客户端指定他人 userId) */
    | { type: 'subNotifications', cursor?: { createdAt: string, id: string } | null }
    | { type: 'unsubNotifications' }
    | { type: 'notification.read', id?: string, channelId?: string, all?: boolean }

/** 事件类型的展示分组(前端过滤条用) */
export const AEP_GROUPS: Record<string, string[]> = {
  all: [],
  messages: ['agent.message', 'agent.status.message', 'a2a.message'],
  chat: ['chat.message', 'chat.member', 'chat.settings', 'chat.delivery.status'],
  tools: ['agent.status.message'],
  tasks: ['task.status', 'task.progress', 'a2a.artifact'],
  team: ['agent.member'],
  devices: ['device.created', 'device.updated', 'device.deleted'],
  scene: ['scene.layout.saved', 'scene.layout.removed'],
  hitl: ['hitl.request', 'hitl.resolved'],
  notifications: ['notification.created', 'notification.read'],
  daq: ['daq.reading', 'daq.node.changed', 'daq.controller', 'daq.template.changed', 'daq.alarm', 'daq.alarm.changed'],
  dcw: ['dcw.node.changed', 'dcw.written', 'dcw.controller', 'dcw.optimization.changed'],
  ops: ['ops.log'],
  errors: ['error'],
}

/**
 * 群聊相关 AEP 事件类型(必须走 channel 流:seq/环形缓冲/落库/重放)。
 * user-scoped 通知事件**不得**走 channel 流 —— 它们经用户通知 hub 定向直推,
 * 且以 user_notifications 表为事实源按游标补发。
 */
export const AEP_CHANNEL_CHAT_EVENTS: readonly string[] = ['chat.message', 'chat.delivery.status', 'chat.member', 'chat.settings']

/** 用户级通知事件(定向;禁止 broadcastPeerEvent 广播) */
export const AEP_USER_SCOPED_EVENTS: readonly string[] = ['notification.created', 'notification.read']

// ===== 人类发起者权限上下文(主计划 §13.3)=====
//
// `@Agent` **不等于**把 owner 的全部权限无条件委托给普通成员。每次由人类触发的
// Agent 调用都必须携带「发起者权限 ∩ Agent 授权能力」,并在委派链上**只收紧不放大**。
//
// 该上下文经 mailbox 元数据头 `x-aw-permission-scope` 传递(与 §13.6 的关联 ID 同路),
// 消费方有两处:
//   1. Agent→Agent 委派(manager.sendA2A):父作用域 ∩ 子作用域后继续向下传;
//   2. Agent 工具调用(manager.invokeHostTool):按作用域拒绝管理面/高危工具。
//
// 为什么把合同放在 shared:接口必须先冻结(§10「任何 Worker 不得在合约未冻结前自行
// 发明字段名」),服务端/测试/前端读同一份定义。

/** mailbox 元数据头名(与 §13.6 的 x-aw-* 关联 ID 同一命名族) */
export const WORKSHOP_PERMISSION_SCOPE_HEADER = 'x-aw-permission-scope'

/** 作用域档位:只允许三档,新增档位必须同时更新 intersect 的收紧规则 */
export type WorkshopPermissionScopeLevel = 'system' | 'channel_owner' | 'channel_member'

export interface WorkshopPermissionScope {
  /** 本次人类调用的幂等标识(= deliveryId,§13.6 关联 ID 之一) */
  invocationId: string
  /** 发起该调用的登录用户(权威来源:服务端登录态,客户端不可伪造) */
  requesterUserId: string
  channelId: string
  /** 档位:channel_member 为最低档,任何交集结果不得高于它 */
  scope: WorkshopPermissionScopeLevel
  /** 是否可执行 Channel/Agent/Task/Plugin 等管理面工具 */
  canManageChannel: boolean
  /** 是否可执行工业/高危写工具(dcw_control、param_control、aml_* 等) */
  canUseHighRiskTools: boolean
}

/**
 * 宽容解析:非法/缺字段一律返回 null(调用方按"无作用域"处理,即不额外限制也不放大)。
 * 只会采纳三档已知档位;未知档位**降级**为最保守的 channel_member,不保留字符串。
 */
export function parseWorkshopPermissionScope(raw: unknown): WorkshopPermissionScope | null {
  if (raw == null) return null
  let value: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    try {
      value = JSON.parse(text)
    }
    catch {
      return null
    }
  }
  if (typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const channelId = typeof o.channelId === 'string' ? o.channelId : ''
  if (!channelId) return null
  const level = o.scope === 'system' || o.scope === 'channel_owner' ? o.scope : 'channel_member'
  return {
    invocationId: typeof o.invocationId === 'string' ? o.invocationId : '',
    requesterUserId: typeof o.requesterUserId === 'string' ? o.requesterUserId : '',
    channelId,
    scope: level,
    canManageChannel: o.canManageChannel === true && level !== 'channel_member',
    canUseHighRiskTools: o.canUseHighRiskTools === true && level !== 'channel_member',
  }
}

/**
 * 作用域交集(§13.3「默认使用发起者权限 ∩ Agent 授权能力」)。
 * 收紧规则(单调不放大):
 *  - 档位取更低的一档(channel_member < channel_owner < system);
 *  - 两个布尔能力都取**与**,任一为 false 则结果为 false;
 *  - 归属字段(invocationId/requesterUserId/channelId)保留**发起者**的,
 *    因为它们标识"这次调用是谁发起的",委派方无权改写。
 * 跨 Channel 委派时 channelId 取发起者的 Channel(权限判定以发起者为边界)。
 */
export function intersectWorkshopPermissionScope(
  parent: WorkshopPermissionScope,
  child: WorkshopPermissionScope | null | undefined,
): WorkshopPermissionScope {
  if (!child) return parent
  const rank: Record<WorkshopPermissionScopeLevel, number> = { channel_member: 0, channel_owner: 1, system: 2 }
  const level = rank[child.scope] < rank[parent.scope] ? child.scope : parent.scope
  return {
    invocationId: parent.invocationId,
    requesterUserId: parent.requesterUserId,
    channelId: parent.channelId,
    scope: level,
    canManageChannel: parent.canManageChannel && child.canManageChannel,
    canUseHighRiskTools: parent.canUseHighRiskTools && child.canUseHighRiskTools,
  }
}
