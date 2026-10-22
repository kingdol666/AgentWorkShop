/**
 * GET /api/workshop/eda/dashboards/:id —— 详情(内嵌 chart 逐个 B4 判定,不可见标 inaccessible)。
 * PATCH/DELETE 走 [id].patch.ts / [id].delete.ts(Nitro 方法分文件)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { dashboardById } from '@/server/services/workshop/eda/dashboard-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const detail = dashboardById(user, id)
  if (!detail) throw new AppError(404, 'NOT_FOUND' as never, `看板不存在或不可见: ${id}`)
  return detail
})
