/**
 * POST /api/workshop/notifications/read —— 标记本人通知已读 + 多标签页同步。
 *
 * body: { id? } 单条 | { channelId? } 频道范围 | { all: true } 全部
 * 只作用于**当前登录用户**;不接受 body 里的 userId(防越权标记他人已读)。
 * 返回 count 并经用户 hub 推送 notification.read(其它标签页同步收敛)。
 */
import { readBody } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { getWorkshopManager } from '@/server/plugins/workshop'

const readSchema = z.object({
  id: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  all: z.boolean().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody(event).then(raw => zValidator(readSchema)(raw ?? {}))
  const manager = getWorkshopManager()
  const result = manager.markNotificationsRead(user.id, {
    id: body.id,
    channelId: body.channelId,
    all: body.all ?? (!body.id && !body.channelId),
  })
  return { ok: true, ...result, unreadCount: manager.groupChat.notifications.unreadCount(user.id) }
})
