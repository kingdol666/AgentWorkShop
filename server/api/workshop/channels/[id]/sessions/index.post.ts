/**
 * POST /api/workshop/channels/:id/sessions —— 一键创建会话（克隆基础成员 + 复制绑定面）。
 * body: { title? }；返回 { sessionId, members }。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

const schema = z.object({ title: z.string().max(120).optional() })

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(schema)).catch(() => ({ title: undefined }))
  return getWorkshopManager().createChannelSession({
    channelId,
    actor: { id: user.id, role: user.role },
    title: body.title,
  })
})
