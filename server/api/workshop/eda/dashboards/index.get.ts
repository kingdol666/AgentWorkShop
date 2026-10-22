/**
 * GET  /api/workshop/eda/dashboards?mine=1 —— 看板清单。
 * POST /api/workshop/eda/dashboards —— 创建 {title, filters?, layout?, line_id?, visibility?}。
 */
import { getQuery, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { listDashboards, createDashboard } from '@/server/services/workshop/eda/dashboard-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  if (event.method === 'GET') {
    const q = getQuery(event)
    return { dashboards: listDashboards(user, { mine: String(q.mine ?? '') === '1' }) }
  }
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  try {
    return { dashboard: createDashboard(user, {
      title: String(body.title ?? '').trim(),
      filters: (body.filters ?? {}) as Record<string, unknown>,
      layout: body.layout,
      lineId: body.line_id ? String(body.line_id) : null,
      visibility: String(body.visibility ?? 'private'),
    }) }
  }
  catch (err) {
    throw new AppError(400, 'VALIDATION_ERROR' as never, err instanceof Error ? err.message : String(err))
  }
})
