/**
 * PATCH /api/workshop/channels/:id/sessions/:sid —— 会话改名（仅展示标题）。
 * owner/admin 可调用；sid 不属于该频道 → 404。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

const schema = z.object({
  title: z.string().trim().min(1).max(120),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const body = await readValidatedBody(event, zValidator(schema))
  return getWorkshopManager().renameChannelSession({
    channelId,
    sessionId,
    actor: { id: user.id, role: user.role },
    title: body.title,
  })
})
