/**
 * 记忆知识网络（Memory Graph）领域类型与受控词表。
 *
 * 设计口径（见 .omc/plans/2026-11-27-memory-knowledge-graph.md）：
 *  - 图谱是派生索引，记忆/经验/claim 是事实源；
 *  - episode 节点保留每条来源记忆，实体/事实边构成网状；
 *  - 失效不删除（valid_to/superseded_by），默认检索排除失效，asOf 可回看。
 */
import type { MemoryScopeKind } from '../../db/database'

export type GraphEntityType
  = | 'episode'
    | 'concept'
    | 'parameter'
    | 'metric'
    | 'device'
    | 'node'
    | 'recipe'
    | 'product'
    | 'line'
    | 'task'
    | 'event'
    | 'document'
    | 'person'

export const GRAPH_ENTITY_TYPES: GraphEntityType[] = [
  'episode', 'concept', 'parameter', 'metric', 'device', 'node',
  'recipe', 'product', 'line', 'task', 'event', 'document', 'person',
]

export type GraphRelation
  = | 'mentions'
    | 'relates_to'
    | 'causes'
    | 'affects'
    | 'supports'
    | 'contradicts'
    | 'supersedes'
    | 'derived_from'
    | 'part_of'
    | 'used_for'
    | 'precedes'
    | 'has_parameter'
    | 'uses_recipe'
    | 'observed_in'
    | 'co_occurs'

export const GRAPH_RELATIONS: GraphRelation[] = [
  'mentions', 'relates_to', 'causes', 'affects', 'supports', 'contradicts',
  'supersedes', 'derived_from', 'part_of', 'used_for', 'precedes',
  'has_parameter', 'uses_recipe', 'observed_in', 'co_occurs',
]

/** PPR 传播权重；contradicts 不传播（只做冲突标记） */
export const RELATION_WEIGHT: Record<GraphRelation, number> = {
  causes: 1,
  affects: 1,
  supports: 0.8,
  part_of: 0.7,
  used_for: 0.7,
  has_parameter: 0.7,
  uses_recipe: 0.7,
  derived_from: 0.6,
  supersedes: 0.6,
  observed_in: 0.5,
  mentions: 0.4,
  precedes: 0.3,
  relates_to: 0.3,
  co_occurs: 0.2,
  contradicts: 0,
}

export type GraphEntityStatus = 'active' | 'provisional' | 'rejected' | 'merged' | 'retired'
export type GraphEdgeStatus = 'active' | 'provisional' | 'rejected' | 'superseded' | 'retired'
export type GraphPolarity = 'positive' | 'negative' | 'neutral'
export type GraphAuthorKind = 'agent' | 'human' | 'curator' | 'ontology' | 'claim' | 'import'

export interface GraphEntity {
  id: string
  channelId: string
  ownerUserId: string
  scopeKind: MemoryScopeKind
  scopeKey: string
  productId: string
  entityType: GraphEntityType
  canonicalName: string
  canonicalKey: string
  aliases: string[]
  summary: string
  confidence: number
  salience: number
  status: GraphEntityStatus
  mergedInto: string | null
  locked: boolean
  authorKind: GraphAuthorKind
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

export interface GraphEdge {
  id: string
  channelId: string
  ownerUserId: string
  scopeKind: MemoryScopeKind
  scopeKey: string
  productId: string
  srcId: string
  dstId: string
  relation: GraphRelation
  relationLabel: string
  fact: string
  factKey: string
  polarity: GraphPolarity
  confidence: number
  weight: number
  status: GraphEdgeStatus
  locked: boolean
  authorKind: GraphAuthorKind
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
  scopeKind: MemoryScopeKind
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

export interface GraphMention {
  id: string
  entityId: string
  memoryId: string
  confidence: number
  extractor: string
  createdAt: string
}

export interface GraphRun {
  id: string
  channelId: string
  scopeKind: MemoryScopeKind
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

export interface GraphState {
  id: string
  channelId: string
  scopeKind: MemoryScopeKind
  scopeKey: string
  enabled: boolean
  lastSourceHash: string
  lastRunId: string
  lastRunAt: string | null
  lastFullRebuildAt: string | null
  lastOntologyHash: string
  lastClaimHash: string
  revision: number
  entityCount: number
  edgeCount: number
  updatedAt: string
}

export interface GraphSubgraph {
  nodes: GraphEntity[]
  edges: GraphEdge[]
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

export interface GraphSeed {
  entityId: string
  weight: number
  reason: 'alias' | 'canonical' | 'fts' | 'vector' | 'mention'
}

export interface GraphRetrievalResult {
  memoryScores: Map<string, { score: number, entityIds: string[], edgeIds: string[] }>
  entityScores: Map<string, number>
  edges: GraphEdge[]
  seedIds: string[]
  durationMs: number
}

export interface GraphDigest {
  text: string
  refs: Array<{ id: string, kind: 'graph-entity' | 'graph-edge' | 'graph-community', scopeKind?: MemoryScopeKind, scopeKey?: string }>
}

/** 图谱分区：channel / session / global(shared) / line / product */
export interface GraphPartitionSpec {
  scopeKind: MemoryScopeKind
  /** sessionId / lineId / productId / ownerUserId（global）；channel 为空 */
  scopeKey?: string
  /** global 共享区按 owner 隔离 */
  ownerUserId?: string
}

export interface GraphSourceMemory {
  id: string
  channelId: string
  ownerUserId: string
  agentId: string
  kind: string
  title: string
  content: string
  status: string
  scopeKind: MemoryScopeKind
  scopeKey: string
  productId: string
  sessionId: string
  taskId: string | null
  importance: number
  updatedAt: string
  validFrom: string | null
  outcome: string
}

export interface GraphClaimFact {
  claimId: string
  memoryId: string
  versionId: string
  lineId: string
  productId: string
  nodeId: string
  nodeName: string
  variable: string
  unit: string
  recipeId: string
  recipeRevision: string
  fromValue: number | null
  toValue: number | null
  direction: string
  targetNodeId: string
  targetMetric: string
  targetDirection: string
  effect: number | null
  ciLow: number | null
  ciHigh: number | null
  verdict: string
  polarity: string
  observedAt: string
  interventionId: string
}
