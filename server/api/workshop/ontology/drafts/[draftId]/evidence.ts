/**
 * POST /api/workshop/ontology/drafts/:draftId/evidence — 登记证据(追加账本 + 写回草稿)
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, appendEvidence } from '@/server/services/workshop/ontology/ontology.service'

const TARGET_KINDS = new Set(['entity', 'relation', 'rule', 'binding'])
const LEVELS = new Set(['candidate_influence', 'observed_correlation', 'validated_control'])

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  if (!draftId) throw new AppError(422, 'DRAFT_ID_REQUIRED', 'draftId 缺失')
  const user = requireRole(event, ['admin', 'editor'])
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const targetKind = String(body.targetKind ?? '')
  const level = String(body.level ?? '')
  if (!TARGET_KINDS.has(targetKind)) throw new AppError(422, 'EVIDENCE_TARGET_INVALID', `targetKind 必须是 entity|relation|rule|binding(收到 ${targetKind})`)
  if (!LEVELS.has(level)) throw new AppError(422, 'EVIDENCE_LEVEL_INVALID', `level 必须是 candidate_influence|observed_correlation|validated_control(收到 ${level})`)
  const source = body.source
  if (!source || typeof source !== 'object') throw new AppError(422, 'EVIDENCE_SOURCE_REQUIRED', 'source 必填(如 {type:"dataset_stats",datasetId,sha256})')
  const detail = appendEvidence(draftId, actorFromUser(user), {
    targetKind: targetKind as 'entity' | 'relation' | 'rule' | 'binding',
    targetKey: String(body.targetKey ?? ''),
    level: level as 'candidate_influence' | 'observed_correlation' | 'validated_control',
    source: source as Parameters<typeof appendEvidence>[2]['source'],
    sourceRef: typeof body.sourceRef === 'string' ? body.sourceRef : undefined,
    note: typeof body.note === 'string' ? body.note : undefined,
  })
  return { draft: { id: detail.draft.id, rev: detail.draft.rev }, validation: detail.validation }
})
