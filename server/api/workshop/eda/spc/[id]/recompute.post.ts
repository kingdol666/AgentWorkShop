/**
 * POST /api/workshop/eda/spc/:id/recompute —— 手动重算控制限(见 [id].get.ts POST 分支)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { spcChartById, recomputeSpcLimits } from '@/server/services/workshop/eda/spc'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!spcChartById(user, id)) throw new AppError(404, 'NOT_FOUND' as never, `控制图不存在或不可见: ${id}`)
  return { chart: recomputeSpcLimits(id) }
})
