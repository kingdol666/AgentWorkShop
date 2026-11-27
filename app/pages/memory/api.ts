/**
 * 记忆中心 / 知识图谱 typed API。
 * 统一走 apiFetch（解包 {code,message,data}），避免页面直读信封。
 */
import { apiFetch } from '~/composables/workshop/apiClient'

export type GraphEntityType
  = | 'episode' | 'concept' | 'parameter' | 'metric' | 'device' | 'node'
    | 'recipe' | 'product' | 'line' | 'task' | 'event' | 'document' | 'person'

export type GraphRelation
  = | 'mentions' | 'relates_to' | 'causes' | 'affects' | 'supports' | 'contradicts'
    | 'supersedes' | 'derived_from' | 'part_of' | 'used_for' | 'precedes'
    | 'has_parameter' | 'uses_recipe' | 'observed_in' | 'co_occurs'

export interface GraphNode {
  id: string
  channelId: string
  ownerUserId: string
  scopeKind: string
  scopeKey: string
  productId: string
  entityType: GraphEntityType
  canonicalName: string
  canonicalKey: string
  aliases: string[]
  summary: string
  confidence: number
  salience: number
  status: string
  mergedInto: string | null
  locked: boolean
  authorKind: string
  authorId: string
  revision: number
  sourceKind: string
  memoryId: string | null
  validFrom: string | null
  validTo: string | null
  recordedAt: string | null
  supersededBy: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  degree?: number
  communityId?: string | null
}

export interface GraphLink {
  id: string
  channelId: string
  ownerUserId: string
  scopeKind: string
  scopeKey: string
  productId: string
  srcId: string
  dstId: string
  relation: GraphRelation
  relationLabel: string
  fact: string
  factKey: string
  polarity: 'positive' | 'negative' | 'neutral'
  confidence: number
  weight: number
  status: string
  locked: boolean
  authorKind: string
  authorId: string
  revision: number
  sourceKind: string
  evidenceCount?: number
  validFrom: string | null
  validTo: string | null
  recordedAt: string | null
  expiredAt: string | null
  supersededBy: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface GraphCommunity {
  id: string
  channelId: string
  scopeKind: string
  scopeKey: string
  productId: string
  level: number
  parentId: string | null
  title: string
  summary: string
  summaryHash: string
  memberCount: number
  edgeCount: number
  algorithm: string
  revision: number
  status: string
  createdAt: string
  updatedAt: string
  members?: Array<{ id: string, name: string, type: string }>
}

export interface GraphSubgraph {
  nodes: GraphNode[]
  edges: GraphLink[]
  communities: GraphCommunity[]
  stats: {
    entityTotal: number
    edgeTotal: number
    communityTotal: number
    truncated: boolean
    asOf: string | null
    revision: number
  }
}

export interface GraphAlias {
  id: string
  alias: string
  aliasKey: string
  source: string
  confidence: number
  createdAt: string
}

export interface GraphMention {
  id: string
  entityId: string
  memoryId: string
  confidence: number
  extractor: string
  createdAt: string
  memoryTitle?: string
  memoryKind?: string
  memoryStatus?: string
  memoryUpdatedAt?: string
}

export interface GraphEvidence {
  id: string
  edgeId: string
  memoryId: string
  claimId: string
  interventionId: string
  quote: string
  confidence: number
  createdAt: string
}

export interface GraphRun {
  id: string
  channelId: string
  scopeKind: string
  scopeKey: string
  mode: 'incremental' | 'full' | 'manual'
  status: 'running' | 'ok' | 'skipped_noop' | 'partial' | 'failed'
  scanned: number
  eligible: number
  entitiesNew: number
  entitiesLinked: number
  edgesNew: number
  edgesInvalidated: number
  communities: number
  llmCalls: number
  inputChars: number
  fallbackReason: string
  error: string
  startedAt: string
  finishedAt: string | null
}

export interface GraphEntityDetail {
  entity: GraphNode
  aliases: GraphAlias[]
  mentions: GraphMention[]
  edges: Array<GraphLink & { other?: string, direction?: 'in' | 'out' }>
  community: GraphCommunity | null
  revisions: Array<Record<string, unknown>>
}

export interface GraphEdgeDetail {
  edge: GraphLink
  source: GraphNode | null
  target: GraphNode | null
  evidence: GraphEvidence[]
  claims: Array<Record<string, unknown>>
  revisions: Array<Record<string, unknown>>
}

export interface GraphSettings {
  enabled: boolean
  intervalMs: number
  initialDelayMs: number
  sweepLimit: number
  useLlm: boolean
  lastRunAt: string | null
  lastFullRebuildAt: string | null
  entityCount: number
  edgeCount: number
}

export interface MergeCandidate {
  id: string
  channelId: string
  sourceEntityId: string
  targetEntityId: string
  score: number
  reason: string
  status: string
  sourceName?: string
  targetName?: string
  createdAt: string
  updatedAt: string
}

function withJson(init?: RequestInit): RequestInit {
  if (!init?.body) return init ?? {}
  return {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  }
}

async function graphApi<T>(channelId: string, path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>({
    base: '',
    path: `/api/workshop/channels/${encodeURIComponent(channelId)}/memory-graph${path}`,
    init: withJson(init),
  })
}

export interface SubgraphQuery {
  q?: string
  entity?: string
  depth?: number
  asOf?: string
  types?: string[]
  relations?: string[]
  statuses?: string[]
  scopeKinds?: string[]
  scopeKeys?: string[]
  scope?: 'channel' | 'session' | 'shared' | 'line' | 'product'
  sessionId?: string
  productId?: string
  limit?: number
}

function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    search.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

export const memoryGraphApi = {
  getSubgraph: (channelId: string, query: SubgraphQuery = {}) =>
    graphApi<GraphSubgraph>(channelId, qs(query as Record<string, unknown>)),
  listEntities: (channelId: string, query: Record<string, unknown> = {}) =>
    graphApi<{ items: GraphNode[], total: number }>(channelId, `/entities${qs(query)}`),
  createEntity: (channelId: string, body: Record<string, unknown>) =>
    graphApi<GraphNode>(channelId, '/entities', { method: 'POST', body: JSON.stringify(body) }),
  getEntity: (channelId: string, entityId: string) =>
    graphApi<GraphEntityDetail>(channelId, `/entities/${encodeURIComponent(entityId)}`),
  updateEntity: (channelId: string, entityId: string, body: Record<string, unknown>) =>
    graphApi<GraphNode>(channelId, `/entities/${encodeURIComponent(entityId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteEntity: (channelId: string, entityId: string, reason = '') =>
    graphApi<{ ok: boolean }>(channelId, `/entities/${encodeURIComponent(entityId)}${qs({ reason })}`, { method: 'DELETE' }),
  restoreEntity: (channelId: string, entityId: string) =>
    graphApi<GraphNode>(channelId, `/entities/${encodeURIComponent(entityId)}/restore`, { method: 'POST' }),
  mergeEntity: (channelId: string, entityId: string, targetId: string) =>
    graphApi<unknown>(channelId, `/entities/${encodeURIComponent(entityId)}/merge`, { method: 'POST', body: JSON.stringify({ targetId }) }),
  unmergeEntity: (channelId: string, entityId: string) =>
    graphApi<GraphNode>(channelId, `/entities/${encodeURIComponent(entityId)}/unmerge`, { method: 'POST' }),

  listEdges: (channelId: string, query: Record<string, unknown> = {}) =>
    graphApi<{ items: GraphLink[], total: number }>(channelId, `/edges${qs(query)}`),
  createEdge: (channelId: string, body: Record<string, unknown>) =>
    graphApi<GraphLink>(channelId, '/edges', { method: 'POST', body: JSON.stringify(body) }),
  getEdge: (channelId: string, edgeId: string) =>
    graphApi<GraphEdgeDetail>(channelId, `/edges/${encodeURIComponent(edgeId)}`),
  updateEdge: (channelId: string, edgeId: string, body: Record<string, unknown>) =>
    graphApi<GraphLink>(channelId, `/edges/${encodeURIComponent(edgeId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteEdge: (channelId: string, edgeId: string, reason = '') =>
    graphApi<{ ok: boolean }>(channelId, `/edges/${encodeURIComponent(edgeId)}${qs({ reason })}`, { method: 'DELETE' }),
  rejectEdge: (channelId: string, edgeId: string, body: Record<string, unknown> = {}) =>
    graphApi<GraphLink>(channelId, `/edges/${encodeURIComponent(edgeId)}/reject`, { method: 'POST', body: JSON.stringify(body) }),
  restoreEdge: (channelId: string, edgeId: string) =>
    graphApi<GraphLink>(channelId, `/edges/${encodeURIComponent(edgeId)}/restore`, { method: 'POST' }),

  mergeCandidates: (channelId: string, status = 'proposed') =>
    graphApi<{ items: MergeCandidate[] }>(channelId, `/merge-candidates${qs({ status })}`),
  acceptCandidate: (channelId: string, candidateId: string) =>
    graphApi<unknown>(channelId, `/merge-candidates/${encodeURIComponent(candidateId)}/accept`, { method: 'POST' }),
  rejectCandidate: (channelId: string, candidateId: string) =>
    graphApi<{ ok: boolean }>(channelId, `/merge-candidates/${encodeURIComponent(candidateId)}/reject`, { method: 'POST' }),

  communities: (channelId: string) =>
    graphApi<{ items: GraphCommunity[] }>(channelId, '/communities'),
  community: (channelId: string, communityId: string) =>
    graphApi<{ community: GraphCommunity, members: GraphNode[], edges: GraphLink[] }>(channelId, `/communities/${encodeURIComponent(communityId)}`),

  runs: (channelId: string, limit = 30) =>
    graphApi<{ items: GraphRun[] }>(channelId, `/runs${qs({ limit })}`),
  startRun: (channelId: string, mode: 'incremental' | 'full', extra: Record<string, unknown> = {}) =>
    graphApi<{ runId: string }>(channelId, '/runs', { method: 'POST', body: JSON.stringify({ mode, ...extra }) }),
  getRun: (channelId: string, runId: string) =>
    graphApi<GraphRun>(channelId, `/runs/${encodeURIComponent(runId)}`),

  settings: (channelId: string) => graphApi<GraphSettings>(channelId, '/settings'),
  updateSettings: (channelId: string, enabled: boolean) =>
    graphApi<GraphSettings>(channelId, '/settings', { method: 'PATCH', body: JSON.stringify({ enabled }) }),
}
