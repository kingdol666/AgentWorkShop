/**
 * WebSocket Hub(AEP v1)— 前端观察入口,事件驱动直推。
 * 路径 /api/workshop/ws?channelId=xxx(缺省 channelId 可连后上行 sub 订阅多 channel)。
 *
 * 协议:Agent Event Protocol(权威定义 #shared/workshop-protocol)
 *  - 下行信封:{ v, type, seq, at, channelId, agentId?, taskId?, payload }
 *    type/payload 与旧 hub 帧兼容(agent.status/task.status/task.progress/
 *    a2a.artifact/a2a.message/channel.snapshot/error/pong),信封字段为增量。
 *  - 上行:{type:'ping'} → pong;{type:'sub',channelId,lastSeq?} 断线续传重放;
 *    {type:'unsub',channelId} 退订。
 *
 * 推送机制:直订 manager ChannelBus(subscribeChannelEvents/onTaskEvent/
 * onAgentStatus/subscribeChannelMessages/subscribeMemoryEvents)——无轮询;
 * per-channel 单调 seq + 环形缓冲(5000),sub 带 lastSeq 时重放缺失段,
 * 缓冲窗外/seq 倒退(服务重启)→ 下发 channel.snapshot 全量对齐。
 */
import { defineWebSocketHandler } from 'h3'
import { getWorkshopManager } from '../../plugins/workshop'
import type { AgentChannelManager, ManagerDeps } from '../../services/workshop/runtime/manager'
import type { AgentRuntime, TaskEngine } from '../../services/workshop/runtime/agent-runtime'
import { rowToMessage } from '../../services/workshop/runtime/mailbox'
import type { AgentEvent } from '../../services/workshop/agents/agent-interface'
import type { A2AMessage } from '../../services/workshop/types/a2a'
import type { AepEnvelope } from '../../../shared/workshop-protocol'

const AEP_VERSION = 1
const RING_CAP = 5000

/** 最小 peer 接口(h3 2.x 未 re-export crossws 类型,duck typing;与 game/ws.ts 同风格) */
interface WsPeer {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

/** channel 级事件流:seq 单调递增 + 环形缓冲 + 订阅清理 + 优雅保留窗口 */
interface ChannelStream {
  channelId: string
  seq: number
  ring: AepEnvelope[]
  peers: Set<WsPeer>
  unsubs: Array<() => void>
  /** 最后一个 peer 离开后的销毁定时器(保留期内事件继续入缓冲,支持断线续传) */
  teardown: ReturnType<typeof setTimeout> | null
}

/** 最后 peer 离开后 stream 保留时长(断线重连窗口;期内事件继续入环形缓冲) */
const TEARDOWN_GRACE_MS = 60_000

const streams = new Map<string, ChannelStream>()
/** peer → 已订阅 channel(断连时批量退订) */
const peerChannels = new Map<WsPeer, Set<string>>()

/** manager 内部结构(类型收窄:公开 API 未暴露 repos/运行时映射) */
interface ManagerInternals {
  deps: ManagerDeps
  agentIndex: Map<string, AgentRuntime>
  getTaskEngine(): TaskEngine
  queueOverview(channelId: string, callerAgentId: string): Promise<import('../../services/workshop/types/task').AgentStatusView[]>
}

function internalsOf(manager: AgentChannelManager): ManagerInternals {
  return manager as unknown as ManagerInternals
}

function resolveChannelIdFromUrl(peer: WsPeer): string | undefined {
  const req = (peer as unknown as { request?: Request }).request
  if (!req) return undefined
  const url = new URL(req.url)
  return url.searchParams.get('channelId') ?? url.searchParams.get('channel_id') ?? undefined
}

/** 安全发送控制帧(error/pong;死连接静默丢弃) */
function sendControl(peer: WsPeer, obj: unknown): void {
  try {
    sendControl(peer, obj)
  }
  catch { /* 死连接 */ }
}

function sendEnvelope(stream: ChannelStream, peer: WsPeer, e: AepEnvelope): void {
  try {
    peer.send(JSON.stringify(e))
  }
  catch {
    // 死连接(TCP 硬断未走 close 回调):移除防后续广播中断
    stream.peers.delete(peer)
  }
}

/** 发布事件:seq 递增 → 入环形缓冲 → 广播全部 peer(逐 peer 容错,死连接即时清理) */
function publish(
  stream: ChannelStream,
  type: string,
  payload: unknown,
  ids: { agentId?: string, taskId?: string } = {},
): AepEnvelope {
  stream.seq += 1
  const e: AepEnvelope = {
    v: AEP_VERSION,
    type,
    seq: stream.seq,
    at: new Date().toISOString(),
    channelId: stream.channelId,
    ...ids,
    payload: payload as AepEnvelope['payload'],
  }
  stream.ring.push(e)
  if (stream.ring.length > RING_CAP) stream.ring.splice(0, stream.ring.length - RING_CAP)
  for (const peer of stream.peers) sendEnvelope(stream, peer, e)
  return e
}

/** 采集 channel 快照(agents 含队列上下文;queue 总览) */
function buildSnapshot(manager: AgentChannelManager, channelId: string): Record<string, unknown> | null {
  const internal = internalsOf(manager)
  const channel = internal.deps.repos.channels.findById(channelId)
  if (!channel) return null
  const memberRows = internal.deps.repos.channelAgents.listByChannel(channelId)
  const agents = memberRows.map((m) => {
    const rt = internal.agentIndex.get(`${channelId}\u0000${m.id}`)
    const view = rt ? rt.getQueueView() : internal.getTaskEngine().queueViewOf(channelId, m.id)
    return {
      agentId: m.id,
      name: m.name,
      role: m.role,
      harness: m.harness,
      state: rt ? rt.getState() : 'idle',
      currentTaskId: view.current?.id ?? null,
      queued: view.queued.length,
      completed: view.completed.length,
    }
  })
  const tasks = internal.getTaskEngine().list(channelId)
  const recentMessages = internal.deps.repos.messages.listRecentByChannel(channelId, 50).map(rowToMessage)
  // queue 总览 = agents 的队列上下文规范化(与 queueOverview 同口径,免异步)
  const queue = agents.map(a => ({
    agentId: a.agentId,
    name: a.name,
    role: a.role,
    state: a.state,
    currentTaskId: a.currentTaskId ?? null,
    queuedCount: a.queued ?? 0,
    completedCount: a.completed ?? 0,
  }))
  return { channelId, channel, agents, tasks, queue, messages: recentMessages }
}

/** AgentEvent 五变体 → AEP 事件 */
function mapAgentEvent(stream: ChannelStream, event: AgentEvent, source: A2AMessage): void {
  const agentId = (source.metadata?.['x-aw-producing-agent'] as string | undefined)
    ?? (source.metadata?.['x-aw-from-agent'] as string | undefined)
    ?? undefined
  const taskId = source.taskId ?? (source.metadata?.['x-aw-task-id'] as string | undefined) ?? undefined
  switch (event.kind) {
    case 'message':
      publish(stream, 'agent.message', event.message, { agentId, taskId: event.message.taskId ?? taskId })
      break
    case 'status':
      if (event.status.message) {
        const text = event.status.message.parts.map(p => ('text' in p ? p.text : '')).join(' ')
        if (text) publish(stream, 'agent.status.message', { text }, { agentId, taskId })
      }
      break
    case 'artifact':
      publish(stream, 'a2a.artifact', { taskId, artifact: event.artifact }, { agentId, taskId })
      break
    case 'error':
      publish(stream, 'error', { code: event.error.code, message: event.error.message }, { agentId, taskId })
      break
    case 'done':
      // 终态由 notifyAgent/notifyTask 驱动,done 不单独成帧
      break
  }
}

/** 建立(或复用)channel 事件流:订阅 ChannelBus,事件直推 */
function ensureStream(manager: AgentChannelManager, channelId: string): ChannelStream | null {
  const existing = streams.get(channelId)
  if (existing) return existing
  const channel = internalsOf(manager).deps.repos.channels.findById(channelId)
  if (!channel) return null
  const stream: ChannelStream = { channelId, seq: 0, ring: [], peers: new Set(), unsubs: [], teardown: null }
  // 任务事件:状态迁移(assignee 补全)/ 进度
  stream.unsubs.push(manager.subscribeTaskEvents(channelId, (e) => {
    if (e.state !== undefined) {
      const assigneeId = internalsOf(manager).getTaskEngine().get(e.taskId)?.assigneeId
      publish(stream, 'task.status', { taskId: e.taskId, state: e.state, assigneeId, agentId: e.agentId }, { taskId: e.taskId, agentId: e.agentId ?? assigneeId })
    }
    if (e.progress !== undefined) {
      publish(stream, 'task.progress', { taskId: e.taskId, progress: e.progress, agentId: e.agentId }, { taskId: e.taskId })
    }
  }))
  // 成员状态(idle/busy + 队列上下文)
  stream.unsubs.push(manager.subscribeAgentStatus(channelId, e => publish(stream, 'agent.status', e, { agentId: e.agentId })))
  // harness 事件流(message/artifact/status.message/error)
  stream.unsubs.push(manager.subscribeChannelEvents(channelId, (event, source) => mapAgentEvent(stream, event, source)))
  // 消息投递(route 汇流点)
  stream.unsubs.push(manager.subscribeChannelMessages(channelId, (message) => {
    const agentId = (message.metadata?.['x-aw-from-agent'] as string | undefined)
      ?? (message.metadata?.['x-aw-target-agent'] as string | undefined)
    publish(stream, 'a2a.message', message, { agentId, taskId: message.taskId ?? undefined })
  }))
  // 记忆写入
  stream.unsubs.push(manager.subscribeMemoryEvents(channelId, e => publish(stream, 'memory.saved', e, { agentId: e.agentId })))
  streams.set(channelId, stream)
  return stream
}

/** 订阅:快照对齐或 lastSeq 重放 */
function subscribePeer(manager: AgentChannelManager, peer: WsPeer, channelId: string, lastSeq?: number): void {
  const stream = ensureStream(manager, channelId)
  if (!stream) {
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId, payload: { code: 'NOT_FOUND', message: `channel 不存在: ${channelId}` } })
    return
  }
  stream.peers.add(peer)
  // 新 peer 加入即取消待销毁(保留期内重连,seq 连续)
  if (stream.teardown) {
    clearTimeout(stream.teardown)
    stream.teardown = null
  }
  let channels = peerChannels.get(peer)
  if (!channels) {
    channels = new Set()
    peerChannels.set(peer, channels)
  }
  channels.add(channelId)
  // 对齐策略:无 lastSeq / seq 倒退(服务重启) / 缓冲窗外 → channel.snapshot 全量;否则重放缺失段
  const oldest = stream.ring[0]?.seq ?? stream.seq + 1
  if (lastSeq === undefined || lastSeq >= stream.seq || lastSeq + 1 < oldest) {
    const snapshot = buildSnapshot(manager, channelId)
    if (snapshot) {
      sendControl(peer, {
        v: AEP_VERSION,
        type: 'channel.snapshot',
        seq: stream.seq,
        at: new Date().toISOString(),
        channelId,
        payload: snapshot,
      })
    }
    if (lastSeq !== undefined && lastSeq > stream.seq) {
      // 客户端游标超前(服务端重启 seq 归零):快照即对齐,无需重放
    }
  }
  else {
    for (const e of stream.ring) {
      if (e.seq > lastSeq) sendEnvelope(stream, peer, e)
    }
  }
}

/** 销毁 stream:退订全部事件源并移除 */
function teardownStream(stream: ChannelStream): void {
  for (const unsub of stream.unsubs) {
    try {
      unsub()
    }
    catch { /* 尽力清理 */ }
  }
  streams.delete(stream.channelId)
}

/** 退订 peer;channel 无 peer 时进入保留窗口(到期内无重连才销毁) */
function unsubscribePeer(peer: WsPeer, channelId?: string): void {
  const channels = peerChannels.get(peer)
  if (!channels) return
  const targets = channelId ? [channelId] : [...channels]
  for (const id of targets) {
    channels.delete(id)
    const stream = streams.get(id)
    if (stream && stream.peers.delete(peer) && stream.peers.size === 0) {
      stream.teardown ??= setTimeout(() => {
        stream.teardown = null
        // 到期仍无 peer → 销毁(seq 将随下次订阅重置,客户端经 snapshot 对齐)
        if (stream.peers.size === 0) teardownStream(stream)
      }, TEARDOWN_GRACE_MS)
      stream.teardown.unref?.()
    }
  }
  if (channels.size === 0) peerChannels.delete(peer)
}

export default defineWebSocketHandler({
  open(peer) {
    let manager: AgentChannelManager
    try {
      manager = getWorkshopManager()
    }
    catch (error) {
      sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'WORKSHOP_NOT_READY', message: error instanceof Error ? error.message : 'workshop 未初始化' } })
      peer.close(1011, 'workshop not ready')
      return
    }
    // 兼容旧路径:?channelId= 连接即订阅(无 lastSeq → 快照对齐)
    const channelId = resolveChannelIdFromUrl(peer)
    if (!channelId) return // 纯上行 sub 模式(多 channel 复用一条连接)
    subscribePeer(manager, peer, channelId)
  },

  message(peer, message) {
    const raw = message.text()
    if (!raw) return
    let parsed: { type?: unknown, channelId?: unknown, lastSeq?: unknown }
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'BAD_MESSAGE', message: '上行消息必须是 JSON' } })
      return
    }
    if (parsed.type === 'ping') {
      sendControl(peer, { v: AEP_VERSION, type: 'pong', seq: 0, at: new Date().toISOString(), channelId: '', payload: { t: Date.now() } })
      return
    }
    if (parsed.type === 'sub' && typeof parsed.channelId === 'string') {
      let manager: AgentChannelManager
      try {
        manager = getWorkshopManager()
      }
      catch (error) {
        sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: parsed.channelId, payload: { code: 'WORKSHOP_NOT_READY', message: error instanceof Error ? error.message : 'workshop 未初始化' } })
        return
      }
      subscribePeer(manager, peer, parsed.channelId, typeof parsed.lastSeq === 'number' ? parsed.lastSeq : undefined)
      return
    }
    if (parsed.type === 'unsub' && typeof parsed.channelId === 'string') {
      unsubscribePeer(peer, parsed.channelId)
      return
    }
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'UNSUPPORTED_UPLINK', message: `不支持的上行消息: ${String(parsed.type)}` } })
  },

  close(peer) {
    unsubscribePeer(peer)
  },

  error(peer, error) {
    console.error('[workshop-ws] connection error:', error)
    unsubscribePeer(peer)
  },
})
