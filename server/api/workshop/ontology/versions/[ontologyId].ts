/**
 * GET  /api/workshop/ontology/versions/:ontologyId — 版本史
 * POST /api/workshop/ontology/versions/:ontologyId — 退役某版本(body {version})
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireAdmin, resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, listVersions, retireVersion } from '@/server/services/workshop/ontology/ontology.service'

function parseCompiled(raw: string): { counts?: unknown, packHash?: string } {
  try {
    return JSON.parse(raw || '{}') as { counts?: unknown, packHash?: string }
  }
  catch {
    return {}
  }
}

export default defineApiHandler(async (event) => {
  const ontologyId = getRouterParam(event, 'ontologyId') ?? ''
  if (!ontologyId) throw new AppError(422, 'ONTOLOGY_ID_REQUIRED', 'ontologyId 缺失')
  const method = event.method?.toUpperCase() ?? 'GET'
  if (method === 'GET') {
    resolveUser(event)
    return {
      ontologyId,
      versions: listVersions(ontologyId).map(v => ({
        version: v.version, status: v.status, name: v.name, lineId: v.lineId,
        parentVersion: v.parentVersion, contentHash: v.contentHash,
        publishedBy: v.publishedBy, createdAt: v.createdAt,
        compiled: parseCompiled(v.compiledJson),
      })),
    }
  }
  const user = requireAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const version = Number(body.version)
  if (!Number.isInteger(version)) throw new AppError(422, 'VERSION_REQUIRED', 'version 必填(整数)')
  retireVersion(ontologyId, version, actorFromUser(user))
  return { ontologyId, version, status: 'retired' }
})
