/**
 * GET /api/workshop/schedules/:id/runs —— 定时任务运行历史(v16;新→旧,默认 50 条)。
 */
import { defineApiHandler } from '../../../../utils/response'
import { getQuery, getRouterParam } from 'h3'
import { resolveUser } from '../../caller'
import { getWorkshopManager } from '../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const q = getQuery(event)
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
  return getWorkshopManager().listScheduleRunsForUser(id, user, limit)
})
