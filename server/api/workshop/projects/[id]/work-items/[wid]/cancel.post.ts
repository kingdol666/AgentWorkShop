/**
 * POST /api/workshop/projects/:id/work-items/:wid/cancel —— owner 取消工作项（完成门豁免入口）。
 * body: { reason }
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ reason?: string }>(event) ?? {}
  return getProjectService().cancelWorkItem(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'wid')!,
    user,
    String(body.reason ?? ''),
  )
})
