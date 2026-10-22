/**
 * GET    /api/workshop/eda/spc/:id —— 控制图详情 + 判定点序列(渲染面:限值+点+规则命中)。
 * DELETE /api/workshop/eda/spc/:id —— 删除(级联清判定点)。
 * POST   /api/workshop/eda/spc/:id/recompute —— 手动重算控制限(n≥25 才 enabled)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { spcChartById, spcPoints, deleteSpcChart, recomputeSpcLimits } from '@/server/services/workshop/eda/spc'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (event.method === 'DELETE') {
    const ok = deleteSpcChart(user, id)
    if (!ok) throw new AppError(404, 'NOT_FOUND' as never, `控制图不存在或不可见: ${id}`)
    return { deleted: true }
  }
  const chart = spcChartById(user, id)
  if (!chart) throw new AppError(404, 'NOT_FOUND' as never, `控制图不存在或不可见: ${id}`)
  if (event.method === 'POST') {
    const updated = recomputeSpcLimits(id)
    return { chart: updated }
  }
  return { chart, points: spcPoints(id) }
})
