/**
 * GET /api/workshop/channels/:id/sessions/:sid/history?limit=80 —— 有界 session 历史。
 */
import { getQuery, getRouterParam } from 'h3'
import { AppError } from '@/server/utils/errors'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const limit = Math.min(200, Math.max(1, Number(getQuery(event).limit ?? 80) || 80))
  const manager = getWorkshopManager()
  manager.getChannelForUser(channelId, user.id)
  const session = manager.getChannelSession(sessionId)
  if (!session || session.channelId !== channelId) {
    throw new AppError(404, 'NOT_FOUND', `会话不存在: ${sessionId}`)
  }
  return manager.getSessionHistory(sessionId, limit)
})
