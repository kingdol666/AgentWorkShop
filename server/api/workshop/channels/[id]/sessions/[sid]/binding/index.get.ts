/**
 * GET /api/workshop/channels/:id/sessions/:sid/binding
 * 会话绑定范围（product/line/recipes）有效视图：覆盖行优先，否则创建快照。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  return getWorkshopManager().getSessionBinding(channelId, sessionId, user)
})
