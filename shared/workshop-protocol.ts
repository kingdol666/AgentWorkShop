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
    | { type: 'daq.reading', payload: AepDaqReading }
    | { type: 'daq.node.changed', payload: AepDaqNodeChange }
    | { type: 'daq.controller', payload: AepDaqControllerState }
    | { type: 'daq.template.changed', payload: AepDaqTemplateChange }
    | { type: 'error', payload: { code: string, message: string } }
    | { type: 'pong', payload: { t: number } }

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

/** 事件类型的展示分组(前端过滤条用) */
export const AEP_GROUPS: Record<string, string[]> = {
  all: [],
  messages: ['agent.message', 'agent.status.message', 'a2a.message'],
  tools: ['agent.status.message'],
  tasks: ['task.status', 'task.progress', 'a2a.artifact'],
  team: ['agent.member'],
  devices: ['device.created', 'device.updated', 'device.deleted'],
  scene: ['scene.layout.saved', 'scene.layout.removed'],
  daq: ['daq.reading', 'daq.node.changed', 'daq.controller', 'daq.template.changed'],
  errors: ['error'],
}
