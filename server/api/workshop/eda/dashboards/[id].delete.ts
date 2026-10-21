/**
 * DELETE /api/workshop/eda/dashboards/:id(见 [id].get.ts;方法分文件)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { deleteDashboard } from '@/server/services/workshop/eda/dashboard-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  try {
    const ok = deleteDashboard(user, id)
    if (!ok) throw new AppError(404, 'NOT_FOUND' as never, `看板不存在: ${id}`)
    return { deleted: true }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new AppError(/仅 owner/.test(msg) ? 403 : 404, 'VALIDATION_ERROR' as never, msg)
  }
})
