/**
 * GET    /api/workshop/ontology/drafts/:draftId — 草稿详情(含校验与绑定报告)
 * PATCH  /api/workshop/ontology/drafts/:draftId — 保存整份文档(乐观锁 rev)
 * DELETE /api/workshop/ontology/drafts/:draftId — 删除草稿
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole, resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import {
  actorFromUser, deleteDraft, getDraftDetail, updateDraft,
} from '@/server/services/workshop/ontology/ontology.service'
import { recordConfigAction } from '@/server/services/workshop/optimization/access'

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  if (!draftId) throw new AppError(422, 'DRAFT_ID_REQUIRED', 'draftId 缺失')
  const method = event.method?.toUpperCase() ?? 'GET'

  if (method === 'GET') {
    const detail = getDraftDetail(draftId, actorFromUser(resolveUser(event)))
    return {
      draft: { id: detail.draft.id, ontologyId: detail.draft.ontologyId, baseVersion: detail.draft.baseVersion, rev: detail.draft.rev, ownerUserId: detail.draft.ownerUserId },
      doc: detail.doc,
      validation: detail.validation,
      bindings: detail.bindings,
    }
  }

  const user = requireRole(event, ['admin', 'editor'])
  if (method === 'DELETE') {
    deleteDraft(draftId, actorFromUser(user))
    recordConfigAction(user, 'ontology.draft.delete', { kind: 'ontology_draft', id: draftId }, `删除本体草稿 ${draftId}`)
    return { deleted: true }
  }

  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const expectedRev = Number(body.expectedRev)
  if (!Number.isInteger(expectedRev)) throw new AppError(422, 'DRAFT_REV_REQUIRED', 'expectedRev 必填(乐观锁;取 GET 返回的 draft.rev)')
  const detail = updateDraft(draftId, actorFromUser(user), {
    doc: body.doc,
    expectedRev,
    strictBindings: body.strictBindings !== false,
  })
  recordConfigAction(user, 'ontology.draft.update', { kind: 'ontology_draft', id: draftId },
    `保存本体草稿 ${draftId}(rev=${detail.draft.rev})`, { rev: detail.draft.rev, ontologyId: detail.draft.ontologyId })
  return {
    draft: { id: detail.draft.id, rev: detail.draft.rev, ontologyId: detail.draft.ontologyId },
    validation: detail.validation,
    bindings: detail.bindings,
  }
})
