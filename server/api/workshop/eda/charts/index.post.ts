/**
 * POST /api/workshop/eda/charts —— 保存图表(按用户持久化,plan1 需求 #9)。
 * body: { title, viz_type, datasource?, encoding?, transform?, options?, line_id?, visibility? }
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { createChart } from '@/server/services/workshop/eda/chart-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  if (!String(body.title ?? '').trim()) throw new AppError(400, 'VALIDATION_ERROR' as never, 'title 必填。')
  try {
    const chart = createChart(user, {
      title: String(body.title).trim().slice(0, 200),
      vizType: String(body.viz_type ?? 'trend'),
      datasource: (body.datasource ?? {}) as Record<string, unknown>,
      encoding: (body.encoding ?? {}) as Record<string, unknown>,
      transform: (body.transform ?? {}) as Record<string, unknown>,
      options: (body.options ?? {}) as Record<string, unknown>,
      lineId: body.line_id ? String(body.line_id) : null,
      visibility: String(body.visibility ?? 'private'),
    })
    return { chart }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /仅 owner/.test(msg) ? 403 : /不存在/.test(msg) ? 404 : 400
    throw new AppError(status, 'VALIDATION_ERROR' as never, msg)
  }
})
