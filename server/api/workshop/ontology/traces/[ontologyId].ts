/**
 * GET /api/workshop/ontology/traces/:ontologyId?version=&ruleId= — 规则溯源(Rule Trace)
 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { getOntologyRepo } from '@/server/services/workshop/ontology/repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const ontologyId = getRouterParam(event, 'ontologyId') ?? ''
  if (!ontologyId) throw new AppError(422, 'ONTOLOGY_ID_REQUIRED', 'ontologyId 缺失')
  const query = getQuery(event)
  const version = query.version !== undefined ? Number(query.version) : undefined
  const ruleId = typeof query.ruleId === 'string' && query.ruleId ? query.ruleId : undefined
  const traces = getOntologyRepo().listTraces(ontologyId, Number.isInteger(version) ? version : undefined)
  return { ontologyId, traces: ruleId ? traces.filter(t => t.ruleId === ruleId) : traces }
})
