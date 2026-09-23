/**
 * 落库聚合缓冲刷盘(400ms 批量事务)
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import type { ChannelStream } from './shared'
import { DB_FLUSH_MS, internalsOf } from './hub'
import { hub, log } from './shared'
import { isTransactionOpen } from '../../../services/workshop/db/transaction'

export function flushDbBuffer(manager: AgentChannelManager, stream: ChannelStream): void {
  if (stream.dbFlushTimer) {
    clearTimeout(stream.dbFlushTimer)
    stream.dbFlushTimer = null
  }
  if (stream.dbBuffer.length === 0) return
  // 有未提交事务时不刷盘:同一连接上的 insertMany 会被**并入那个事务**,一旦它回滚,
  // 这些事件就"已在 ring/已推给 peer、却从未落库"(内存与事实源分叉)。
  // 推迟到事务结束后由定时器/sweep 刷出即可 —— 缓冲本就有界且失败会回队。
  if (isTransactionOpen()) {
    if (!stream.dbFlushTimer) {
      stream.dbFlushTimer = setTimeout(() => {
        stream.dbFlushTimer = null
        if (hub.boundManager) flushDbBuffer(hub.boundManager, stream)
      }, DB_FLUSH_MS)
      stream.dbFlushTimer.unref?.()
    }
    return
  }
  const buffered = stream.dbBuffer
  stream.dbBuffer = []
  try {
    internalsOf(manager).deps.repos.channelEvents.insertMany(stream.channelId, buffered.map(e => ({
      seq: e.seq, type: e.type, at: e.at, agentId: e.agentId ?? null, taskId: e.taskId ?? null, payload: e.payload,
    })))
  }
  catch (err) {
    // 频道已被删除(FOREIGN KEY 约束失败 = 永久性错误,常见于 e2e/用户 purge 频道后
    // hub 缓冲仍有其在途事件):缓冲事件无处可落,丢弃并计数 —— 重试语义只服务瞬态
    // 故障(SQLITE_BUSY 等),对永久 FK 失败重试只会每 400ms 刷一条错误直到进程结束
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('FOREIGN KEY constraint failed')) {
      const gDropped = globalThis as typeof globalThis & { __wsDbFlushDropped?: number }
      gDropped.__wsDbFlushDropped = (gDropped.__wsDbFlushDropped ?? 0) + buffered.length
      log.warn(`[workshop-ws] 频道 ${stream.channelId.slice(0, 8)} 已不存在,丢弃 ${buffered.length} 条缓冲事件(落库无主)`)
      return
    }
    // R4:失败计数暴露到 /api/metrics(落库异常静默重试,不能无观测)
    const g = globalThis as typeof globalThis & { __wsDbFlushFails?: number }
    g.__wsDbFlushFails = (g.__wsDbFlushFails ?? 0) + 1
    log.error('[workshop-ws] 事件批量落库失败:', err)
    // 帧 回队 + 稍后重试:retention/backup 持写锁的 SQLITE_BUSY 窗口不应永久丢帧
    // (带上限,防止库长期不可用时缓冲无限膨胀)
    const WS_DB_BUFFER_MAX = 5000
    if (buffered.length <= WS_DB_BUFFER_MAX) {
      stream.dbBuffer = [...buffered, ...stream.dbBuffer]
      if (!stream.dbFlushTimer) {
        stream.dbFlushTimer = setTimeout(() => flushDbBuffer(manager, stream), DB_FLUSH_MS)
        stream.dbFlushTimer.unref?.()
      }
    }
    else {
      log.error(`[workshop-ws] 落库缓冲超出上限(${WS_DB_BUFFER_MAX}),丢弃 ${buffered.length} 帧`)
    }
  }
}

/** 发布事件:seq 递增 → 入环形缓冲(双封顶)→ 批量落库 → 广播全部 peer(信封单次序列化复用) */
