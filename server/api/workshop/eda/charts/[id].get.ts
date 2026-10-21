/**
 * GET /api/workshop/eda/charts/:id —— 单图(B4:private 仅 owner/admin;line 需产线可读)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { chartById } from '@/server/services/workshop/eda/chart-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const chart = chartById(user, id)
  if (!chart) throw new AppError(404, 'NOT_FOUND' as never, `图表不存在或不可见: ${id}`)
  return { chart }
})
