/**
 * GET /api/workshop/channels/:id —— channel 详情(含 workspace 与成员列表)。
 * - channel 不存在 → 404 NOT_FOUND
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../../caller'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager, ensureLeadSchedulerLoop } from '../../../../plugins/workshop'
export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  manager.getChannelForUser(channelId, user.id) // 读取守卫(404/越权)
  const channel = await manager.getChannel(channelId)
  // 兜底:详情请求时确保 lead 的调度循环已装配(如启动恢复遗漏)
  ensureLeadSchedulerLoop(manager, channelId)
  return channel
})
