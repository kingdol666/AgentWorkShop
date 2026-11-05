/**
 * GET /api/workshop/projects/:id/observability —— 执行工作台快照（Router v3 P3）。
 * 单请求返回：项目/权限/摘要/Channel 泳道/交付物门/工作项 stage/route/kernel。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { resolveUser } from '../../caller'
import { getProjectService } from '../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().projectObservability(getRouterParam(event, 'id')!, user)
})
