/**
 * GET /api/workshop/channels/:id/sessions/:sid/runtime —— 会话 runtime 对象清单。
 * 返回 memberMap 中每个 clone 的 runtimeObjectId、effective 元数据与 revision；
 * 未自定义的 runtime 也返回（revision=0, customized=false）。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const manager = getWorkshopManager()
  const items = manager.listSessionRuntime(channelId, sessionId, user)
  return { sessionId, items }
})
