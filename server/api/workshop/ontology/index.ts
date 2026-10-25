/**
 * GET  /api/workshop/ontology — 本体清单(按产线过滤)+ 我的草稿概览
 * POST /api/workshop/ontology — 创建草稿(单活跃 409)
 */
import { getQuery, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole, resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, createDraft, listDrafts, listOntologies } from '@/server/services/workshop/ontology/ontology.service'
import { recordConfigAction } from '@/server/services/workshop/optimization/access'

export default defineApiHandler(async (event) => {
  const method = event.method?.toUpperCase() ?? 'GET'
  if (method === 'GET') {
    const user = resolveUser(event)
    const query = getQuery(event)
    const lineId = typeof query.lineId === 'string' && query.lineId ? query.lineId : undefined
    const ontologies = listOntologies(lineId)
    const drafts = listDrafts(actorFromUser(user), typeof query.ontologyId === 'string' ? { ontologyId: query.ontologyId } : {})
    return {
      ontologies,
      drafts: drafts.map(d => ({ id: d.id, ontologyId: d.ontologyId, baseVersion: d.baseVersion, rev: d.rev, ownerUserId: d.ownerUserId, updatedAt: d.updatedAt })),
    }
  }
  const user = requireRole(event, ['admin', 'editor'])
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const ontologyId = String(body.ontologyId ?? '').trim()
  if (!ontologyId) throw new AppError(422, 'ONTOLOGY_ID_REQUIRED', 'ontologyId 必填(形如 ont-pva-line01)')
  const draft = createDraft(actorFromUser(user), {
    ontologyId,
    lineId: typeof body.lineId === 'string' ? body.lineId : '',
    name: typeof body.name === 'string' ? body.name : undefined,
    cloneFromVersion: body.cloneFromVersion === true,
  })
  recordConfigAction(user, 'ontology.draft.create', { kind: 'ontology_draft', id: draft.id },
    `创建本体草稿 ${draft.id}(${draft.ontologyId})`, { ontologyId: draft.ontologyId })
  return { draft: { id: draft.id, ontologyId: draft.ontologyId, rev: draft.rev, baseVersion: draft.baseVersion } }
})
