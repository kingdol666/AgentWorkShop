/**
 * PATCH /api/workshop/eda/charts/:id —— 更新(owner/admin;version 自增)。
 */
import { readBody, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { updateChart } from '@/server/services/workshop/eda/chart-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  try {
    const chart = updateChart(user, id, {
      title: body.title == null ? undefined : String(body.title).trim().slice(0, 200),
      vizType: body.viz_type == null ? undefined : String(body.viz_type),
      datasource: body.datasource as Record<string, unknown> | undefined,
      encoding: body.encoding as Record<string, unknown> | undefined,
      transform: body.transform as Record<string, unknown> | undefined,
      options: body.options as Record<string, unknown> | undefined,
      annotations: body.annotations as unknown[] | undefined,
      lineId: body.line_id === undefined ? undefined : (body.line_id ? String(body.line_id) : null),
      visibility: body.visibility == null ? undefined : String(body.visibility),
    })
    return { chart }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /仅 owner/.test(msg) ? 403 : /不存在/.test(msg) ? 404 : 400
    throw new AppError(status, 'VALIDATION_ERROR' as never, msg)
  }
})
