/**
 * POST /api/workshop/ontology/drafts/:draftId/rules/:ruleId/transition — 规则状态迁移
 * body: { to, approvalId?, comment? }
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { ONTOLOGY_STATES, type OntologyState } from '@/server/services/workshop/ontology/contracts'
import { actorFromUser, transitionRule } from '@/server/services/workshop/ontology/ontology.service'

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  const ruleId = getRouterParam(event, 'ruleId') ?? ''
  if (!draftId || !ruleId) throw new AppError(422, 'RULE_ID_REQUIRED', 'draftId/ruleId 缺失')
  const user = requireRole(event, ['admin', 'editor'])
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const to = String(body.to ?? '') as OntologyState
  if (!(ONTOLOGY_STATES as readonly string[]).includes(to)) {
    throw new AppError(422, 'RULE_STATE_INVALID', `to 必须是 ${ONTOLOGY_STATES.join('|')}(收到 ${to})`)
  }
  const detail = transitionRule(draftId, ruleId, actorFromUser(user), {
    to,
    approvalId: typeof body.approvalId === 'string' ? body.approvalId : undefined,
    comment: typeof body.comment === 'string' ? body.comment : undefined,
  })
  return {
    draft: { id: detail.draft.id, rev: detail.draft.rev },
    rule: detail.doc.rules.find(r => r.id === ruleId || r.key === ruleId),
    validation: detail.validation,
  }
})
