/**
 * POST /api/workshop/ontology/drafts/:draftId/publish — 冻结为不可变版本(仅 admin)
 *
 * body.currentBounds 可选(提供时编译期强制「只收紧」)。
 * 失败语义:422 VALIDATION_BLOCKED / ONTOLOGY_BINDING_INVALID / ONTOLOGY_NOT_APPROVED;
 *           409 ONTOLOGY_VERSION_CONFLICT(并发发布)。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireAdmin } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, getDraft, publishDraft } from '@/server/services/workshop/ontology/ontology.service'
import type { CompileOptions } from '@/server/services/workshop/ontology/contracts'
import { recordConfigAction } from '@/server/services/workshop/optimization/access'

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  if (!draftId) throw new AppError(422, 'DRAFT_ID_REQUIRED', 'draftId 缺失')
  const user = requireAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const result = publishDraft(draftId, actorFromUser(user), {
    currentBounds: body.currentBounds as CompileOptions['currentBounds'] | undefined,
  })
  const draft = getDraft(draftId)
  recordConfigAction(user, 'ontology.publish', { kind: 'ontology_version', id: `${result.version.id}@${result.version.version}` },
    `发布本体 ${result.version.id}@${result.version.version}(编译 ${result.compile.compiledCount} / 守卫 ${result.compile.guardCount})`,
    { ontologyId: result.version.id, version: result.version.version, packHash: result.packHash, revision: draft.rev })
  return {
    version: {
      id: result.version.id, version: result.version.version, status: result.version.status,
      contentHash: result.version.contentHash, parentVersion: result.version.parentVersion,
      lineId: result.version.lineId, createdAt: result.version.createdAt,
    },
    packHash: result.packHash,
    counts: {
      compiled: result.compile.compiledCount,
      guard: result.compile.guardCount,
      explained: result.compile.explainedCount,
      rejected: result.compile.rejectedCount,
    },
    issues: result.compile.issues,
    draftRev: result.draft.rev,
  }
})
