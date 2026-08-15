/**
 * GET /api/workshop/channels/:id/agents/:agentId/memories —— Agent 记忆只读观察面。
 * - 需要 Bearer token 且 caller 为本 channel 成员;否则 401(与 mailbox.get.ts 同语义)
 * - 返回该实例最近记忆(listByAgent);实例不存在 → 404(由 manager.listMemories 抛出)
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../../../utils/errors'
import { defineApiHandler } from '../../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../../plugins/workshop'
import { resolveCallerOrNull } from '../../../../../caller'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const caller = resolveCallerOrNull(event)
  if (!caller || caller.channelId !== channelId) {
    throw new AppError(401, 'UNAUTHORIZED', '需要有效的 Agent token')
  }
  return getWorkshopManager().listMemories(channelId, agentId)
})
