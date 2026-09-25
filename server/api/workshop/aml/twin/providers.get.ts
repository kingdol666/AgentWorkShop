/**
 * GET /api/workshop/aml/twin/providers
 *
 * Provider catalog for Channel designers, Agent discovery and hot-load
 * observability. This endpoint is read-only; it never changes model or DCW state.
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getTwinProviderRegistry } from '@/server/services/workshop/aml/twin/provider-registry'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const query = getQuery(event)
  const registry = getTwinProviderRegistry()
  const providerId = typeof query.providerId === 'string' ? query.providerId : undefined
  const version = typeof query.version === 'string' ? query.version : undefined
  const providers = registry.listProviders({
    ...(providerId ? { providerId } : {}),
    ...(version ? { version } : {}),
    includeDraining: query.includeDraining === 'true',
    includeRetired: query.includeRetired === 'true',
    includeFailed: true,
  })
  const health = providerId ? await registry.checkProviderHealth(providerId, version).catch(err => ({ status: 'failed', detail: err instanceof Error ? err.message : String(err) })) : null
  return {
    apiVersion: 'twin-provider.v1',
    providers,
    scenePacks: registry.listScenePacks(),
    solverAdapters: registry.listSolverAdapters(),
    ...(health ? { health } : {}),
  }
})
