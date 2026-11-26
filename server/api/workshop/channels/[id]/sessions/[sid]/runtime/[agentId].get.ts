/** GET /api/workshop/channels/:id/sessions/:sid/runtime/:agentId —— 单个 runtime 元数据。 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const agentId = getRouterParam(event, 'agentId')!
  const manager = getWorkshopManager()
  const runtime = manager.getSessionRuntime(channelId, sessionId, agentId, user)
  return { runtime }
})
