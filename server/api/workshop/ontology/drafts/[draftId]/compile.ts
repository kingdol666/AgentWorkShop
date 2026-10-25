/**
 * POST /api/workshop/ontology/drafts/:draftId/compile — 编译预览(四类产物 + Rule Trace;不落库)
 *
 * body.currentBounds 可选(现行权威界):提供时强制「只收紧」。
 * body.approvedOnly 可选:true 时模拟发布路径(未获批硬约束将被拒)。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, compileDraft } from '@/server/services/workshop/ontology/ontology.service'
import type { CompileOptions } from '@/server/services/workshop/ontology/contracts'

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  if (!draftId) throw new AppError(422, 'DRAFT_ID_REQUIRED', 'draftId 缺失')
  const user = requireRole(event, ['admin', 'editor'])
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const currentBounds = body.currentBounds as CompileOptions['currentBounds'] | undefined
  const preview = compileDraft(draftId, actorFromUser(user), {
    approvedOnly: body.approvedOnly === true,
    currentBounds,
  })
  return {
    status: preview.result.status,
    contentHash: preview.contentHash,
    packHash: preview.packHash,
    rulePackHash: preview.result.rulePackHash,
    counts: {
      compiled: preview.result.compiledCount,
      guard: preview.result.guardCount,
      explained: preview.result.explainedCount,
      rejected: preview.result.rejectedCount,
    },
    artifacts: preview.result.artifacts,
    traces: preview.result.traces,
    issues: preview.result.issues,
  }
})
