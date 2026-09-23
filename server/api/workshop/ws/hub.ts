/**
 * hub↔manager 绑定自愈 / 查询参数 / 场景 peer / 控制帧与流帧发送
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentChannelManager, ManagerDeps } from '../../../services/workshop/runtime/manager'
import type { AgentRuntime, TaskEngine } from '../../../services/workshop/runtime/agent-runtime'
import type { ChannelStream, WsPeer } from './shared'
import { PEER_SEND_BUDGET_BYTES, hub, streams } from './shared'
import { ensureStream } from './streams'
import { flushDbBuffer } from './db-buffer'
import { getWorkshopManager } from '../../../plugins/workshop'
import { registerScenePeer, setPeerVisibleLines } from '../../../services/workshop/scene-events'
import { visibleLineIds } from '../../../services/workshop/permissions'

export function ensureHubBound(manager: AgentChannelManager): void {
  if (hub.boundManager === manager) return
  hub.boundManager = manager
  for (const stream of [...streams.values()]) {
    const channelId = stream.channelId
    // manager 更替前刷净落库缓冲:流即将重建,缓冲帧必须先落库保序
    try {
      flushDbBuffer(manager, stream)
    }
    catch { /* 尽力刷盘 */ }
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
export interface ManagerInternals {
  deps: ManagerDeps
  agentIndex: Map<string, AgentRuntime>
  /** channel → 事件总线(生命期与管理器同源;空闲卸载后 channel 重激活会重建) */
  buses: Map<string, object>
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
