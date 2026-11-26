/**
 * POST /api/workshop/channels/:id/sessions/:sid/runtime/:agentId/rebuild
 * 请求在下一回合重建该运行实例（刷新装配期注入的产线/上下文提示与工具面）。
 * 只入队；当前回合不打断。未装配的实例返回 queued=false（下一条消息自然按最新 DB 装配）。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const agentId = getRouterParam(event, 'agentId')!
  return getWorkshopManager().requestSessionRuntimeRebuild(channelId, sessionId, agentId, user)
})
