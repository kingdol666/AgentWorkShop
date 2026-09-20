/**
 * GET /api/workshop/schedules/:id —— 定时任务详情(v16)。
 */
import { defineApiHandler } from '../../../utils/response'
import { getRouterParam } from 'h3'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  return getWorkshopManager().getScheduleForUser(id, user)
})
