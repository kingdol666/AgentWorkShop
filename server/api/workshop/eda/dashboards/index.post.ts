/**
 * POST /api/workshop/eda/dashboards —— 创建看板(见 index.get.ts 头注)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { createDashboard } from '@/server/services/workshop/eda/dashboard-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
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
