/**
 * POST /api/workshop/projects/:id/proposals/:decisionId/apply
 * owner 应用 project leader 的提案（dispatch.proposed → 工作项；可选立即派发）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getProjectService } from '../../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().applyProposal(
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'decisionId')!,
    user,
  )
})
