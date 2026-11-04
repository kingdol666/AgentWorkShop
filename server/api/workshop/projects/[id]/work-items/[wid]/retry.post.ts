/**
 * POST /api/workshop/projects/:id/work-items/:wid/retry —— 重派工作项（owner-only）。
 * 对 FAILED/CANCELED/已完成工作项发起新 attempt（dispatch 语义的显式 retry 入口）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().dispatchWorkItem(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'wid')!,
    user,
  )
})
