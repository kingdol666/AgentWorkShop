/**
 * DELETE /api/workshop/schedules/:id —— 删除定时任务(v16;运行历史随行级联)。
 */
import { defineApiHandler } from '../../../utils/response'
import { getRouterParam } from 'h3'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  getWorkshopManager().removeSchedule(id, user)
  return { deleted: id }
})
