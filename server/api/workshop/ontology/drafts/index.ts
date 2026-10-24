/**
 * GET /api/workshop/ontology/drafts?ontologyId= — 我的(admin=全部)草稿列表
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { actorFromUser, listDrafts } from '@/server/services/workshop/ontology/ontology.service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const query = getQuery(event)
  const ontologyId = typeof query.ontologyId === 'string' && query.ontologyId ? query.ontologyId : undefined
  const drafts = listDrafts(actorFromUser(user), ontologyId ? { ontologyId } : {})
  return {
    drafts: drafts.map(d => ({
      id: d.id, ontologyId: d.ontologyId, baseVersion: d.baseVersion, rev: d.rev,
      ownerUserId: d.ownerUserId, createdAt: d.createdAt, updatedAt: d.updatedAt,
    })),
  }
})
