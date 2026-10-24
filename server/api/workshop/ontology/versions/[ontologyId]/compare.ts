/**
 * GET /api/workshop/ontology/versions/:ontologyId/compare?from=&to= — 版本差异(实体/关系/规则/绑定四段)
 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { compareVersions } from '@/server/services/workshop/ontology/ontology.service'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const ontologyId = getRouterParam(event, 'ontologyId') ?? ''
  if (!ontologyId) throw new AppError(422, 'ONTOLOGY_ID_REQUIRED', 'ontologyId 缺失')
  const query = getQuery(event)
  const from = Number(query.from)
  const to = Number(query.to)
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new AppError(422, 'VERSION_REQUIRED', 'from/to 必须是整数版本号')
  }
  return compareVersions(ontologyId, from, to)
})
