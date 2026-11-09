/**
 * GET /api/workshop/projects/:id/work-items/:wid —— 单工作项(主资源路径)。
 *
 * 对称性修复(2026-11-08 审查):该路径此前只有 patch/cancel/dispatch/retry,
 * 主资源路径**可改不可读**(读侧只能走 observability 旁路或拉全量列表)。
 * 本端点只读、返回工作项行本身;执行链详情仍走 observability 旁路(职责不同)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().getWorkItem(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'wid')!,
    user,
  )
})
