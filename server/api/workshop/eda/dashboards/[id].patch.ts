/**
 * PATCH /api/workshop/eda/dashboards/:id —— 标题/筛选/布局/可见性(见 [id].get.ts;方法分文件)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { updateDashboard } from '@/server/services/workshop/eda/dashboard-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  try {
    const dashboard = updateDashboard(user, id, {
      title: body.title == null ? undefined : String(body.title).trim().slice(0, 200),
      filters: body.filters as Record<string, unknown> | undefined,
      layout: body.layout,
      visibility: body.visibility == null ? undefined : String(body.visibility),
      lineId: body.line_id === undefined ? undefined : (body.line_id ? String(body.line_id) : null),
    })
    return { dashboard }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new AppError(/仅 owner/.test(msg) ? 403 : 400, 'VALIDATION_ERROR' as never, msg)
  }
})
