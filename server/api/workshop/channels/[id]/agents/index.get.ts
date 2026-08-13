/**
 * GET /api/workshop/channels/:id/agents —— channel 内 Agent 列表(设计文档 §6.2)。
 * channel 不存在 → 404 NOT_FOUND。
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = (await manager.listChannels()).find(c => c.id === channelId)
  if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
  return manager.listAgents(channelId)
})
