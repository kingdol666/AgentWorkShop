/**
 * DELETE /api/workshop/channels/:id/agents/:agentId —— 从 channel 移除成员(仅删关系,不删 Agent 定义)。
 * - channel/成员不存在 → 404 NOT_FOUND
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const manager = getWorkshopManager()
  const channel = (await manager.listChannels()).find(c => c.id === channelId)
  if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
  const members = await manager.listChannelAgents(channelId)
  if (!members.some(a => a.id === agentId)) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)
  await manager.removeAgentFromChannel(channelId, agentId)
  return { ok: true }
})
