/**
 * GET /api/workshop/channels/:id/sessions/:sid/brief —— 平台 session 上下文 brief。
 * 只读；brief 由 SessionContextService 从任务/消息/项目事实确定性装配。
 * ?format=block —— 返回注入 prompt 前的最终装配文本（分层块；UI 预览/验收共用）。
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
  const manager = getWorkshopManager()
  manager.getChannelForUser(channelId, user.id)
  const session = manager.getChannelSession(sessionId)
  if (!session || session.channelId !== channelId) {
    throw new AppError(404, 'NOT_FOUND', `会话不存在: ${sessionId}`)
  }
  const format = String(getQuery(event).format ?? '')
  if (format === 'block') {
    return { block: manager.getSessionContextBlock(sessionId) }
  }
  return manager.getSessionBrief(sessionId)
})
