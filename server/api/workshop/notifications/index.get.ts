/**
 * GET /api/workshop/notifications?limit=&cursor=&unreadOnly= —— 本人用户通知(事实源)。
 *
 * 隔离:只返回 recipientUserId = 当前登录用户的通知(禁止客户端指定他人)。
 * 游标补发:cursor = `${createdAt}|${id}`(或 ?cursorId= 单给 id 由服务端解析);
 *          给出 cursor 时返回该游标**之后**的通知(升序),用于断线/刷新补齐。
 * 返回 unreadCount 供全局徽标使用。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const manager = getWorkshopManager()
  const limitRaw = Number.parseInt(typeof q.limit === 'string' ? q.limit : '', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
  const unreadOnly = q.unreadOnly === '1' || q.unreadOnly === 'true'

  let cursor: { createdAt: string, id: string } | null = null
  if (typeof q.cursor === 'string' && q.cursor.includes('|')) {
    const [createdAt, id] = q.cursor.split('|')
    if (createdAt && id) cursor = { createdAt, id }
  }
  else if (typeof q.cursorId === 'string' && q.cursorId) {
    cursor = manager.groupChat.notifications.cursorOf(q.cursorId)
  }

  const rows = cursor
    ? manager.listNotificationsAfter(user.id, cursor, limit)
    : manager.listNotifications(user.id, { limit, unreadOnly })

  return {
    notifications: rows.map(r => ({
      id: r.id,
      recipientUserId: r.recipientUserId,
      channelId: r.channelId,
      chatMessageId: r.chatMessageId,
      hitlKind: r.hitlKind,
      hitlId: r.hitlId,
      eventId: r.eventId,
      type: r.type,
      title: r.title,
      body: r.body,
      payload: JSON.parse(r.payloadJson || '{}') as Record<string, unknown>,
      createdAt: r.createdAt,
      readAt: r.readAt,
    })),
    unreadCount: manager.groupChat.notifications.unreadCount(user.id),
    cursor,
    // 升序补发时给出下一个游标(便于客户端续拉)
    nextCursor: (() => {
      if (!cursor || rows.length === 0) return null
      const last = rows[rows.length - 1]!
      return { createdAt: last.createdAt, id: last.id }
    })(),
  }
})
