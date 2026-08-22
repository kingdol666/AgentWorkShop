/**
 * DELETE /api/workshop/channels/:id/memories/:memoryId —— 删团队共享记忆(仅 lead)。
 * - 需要 Bearer token;caller 须为本 channel 成员(跨 channel → 403 SCOPE_VIOLATION)
 * - 仅 lead 可删(manager 校验);memoryId 不属于本 channel 团队行 → 404
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveAgentOrUser } from '../../../caller'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const memoryId = getRouterParam(event, 'memoryId')!
  // 双域鉴权:Agent 成员 token(作业面)或用户 token(控制台 owner)
  const who = resolveAgentOrUser(event)
  const manager = getWorkshopManager()
  let byOwner = false
  if (who.kind === 'agent') {
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可删团队记忆')
  }
  else {
    const ch = manager.getChannelForUser(channelId, who.user.id)
    manager.requireOwned(ch.ownerUserId, who.user.id, 'channel')
    byOwner = true
  }
  await manager.deleteTeamMemory(channelId, who.kind === 'agent' && !byOwner ? who.caller.id : '__team__', memoryId, { byOwner })
  return { deleted: true, memoryId }
})
