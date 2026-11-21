/**
 * hub↔manager 绑定自愈 / 查询参数 / 场景 peer / 控制帧与流帧发送
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentChannelManager, ManagerDeps } from '../../../services/workshop/runtime/manager'
import type { AgentRuntime, TaskEngine } from '../../../services/workshop/runtime/agent-runtime'
import type { ChannelStream, WsPeer } from './shared'
import { PEER_SEND_BUDGET_BYTES, hub, streams } from './shared'
import { rebindStreamIfStale, closeStream } from './streams'
import { bindHitlSubscription } from './subscriptions'
import { flushDbBuffer } from './db-buffer'
import { getWorkshopManager } from '../../../plugins/workshop'
import { registerScenePeer, setPeerIdentity, setPeerVisibleLines } from '../../../services/workshop/scene-events'
import { visibleLineIds } from '../../../services/workshop/permissions'

/**
 * manager 更替前把未落库帧与流隔离:旧帧属于创建该流的**原**管理器数据库。
 * 事务未提交时 flushDbBuffer 会延迟重试,因此必须把旧帧搬到 detached 快照流
 * (携带 owner):否则重试路径会读 hub.boundManager(新 manager)把旧帧写进新库,
 * 或与之后新 manager 的事件混在同一缓冲里。
 */
export function drainDbBuffer(owner: AgentChannelManager | null | undefined, stream: ChannelStream): void {
  if (stream.dbFlushTimer) {
    clearTimeout(stream.dbFlushTimer)
    stream.dbFlushTimer = null
  }
  if (stream.dbBuffer.length === 0) return
  if (!owner) {
    // 无归属可追溯(异常路径):丢弃无主帧,不把它写进未知数据库
    stream.dbBuffer = []
    return
  }
  const detached: ChannelStream = {
    ...stream,
    peers: new Set(),
    unsubs: [],
    hitlUnsub: null,
    dbBuffer: stream.dbBuffer,
    dbFlushTimer: null,
    manager: owner,
  }
  stream.dbBuffer = []
  flushDbBuffer(owner, detached)
}

export function ensureHubBound(manager: AgentChannelManager): void {
  if (hub.boundManager === manager) return
  const previous = hub.boundManager
  hub.boundManager = manager
  const internal = internalsOf(manager)
  for (const stream of [...streams.values()]) {
    try {
      const channelId = stream.channelId
      const owner = stream.manager ?? previous
      // 先把旧缓冲搬进 detached 流并按 owner 落库(事务中则延后由 detached 自己的 owner 重试)
      drainDbBuffer(owner, stream)
      // 新库不认识该频道(换库/跨库 HMR):立即回收流,不建总线也不重绑 HITL,
      // 否则会为已不存在的频道维持常驻流直到 3s sweep。
      if (!internal.deps.repos.channels.findById(channelId)) {
        closeStream(owner ?? manager, channelId)
        continue
      }
      // 流本身保留(seq/ring/peers 延续):录制流即使无 peer 也不得断流,
      // 否则 manager 更替窗口内发布的事件永久丢失。只把订阅面重绑到新 manager 的总线。
      rebindStreamIfStale(manager, stream)
      // 替换库可能已有更高 seq:接续持久层,避免 INSERT OR IGNORE 静默丢弃新帧
      try {
        stream.seq = Math.max(stream.seq, internal.deps.repos.channelEvents.maxSeq(channelId))
      }
      catch { /* 读失败保持内存 seq */ }
      // manager 更替(HMR)时 hitl 订阅闭包持旧 manager → 幂等重挂(bind 内先退订)
      bindHitlSubscription(manager, stream)
    }
    catch (err) {
      // 单个流的 DB/订阅异常不得中断其余流的重绑(旧语义是整体循环裸跑)
      console.warn('[workshop-ws] hub 换绑单流失败(继续):', err instanceof Error ? err.message : err)
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
export interface ManagerInternals {
  deps: ManagerDeps
  agentIndex: Map<string, AgentRuntime>
  /** channel → 事件总线(生命期 = 频道;仅频道删除与 manager 停机时释放) */
  buses: Map<string, object>
  /** 按需建立频道级总线(不激活运行时;订阅/录制面的入口) */
  ensureChannelBus(channelId: string): object | undefined
  getTaskEngine(): TaskEngine
}

export function internalsOf(manager: AgentChannelManager): ManagerInternals {
  return manager as unknown as ManagerInternals
}

export function resolveQueryParam(peer: WsPeer, name: string): string | undefined {
  const req = (peer as unknown as { request?: Request }).request
  if (!req) return undefined
  return new URL(req.url).searchParams.get(name) ?? undefined
}

export function resolveChannelIdFromUrl(peer: WsPeer): string | undefined {
  return resolveQueryParam(peer, 'channelId') ?? resolveQueryParam(peer, 'channel_id')
}

/** 场景事件注册(鉴权后):按用户产线可见集挂 per-peer 过滤,未经鉴权的 peer 不注册 */
export function attachScenePeer(peer: WsPeer, user: { id: string, role: string }): void {
  setPeerVisibleLines(peer, visibleLineIds(user))
  setPeerIdentity(peer, user)
  registerScenePeer(peer)
}

/** 安全发送控制帧(error/pong/snapshot;死连接静默丢弃) */
export function sendControl(peer: WsPeer, obj: unknown): void {
  try {
    peer.send(JSON.stringify(obj))
  }
  catch { /* 死连接 */ }
}

/** 每 peer 发送预算窗(慢消费者守卫;正常 peer 零延迟影响) */
export const peerBudget = new WeakMap<WsPeer, { bytes: number, winStart: number }>()

export function sendFrame(stream: ChannelStream, peer: WsPeer, frame: string): void {
  // 预算:同一秒窗内累计发送超限 → 判定慢消费者,断开交由客户端重连快照对齐
  const now = Date.now()
  let b = peerBudget.get(peer)
  if (!b || now - b.winStart >= 1000) {
    b = { bytes: 0, winStart: now }
    peerBudget.set(peer, b)
  }
  b.bytes += frame.length
  if (b.bytes > PEER_SEND_BUDGET_BYTES) {
    try {
      peer.close(1013, 'slow consumer')
    }
    catch { /* already gone */ }
    stream.peers.delete(peer)
    return
  }
  try {
    peer.send(frame)
  }
  catch {
    // 死连接(TCP 硬断未走 close 回调):移除防后续广播中断
    stream.peers.delete(peer)
  }
}

/** 落库缓冲刷盘窗口(ms):全部帧型按此节奏批量事务落库 */
export const DB_FLUSH_MS = 400

/** 刷盘缓冲中的事件(单事务批量 insert;清定时器) */
