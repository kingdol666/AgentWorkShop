/**
 * POST /api/workshop/ontology/drafts/:draftId/validate — 全量校验(结构+活体绑定)
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, validateDraft } from '@/server/services/workshop/ontology/ontology.service'

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  if (!draftId) throw new AppError(422, 'DRAFT_ID_REQUIRED', 'draftId 缺失')
  const user = requireRole(event, ['admin', 'editor'])
  const report = validateDraft(draftId, actorFromUser(user))
  return report
})
