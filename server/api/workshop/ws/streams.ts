/**
 * 流生命周期:陈旧重订 / 回收 / 确保存在
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import type { ChannelStream } from './shared'
import { EVENTS_RETENTION_DAYS, hub, hubGlobal, peerChannels, streams } from './shared'
import { bindHitlSubscription, bindStreamSubscriptions } from './subscriptions'
import { flushDbBuffer } from './db-buffer'
import { internalsOf } from './hub'

export function rebindStreamIfStale(manager: AgentChannelManager, stream: ChannelStream): void {
  const currentBus = internalsOf(manager).buses.get(stream.channelId) ?? null
  if (stream.busRef === currentBus) return
  for (const unsub of stream.unsubs) {
    try {
      unsub()
    }
    catch { /* 尽力清理 */ }
  }
  stream.unsubs = []
  stream.busRef = currentBus
  if (currentBus) bindStreamSubscriptions(manager, stream)
}

/** 常驻自愈 sweep:channel 总线生命期短于 stream(空闲卸载 → 重激活重建总线)时,
 * 周期性把 stream 重订到当前总线,保证事件流在 channel 重激活后自动恢复(≤3s 收敛)。
 * 定时器挂 globalThis:防 nitro HMR 重建模块产生重复 sweep。 */
export const BUS_REBIND_MS = 3000
export const REBIND_TIMER_KEY = '__workshopWsRebindTimer'
/** rebind 定时器(模块私有:拆分前就没有导出) */
let rebindTimer = (hubGlobal as Record<string, unknown>)[REBIND_TIMER_KEY] as NodeJS.Timeout | undefined
if (!rebindTimer) {
  rebindTimer = setInterval(() => {
    if (hub.boundManager) {
      for (const stream of [...streams.values()]) {
        try {
          // channel 已删除 → 回收事件流:死 stream 的 ring(≤4MB)会永久驻留,
          // 且本 sweep 每 3s 永远遍历它。回收 = 刷净落库缓冲 + 退订 + 释放。
          const exists = internalsOf(hub.boundManager).deps.repos.channels.findById(stream.channelId)
          if (!exists) {
            closeStream(hub.boundManager, stream.channelId)
            continue
          }
          rebindStreamIfStale(hub.boundManager, stream)
          // 顺带兜底刷盘:落库缓冲异常滞留(如定时器丢失)时由 sweep 收口
          if (stream.dbBuffer.length > 0) flushDbBuffer(hub.boundManager, stream)
        }
        catch { /* 单个 stream 自愈失败不影响其他 */ }
      }
    }
  }, BUS_REBIND_MS)
  rebindTimer.unref?.()
  ;(hubGlobal as Record<string, unknown>)[REBIND_TIMER_KEY] = rebindTimer
}

/** channel_events 保留期任务(30min 周期分批清理;globalThis 防 HMR 重复) */
export const RETENTION_TIMER_KEY = '__workshopWsRetentionTimer'
if (!(hubGlobal as Record<string, unknown>)[RETENTION_TIMER_KEY]) {
  const t = setInterval(() => {
    if (!hub.boundManager) return
    try {
      const days = EVENTS_RETENTION_DAYS()
      const removed = internalsOf(hub.boundManager).deps.repos.channelEvents.sweepRetention(days)
      if (removed > 0) console.log(`[workshop-ws] 事件保留期清理 ${removed} 行(>${days}d)`)
    }
    catch (err) {
      console.error('[workshop-ws] 事件保留期清理失败:', err)
    }
  }, 30 * 60_000)
  t.unref?.()
  ;(hubGlobal as Record<string, unknown>)[RETENTION_TIMER_KEY] = t
}

/**
 * 回收 channel 事件流(channel 已删除时由 rebind sweep 调用):刷净落库缓冲 →
 * 退订总线 → 释放 ring/peers。不做 manager→api 反向依赖的回调接线,
 * 由 sweep 自愈发现(≤3s 收敛)。
 */
export function closeStream(manager: AgentChannelManager, channelId: string): void {
  const stream = streams.get(channelId)
  if (!stream) return
  try {
    flushDbBuffer(manager, stream)
  }
  catch { /* 尽力刷盘 */ }
  for (const unsub of stream.unsubs) {
    try {
      unsub()
    }
    catch { /* 尽力清理 */ }
  }
  if (stream.hitlUnsub) {
    try {
      stream.hitlUnsub()
    }
    catch { /* 尽力清理 */ }
    stream.hitlUnsub = null
  }
  streams.delete(channelId)
  for (const peer of stream.peers) {
    peerChannels.get(peer)?.delete(channelId)
  }
  stream.peers.clear()
  stream.ring.length = 0
  console.log(`[workshop-ws] channel ${channelId.slice(0, 8)} 已删除,事件流已回收`)
}

/**
 * 建立(或复用)channel 事件流:订阅 ChannelBus,事件直推 + 全时落库。
 * 流生命周期 = 进程生命周期(与订阅者无关;无 peer 时事件仍持久化,DB 为事实源)。
 */
export function ensureStream(manager: AgentChannelManager, channelId: string): ChannelStream | null {
  const channel = internalsOf(manager).deps.repos.channels.findById(channelId)
  if (!channel) return null
  const existing = streams.get(channelId)
  if (existing) {
    // 订阅入口处即时自愈(不等 sweep):bus 已重建 → 立即重订到当前总线
    rebindStreamIfStale(manager, existing)
    // manager 更替(HMR)时 hitl 订阅闭包持旧 manager → 幂等重挂(bind 内先退订)
    bindHitlSubscription(manager, existing)
    return existing
  }
  // seq 从持久层续接(重启后继续递增;INSERT OR IGNORE 幂等兜底)
  const initSeq = internalsOf(manager).deps.repos.channelEvents.maxSeq(channelId)
  const stream: ChannelStream = {
    channelId,
    seq: initSeq,
    ring: [],
    ringBytes: 0,
    peers: new Set(),
    unsubs: [],
    hitlUnsub: null,
    busRef: internalsOf(manager).buses.get(channelId) ?? null,
    dbBuffer: [],
    dbFlushTimer: null,
  }
  bindStreamSubscriptions(manager, stream)
  bindHitlSubscription(manager, stream)
  // bind 过程可能懒创建 bus:同步真实 busRef,否则 stale 检查会误判重绑
  stream.busRef = internalsOf(manager).buses.get(channelId) ?? null
  streams.set(channelId, stream)
  return stream
}

/** 订阅:用户鉴权(channel 可见性)+ 快照对齐或 lastSeq 重放 */
