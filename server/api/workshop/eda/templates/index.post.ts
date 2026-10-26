/**
 * POST /api/workshop/eda/templates —— 保存图表配置模板。
 * body: { name, description?, chart_type, config }
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { createTemplate } from '@/server/services/workshop/eda/template-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const template = createTemplate(user, {
    name: String(body.name ?? ''),
    description: body.description === undefined ? undefined : String(body.description),
    chartType: String(body.chart_type ?? ''),
    config: (body.config ?? {}) as Record<string, unknown>,
  })
  return { template }
})
