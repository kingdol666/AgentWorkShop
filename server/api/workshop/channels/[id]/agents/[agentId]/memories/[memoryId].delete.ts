/**
 * DELETE /api/workshop/channels/:id/agents/:agentId/memories/:memoryId —— 删 Agent 私有记忆(本人或 lead)。
 * - 需要 Bearer token;caller 须为本 channel 成员(跨 channel → 403 SCOPE_VIOLATION)
 * - 仅本人或 lead 可删(manager 校验);memoryId 不属于该 agent 的本 channel 行 → 404
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../../../utils/errors'
import { defineApiHandler } from '../../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../../plugins/workshop'
import { resolveCaller } from '../../../../../caller'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const memoryId = getRouterParam(event, 'memoryId')!
  const caller = resolveCaller(event)
  if (caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可删 Agent 记忆')
  getWorkshopManager().deleteAgentMemory(channelId, caller.id, agentId, memoryId)
  return { deleted: true, memoryId }
})
