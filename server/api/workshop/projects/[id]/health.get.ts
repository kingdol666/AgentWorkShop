/**
 * GET /api/workshop/projects/:id/health —— HealthBoard（plan §7.1/S7）。
 * 组件健康 + effects 计数 + 计划版本 + 账本概览。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { resolveUser } from '../../caller'
import { getProjectService } from '../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().kernelStatus(getRouterParam(event, 'id')!, user)
})
