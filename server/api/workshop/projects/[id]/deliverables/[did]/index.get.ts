/**
 * GET /api/workshop/projects/:id/deliverables/:did —— 单交付物(主资源路径)。
 *
 * 对称性修复(2026-11-08 审查):该路径此前只有 patch 与 waive,主资源路径
 * 可改不可读(读侧只能拉全量列表)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().getDeliverable(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'did')!,
    user,
  )
})
