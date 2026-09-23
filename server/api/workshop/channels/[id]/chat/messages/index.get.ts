/**
 * GET /api/workshop/channels/:id/chat/messages?before=&limit= —— 群聊历史(投影)。
 *
 * 分页:before = 消息 id 游标(取该消息**之前**的 limit 条,新→旧);缺省 = 最新。
 * 鉴权:requireChannelMember(成员可读完整群聊历史)。
 * 返回投影:不含 token / config / 工作目录 / 内部 mailbox 载荷(§13.1)。
 */
import { getQuery, getRouterParam } from 'h3'
import { resolveUser } from '../../../../caller'
import { defineApiHandler } from '../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const q = getQuery(event)
  const before = typeof q.before === 'string' && q.before ? q.before : undefined
  const limitRaw = Number.parseInt(typeof q.limit === 'string' ? q.limit : '', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
  const manager = getWorkshopManager()
  const messages = manager.listChatMessages(channelId, user, { before, limit })
  return {
    channelId,
    messages,
    // 升序副本便于前端直接追加(服务端返回保持新→旧,与 events 端点同风格)
    nextCursor: messages.length > 0 ? messages[messages.length - 1]!.id : null,
    permissions: manager.channelPermissionsOf(channelId, user),
  }
})
