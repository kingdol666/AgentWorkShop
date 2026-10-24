/**
 * GET /api/workshop/ontology/export/:ontologyId?version= — 导出发布快照(JSON bundle)
 *
 * 只读导出:供外部评审/互操作与 P1 RDF 导出的输入。
 */
import { getQuery, getRouterParam, setResponseHeader } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { getOntologyRepo } from '@/server/services/workshop/ontology/repo'
import { getVersion } from '@/server/services/workshop/ontology/ontology.service'

function parseCompiled(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}') as unknown
  }
  catch {
    return null
  }
}

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const ontologyId = getRouterParam(event, 'ontologyId') ?? ''
  if (!ontologyId) throw new AppError(422, 'ONTOLOGY_ID_REQUIRED', 'ontologyId 缺失')
  const query = getQuery(event)
  const requested = query.version !== undefined ? Number(query.version) : undefined
  const repo = getOntologyRepo()
  const latest = Number.isInteger(requested) ? requested! : (repo.latestVersion(ontologyId, 'published')?.version ?? 0)
  if (!latest) throw new AppError(404, 'VERSION_NOT_FOUND', `本体 ${ontologyId} 还没有已发布版本`)
  const version = getVersion(ontologyId, latest)
  const bundle = {
    schemaVersion: 1,
    ontologyId,
    version: version.version,
    status: version.status,
    lineId: version.lineId,
    contentHash: version.contentHash,
    parentVersion: version.parentVersion,
    createdAt: version.createdAt,
    entities: repo.listEntities(version.id, version.version),
    relations: repo.listRelations(version.id, version.version),
    rules: repo.listRules(version.id, version.version),
    bindings: repo.listBindings(version.id, version.version),
    traces: repo.listTraces(version.id, version.version),
    compiled: parseCompiled(version.compiledJson),
  }
  setResponseHeader(event, 'content-disposition', `attachment; filename="${ontologyId}-v${version.version}.json"`)
  return bundle
})
