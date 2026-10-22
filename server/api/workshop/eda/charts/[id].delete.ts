/**
 * DELETE /api/workshop/eda/charts/:id —— 删除(owner/admin;级联清看板关联)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { deleteChart } from '@/server/services/workshop/eda/chart-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  try {
    const ok = deleteChart(user, id)
    if (!ok) throw new AppError(404, 'NOT_FOUND' as never, `图表不存在: ${id}`)
    return { deleted: true }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/仅 owner/.test(msg)) throw new AppError(403, 'SCOPE_VIOLATION' as never, msg)
    throw err
  }
})
