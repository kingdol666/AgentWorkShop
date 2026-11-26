/**
 * PATCH /api/workshop/channels/:id/sessions/:sid/binding
 * 修改会话绑定范围（product/line/recipes）—— 运行期可改，下一回合热切换。
 * body: { expectedRevision, reset?, productId?, recipeIds? }
 */
import { getRouterParam, readValidatedBody } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { getWorkshopManager } from '@/server/plugins/workshop'

const schema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reset: z.boolean().optional(),
  productId: z.string().trim().min(1).max(200).optional(),
  recipeIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
}).strict()

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const body = await readValidatedBody(event, zValidator(schema))
  const binding = await getWorkshopManager().updateSessionBinding(channelId, sessionId, body, user)
  return { binding, effectiveAt: 'next_turn' }
})
