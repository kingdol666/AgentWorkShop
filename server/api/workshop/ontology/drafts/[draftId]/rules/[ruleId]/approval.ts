/**
 * POST /api/workshop/ontology/drafts/:draftId/rules/:ruleId/approval — 申请控制级批准(第二人裁决)
 * 返回 { approvalId };后续 POST /api/workshop/ontology/approvals/:approvalId/decide。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, requestRuleApproval } from '@/server/services/workshop/ontology/ontology.service'

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  const ruleId = getRouterParam(event, 'ruleId') ?? ''
  if (!draftId || !ruleId) throw new AppError(422, 'RULE_ID_REQUIRED', 'draftId/ruleId 缺失')
  const user = requireRole(event, ['admin', 'editor'])
  return requestRuleApproval(draftId, ruleId, actorFromUser(user))
})
