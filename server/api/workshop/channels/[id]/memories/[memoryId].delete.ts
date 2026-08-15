/**
 * DELETE /api/workshop/channels/:id/memories/:memoryId —— 删团队共享记忆(仅 lead)。
 * - 需要 Bearer token;caller 须为本 channel 成员(跨 channel → 403 SCOPE_VIOLATION)
 * - 仅 lead 可删(manager 校验);memoryId 不属于本 channel 团队行 → 404
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveCaller } from '../../../caller'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const memoryId = getRouterParam(event, 'memoryId')!
  const caller = resolveCaller(event)
  if (caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可删团队记忆')
  await getWorkshopManager().deleteTeamMemory(channelId, caller.id, memoryId)
  return { deleted: true, memoryId }
})
