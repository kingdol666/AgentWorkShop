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
}

/**
 * HMR 存活:nitro dev 热重载重建模块图(模块级 Map 随之蒸发),但 crossws peer 连接仍存活——
 * hub 状态挂 globalThis 跨模块实例存活;manager 更替(plugin 重新 init)时由 ensureHubBound
 * 自愈式重建订阅(peers 平移),存活连接在下一帧(最长一个 ping 周期)自动恢复事件流。
 */
interface HubState {
  streams: Map<string, ChannelStream>
  peerChannels: Map<WsPeer, Set<string>>
  boundManager: AgentChannelManager | null
}
const hubGlobal = globalThis as typeof globalThis & { __workshopWsHub?: HubState }
const hub: HubState = hubGlobal.__workshopWsHub
  ?? (hubGlobal.__workshopWsHub = { streams: new Map(), peerChannels: new Map(), boundManager: null })
const streams = hub.streams
const peerChannels = hub.peerChannels

/**
 * hub ↔ manager 绑定校验(消息入口调用):manager 更替(HMR 后 plugin 重新 init)时,
 * 退订旧 manager 总线上的全部 stream 并按新 manager 重建订阅;已注册 peers 平移,
 * ring/seq 延续,客户端无需重连即恢复事件流。
 */
function ensureHubBound(manager: AgentChannelManager): void {
  if (hub.boundManager === manager) return
  hub.boundManager = manager
  for (const stream of [...streams.values()]) {
    const channelId = stream.channelId
    // seq/ring 延续:客户端游标(已收到的 lastSeq)不变,重建流必须接续原 seq 递增,
    // 否则新事件 seq 从 1 重来会被客户端 ingest 的 seq>lastSeq 判重逻辑整段丢弃。
    const seq = stream.seq
    const ring = stream.ring
    const peers = [...stream.peers]
    for (const unsub of stream.unsubs) {
      try {
        unsub()
      }
      catch { /* 尽力清理 */ }
    }
    streams.delete(channelId)
    // 有 peer 的 channel 立即按新 manager 重建(peers 平移 + seq/ring 延续);无 peer 的任其自然重建
    if (peers.length > 0) {
      const fresh = ensureStream(manager, channelId)
      if (fresh) {
        fresh.peers = new Set(peers)
        fresh.seq = seq
        fresh.ring = ring
      }
    }
  }
}

// 模块加载自愈(HMR):nitro reload 后新模块消息入口触达不了旧 socket(旧 handler 继续应答),
// 加载时主动把 hub 换绑到当前 manager(peers 平移,存活连接即刻恢复推送)。
// manager 可能尚未重新 init(plugin 时序)→ 有限重试等待就绪。
if (hub.streams.size > 0) {
  const rebindWhenReady = (attempt: number): void => {
    try {
      ensureHubBound(getWorkshopManager())
    }
    catch {
      if (attempt < 50) setTimeout(() => rebindWhenReady(attempt + 1), 200) // ≤10s
    }
  }
  setTimeout(() => rebindWhenReady(0), 50)
}

/** manager 内部结构(类型收窄:公开 API 未暴露 repos/运行时映射) */
interface ManagerInternals {
  deps: ManagerDeps
  agentIndex: Map<string, AgentRuntime>
  getTaskEngine(): TaskEngine
}

function internalsOf(manager: AgentChannelManager): ManagerInternals {
  return manager as unknown as ManagerInternals
}

function resolveQueryParam(peer: WsPeer, name: string): string | undefined {
  const req = (peer as unknown as { request?: Request }).request
  if (!req) return undefined
  return new URL(req.url).searchParams.get(name) ?? undefined
}

function resolveChannelIdFromUrl(peer: WsPeer): string | undefined {
  return resolveQueryParam(peer, 'channelId') ?? resolveQueryParam(peer, 'channel_id')
}

/** 安全发送控制帧(error/pong/snapshot;死连接静默丢弃) */
function sendControl(peer: WsPeer, obj: unknown): void {
  try {
    peer.send(JSON.stringify(obj))
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
  manager: AgentChannelManager,
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
  // 持久化(server 驱动;与 client 无关):落库失败仅记日志,不影响实时推送
  try {
    internalsOf(manager).deps.repos.channelEvents.insert(stream.channelId, {
      seq: e.seq, type: e.type, at: e.at, agentId: e.agentId ?? null, taskId: e.taskId ?? null, payload: e.payload,
    })
  }
  catch (err) {
    console.error('[workshop-ws] 事件落库失败:', err)
  }
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
      enabled: m.enabled,
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
function mapAgentEvent(manager: AgentChannelManager, stream: ChannelStream, event: AgentEvent, source: A2AMessage): void {
  const agentId = (source.metadata?.['x-aw-producing-agent'] as string | undefined)
    ?? (source.metadata?.['x-aw-from-agent'] as string | undefined)
    ?? undefined
  const taskId = source.taskId ?? (source.metadata?.['x-aw-task-id'] as string | undefined) ?? undefined
  switch (event.kind) {
    case 'message':
      publish(manager, stream, 'agent.message', event.message, { agentId, taskId: event.message.taskId ?? taskId })
      break
    case 'delta':
      publish(manager, stream, 'agent.delta', { delta: event.delta.text }, { agentId, taskId })
      break
    case 'status':
      if (event.status.message) {
        const text = event.status.message.parts.map(p => ('text' in p ? p.text : '')).join(' ')
        if (text) publish(manager, stream, 'agent.status.message', { text }, { agentId, taskId })
      }
      break
    case 'artifact':
      publish(manager, stream, 'a2a.artifact', { taskId, artifact: event.artifact }, { agentId, taskId })
      break
    case 'error':
      publish(manager, stream, 'error', { code: event.error.code, message: event.error.message }, { agentId, taskId })
      break
    case 'done':
      // 终态由 notifyAgent/notifyTask 驱动,done 不单独成帧
      break
  }
}

/**
 * 建立(或复用)channel 事件流:订阅 ChannelBus,事件直推 + 全时落库。
 * 流生命周期 = 进程生命周期(与订阅者无关;无 peer 时事件仍持久化,DB 为事实源)。
 */
export function ensureStream(manager: AgentChannelManager, channelId: string): ChannelStream | null {
  const existing = streams.get(channelId)
  if (existing) return existing
  const channel = internalsOf(manager).deps.repos.channels.findById(channelId)
  if (!channel) return null
  // seq 从持久层续接(重启后继续递增;INSERT OR IGNORE 幂等兜底)
  const initSeq = internalsOf(manager).deps.repos.channelEvents.maxSeq(channelId)
  const stream: ChannelStream = { channelId, seq: initSeq, ring: [], peers: new Set(), unsubs: [] }
  // 任务事件:状态迁移(assignee 补全)/ 进度
  stream.unsubs.push(manager.subscribeTaskEvents(channelId, (e) => {
    if (e.state !== undefined) {
      const assigneeId = internalsOf(manager).getTaskEngine().get(e.taskId)?.assigneeId
      publish(manager, stream, 'task.status', { taskId: e.taskId, state: e.state, assigneeId, agentId: e.agentId }, { taskId: e.taskId, agentId: e.agentId ?? assigneeId })
    }
    if (e.progress !== undefined) {
      publish(manager, stream, 'task.progress', { taskId: e.taskId, progress: e.progress, agentId: e.agentId }, { taskId: e.taskId })
    }
  }))
  // 成员状态(idle/busy + 队列上下文)
  stream.unsubs.push(manager.subscribeAgentStatus(channelId, e => publish(manager, stream, 'agent.status', e, { agentId: e.agentId })))
  // harness 事件流(message/artifact/status.message/error)
  stream.unsubs.push(manager.subscribeChannelEvents(channelId, (event, source) => mapAgentEvent(manager, stream, event, source)))
  // 消息投递(route 汇流点)
  stream.unsubs.push(manager.subscribeChannelMessages(channelId, (message) => {
    const agentId = (message.metadata?.['x-aw-from-agent'] as string | undefined)
      ?? (message.metadata?.['x-aw-target-agent'] as string | undefined)
    publish(manager, stream, 'a2a.message', message, { agentId, taskId: message.taskId ?? undefined })
  }))
  // 记忆写入
  stream.unsubs.push(manager.subscribeMemoryEvents(channelId, e => publish(manager, stream, 'memory.saved', e, { agentId: e.agentId })))
  // 团队成员增/改/删(lead 自主管理或用户 REST;agent.member)
  stream.unsubs.push(manager.subscribeMemberEvents(channelId, (e) => {
    publish(manager, stream, 'agent.member', e, { agentId: e.agentId })
  }))
  streams.set(channelId, stream)
  return stream
}

/** 订阅:用户鉴权(channel 可见性)+ 快照对齐或 lastSeq 重放 */
function subscribePeer(manager: AgentChannelManager, peer: WsPeer, channelId: string, lastSeq?: number, userToken?: string): void {
  // 用户隔离:管理 API 同口径(sub 帧 token 字段或连接 ?token=;本人 channel + 遗留公共只读观察)
  if (!userToken) {
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId, payload: { code: 'USER_UNAUTHORIZED', message: 'WS 订阅需要用户 token(sub 帧携带 token 字段或连接 ?token= 查询参数)' } })
    return
  }
  const user = manager.getUserByToken(userToken)
  if (!user) {
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId, payload: { code: 'USER_UNAUTHORIZED', message: '用户 token 无效' } })
    return
  }
  try {
    manager.getChannelForUser(channelId, user.id)
  }
  catch (err) {
    const e = err as { code?: string, message?: string }
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId, payload: { code: e.code ?? 'FORBIDDEN', message: e.message ?? 'channel 不可见' } })
    return
  }
  const stream = ensureStream(manager, channelId)
  if (!stream) {
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId, payload: { code: 'NOT_FOUND', message: `channel 不存在: ${channelId}` } })
    return
  }
  stream.peers.add(peer)
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

/** 退订 peer(仅移除 peer;流与订阅常驻——全时录制,无订阅者事件仍落库) */
function unsubscribePeer(peer: WsPeer, channelId?: string): void {
  const channels = peerChannels.get(peer)
  if (!channels) return
  const targets = channelId ? [channelId] : [...channels]
  for (const id of targets) {
    channels.delete(id)
    streams.get(id)?.peers.delete(peer)
  }
  if (channels.size === 0) peerChannels.delete(peer)
}

/** 插件启动钩子:为全部存量 channel 建立常驻录制流(新 channel 由 ensureStream 即时建) */
export async function ensureAllEventRecorders(manager: AgentChannelManager): Promise<void> {
  for (const ch of await manager.listChannels()) {
    ensureStream(manager, ch.id)
  }
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
    ensureHubBound(manager)
    // 兼容旧路径:?channelId= 连接即订阅(无 lastSeq → 快照对齐)
    const channelId = resolveChannelIdFromUrl(peer)
    if (!channelId) return // 纯上行 sub 模式(多 channel 复用一条连接)
    subscribePeer(manager, peer, channelId, undefined, resolveQueryParam(peer, 'token'))
  },

  message(peer, message) {
    const raw = message.text()
    if (!raw) return
    let parsed: { type?: unknown, channelId?: unknown, lastSeq?: unknown, token?: unknown }
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'BAD_MESSAGE', message: '上行消息必须是 JSON' } })
      return
    }
    if (parsed.type === 'ping') {
      // HMR 自愈入口:manager 更替(nitro reload)后首个 ping 触发订阅重建,pong 正常应答
      try {
        ensureHubBound(getWorkshopManager())
      }
      catch { /* manager 未就绪:pong 照常,下次 ping 再自愈 */ }
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
      ensureHubBound(manager)
      subscribePeer(manager, peer, parsed.channelId, typeof parsed.lastSeq === 'number' ? parsed.lastSeq : undefined, typeof parsed.token === 'string' ? parsed.token : undefined)
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
