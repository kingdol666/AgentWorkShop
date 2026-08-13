/**
 * WebSocket Hub — 前端观察入口(设计文档 §6.4)。
 * 路径 /api/workshop/ws?channelId=xxx(设计文档 /ws/workshop/:channelId 在本项目
 * Nitro 路由(server/api/workshop/ws.ts → /api/workshop/ws)下的落地:channelId 走查询参数)。
 *
 * 下行事件(统一 { type, payload }):
 *  - channel.snapshot  channel 信息 + 同事列表(role/state/harness)+ 最近消息 + 任务列表
 *  - agent.status      { agentId, state }
 *  - a2a.message       A2A 消息(新入 channel 的 mailbox 消息)
 *  - a2a.artifact      工件分块 { taskId, artifact }(任务新增 artifacts)
 *  - task.status       { taskId, state, assigneeId }
 *  - task.progress     { taskId, progress }
 *  - error             { code, message }
 * 上行:仅 ping → 回 pong;其它上行回 error(UNSUPPORTED_UPLINK)。
 *
 * 事件推送:manager 的 ChannelBus 不做外部广播(onTaskEvent 仅注册不触发),
 * 故采用 channel 级轮询(500ms)对快照做增量 diff,满足"订阅任务/消息/进度事件推送给 peer"。
 */
import { defineWebSocketHandler } from 'h3'
import { getWorkshopManager } from '../../plugins/workshop'
import type { AgentChannelManager, ManagerDeps } from '../../services/workshop/runtime/manager'
import type { AgentRuntime, TaskEngine } from '../../services/workshop/runtime/agent-runtime'
import { rowToMessage } from '../../services/workshop/runtime/mailbox'
import type { A2AArtifact, A2AMessage } from '../../services/workshop/types/a2a'

/** 最小 peer 接口(h3 2.x 未 re-export crossws 类型,duck typing;与 game/ws.ts 同风格) */
interface WsPeer {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

/** 单次快照状态(diff 基线) */
interface SnapshotState {
  agentStates: Map<string, string>
  taskStates: Map<string, string>
  assignees: Map<string, string>
  taskProgress: Map<string, number>
  artifactCounts: Map<string, number>
  artifacts: Map<string, A2AArtifact[]>
  recentMessages: A2AMessage[]
  messageIds: Set<string>
}

interface ChannelEntry {
  peers: Set<WsPeer>
  timer: ReturnType<typeof setInterval> | null
  last: SnapshotState | null
}

/** 下行事件({ type, payload }) */
type DownlinkEvent = { type: string, payload: unknown }

const POLL_MS = 500
const hub = new Map<string, ChannelEntry>()

/** manager 内部结构(类型收窄:公开 API 未暴露 repos/运行时映射) */
interface ManagerInternals {
  deps: ManagerDeps
  agentIndex: Map<string, AgentRuntime>
  getTaskEngine(): TaskEngine
}

function internalsOf(manager: AgentChannelManager): ManagerInternals {
  return manager as unknown as ManagerInternals
}

/** 从升级请求 URL 解析 channelId(查询参数 channelId / channel_id) */
function resolveChannelId(peer: WsPeer): string | undefined {
  const req = (peer as unknown as { request?: Request }).request
  if (!req) return undefined
  const url = new URL(req.url)
  return url.searchParams.get('channelId') ?? url.searchParams.get('channel_id') ?? undefined
}

function sendJson(peer: WsPeer, type: string, payload: unknown): void {
  peer.send(JSON.stringify({ type, payload }))
}

/** 采集 channel 快照;channel 不存在返回 null */
function buildSnapshot(manager: AgentChannelManager, channelId: string): { data: Record<string, unknown>, last: SnapshotState } | null {
  const internal = internalsOf(manager)
  const channel = internal.deps.repos.channels.findById(channelId)
  if (!channel) return null

  const agentRows = internal.deps.repos.agents.listByChannel(channelId)
  const agents = agentRows.map(row => ({
    agentId: row.id,
    name: row.name,
    role: row.role,
    harness: row.harness,
    state: internal.agentIndex.get(row.id)?.getState() ?? 'stopped',
  }))
  const tasks = internal.getTaskEngine().list(channelId)
  const recentMessages = internal.deps.repos.messages.listRecentByChannel(channelId, 50).map(rowToMessage)

  const agentStates = new Map<string, string>()
  for (const agent of agents) agentStates.set(agent.agentId, agent.state)
  const taskStates = new Map<string, string>()
  const assignees = new Map<string, string>()
  const taskProgress = new Map<string, number>()
  const artifactCounts = new Map<string, number>()
  const artifacts = new Map<string, A2AArtifact[]>()
  for (const task of tasks) {
    taskStates.set(task.id, task.state)
    assignees.set(task.id, task.assigneeId)
    taskProgress.set(task.id, task.progress)
    artifactCounts.set(task.id, task.artifacts.length)
    artifacts.set(task.id, task.artifacts)
  }

  return {
    data: { channelId, channel, agents, tasks, messages: recentMessages },
    last: {
      agentStates,
      taskStates,
      assignees,
      taskProgress,
      artifactCounts,
      artifacts,
      recentMessages,
      messageIds: new Set(recentMessages.map(m => m.messageId)),
    },
  }
}

/** 两帧快照 diff → 增量事件(agent.status / task.status / task.progress / a2a.artifact / a2a.message) */
function diffDeltas(prev: SnapshotState, next: SnapshotState): DownlinkEvent[] {
  const events: DownlinkEvent[] = []
  for (const [agentId, state] of next.agentStates) {
    if (prev.agentStates.get(agentId) !== state) {
      events.push({ type: 'agent.status', payload: { agentId, state } })
    }
  }
  for (const [taskId, state] of next.taskStates) {
    if (prev.taskStates.get(taskId) !== state) {
      events.push({ type: 'task.status', payload: { taskId, state, assigneeId: next.assignees.get(taskId) } })
    }
  }
  for (const [taskId, progress] of next.taskProgress) {
    if (prev.taskProgress.get(taskId) !== progress) {
      events.push({ type: 'task.progress', payload: { taskId, progress } })
    }
  }
  for (const [taskId, taskArtifacts] of next.artifacts) {
    const prevCount = prev.artifactCounts.get(taskId) ?? 0
    for (const artifact of taskArtifacts.slice(prevCount)) {
      events.push({ type: 'a2a.artifact', payload: { taskId, artifact } })
    }
  }
  for (const message of next.recentMessages) {
    if (!prev.messageIds.has(message.messageId)) {
      events.push({ type: 'a2a.message', payload: message })
    }
  }
  return events
}

/** 轮询广播:对 channel 内全部 peer 推送增量事件 */
function broadcastDeltas(channelId: string, manager: AgentChannelManager): void {
  const entry = hub.get(channelId)
  if (!entry) return
  if (entry.peers.size === 0) {
    if (entry.timer) {
      clearInterval(entry.timer)
      entry.timer = null
    }
    hub.delete(channelId)
    return
  }
  const snapshot = buildSnapshot(manager, channelId)
  if (!snapshot) return
  const events = entry.last ? diffDeltas(entry.last, snapshot.last) : []
  if (events.length > 0) {
    const frames = events.map(e => JSON.stringify(e))
    for (const peer of entry.peers) {
      for (const frame of frames) peer.send(frame)
    }
  }
  entry.last = snapshot.last
}

/** 从连接表中移除 peer;channel 无 peer 时停表清理 */
function removePeer(peer: WsPeer): void {
  for (const [channelId, entry] of hub) {
    if (!entry.peers.delete(peer)) continue
    if (entry.peers.size === 0) {
      if (entry.timer) {
        clearInterval(entry.timer)
        entry.timer = null
      }
      hub.delete(channelId)
    }
  }
}

export default defineWebSocketHandler({
  open(peer) {
    const channelId = resolveChannelId(peer)
    if (!channelId) {
      sendJson(peer, 'error', { code: 'CHANNEL_ID_REQUIRED', message: '缺少 channelId 查询参数(ws://…/api/workshop/ws?channelId=xxx)' })
      peer.close(4400, 'channelId required')
      return
    }
    let manager: AgentChannelManager
    try {
      manager = getWorkshopManager()
    }
    catch (error) {
      sendJson(peer, 'error', { code: 'WORKSHOP_NOT_READY', message: error instanceof Error ? error.message : 'workshop 未初始化' })
      peer.close(1011, 'workshop not ready')
      return
    }
    const snapshot = buildSnapshot(manager, channelId)
    if (!snapshot) {
      sendJson(peer, 'error', { code: 'NOT_FOUND', message: `channel 不存在: ${channelId}` })
      peer.close(4404, 'channel not found')
      return
    }
    let entry = hub.get(channelId)
    if (!entry) {
      entry = { peers: new Set(), timer: null, last: null }
      hub.set(channelId, entry)
    }
    entry.peers.add(peer)
    // 连接后立即下发 channel.snapshot(此后轮询只推增量)
    peer.send(JSON.stringify({ type: 'channel.snapshot', payload: snapshot.data }))
    entry.last = snapshot.last
    if (!entry.timer) {
      entry.timer = setInterval(() => broadcastDeltas(channelId, manager), POLL_MS)
    }
  },

  message(peer, message) {
    const raw = message.text()
    if (!raw) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      sendJson(peer, 'error', { code: 'BAD_MESSAGE', message: '上行消息必须是 JSON' })
      return
    }
    const type = (parsed as { type?: unknown }).type
    if (type === 'ping') {
      sendJson(peer, 'pong', { t: Date.now() })
      return
    }
    sendJson(peer, 'error', { code: 'UNSUPPORTED_UPLINK', message: `不支持的上行消息: ${String(type)}` })
  },

  close(peer) {
    removePeer(peer)
  },

  error(peer, error) {
    console.error('[workshop-ws] connection error:', error)
    removePeer(peer)
  },
})
