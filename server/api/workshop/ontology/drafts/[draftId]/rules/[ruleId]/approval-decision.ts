/**
 * POST /api/workshop/ontology/drafts/:draftId/rules/:ruleId/approval-decision — 裁决批准申请
 * body: { approvalId, approved, comment? }
 *
 * 自审禁止:起草人不能裁决自己的申请(单管理员实例由服务层打 solo_operator 豁免)。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, decideRuleApproval } from '@/server/services/workshop/ontology/ontology.service'
import { recordConfigAction } from '@/server/services/workshop/optimization/access'

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  if (!draftId) throw new AppError(422, 'DRAFT_ID_REQUIRED', 'draftId 缺失')
  const user = requireRole(event, ['admin', 'editor'])
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const approvalId = String(body.approvalId ?? '')
  if (!approvalId) throw new AppError(422, 'APPROVAL_ID_REQUIRED', 'approvalId 必填')
  const result = decideRuleApproval(draftId, approvalId, actorFromUser(user), {
    approved: body.approved === true,
    comment: typeof body.comment === 'string' ? body.comment : undefined,
  })
  recordConfigAction(user, 'ontology.rule.decide', { kind: 'ontology_approval', id: approvalId },
    `裁决本体规则批准 ${approvalId}:${result.decision}`)
  return result
})
