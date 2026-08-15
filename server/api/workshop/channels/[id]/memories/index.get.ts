/**
 * GET /api/workshop/channels/:id/memories —— 团队共享记忆列表(channel 级)。
 * - 需要 Bearer token;caller 须为本 channel 成员(跨 channel → 403 SCOPE_VIOLATION)
 * - 任意本 channel 成员可读(全员 recall 同口径);channel 不存在 → 404(manager 校验)
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveCaller } from '../../../caller'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const caller = resolveCaller(event)
  if (caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可读团队记忆')
  return getWorkshopManager().listTeamMemories(channelId)
})
