/**
 * POST /api/workshop/channels/:id/agents/:agentId/stop —— HITL 独立中断指定成员运行时。
 * worker/lead 均可;lead 停止同时停调度循环,下次任务提交自动重激活。
 * 成员行保留(interrupt 语义),运行时强制 stop + detach;变更经 AEP agent.member 广播。
 * - channel/成员不存在 → 404;非属主 → 403
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  const members = await manager.listChannelAgents(channelId)
  if (!members.some(a => a.id === agentId)) {
    throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)
  }
  return manager.stopAgentRuntime(channelId, agentId, 'user')
})
