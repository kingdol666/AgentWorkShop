/**
 * GET /api/workshop/channels/:id/queue —— Channel 队列总览(实时状态追踪)。
 * 返回全员 status(idle/busy/stopped + 当前任务)+ 各自任务队列长度(待执行/已完成)。
 * lead 统一调度与最优调配的观察面;channel 不存在 → 404,无 lead → 400 NO_LEAD_AGENT。
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../utils/errors'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'
import type { AgentStatusView } from '../../../../services/workshop/types/task'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = (await manager.listChannels()).find(c => c.id === channelId)
  if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
  if (!channel.leadAgentId) throw new AppError(400, 'NO_LEAD_AGENT', `channel ${channelId} 无 lead`)
  // 外部观察视角:以 lead 成员身份查询(queueOverview 校验调用方为本 channel 成员)
  const overview: AgentStatusView[]
    = await manager.queueOverview(channelId, channel.leadAgentId)
  return overview
})
