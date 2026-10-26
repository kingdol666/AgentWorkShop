/**
 * PATCH /api/workshop/eda/templates/:id —— 更新模板(owner/admin)。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { updateTemplate } from '@/server/services/workshop/eda/template-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(getRouterParam(event, 'id') ?? '')
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const template = updateTemplate(user, id, {
    name: body.name === undefined ? undefined : String(body.name),
    description: body.description === undefined ? undefined : String(body.description),
    chartType: body.chart_type === undefined ? undefined : String(body.chart_type),
    config: (body.config ?? undefined) as Record<string, unknown> | undefined,
  })
  return { template }
})
