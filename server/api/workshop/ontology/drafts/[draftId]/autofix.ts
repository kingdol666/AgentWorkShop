/**
 * POST /api/workshop/ontology/drafts/:draftId/autofix — 自动修复草稿
 *
 * 只做安全、确定、幂等的规范化(补描述/量纲跟随单位/作用域回填/悬空引用与重复 id
 * 的确定性修复/证据不足的控制级状态回退);证据本身不会被伪造,平台侧绑定漂移仍在
 * bindings.failures 中如实返回。写路径与 updateDraft 同源(乐观锁 rev + 审计)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole, resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, autoFixDraft } from '@/server/services/workshop/ontology/ontology.service'
import { recordConfigAction } from '@/server/services/workshop/optimization/access'

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  if (!draftId) throw new AppError(422, 'DRAFT_ID_REQUIRED', 'draftId 缺失')
  const user = requireRole(event, ['admin', 'editor'])
  const detail = autoFixDraft(draftId, actorFromUser(user))
  recordConfigAction(user, 'ontology.draft.autofix', { kind: 'ontology_draft', id: draftId },
    `自动修复本体草稿 ${draftId}(${detail.fixes.length} 项)`, { rev: detail.draft.rev, fixes: detail.fixes.length })
  return {
    draft: { id: detail.draft.id, ontologyId: detail.draft.ontologyId, rev: detail.draft.rev, baseVersion: detail.draft.baseVersion },
    doc: detail.doc,
    validation: detail.validation,
    bindings: detail.bindings,
    fixes: detail.fixes,
    fixedCount: detail.fixes.length,
    actor: resolveUser(event).id,
  }
})
