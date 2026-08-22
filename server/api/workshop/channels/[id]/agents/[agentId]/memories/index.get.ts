/**
 * GET /api/workshop/channels/:id/agents/:agentId/memories —— Agent 记忆只读观察面。
 * - 需要 Bearer token 且 caller 为本 channel 成员;否则 401(与 mailbox.get.ts 同语义)
 * - 返回该实例最近记忆(listByAgent);实例不存在 → 404(由 manager.listMemories 抛出)
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../../../utils/errors'
import { defineApiHandler } from '../../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../../plugins/workshop'
import { resolveAgentOrUser } from '../../../../../caller'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  // 双域鉴权:Agent 成员 token(作业面)或用户 token(控制台 owner)
  const who = resolveAgentOrUser(event)
  const manager = getWorkshopManager()
  let byOwner = false
  if (who.kind === 'agent') {
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可观察 Agent 记忆')
  }
  else {
    const ch = manager.getChannelForUser(channelId, who.user.id)
    manager.requireOwned(ch.ownerUserId, who.user.id, 'channel')
    byOwner = true
  }
  void byOwner
  return manager.listMemories(channelId, agentId)
})
