/**
 * UserNotificationHub —— v17 用户级定向通知 hub(主计划 §6)。
 *
 * 为什么不能复用 `broadcastPeerEvent`(scene-events.ts):
 *  - 它对**全部**已登记 peer 广播,没有 recipient 隔离 → 通知跨用户泄漏;
 *  - 它固定 `seq=0 / channelId=''`,没有游标、没有幂等 ID、无法可靠补发。
 *
 * 本模块职责:
 *  - peer 在**认证后**绑定 userId(绑定值来自服务端 token 解析,客户端不可指定他人);
 *  - 只向 recipientUserId 匹配的 peer 推送 `notification.created/read`;
 *  - 通知**先持久化再发布**(调用方保证顺序;本模块只管投递);
 *  - 幂等:同一 (recipient, eventId) 的重复发布由调用方的 user_notifications 唯一键兜底,
 *    本模块额外做一次 peer 级去重(防同一 peer 因重连挂了两份订阅);
 *  - 断线补发:重连时由 ws hub 用 `user_notifications` 表按游标重放(notifications 表是事实源)。
 *
 * 生命周期:`globalThis` 单例(HMR 跨模块实例存活,与 hitl-registry 同风格)。
 */
import { emitPluginEvent } from '../plugins/host.mjs'

const AEP_VERSION = 1

/** 最小 peer 接口(crossws peer 的 duck typing;与 ws.ts 同风格) */
interface WsPeer {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

interface HubState {
  /** userId → 该用户的在线 peer 集合(多标签页/多设备) */
  byUser: Map<string, Set<WsPeer>>
  /** peer → userId(反向索引,解绑用) */
  peerUser: Map<WsPeer, string>
  /** 已推送事件幂等键:peer 最近 N 条 eventId(防重连后同帧双发) */
  seen: Map<WsPeer, string[]>
  /** 统计(可观测性:被隔离掉多少帧) */
  stats: { published: number, delivered: number, isolated: number, skippedDuplicate: number }
}

const g = globalThis as typeof globalThis & { __userNotificationHub?: HubState }

function state(): HubState {
  return g.__userNotificationHub ??= {
    byUser: new Map(),
    peerUser: new Map(),
    seen: new Map(),
    stats: { published: 0, delivered: 0, isolated: 0, skippedDuplicate: 0 },
  }
}

/** 每个 peer 保留的最近 eventId 数(防无限增长) */
const SEEN_CAP = 200

/**
 * 绑定 peer → userId(**认证后**调用;userId 必须来自服务端 token 解析)。
 * 同一 peer 重复绑定不同 userId(理论不应发生)= 先解绑旧的,避免双身份。
 */
export function bindUserPeer(peer: WsPeer, userId: string): void {
  const s = state()
  const prev = s.peerUser.get(peer)
  if (prev && prev !== userId) unbindUserPeer(peer)
  s.peerUser.set(peer, userId)
  let set = s.byUser.get(userId)
  if (!set) {
    set = new Set()
    s.byUser.set(userId, set)
  }
  set.add(peer)
}

/** 解绑(连接关闭/错误时调用) */
export function unbindUserPeer(peer: WsPeer): void {
  const s = state()
  const userId = s.peerUser.get(peer)
  s.peerUser.delete(peer)
  s.seen.delete(peer)
  if (!userId) return
  const set = s.byUser.get(userId)
  if (!set) return
  set.delete(peer)
  if (set.size === 0) s.byUser.delete(userId)
}

/** peer 当前绑定的 userId(未认证返回 null) */
export function userIdOfPeer(peer: WsPeer): string | null {
  return state().peerUser.get(peer) ?? null
}

/**
 * 向指定用户定向推送一条通知帧。
 *
 * **只**投递给 recipientUserId 匹配的 peer;未绑定该 userId 的 peer 永远收不到。
 * 带 eventId 时做 peer 级幂等(同帧重复发布不重复下发)。
 *
 * @returns 实际投递的 peer 数
 */
export function publishToUser(recipientUserId: string, type: string, payload: unknown, opts: { eventId?: string } = {}): number {
  const s = state()
  s.stats.published += 1
  // 插件宿主事件桥(宿主未装载时 no-op)
  emitPluginEvent(type, payload)
  const set = recipientUserId ? s.byUser.get(recipientUserId) : undefined
  if (!set || set.size === 0) {
    s.stats.isolated += 1
    return 0
  }
  const frame = JSON.stringify({
    v: AEP_VERSION,
    type,
    // 用户级事件无 channel seq 语义:显式 seq=0,但**带 eventId 幂等键**,
    // 与 broadcastPeerEvent 的本质区别是 recipient 隔离 + 可补发(表为事实源)。
    seq: 0,
    at: new Date().toISOString(),
    channelId: (payload as { channelId?: string } | null)?.channelId ?? '',
    payload,
  })
  let delivered = 0
  for (const peer of set) {
    if (opts.eventId) {
      const seen = s.seen.get(peer) ?? []
      if (seen.includes(opts.eventId)) {
        s.stats.skippedDuplicate += 1
        continue
      }
      seen.push(opts.eventId)
      if (seen.length > SEEN_CAP) seen.splice(0, seen.length - SEEN_CAP)
      s.seen.set(peer, seen)
    }
    try {
      peer.send(frame)
      delivered += 1
    }
    catch {
      // 死连接(TCP 硬断未走 close 回调):立即解绑,防后续投递中断
      unbindUserPeer(peer)
    }
  }
  s.stats.delivered += delivered
  return delivered
}

/** 该用户当前在线 peer 数(E2E 取证 / 排障用) */
export function peerCountOfUser(userId: string): number {
  return state().byUser.get(userId)?.size ?? 0
}

/** hub 统计快照(可观测性) */
export function notificationHubStats(): HubState['stats'] & { boundUsers: number, boundPeers: number } {
  const s = state()
  return { ...s.stats, boundUsers: s.byUser.size, boundPeers: s.peerUser.size }
}

/** 测试用:重置 hub(仅测试脚本调用) */
export function resetNotificationHub(): void {
  g.__userNotificationHub = {
    byUser: new Map(),
    peerUser: new Map(),
    seen: new Map(),
    stats: { published: 0, delivered: 0, isolated: 0, skippedDuplicate: 0 },
  }
}
