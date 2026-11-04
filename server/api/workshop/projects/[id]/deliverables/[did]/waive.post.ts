/**
 * POST /api/workshop/projects/:id/deliverables/:did/waive —— owner 豁免交付物（完成门豁免入口）。
 * body: { reason }
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ reason?: string }>(event) ?? {}
  return getProjectService().waiveDeliverable(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'did')!,
    user,
    String(body.reason ?? ''),
  )
})
