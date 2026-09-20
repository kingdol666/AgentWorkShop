/**
 * POST /api/workshop/schedules/:id/run —— 手动立即执行定时任务(v16)。
 * 与 timer 触发同一条 fire 主路径:Channel 忙 → 409 CHANNEL_BUSY(等全部任务收口);
 * 上一轮在途 → 409;提交失败 → 502(run 已留痕)。
 */
import { defineApiHandler } from '../../../../utils/response'
import { getRouterParam } from 'h3'
import { resolveUser } from '../../caller'
import { getWorkshopManager } from '../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  return getWorkshopManager().runScheduleNow(id, user)
})
