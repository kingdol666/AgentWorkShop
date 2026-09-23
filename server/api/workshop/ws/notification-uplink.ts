/**
 * 用户级通知上行(subNotifications / unsub / read)
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AepNotification } from '../../../../shared/workshop-protocol'
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import type { WsPeer } from './shared'
import { AEP_VERSION } from './shared'
import { projectNotification } from '../../../services/workshop/runtime/chat-projection'
import { sendControl } from './hub'
import { unbindUserPeer, userIdOfPeer } from '../../../services/workshop/runtime/user-notification-hub'

/**
 * 用户级通知上行处理(subNotifications / unsubNotifications / notification.read)。
 *
 * 隔离前提:peer 的 userId **只**来自连接期 token 解析(subscribePeer 或 open 时绑定);
 * 上行帧里即使带 userId 也一律忽略 —— 客户端不能订阅或标记他人的通知。
 */
export function handleNotificationUplink(
  manager: AgentChannelManager,
  peer: WsPeer,
  parsed: { type?: unknown, cursor?: unknown, id?: unknown, channelId?: unknown, all?: unknown },
): void {
  const userId = userIdOfPeer(peer)
  if (!userId) {
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'USER_UNAUTHORIZED', message: '通知订阅需要已认证的用户 token(连接 ?token= 或 sub 帧 token)' } })
    return
  }
  const notifications = manager.groupChat.notifications
  if (parsed.type === 'unsubNotifications') {
    sendControl(peer, { v: AEP_VERSION, type: 'notification.unsubscribed', seq: 0, at: new Date().toISOString(), channelId: '', payload: { ok: true } })
    return
  }
  if (parsed.type === 'notification.read') {
    const result = manager.markNotificationsRead(userId, {
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      channelId: typeof parsed.channelId === 'string' ? parsed.channelId : undefined,
      all: parsed.all === true,
    })
    sendControl(peer, { v: AEP_VERSION, type: 'notification.read.ack', seq: 0, at: new Date().toISOString(), channelId: '', payload: { ...result, unreadCount: notifications.unreadCount(userId) } })
    return
  }
  // subNotifications:按游标补发(通知表是事实源;重连后不丢不重)
  const rawCursor = parsed.cursor as { createdAt?: unknown, id?: unknown } | null | undefined
  let cursor: { createdAt: string, id: string } | null = null
  if (rawCursor && typeof rawCursor.createdAt === 'string' && typeof rawCursor.id === 'string') {
    cursor = { createdAt: rawCursor.createdAt, id: rawCursor.id }
  }
  const rows = manager.listNotificationsAfter(userId, cursor, 200)
  for (const r of rows) {
    // 与 REST 快照 / 定向推送共用同一投影:三处此前各写一份字段映射,
    // 任一漏改都会让同一条通知在不同通道里形状不同(前端按 eventId 去重,形状漂移会渲染成两种样子)。
    const payload: AepNotification = projectNotification(r)
    // 补发经 peer 直发(带 eventId 幂等键;客户端按 eventId 去重)
    try {
      peer.send(JSON.stringify({ v: AEP_VERSION, type: 'notification.created', seq: 0, at: new Date().toISOString(), channelId: r.channelId ?? '', payload }))
    }
    catch {
      unbindUserPeer(peer)
      return
    }
  }
  sendControl(peer, {
    v: AEP_VERSION,
    type: 'notification.snapshot',
    seq: 0,
    at: new Date().toISOString(),
    channelId: '',
    payload: {
      replayed: rows.length,
      unreadCount: notifications.unreadCount(userId),
      nextCursor: rows.length > 0
        ? { createdAt: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.id }
        : cursor,
    },
  })
}
