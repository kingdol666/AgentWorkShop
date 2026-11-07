/**
 * POST /api/workshop/channels/:id/sessions/:sid/messages —— 向手工会话发送消息。
 * 语义：投给该 session 的 clone 成员（优先基础 lead 的 clone），requireReply=true，
 * 消息与回执都带 session_id；不是项目任务派发。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

const schema = z.object({
  text: z.string().trim().min(1).max(8000),
  clientMessageId: z.string().max(200).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const body = await readValidatedBody(event, zValidator(schema))
  return getWorkshopManager().sendSessionMessage({
    channelId,
    sessionId,
    actor: { id: user.id, role: user.role },
    text: body.text,
  })
})
