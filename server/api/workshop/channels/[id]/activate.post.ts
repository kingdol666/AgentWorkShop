/**
 * POST /api/workshop/channels/:id/activate —— 显式激活 channel(装配 lead + 调度循环)。
 * 懒加载设计下通常在任务提交时自动激活;此端点供前端主动预热/恢复。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager, ensureLeadSchedulerLoop } from '../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  ensureLeadSchedulerLoop(manager, channelId)
  return manager.runtimeStatus()
})
