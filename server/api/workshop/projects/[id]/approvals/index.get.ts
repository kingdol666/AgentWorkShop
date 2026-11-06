/**
 * GET /api/workshop/projects/:id/approvals?scope=pending|all
 * pending（缺省）= 待审批；all = 含已决策/过期/消费的审批历史（倒序）。
 */
import { getRouterParam, getQuery } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const scope = String(getQuery(event).scope ?? 'pending')
  if (scope === 'all') return getProjectService().listApprovalHistory(id, user)
  return getProjectService().listApprovals(id, user)
})
