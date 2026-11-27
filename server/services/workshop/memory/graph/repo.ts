/**
 * Memory Graph 持久层：实体/别名/提及/事实边/证据/社区/运行/状态/修订/合并候选。
 *
 * 与 memory.repo 的分工：
 *  - 本文件只做图谱表读写与最小防护（human/locked 保护、证据必填、失效不删除）；
 *  - 抽取/解析/社区/检索编排在 graph 目录其它模块；
 *  - 所有查询按 channel_id 限定，图谱不跨频道读。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryScopeKind } from '../../db/database'
import {
  clamp01,
  deterministicId,
  entitySearchText,
  factKeyOf,
  makeId,
  normalizeEntityKey,
  safeJsonArray,
  sha256,
  shortHash,
  uniqueAliases,
} from './normalize'
import type {
  GraphAuthorKind,
  GraphClaimFact,
  GraphCommunity,
  GraphEdge,
  GraphEdgeStatus,
  GraphEntity,
  GraphEntityStatus,
  GraphEntityType,
  GraphEvidence,
  GraphMention,
  GraphPartitionSpec,
  GraphPolarity,
  GraphRelation,
  GraphRun,
  GraphSourceMemory,
  GraphState,
} from './types'

const ENTITY_COLS = `id, channel_id AS channelId, owner_user_id AS ownerUserId, scope_kind AS scopeKind, scope_key AS scopeKey,
  product_id AS productId, entity_type AS entityType, canonical_name AS canonicalName,
  canonical_key AS canonicalKey, aliases_json AS aliasesJson, summary, confidence, salience,
  status, merged_into AS mergedInto, locked, author_kind AS authorKind, author_id AS authorId,
  revision, source_kind AS sourceKind, evidence_json AS evidenceJson, memory_id AS memoryId,
  valid_from AS validFrom, valid_to AS validTo, recorded_at AS recordedAt,
  superseded_by AS supersededBy, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt`

const ENTITY_COLS_E = ENTITY_COLS.split(',').map(s => `e.${s.trim()}`).join(', ')

const EDGE_COLS = `e.id, e.channel_id AS channelId, e.owner_user_id AS ownerUserId, e.scope_kind AS scopeKind, e.scope_key AS scopeKey,
  e.product_id AS productId, e.src_id AS srcId, e.dst_id AS dstId, e.relation,
  e.relation_label AS relationLabel, e.fact, e.fact_key AS factKey, e.polarity, e.confidence,
  e.weight, e.status, e.locked, e.author_kind AS authorKind, e.author_id AS authorId,
  e.revision, e.source_kind AS sourceKind, e.evidence_json AS evidenceJson,
  e.valid_from AS validFrom, e.valid_to AS validTo, e.recorded_at AS recordedAt,
  e.expired_at AS expiredAt, e.superseded_by AS supersededBy, e.created_at AS createdAt,
  e.updated_at AS updatedAt, e.deleted_at AS deletedAt`

const COMMUNITY_COLS = `id, channel_id AS channelId, scope_kind AS scopeKind, scope_key AS scopeKey,
  product_id AS productId, level, parent_id AS parentId, title, summary, summary_hash AS summaryHash,
  member_count AS memberCount, edge_count AS edgeCount, algorithm, revision, status,
  created_at AS createdAt, updated_at AS updatedAt`
const COMMUNITY_COLS_C = COMMUNITY_COLS.split(',').map(s => `c.${s.trim()}`).join(', ')

const RUN_COLS = `id, channel_id AS channelId, scope_kind AS scopeKind, scope_key AS scopeKey, mode,
  status, scanned, eligible, entities_new AS entitiesNew, entities_linked AS entitiesLinked,
  edges_new AS edgesNew, edges_invalidated AS edgesInvalidated, communities, llm_calls AS llmCalls,
  input_chars AS inputChars, fallback_reason AS fallbackReason, error,
  started_at AS startedAt, finished_at AS finishedAt`

const STATE_COLS = `id, channel_id AS channelId, scope_kind AS scopeKind, scope_key AS scopeKey,
  enabled, last_source_hash AS lastSourceHash, last_run_id AS lastRunId, last_run_at AS lastRunAt,
  last_full_rebuild_at AS lastFullRebuildAt, last_ontology_hash AS lastOntologyHash,
  last_claim_hash AS lastClaimHash, revision, entity_count AS entityCount,
  edge_count AS edgeCount, updated_at AS updatedAt`

interface EntityRow extends Omit<GraphEntity, 'aliases' | 'locked'> {
  aliasesJson: string
  locked: number
}
interface EdgeRow extends Omit<GraphEdge, 'locked'> {
  locked: number
  evidenceJson: string
}
type CommunityRow = GraphCommunity
type RunRow = GraphRun

function sourceScope(partition?: GraphPartitionSpec): {
  where: string[]
  params: Array<string | number>
  scopeKind: MemoryScopeKind
  scopeKey: string
  ownerUserId: string
} | null {
  const p = partition ?? { scopeKind: 'channel' as MemoryScopeKind }
  if (p.scopeKind === 'channel') {
    // 频道图只收团队共享语义行与无会话的任务/协作过程行；
    // agent 私有 semantic 即使没有会话也不得进入频道图（否则术语/事实会经 digest 泄漏给其他 Agent）。
    return {
      where: [`m.scope_kind = 'channel'`,
        `(m.agent_id = '__team__' OR (m.kind IN ('episodic-task', 'episodic-peer', 'episodic-team-task') AND m.session_id = ''))`],
      params: [], scopeKind: 'channel', scopeKey: '', ownerUserId: '',
    }
  }
  if (p.scopeKind === 'session') {
    const key = p.scopeKey ?? ''
    if (!key) return null
    return { where: [`m.scope_kind = 'session'`, 'm.session_id = ?'], params: [key], scopeKind: 'session', scopeKey: key, ownerUserId: '' }
  }
  if (p.scopeKind === 'global') {
    const owner = p.ownerUserId ?? p.scopeKey ?? ''
    if (!owner) return null
    return { where: [`m.scope_kind = 'global'`, `COALESCE(m.owner_user_id, '') = ?`], params: [owner], scopeKind: 'global', scopeKey: owner, ownerUserId: owner }
  }
  // line/product 只从 experience_claims / ontology 导入，不直接读普通记忆行。
  return null
}

function appendScopeFilters(where: string[], params: Array<string | number>, alias: string, scope?: GraphQueryScope): void {
  if (!scope) return
  if (scope.scopeKinds?.length) {
    where.push(`${alias}.scope_kind IN (${scope.scopeKinds.map(() => '?').join(',')})`)
    params.push(...scope.scopeKinds)
  }
  if (scope.scopeKeys?.length) {
    where.push(`${alias}.scope_key IN (${scope.scopeKeys.map(() => '?').join(',')})`)
    params.push(...scope.scopeKeys)
  }
  if (scope.ownerUserId !== undefined && scope.ownerUserId !== '') {
    where.push(`${alias}.owner_user_id = ?`)
    params.push(scope.ownerUserId)
  }
}
interface StateRow extends Omit<GraphState, 'enabled'> {
  enabled: number
}

function toEntity(row: EntityRow | null | undefined): GraphEntity | null {
  if (!row) return null
  return {
    ...row,
    aliases: safeJsonArray<string>(row.aliasesJson).filter(a => typeof a === 'string'),
    locked: row.locked === 1,
  }
}

function toEdge(row: (EdgeRow & { evidenceCount?: number }) | undefined): GraphEdge | null {
  if (!row) return null
  return {
    ...row,
    locked: row.locked === 1,
    evidenceCount: Number(row.evidenceCount ?? 0),
  }
}

function toState(row: StateRow | undefined): GraphState | null {
  return row ? { ...row, enabled: row.enabled === 1 } : null
}

export interface UpsertEntityInput {
  id?: string
  channelId: string
  ownerUserId?: string
  scopeKind?: MemoryScopeKind
  scopeKey?: string
  productId?: string
  entityType: GraphEntityType
  canonicalName: string
  canonicalKey?: string
  aliases?: string[]
  summary?: string
  confidence?: number
  salience?: number
  status?: GraphEntityStatus
  authorKind?: GraphAuthorKind
  authorId?: string
  sourceKind?: string
  evidenceJson?: string
  memoryId?: string | null
  validFrom?: string | null
  validTo?: string | null
  locked?: boolean
  recordedAt?: string | null
}

export interface UpsertEntityResult {
  entity: GraphEntity
  outcome: 'inserted' | 'updated' | 'protected' | 'merged'
}

export interface EdgeEvidenceInput {
  memoryId: string
  claimId?: string
  interventionId?: string
  quote?: string
  confidence?: number
}

export interface UpsertEdgeInput {
  id?: string
  channelId: string
  ownerUserId?: string
  scopeKind?: MemoryScopeKind
  scopeKey?: string
  productId?: string
  srcId: string
  dstId: string
  relation: GraphRelation
  relationLabel?: string
  fact?: string
  factKey?: string
  polarity?: GraphPolarity
  confidence?: number
  weight?: number
  status?: GraphEdgeStatus
  authorKind?: GraphAuthorKind
  authorId?: string
  sourceKind?: string
  evidence?: EdgeEvidenceInput[]
  validFrom?: string | null
  validTo?: string | null
  locked?: boolean
  recordedAt?: string | null
  evidenceJson?: string
}

export interface UpsertEdgeResult {
  edge: GraphEdge
  outcome: 'inserted' | 'updated' | 'protected'
}

export interface GraphQueryScope {
  scopeKinds?: MemoryScopeKind[]
  scopeKeys?: string[]
  ownerUserId?: string
}

export interface GraphSubgraphQuery {
  channelId: string
  asOf?: string | null
  scopeKinds?: MemoryScopeKind[]
  scopeKeys?: string[]
  ownerUserId?: string
  types?: string[]
  relations?: string[]
  statuses?: string[]
  entityIds?: string[]
  limitNodes?: number
  limitEdges?: number
}

export interface GraphRepo {
  readonly available: boolean
  getState(channelId: string, scopeKind?: MemoryScopeKind, scopeKey?: string): GraphState | null
  ensureState(channelId: string, scopeKind?: MemoryScopeKind, scopeKey?: string): GraphState
  updateState(channelId: string, patch: Partial<Pick<GraphState,
  'enabled' | 'lastSourceHash' | 'lastRunId' | 'lastRunAt' | 'lastFullRebuildAt'
  | 'lastOntologyHash' | 'lastClaimHash' | 'entityCount' | 'edgeCount'>>,
    scopeKind?: MemoryScopeKind, scopeKey?: string): void
  bumpRevision(channelId: string): number

  startRun(channelId: string, mode: 'incremental' | 'full' | 'manual', scopeKind?: MemoryScopeKind, scopeKey?: string): string
  finishRun(runId: string, patch: Partial<Pick<GraphRun,
  'status' | 'scanned' | 'eligible' | 'entitiesNew' | 'entitiesLinked' | 'edgesNew'
  | 'edgesInvalidated' | 'communities' | 'llmCalls' | 'inputChars' | 'fallbackReason' | 'error'>>): void
  getRun(runId: string): GraphRun | null
  listRuns(channelId: string, limit?: number): GraphRun[]
  reconcileStaleRuns(olderThanMs?: number): number

  selectPendingSources(channelId: string, limit?: number, partition?: GraphPartitionSpec): GraphSourceMemory[]
  sourceFingerprint(channelId: string, partition?: GraphPartitionSpec): string
  markSourceEpisode(channelId: string, memory: GraphSourceMemory): GraphEntity
  listClaimFacts(channelId: string, limit?: number): GraphClaimFact[]

  findEntityByKey(channelId: string, scopeKind: MemoryScopeKind, scopeKey: string, entityType: GraphEntityType, canonicalKey: string): GraphEntity | null
  findEntitiesByAlias(channelId: string, aliasKeys: string[], limit?: number, scope?: GraphQueryScope): GraphEntity[]
  getEntity(id: string, followMerged?: boolean): GraphEntity | null
  listEntitiesByIds(ids: string[]): GraphEntity[]
  listEntitiesByRowids(rowids: number[]): GraphEntity[]
  searchEntitiesFts(channelId: string, matchQuery: string, limit?: number, scope?: GraphQueryScope): GraphEntity[]
  listEntities(channelId: string, opts?: { q?: string, types?: string[], statuses?: string[], limit?: number, offset?: number, includeMerged?: boolean } & GraphQueryScope): GraphEntity[]
  countEntities(channelId: string, scope?: GraphQueryScope): number
  upsertEntity(input: UpsertEntityInput): UpsertEntityResult
  updateEntity(id: string, patch: Partial<UpsertEntityInput> & { expectedRevision?: number }, actor: { kind: GraphAuthorKind, id: string }): GraphEntity
  mergeEntity(sourceId: string, targetId: string, actor: { kind: GraphAuthorKind, id: string }): { source: GraphEntity, target: GraphEntity }
  unmergeEntity(sourceId: string, actor: { kind: GraphAuthorKind, id: string }): GraphEntity
  softDeleteEntity(id: string, actor: { kind: GraphAuthorKind, id: string }, reason?: string): boolean
  restoreEntity(id: string, actor: { kind: GraphAuthorKind, id: string }): boolean
  listAliases(entityId: string): Array<{ id: string, alias: string, aliasKey: string, source: string, confidence: number, createdAt: string }>
  addAlias(entityId: string, alias: string, source?: string, confidence?: number): void

  addMention(entityId: string, memoryId: string, confidence?: number, extractor?: string): void
  listMentions(entityId: string, limit?: number): GraphMention[]
  listMentionsByMemory(memoryId: string): GraphMention[]
  countMentions(entityId: string): number

  getEdge(id: string): GraphEdge | null
  listEdges(channelId: string, opts?: { srcId?: string, dstId?: string, relations?: string[], statuses?: string[], asOf?: string | null, limit?: number, offset?: number } & GraphQueryScope): GraphEdge[]
  countEdges(channelId: string, scope?: GraphQueryScope): number
  upsertEdge(input: UpsertEdgeInput): UpsertEdgeResult | null
  updateEdge(id: string, patch: Partial<UpsertEdgeInput> & { expectedRevision?: number }, actor: { kind: GraphAuthorKind, id: string }): GraphEdge
  invalidateEdge(edgeId: string, supersededBy?: string, at?: string): boolean
  softDeleteEdge(id: string, actor: { kind: GraphAuthorKind, id: string }, reason?: string): boolean
  restoreEdge(id: string, actor: { kind: GraphAuthorKind, id: string }): boolean
  listEvidence(edgeId: string): GraphEvidence[]
  /** 关系证据中至少有一条来源记忆仍存活（或为非记忆锚点）。 */
  edgeEvidenceLive(edgeId: string): boolean
  evidenceCount(edgeId: string): number

  listEdgesForSubgraph(q: GraphSubgraphQuery): GraphEdge[]
  listCommunities(channelId: string, opts?: { level?: number, limit?: number } & GraphQueryScope): GraphCommunity[]
  getCommunity(id: string): GraphCommunity | null
  communityForEntity(entityId: string): GraphCommunity | null
  communityMembers(communityId: string): GraphEntity[]
  replaceCommunities(channelId: string, communities: Array<{
    id: string
    level: number
    parentId?: string | null
    title: string
    summary: string
    memberIds: string[]
    edgeCount?: number
    scopeKind?: MemoryScopeKind
    scopeKey?: string
  }>, actor?: { kind: GraphAuthorKind, id: string }, scope?: GraphQueryScope): number
  listMergeCandidates(channelId: string, status?: string): Array<Record<string, unknown>>
  upsertMergeCandidate(channelId: string, sourceId: string, targetId: string, score: number, reason: string): void
  setMergeCandidateStatus(id: string, status: 'accepted' | 'rejected'): void

  snapshotRevision(subjectKind: 'entity' | 'edge' | 'community', subjectId: string, revision: number, snapshot: unknown, reason: string, actor: { kind: GraphAuthorKind, id: string }): void
  listRevisions(subjectKind: string, subjectId: string): Array<Record<string, unknown>>
  graphStats(channelId: string): {
    entities: number
    edges: number
    communities: number
    provisionalEntities: number
    provisionalEdges: number
    orphanEdges: number
    staleRuns: number
    lastRunAt: string | null
  }

  ensureEntityVec(dims: number): boolean
  readonly entityVecReady: boolean
  entityVecSet(entityRowid: number, channelId: string, vec: Float32Array): void
  entityVecSearch(channelId: string, vec: Float32Array, k: number): Array<{ entityRowid: number, distance: number }>
  entityVecDelete(entityRowid: number): void
  entityRowid(id: string): number | null
}

const ENTITY_TABLE_SQL = `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entities'`

export function createMemoryGraphRepo(db: DatabaseSync): GraphRepo {
  let available = false
  try {
    available = Boolean(db.prepare(ENTITY_TABLE_SQL).get())
  }
  catch {
    available = false
  }

  let vecReady = false
  let vecInsert: ReturnType<DatabaseSync['prepare']> | null = null
  let vecSearchStmt: ReturnType<DatabaseSync['prepare']> | null = null
  let vecDeleteStmt: ReturnType<DatabaseSync['prepare']> | null = null

  const now = (): string => new Date().toISOString()

  function stateKey(channelId: string, scopeKind: MemoryScopeKind = 'channel', scopeKey = ''): string {
    return deterministicId('mgs', [channelId, scopeKind, scopeKey])
  }

  function getEntityRow(id: string): EntityRow | null {
    const row = db.prepare(`SELECT ${ENTITY_COLS} FROM memory_entities WHERE id = ?`).get(id) as unknown as EntityRow | undefined
    return row ?? null
  }

  function resolveCanonical(id: string, depth = 0): GraphEntity | null {
    if (depth > 5) return null
    const row = getEntityRow(id)
    if (!row) return null
    if (row.mergedInto) return resolveCanonical(row.mergedInto, depth + 1)
    return toEntity(row)
  }

  function addAliasRows(entityId: string, name: string, aliases: string[], source: string, confidence: number): void {
    const stmt = db.prepare(`INSERT INTO memory_entity_aliases(id, entity_id, alias, alias_key, source, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(entity_id, alias_key) DO NOTHING`)
    const at = now()
    for (const alias of uniqueAliases(aliases, name)) {
      stmt.run(makeId('mea'), entityId, alias, normalizeEntityKey(alias), source, clamp01(confidence), at)
    }
  }

  function entityById(id: string): GraphEntity | null {
    return resolveCanonical(id)
  }

  function insertEvidence(edgeId: string, items: EdgeEvidenceInput[]): void {
    const stmt = db.prepare(`INSERT INTO memory_edge_evidence(id, edge_id, memory_id, claim_id, intervention_id, quote, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(edge_id, memory_id) DO UPDATE SET
        claim_id = CASE WHEN excluded.claim_id != '' THEN excluded.claim_id ELSE memory_edge_evidence.claim_id END,
        intervention_id = CASE WHEN excluded.intervention_id != '' THEN excluded.intervention_id ELSE memory_edge_evidence.intervention_id END,
        quote = CASE WHEN excluded.quote != '' THEN excluded.quote ELSE memory_edge_evidence.quote END,
        confidence = MAX(memory_edge_evidence.confidence, excluded.confidence)`)
    const at = now()
    for (const e of items) {
      if (!e.memoryId) continue
      stmt.run(makeId('mee'), edgeId, e.memoryId, e.claimId ?? '', e.interventionId ?? '',
        String(e.quote ?? '').slice(0, 500), clamp01(e.confidence ?? 0.5), at)
    }
  }

  function bumpRevision(channelId: string): number {
    const state = ensureState(channelId)
    db.prepare(`UPDATE memory_graph_state SET revision = revision + 1, updated_at = ? WHERE id = ?`).run(now(), state.id)
    return (getState(channelId)?.revision ?? state.revision) + 1
  }

  function ensureState(channelId: string, scopeKind: MemoryScopeKind = 'channel', scopeKey = ''): GraphState {
    const existing = getState(channelId, scopeKind, scopeKey)
    if (existing) return existing
    const at = now()
    db.prepare(`INSERT INTO memory_graph_state(id, channel_id, scope_kind, scope_key, enabled, updated_at)
      VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(channel_id, scope_kind, scope_key) DO NOTHING`)
      .run(stateKey(channelId, scopeKind, scopeKey), channelId, scopeKind, scopeKey, at)
    return getState(channelId, scopeKind, scopeKey)!
  }

  function getState(channelId: string, scopeKind: MemoryScopeKind = 'channel', scopeKey = ''): GraphState | null {
    if (!available) return null
    const row = db.prepare(`SELECT ${STATE_COLS} FROM memory_graph_state
      WHERE channel_id = ? AND scope_kind = ? AND scope_key = ?`)
      .get(channelId, scopeKind, scopeKey) as unknown as StateRow | undefined
    return toState(row)
  }

  const repo: GraphRepo = {
    available,

    getState,
    ensureState,
    updateState(channelId, patch, scopeKind = 'channel', scopeKey = '') {
      const state = ensureState(channelId, scopeKind, scopeKey)
      const fields: string[] = []
      const params: Array<string | number | null> = []
      if (patch.enabled !== undefined) {
        fields.push('enabled = ?')
        params.push(patch.enabled ? 1 : 0)
      }
      if (patch.lastSourceHash !== undefined) {
        fields.push('last_source_hash = ?')
        params.push(patch.lastSourceHash)
      }
      if (patch.lastRunId !== undefined) {
        fields.push('last_run_id = ?')
        params.push(patch.lastRunId)
      }
      if (patch.lastRunAt !== undefined) {
        fields.push('last_run_at = ?')
        params.push(patch.lastRunAt)
      }
      if (patch.lastFullRebuildAt !== undefined) {
        fields.push('last_full_rebuild_at = ?')
        params.push(patch.lastFullRebuildAt)
      }
      if (patch.lastOntologyHash !== undefined) {
        fields.push('last_ontology_hash = ?')
        params.push(patch.lastOntologyHash)
      }
      if (patch.lastClaimHash !== undefined) {
        fields.push('last_claim_hash = ?')
        params.push(patch.lastClaimHash)
      }
      if (patch.entityCount !== undefined) {
        fields.push('entity_count = ?')
        params.push(patch.entityCount)
      }
      if (patch.edgeCount !== undefined) {
        fields.push('edge_count = ?')
        params.push(patch.edgeCount)
      }
      fields.push('updated_at = ?')
      params.push(now())
      db.prepare(`UPDATE memory_graph_state SET ${fields.join(', ')} WHERE id = ?`).run(...params, state.id)
    },
    bumpRevision,

    startRun(channelId, mode, scopeKind = 'channel', scopeKey = '') {
      const id = makeId('mgr')
      db.prepare(`INSERT INTO memory_graph_runs(id, channel_id, scope_kind, scope_key, mode, status, started_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?)`).run(id, channelId, scopeKind, scopeKey, mode, now())
      return id
    },
    finishRun(runId, patch) {
      const fields: string[] = []
      const params: Array<string | number | null> = []
      const map: Array<[keyof typeof patch, string]> = [
        ['status', 'status'], ['scanned', 'scanned'], ['eligible', 'eligible'],
        ['entitiesNew', 'entities_new'], ['entitiesLinked', 'entities_linked'],
        ['edgesNew', 'edges_new'], ['edgesInvalidated', 'edges_invalidated'],
        ['communities', 'communities'], ['llmCalls', 'llm_calls'], ['inputChars', 'input_chars'],
        ['fallbackReason', 'fallback_reason'], ['error', 'error'],
      ]
      for (const [key, col] of map) {
        if (patch[key] !== undefined) {
          fields.push(`${col} = ?`)
          params.push(patch[key] as string | number)
        }
      }
      fields.push('finished_at = ?')
      params.push(now())
      db.prepare(`UPDATE memory_graph_runs SET ${fields.join(', ')} WHERE id = ?`).run(...params, runId)
    },
    getRun(runId) {
      const row = db.prepare(`SELECT ${RUN_COLS} FROM memory_graph_runs WHERE id = ?`).get(runId) as unknown as RunRow | undefined
      return row ? { ...row } : null
    },
    listRuns(channelId, limit = 30) {
      return db.prepare(`SELECT ${RUN_COLS} FROM memory_graph_runs WHERE channel_id = ?
        ORDER BY started_at DESC LIMIT ?`).all(channelId, Math.min(Math.max(limit, 1), 200)) as unknown as GraphRun[]
    },
    reconcileStaleRuns(olderThanMs = 30 * 60_000) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString()
      const result = db.prepare(`UPDATE memory_graph_runs SET status = 'failed', error = 'stale_run',
        finished_at = ? WHERE status = 'running' AND started_at < ?`).run(now(), cutoff)
      return Number(result.changes ?? 0)
    },

    selectPendingSources(channelId, limit = 200, partition) {
      if (!available) return []
      const scope = sourceScope(partition)
      if (!scope) return []
      return db.prepare(`
        SELECT m.id, m.channel_id AS channelId, COALESCE(m.owner_user_id, '') AS ownerUserId,
          m.agent_id AS agentId, m.kind, m.title, m.content,
          m.status, m.scope_kind AS scopeKind, m.scope_key AS scopeKey,
          COALESCE((SELECT CASE WHEN COUNT(*) = 1 THEN MIN(cp.product_id) END
                    FROM channel_product_bindings cp WHERE cp.channel_id = m.channel_id), '') AS productId,
          m.session_id AS sessionId, m.task_id AS taskId, m.importance, m.updated_at AS updatedAt,
          m.valid_from AS validFrom, COALESCE(m.outcome, 'neutral') AS outcome
        FROM agent_memories m
        LEFT JOIN memory_entities e ON e.memory_id = m.id AND e.entity_type = 'episode' AND e.deleted_at IS NULL
        WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.status != 'retired'
          AND ${scope.where.join(' AND ')}
          AND m.kind IN ('semantic', 'episodic-task', 'episodic-peer', 'episodic-team-task', 'experience')
          AND (m.kind != 'experience' OR (m.status = 'validated' AND COALESCE((
                SELECT v.deployment FROM experience_heads h JOIN experience_versions v ON v.version_id = h.version_id
                 WHERE h.experience_id = m.id), 'none') IN ('active', 'canary')))
          AND (e.id IS NULL OR e.updated_at < m.updated_at)
        ORDER BY m.updated_at ASC LIMIT ?`)
        .all(channelId, ...scope.params, Math.min(Math.max(limit, 1), 500)) as unknown as GraphSourceMemory[]
    },
    sourceFingerprint(channelId, partition) {
      const scope = sourceScope(partition)
      if (!scope) return ''
      const rows = db.prepare(`SELECT m.id, m.updated_at AS updatedAt, m.status
        FROM agent_memories m
        WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.status != 'retired'
          AND ${scope.where.join(' AND ')}
          AND m.kind IN ('semantic', 'episodic-task', 'episodic-peer', 'episodic-team-task', 'experience')
          AND (m.kind != 'experience' OR (m.status = 'validated' AND COALESCE((
                SELECT v.deployment FROM experience_heads h JOIN experience_versions v ON v.version_id = h.version_id
                 WHERE h.experience_id = m.id), 'none') IN ('active', 'canary')))
        ORDER BY m.id`).all(channelId, ...scope.params) as Array<{ id: string, updatedAt: string, status: string }>
      return sha256(rows.map(r => `${r.id}:${r.updatedAt}:${r.status}`).join('|')).slice(0, 32)
    },
    markSourceEpisode(channelId, memory) {
      const id = deterministicId('mep', [channelId, memory.id])
      const at = now()
      const validFrom = memory.validFrom ?? memory.updatedAt
      db.prepare(`INSERT INTO memory_entities(id, channel_id, owner_user_id, scope_kind, scope_key, product_id, entity_type,
          canonical_name, canonical_key, aliases_json, summary, search_text, confidence, salience, status,
          author_kind, author_id, revision, source_kind, evidence_json, memory_id, valid_from, recorded_at,
          created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'episode', ?, ?, '[]', ?, ?, 1, 0.4, 'active', 'agent', 'memory-graph', 1,
          'memory', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, search_text = excluded.search_text,
          owner_user_id = excluded.owner_user_id, scope_kind = excluded.scope_kind,
          scope_key = excluded.scope_key, product_id = excluded.product_id,
          updated_at = excluded.updated_at, deleted_at = NULL, status = 'active'`)
        .run(id, channelId, memory.ownerUserId ?? '', memory.scopeKind ?? 'channel', memory.scopeKey ?? '', memory.productId ?? '',
          String(memory.title || memory.id).slice(0, 200), `episode:${memory.id}`,
          String(memory.title || '').slice(0, 300), entitySearchText(String(memory.title || ''), [], String(memory.title || '')),
          JSON.stringify({ memoryId: memory.id, kind: memory.kind, status: memory.status }),
          memory.id, validFrom, at, at, at)
      return repo.getEntity(id)!
    },
    listClaimFacts(channelId, limit = 200) {
      if (!available) return []
      return db.prepare(`
        SELECT c.claim_id AS claimId, c.memory_id AS memoryId, c.version_id AS versionId,
          c.line_id AS lineId, c.product_id AS productId, c.node_id AS nodeId, c.node_name AS nodeName,
          c.variable, c.unit, c.recipe_id AS recipeId, c.recipe_revision AS recipeRevision,
          c.from_value AS fromValue, c.to_value AS toValue, c.direction,
          c.target_node_id AS targetNodeId, c.target_metric AS targetMetric,
          c.target_direction AS targetDirection, c.effect, c.ci_low AS ciLow, c.ci_high AS ciHigh,
          c.verdict, c.polarity, c.observed_at AS observedAt, c.intervention_id AS interventionId
        FROM experience_claims c
        JOIN agent_memories m ON m.id = c.memory_id AND m.deleted_at IS NULL
        JOIN experience_heads h ON h.experience_id = m.id
        JOIN experience_versions v ON v.version_id = h.version_id
        WHERE m.channel_id = ? AND c.verdict IN ('identifiable_effect', 'no_resolvable_effect')
          AND v.deployment IN ('active', 'canary')
          AND (c.valid_to IS NULL OR c.valid_to > ?)
        ORDER BY c.observed_at DESC LIMIT ?`)
        .all(channelId, now(), Math.min(Math.max(limit, 1), 500)) as unknown as GraphClaimFact[]
    },

    findEntityByKey(channelId, scopeKind, scopeKey, entityType, canonicalKey) {
      const row = db.prepare(`SELECT ${ENTITY_COLS} FROM memory_entities
        WHERE channel_id = ? AND scope_kind = ? AND scope_key = ? AND entity_type = ?
          AND canonical_key = ? AND merged_into IS NULL AND deleted_at IS NULL LIMIT 1`)
        .get(channelId, scopeKind, scopeKey, entityType, canonicalKey) as unknown as EntityRow | undefined
      return toEntity(row)
    },
    findEntitiesByAlias(channelId, aliasKeys, limit = 20, scope) {
      const keys = [...new Set(aliasKeys.map(normalizeEntityKey).filter(Boolean))].slice(0, 20)
      if (keys.length === 0) return []
      const placeholders = keys.map(() => '?').join(',')
      const where = [`e.channel_id = ?`, `a.alias_key IN (${placeholders})`, 'e.merged_into IS NULL', 'e.deleted_at IS NULL']
      const params: Array<string | number> = [channelId, ...keys]
      appendScopeFilters(where, params, 'e', scope)
      const rows = db.prepare(`SELECT ${ENTITY_COLS_E} FROM memory_entities e
        JOIN memory_entity_aliases a ON a.entity_id = e.id
        WHERE ${where.join(' AND ')}
        LIMIT ?`).all(...params, limit) as unknown as EntityRow[]
      return rows.map(r => toEntity(r)!).filter(Boolean)
    },
    getEntity(id, followMerged = true) {
      return followMerged ? entityById(id) : toEntity(getEntityRow(id))
    },
    listEntitiesByIds(ids) {
      const uniq = [...new Set(ids.filter(Boolean))].slice(0, 500)
      if (uniq.length === 0) return []
      const placeholders = uniq.map(() => '?').join(',')
      const rows = db.prepare(`SELECT ${ENTITY_COLS} FROM memory_entities WHERE id IN (${placeholders})`)
        .all(...uniq) as unknown as EntityRow[]
      return rows.map(r => toEntity(r)!).filter(Boolean)
    },
    listEntitiesByRowids(rowids) {
      const uniq = [...new Set(rowids.filter(n => Number.isFinite(n)))].slice(0, 100)
      if (uniq.length === 0) return []
      const placeholders = uniq.map(() => '?').join(',')
      const rows = db.prepare(`SELECT ${ENTITY_COLS} FROM memory_entities WHERE rowid IN (${placeholders})`)
        .all(...uniq) as unknown as EntityRow[]
      return rows.map(r => toEntity(r)!).filter(Boolean)
    },
    searchEntitiesFts(channelId, matchQuery, limit = 20, scope) {
      if (!matchQuery) return []
      try {
        const where = [`e.channel_id = ?`, 'e.merged_into IS NULL', 'e.deleted_at IS NULL', `e.status IN ('active', 'provisional')`]
        const params: Array<string | number> = [matchQuery, channelId]
        appendScopeFilters(where, params, 'e', scope)
        const rows = db.prepare(`SELECT ${ENTITY_COLS} FROM memory_entities e
          JOIN (
            SELECT entity_rowid, bm25(memory_entities_fts) AS rank
            FROM memory_entities_fts WHERE memory_entities_fts MATCH ?
          ) f ON f.entity_rowid = e.rowid
          WHERE ${where.join(' AND ')}
          ORDER BY f.rank LIMIT ?`)
          .all(...params, limit) as unknown as EntityRow[]
        return rows.map(r => toEntity(r)!).filter(Boolean)
      }
      catch {
        return []
      }
    },
    listEntities(channelId, opts = {}) {
      const where = ['channel_id = ?', 'deleted_at IS NULL']
      const params: Array<string | number> = [channelId]
      if (!opts.includeMerged) where.push('merged_into IS NULL')
      if (opts.types?.length) {
        where.push(`entity_type IN (${opts.types.map(() => '?').join(',')})`)
        params.push(...opts.types)
      }
      if (opts.statuses?.length) {
        where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`)
        params.push(...opts.statuses)
      }
      if (opts.q?.trim()) {
        where.push('(canonical_name LIKE ? OR summary LIKE ?)')
        const like = `%${opts.q.trim().slice(0, 80)}%`
        params.push(like, like)
      }
      appendScopeFilters(where, params, 'memory_entities', opts)
      const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
      const offset = Math.max(opts.offset ?? 0, 0)
      const rows = db.prepare(`SELECT ${ENTITY_COLS} FROM memory_entities WHERE ${where.join(' AND ')}
        ORDER BY salience DESC, updated_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as unknown as EntityRow[]
      return rows.map(r => toEntity(r)!).filter(Boolean)
    },
    countEntities(channelId, scope) {
      const where = ['channel_id = ?', 'deleted_at IS NULL']
      const params: Array<string | number> = [channelId]
      appendScopeFilters(where, params, 'memory_entities', scope)
      const row = db.prepare(`SELECT COUNT(*) AS n FROM memory_entities WHERE ${where.join(' AND ')}`).get(...params) as { n: number }
      return Number(row.n)
    },
    upsertEntity(input) {
      const scopeKind = input.scopeKind ?? 'channel'
      const scopeKey = input.scopeKey ?? ''
      const key = input.canonicalKey ?? normalizeEntityKey(input.canonicalName)
      if (!key) throw new Error('实体名不能为空')
      const existing = repo.findEntityByKey(input.channelId, scopeKind, scopeKey, input.entityType, key)
      const actorKind = input.authorKind ?? 'agent'
      const at = now()
      if (existing) {
        if (existing.status === 'rejected' && actorKind !== 'human') {
          return { entity: existing, outcome: 'protected' }
        }
        if ((existing.locked || existing.authorKind === 'human') && actorKind !== 'human') {
          addAliasRows(existing.id, existing.canonicalName, input.aliases ?? [], actorKind, input.confidence ?? 0.5)
          return { entity: existing, outcome: 'protected' }
        }
        const summary = String(input.summary ?? '').length > existing.summary.length
          ? String(input.summary).slice(0, 600)
          : existing.summary
        const mergedAliases = uniqueAliases([...existing.aliases, ...(input.aliases ?? [])], input.canonicalName)
        const status = input.status ?? existing.status
        const nextStatus = existing.status === 'rejected' && actorKind !== 'human' ? 'rejected' : status
        const confidence = Math.max(existing.confidence, clamp01(input.confidence ?? 0.5))
        const salience = Math.max(existing.salience, clamp01(input.salience ?? 0.5))
        db.prepare(`UPDATE memory_entities SET canonical_name = ?, aliases_json = ?, summary = ?, search_text = ?,
            confidence = ?, salience = ?, status = ?, valid_from = COALESCE(?, valid_from),
            valid_to = ?, owner_user_id = COALESCE(NULLIF(?, ''), owner_user_id),
            updated_at = ?, revision = revision + 1
          WHERE id = ?`)
          .run(String(input.canonicalName).slice(0, 200),
            JSON.stringify(mergedAliases),
            summary,
            entitySearchText(String(input.canonicalName), mergedAliases, summary),
            confidence, salience, nextStatus,
            input.validFrom ?? null, input.validTo ?? existing.validTo,
            input.ownerUserId ?? '', at, existing.id)
        addAliasRows(existing.id, input.canonicalName, input.aliases ?? [], actorKind, input.confidence ?? 0.5)
        return { entity: repo.getEntity(existing.id)!, outcome: 'updated' }
      }
      const id = input.id ?? makeId('ment')
      const aliases = uniqueAliases(input.aliases ?? [], input.canonicalName)
      const summary = String(input.summary ?? '').slice(0, 600)
      db.prepare(`INSERT INTO memory_entities(id, channel_id, owner_user_id, scope_kind, scope_key, product_id, entity_type,
          canonical_name, canonical_key, aliases_json, summary, search_text, confidence, salience, status,
          locked, author_kind, author_id, revision, source_kind, evidence_json, memory_id, valid_from, valid_to,
          recorded_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.channelId, input.ownerUserId ?? '', scopeKind, scopeKey, input.productId ?? '', input.entityType,
          String(input.canonicalName).slice(0, 200), key, JSON.stringify(aliases), summary,
          entitySearchText(String(input.canonicalName), aliases, summary),
          clamp01(input.confidence ?? 0.5), clamp01(input.salience ?? 0.5),
          input.status ?? 'active', input.locked ? 1 : 0, actorKind, input.authorId ?? '',
          input.sourceKind ?? 'memory', input.evidenceJson ?? '{}', input.memoryId ?? null,
          input.validFrom ?? null, input.validTo ?? null, input.recordedAt ?? at, at, at)
      addAliasRows(id, input.canonicalName, aliases, actorKind, input.confidence ?? 0.5)
      return { entity: repo.getEntity(id)!, outcome: 'inserted' }
    },
    updateEntity(id, patch, actor) {
      const current = repo.getEntity(id, false)
      if (!current) throw new Error('实体不存在')
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
        throw Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT', currentRevision: current.revision })
      }
      repo.snapshotRevision('entity', id, current.revision, current, 'human:update', actor)
      const name = patch.canonicalName ?? current.canonicalName
      const aliases = patch.aliases ?? current.aliases
      const summary = patch.summary ?? current.summary
      const key = patch.canonicalKey ?? normalizeEntityKey(name)
      const at = now()
      db.prepare(`UPDATE memory_entities SET canonical_name = ?, canonical_key = ?, aliases_json = ?,
          summary = ?, search_text = ?, entity_type = ?, status = ?, locked = ?, author_kind = ?,
          author_id = ?, valid_from = ?, valid_to = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?`)
        .run(String(name).slice(0, 200), key, JSON.stringify(uniqueAliases(aliases, name)),
          String(summary).slice(0, 600), entitySearchText(String(name), aliases, String(summary)),
          patch.entityType ?? current.entityType, patch.status ?? current.status,
          patch.locked === undefined ? (current.locked ? 1 : 0) : (patch.locked ? 1 : 0),
          actor.kind, actor.id, patch.validFrom !== undefined ? patch.validFrom : current.validFrom,
          patch.validTo !== undefined ? patch.validTo : current.validTo,
          at, id)
      addAliasRows(id, name, aliases, actor.kind, 1)
      return repo.getEntity(id, false)!
    },
    mergeEntity(sourceId, targetId, actor) {
      if (sourceId === targetId) throw new Error('不能合并到自身')
      const source = repo.getEntity(sourceId, false)
      const target = repo.getEntity(targetId, false)
      if (!source || !target) throw new Error('实体不存在')
      if (source.channelId !== target.channelId || source.scopeKind !== target.scopeKind
        || source.scopeKey !== target.scopeKey
        || (source.scopeKind === 'global' && (source.ownerUserId ?? '') !== (target.ownerUserId ?? ''))) {
        throw new Error('只能合并同一作用域内的实体')
      }
      if (source.locked || target.locked) {
        if (actor.kind !== 'human') throw new Error('实体已锁定')
      }
      repo.snapshotRevision('entity', sourceId, source.revision, source, 'human:merge', actor)
      const at = now()
      db.prepare(`UPDATE memory_entities SET merged_into = ?, status = 'merged', updated_at = ?, revision = revision + 1
        WHERE id = ?`).run(targetId, at, sourceId)
      // 别名并入 target（不搬边；读时 follow merged_into）
      const aliases = uniqueAliases([...target.aliases, source.canonicalName, ...source.aliases], target.canonicalName)
      db.prepare(`UPDATE memory_entities SET aliases_json = ?, search_text = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?`).run(JSON.stringify(aliases), entitySearchText(target.canonicalName, aliases, target.summary), at, targetId)
      addAliasRows(targetId, source.canonicalName, source.aliases, actor.kind, 1)
      return { source: repo.getEntity(sourceId, false)!, target: repo.getEntity(targetId, false)! }
    },
    unmergeEntity(sourceId, actor) {
      const source = repo.getEntity(sourceId, false)
      if (!source || !source.mergedInto) throw new Error('实体不是已合并状态')
      repo.snapshotRevision('entity', sourceId, source.revision, source, 'human:unmerge', actor)
      db.prepare(`UPDATE memory_entities SET merged_into = NULL, status = 'active', updated_at = ?, revision = revision + 1
        WHERE id = ?`).run(now(), sourceId)
      return repo.getEntity(sourceId, false)!
    },
    softDeleteEntity(id, actor, reason = '') {
      const current = repo.getEntity(id, false)
      if (!current) return false
      repo.snapshotRevision('entity', id, current.revision, current, reason || 'human:delete', actor)
      db.prepare(`UPDATE memory_entities SET deleted_at = ?, status = 'retired', updated_at = ?, revision = revision + 1
        WHERE id = ?`).run(now(), now(), id)
      return true
    },
    restoreEntity(id, actor) {
      const current = repo.getEntity(id, false)
      if (!current) return false
      repo.snapshotRevision('entity', id, current.revision, current, 'human:restore', actor)
      db.prepare(`UPDATE memory_entities SET deleted_at = NULL, status = 'active', updated_at = ?, revision = revision + 1
        WHERE id = ?`).run(now(), id)
      return true
    },
    listAliases(entityId) {
      return db.prepare(`SELECT id, alias, alias_key AS aliasKey, source, confidence, created_at AS createdAt
        FROM memory_entity_aliases WHERE entity_id = ? ORDER BY confidence DESC, created_at ASC`)
        .all(entityId) as unknown as Array<{ id: string, alias: string, aliasKey: string, source: string, confidence: number, createdAt: string }>
    },
    addAlias(entityId, alias, source = 'human', confidence = 1) {
      addAliasRows(entityId, alias, [alias], source, confidence)
    },

    addMention(entityId, memoryId, confidence = 0.5, extractor = 'rule') {
      db.prepare(`INSERT INTO memory_entity_mentions(id, entity_id, memory_id, confidence, extractor, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(entity_id, memory_id) DO UPDATE SET
          confidence = MAX(memory_entity_mentions.confidence, excluded.confidence)`)
        .run(makeId('mem'), entityId, memoryId, clamp01(confidence), extractor, now())
    },
    listMentions(entityId, limit = 50) {
      // 提及只返回来源记忆仍存活的记录：软删/退役记忆的内容不得继续投影回检索。
      return db.prepare(`SELECT x.id, x.entity_id AS entityId, x.memory_id AS memoryId, x.confidence, x.extractor, x.created_at AS createdAt
        FROM memory_entity_mentions x JOIN agent_memories m ON m.id = x.memory_id
        WHERE x.entity_id = ? AND m.deleted_at IS NULL AND m.status != 'retired'
        ORDER BY x.created_at DESC LIMIT ?`)
        .all(entityId, Math.min(Math.max(limit, 1), 200)) as unknown as GraphMention[]
    },
    listMentionsByMemory(memoryId) {
      return db.prepare(`SELECT id, entity_id AS entityId, memory_id AS memoryId, confidence, extractor, created_at AS createdAt
        FROM memory_entity_mentions WHERE memory_id = ?`).all(memoryId) as unknown as GraphMention[]
    },
    countMentions(entityId) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM memory_entity_mentions x
        JOIN agent_memories m ON m.id = x.memory_id
        WHERE x.entity_id = ? AND m.deleted_at IS NULL AND m.status != 'retired'`).get(entityId) as { n: number }
      return Number(row.n)
    },

    getEdge(id) {
      const row = db.prepare(`SELECT ${EDGE_COLS}, (SELECT COUNT(*) FROM memory_edge_evidence v WHERE v.edge_id = e.id) AS evidenceCount
        FROM memory_edges e WHERE e.id = ?`).get(id) as unknown as EdgeRow | undefined
      return toEdge(row)
    },
    listEdges(channelId, opts = {}) {
      const where = ['e.channel_id = ?', 'e.deleted_at IS NULL']
      const params: Array<string | number> = [channelId]
      if (opts.srcId) {
        where.push('e.src_id = ?')
        params.push(opts.srcId)
      }
      if (opts.dstId) {
        where.push('e.dst_id = ?')
        params.push(opts.dstId)
      }
      if (opts.relations?.length) {
        where.push(`e.relation IN (${opts.relations.map(() => '?').join(',')})`)
        params.push(...opts.relations)
      }
      appendScopeFilters(where, params, 'e', opts)
      const asOf = opts.asOf ?? null
      if (asOf) {
        where.push('(e.valid_from IS NULL OR e.valid_from <= ?)')
        where.push('(e.valid_to IS NULL OR e.valid_to > ?)')
        params.push(asOf, asOf)
      }
      else {
        const statuses = opts.statuses?.length ? opts.statuses : ['active', 'provisional']
        where.push(`e.status IN (${statuses.map(() => '?').join(',')})`)
        params.push(...statuses)
        where.push('(e.valid_to IS NULL OR e.valid_to > ?)')
        params.push(now())
      }
      if (opts.statuses?.length && asOf) {
        where.push(`e.status IN (${opts.statuses.map(() => '?').join(',')})`)
        params.push(...opts.statuses)
      }
      const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 20000)
      const offset = Math.max(opts.offset ?? 0, 0)
      const rows = db.prepare(`SELECT ${EDGE_COLS}, (SELECT COUNT(*) FROM memory_edge_evidence v WHERE v.edge_id = e.id) AS evidenceCount
        FROM memory_edges e WHERE ${where.join(' AND ')}
        ORDER BY e.confidence DESC, e.updated_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as unknown as Array<EdgeRow & { evidenceCount: number }>
      return rows.map(r => toEdge(r)!).filter(Boolean)
    },
    countEdges(channelId, scope) {
      const where = ['channel_id = ?', 'deleted_at IS NULL']
      const params: Array<string | number> = [channelId]
      appendScopeFilters(where, params, 'memory_edges', scope)
      const row = db.prepare(`SELECT COUNT(*) AS n FROM memory_edges WHERE ${where.join(' AND ')}`).get(...params) as { n: number }
      return Number(row.n)
    },
    upsertEdge(input) {
      const src = repo.getEntity(input.srcId)
      const dst = repo.getEntity(input.dstId)
      if (!src || !dst) return null
      // 分区隔离：边只能连接同 channel、同 scope、同 owner 的端点（session/shared/line/product 不串图）。
      if (src.channelId !== input.channelId || dst.channelId !== input.channelId) return null
      if (src.scopeKind !== dst.scopeKind || src.scopeKey !== dst.scopeKey) return null
      if ((src.scopeKind === 'global' || dst.scopeKind === 'global')
        && (src.ownerUserId ?? '') !== (dst.ownerUserId ?? '')) return null
      const evidence = input.evidence ?? []
      const actorKind = input.authorKind ?? 'agent'
      if (actorKind !== 'human' && evidence.length === 0) return null
      // 边分区必须由端点决定；调用方显式给不同 scope 时拒收（否则边会出现在另一分区）。
      if ((input.scopeKind && input.scopeKind !== src.scopeKind)
        || (input.scopeKey !== undefined && input.scopeKey !== src.scopeKey)) return null
      const scopeKind = src.scopeKind
      const scopeKey = src.scopeKey
      const fact = String(input.fact ?? '').slice(0, 600)
      const factKey = input.factKey ?? factKeyOf(fact)
      const at = now()
      // 人工否决/软删是墓碑：后续 agent/claim/ontology 整理不得用同 fact 重建。
      if (actorKind !== 'human') {
        const tomb = db.prepare(`SELECT ${EDGE_COLS} FROM memory_edges e
          WHERE e.channel_id = ? AND e.src_id = ? AND e.dst_id = ? AND e.relation = ? AND e.fact_key = ?
            AND (e.deleted_at IS NOT NULL OR e.status IN ('rejected', 'retired')) LIMIT 1`)
          .get(input.channelId, src.id, dst.id, input.relation, factKey) as unknown as EdgeRow | undefined
        if (tomb) return { edge: toEdge(tomb)!, outcome: 'protected' }
      }
      const existingRow = db.prepare(`SELECT ${EDGE_COLS} FROM memory_edges e
        WHERE e.channel_id = ? AND e.src_id = ? AND e.dst_id = ? AND e.relation = ? AND e.fact_key = ?
          AND e.deleted_at IS NULL AND e.status IN ('active', 'provisional') LIMIT 1`)
        .get(input.channelId, src.id, dst.id, input.relation, factKey) as unknown as EdgeRow | undefined
      const existing = toEdge(existingRow)
      if (existing) {
        if ((existing.locked || existing.authorKind === 'human') && actorKind !== 'human') {
          insertEvidence(existing.id, evidence)
          return { edge: repo.getEdge(existing.id)!, outcome: 'protected' }
        }
        db.prepare(`UPDATE memory_edges SET relation_label = CASE WHEN ? != '' THEN ? ELSE relation_label END,
            fact = CASE WHEN ? != '' THEN ? ELSE fact END, polarity = ?, confidence = MAX(confidence, ?),
            weight = MAX(weight, ?), status = ?, valid_from = COALESCE(valid_from, ?),
            owner_user_id = COALESCE(NULLIF(?, ''), owner_user_id),
            updated_at = ?, revision = revision + 1, evidence_json = ?
          WHERE id = ?`)
          .run(input.relationLabel ?? '', input.relationLabel ?? '', fact, fact,
            input.polarity ?? existing.polarity, clamp01(input.confidence ?? 0.5),
            Number(input.weight ?? 1), input.status ?? existing.status, input.validFrom ?? at,
            src.ownerUserId ?? '', at, input.evidenceJson ?? '[]', existing.id)
        insertEvidence(existing.id, evidence)
        return { edge: repo.getEdge(existing.id)!, outcome: 'updated' }
      }
      const id = input.id ?? makeId('meg')
      db.prepare(`INSERT INTO memory_edges(id, channel_id, owner_user_id, scope_kind, scope_key, product_id, src_id, dst_id,
          relation, relation_label, fact, fact_key, polarity, confidence, weight, status, locked,
          author_kind, author_id, revision, source_kind, evidence_json, valid_from, valid_to, recorded_at,
          created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.channelId, src.ownerUserId ?? '', scopeKind, scopeKey, input.productId ?? src.productId ?? '',
          src.id, dst.id, input.relation, input.relationLabel ?? '', fact, factKey,
          input.polarity ?? 'positive', clamp01(input.confidence ?? 0.5), Number(input.weight ?? 1),
          input.status ?? (actorKind === 'agent' ? 'provisional' : 'active'), input.locked ? 1 : 0,
          actorKind, input.authorId ?? '', input.sourceKind ?? 'memory', input.evidenceJson ?? '[]',
          input.validFrom ?? at, input.validTo ?? null, input.recordedAt ?? at, at, at)
      insertEvidence(id, evidence)
      return { edge: repo.getEdge(id)!, outcome: 'inserted' }
    },
    updateEdge(id, patch, actor) {
      const current = repo.getEdge(id)
      if (!current) throw new Error('关系不存在')
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
        throw Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT', currentRevision: current.revision })
      }
      repo.snapshotRevision('edge', id, current.revision, current, 'human:update', actor)
      const fact = patch.fact ?? current.fact
      db.prepare(`UPDATE memory_edges SET relation = ?, relation_label = ?, fact = ?, fact_key = ?,
          polarity = ?, confidence = ?, weight = ?, status = ?, locked = ?, author_kind = ?, author_id = ?,
          valid_from = ?, valid_to = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?`)
        .run(patch.relation ?? current.relation, patch.relationLabel ?? current.relationLabel,
          String(fact).slice(0, 600), patch.factKey ?? factKeyOf(String(fact)),
          patch.polarity ?? current.polarity, clamp01(patch.confidence ?? current.confidence),
          Number(patch.weight ?? current.weight), patch.status ?? current.status,
          patch.locked === undefined ? (current.locked ? 1 : 0) : (patch.locked ? 1 : 0),
          actor.kind, actor.id, patch.validFrom !== undefined ? patch.validFrom : current.validFrom,
          patch.validTo !== undefined ? patch.validTo : current.validTo,
          now(), id)
      return repo.getEdge(id)!
    },
    invalidateEdge(edgeId, supersededBy = '', at = now()) {
      const edge = repo.getEdge(edgeId)
      if (!edge || edge.locked || edge.authorKind === 'human') return false
      db.prepare(`UPDATE memory_edges SET valid_to = ?, status = 'superseded', superseded_by = ?,
          expired_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`)
        .run(at, supersededBy, at, at, edgeId)
      return true
    },
    softDeleteEdge(id, actor, reason = '') {
      const current = repo.getEdge(id)
      if (!current) return false
      repo.snapshotRevision('edge', id, current.revision, current, reason || 'human:delete', actor)
      db.prepare(`UPDATE memory_edges SET deleted_at = ?, status = 'retired', updated_at = ?, revision = revision + 1
        WHERE id = ?`).run(now(), now(), id)
      return true
    },
    restoreEdge(id, actor) {
      const current = repo.getEdge(id)
      if (!current) return false
      repo.snapshotRevision('edge', id, current.revision, current, 'human:restore', actor)
      db.prepare(`UPDATE memory_edges SET deleted_at = NULL, status = 'active', updated_at = ?, revision = revision + 1
        WHERE id = ?`).run(now(), id)
      return true
    },
    listEvidence(edgeId) {
      return db.prepare(`SELECT id, edge_id AS edgeId, memory_id AS memoryId, claim_id AS claimId,
          intervention_id AS interventionId, quote, confidence, created_at AS createdAt
        FROM memory_edge_evidence WHERE edge_id = ? ORDER BY confidence DESC, created_at DESC`)
        .all(edgeId) as unknown as GraphEvidence[]
    },
    evidenceCount(edgeId) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM memory_edge_evidence WHERE edge_id = ?').get(edgeId) as { n: number }
      return Number(row.n)
    },
    edgeEvidenceLive(edgeId) {
      const row = db.prepare(`SELECT 1 AS ok FROM memory_edge_evidence e
        LEFT JOIN agent_memories m ON m.id = e.memory_id
        WHERE e.edge_id = ? AND (
          (m.id IS NOT NULL AND m.deleted_at IS NULL AND m.status != 'retired')
          OR e.memory_id = '' OR e.memory_id LIKE 'ontology:%' OR e.memory_id LIKE 'claim:%'
        ) LIMIT 1`).get(edgeId)
      return Boolean(row)
    },

    listEdgesForSubgraph(q) {
      return repo.listEdges(q.channelId, {
        asOf: q.asOf,
        scopeKinds: q.scopeKinds,
        scopeKeys: q.scopeKeys,
        ownerUserId: q.ownerUserId,
        relations: q.relations,
        statuses: q.asOf ? ['active', 'provisional', 'superseded'] : ['active', 'provisional'],
        limit: q.limitEdges ?? 2000,
      })
    },
    listCommunities(channelId, opts = {}) {
      const where = ['channel_id = ?', 'status = \'active\'', 'deleted_at IS NULL']
      const params: Array<string | number> = [channelId]
      if (opts.level !== undefined) {
        where.push('level = ?')
        params.push(opts.level)
      }
      appendScopeFilters(where, params, 'memory_communities', opts)
      const rows = db.prepare(`SELECT ${COMMUNITY_COLS} FROM memory_communities WHERE ${where.join(' AND ')}
        ORDER BY level ASC, member_count DESC LIMIT ?`)
        .all(...params, Math.min(Math.max(opts.limit ?? 100, 1), 500)) as unknown as CommunityRow[]
      return rows
    },
    getCommunity(id) {
      const row = db.prepare(`SELECT ${COMMUNITY_COLS} FROM memory_communities WHERE id = ?`).get(id) as unknown as CommunityRow | undefined
      return row ?? null
    },
    communityForEntity(entityId) {
      const row = db.prepare(`SELECT ${COMMUNITY_COLS_C}
        FROM memory_communities c
        JOIN memory_community_members m ON m.community_id = c.id
        WHERE m.entity_id = ? AND c.status = 'active' AND c.deleted_at IS NULL
        ORDER BY c.level ASC, c.member_count DESC LIMIT 1`).get(entityId) as unknown as CommunityRow | undefined
      return row ?? null
    },
    communityMembers(communityId) {
      const rows = db.prepare(`SELECT ${ENTITY_COLS} FROM memory_entities e
        JOIN memory_community_members m ON m.entity_id = e.id
        WHERE m.community_id = ? AND e.deleted_at IS NULL ORDER BY e.salience DESC, e.canonical_name ASC`)
        .all(communityId) as unknown as EntityRow[]
      return rows.map(r => toEntity(r)!).filter(Boolean)
    },
    replaceCommunities(channelId, communities, actor = { kind: 'agent', id: 'memory-graph' }, scope) {
      const at = now()
      const keep = new Set(communities.map(c => c.id))
      const where = ['channel_id = ?', `status = 'active'`]
      const params: Array<string | number> = [channelId]
      appendScopeFilters(where, params, 'memory_communities', scope ? { scopeKinds: scope.scopeKinds, scopeKeys: scope.scopeKeys } : undefined)
      const existing = db.prepare(`SELECT id FROM memory_communities WHERE ${where.join(' AND ')}`).all(...params) as Array<{ id: string }>
      for (const row of existing) {
        if (!keep.has(row.id)) {
          db.prepare(`UPDATE memory_communities SET status = 'retired', updated_at = ? WHERE id = ?`).run(at, row.id)
          db.prepare('DELETE FROM memory_community_members WHERE community_id = ?').run(row.id)
        }
      }
      for (const c of communities) {
        db.prepare(`INSERT INTO memory_communities(id, channel_id, scope_kind, scope_key, product_id, level, parent_id,
            title, summary, summary_hash, member_count, edge_count, algorithm, revision, status, author_kind, author_id,
            created_at, updated_at)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'label_propagation', 1, 'active', ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET scope_kind = excluded.scope_kind, scope_key = excluded.scope_key,
            product_id = excluded.product_id, title = excluded.title, summary = excluded.summary,
            summary_hash = excluded.summary_hash, member_count = excluded.member_count,
            edge_count = excluded.edge_count, status = 'active', updated_at = excluded.updated_at`)
          .run(c.id, channelId, c.scopeKind ?? 'channel', c.scopeKey ?? '', c.level, c.parentId ?? null,
            c.title.slice(0, 200), c.summary.slice(0, 1200), shortHash(c.summary, 16),
            c.memberIds.length, c.edgeCount ?? 0, actor.kind, actor.id, at, at)
        db.prepare('DELETE FROM memory_community_members WHERE community_id = ?').run(c.id)
        const stmt = db.prepare('INSERT INTO memory_community_members(community_id, entity_id, weight) VALUES (?, ?, 1)')
        for (const id of c.memberIds) stmt.run(c.id, id)
      }
      return communities.length
    },
    listMergeCandidates(channelId, status = 'proposed') {
      return db.prepare(`SELECT c.id, c.channel_id AS channelId, c.source_entity_id AS sourceEntityId,
          c.target_entity_id AS targetEntityId, c.score, c.reason, c.status,
          s.canonical_name AS sourceName, t.canonical_name AS targetName,
          c.created_at AS createdAt, c.updated_at AS updatedAt
        FROM memory_merge_candidates c
        LEFT JOIN memory_entities s ON s.id = c.source_entity_id
        LEFT JOIN memory_entities t ON t.id = c.target_entity_id
        WHERE c.channel_id = ? AND c.status = ? ORDER BY c.score DESC, c.created_at DESC`)
        .all(channelId, status) as unknown as Array<Record<string, unknown>>
    },
    upsertMergeCandidate(channelId, sourceId, targetId, score, reason) {
      if (sourceId === targetId) return
      const at = now()
      db.prepare(`INSERT INTO memory_merge_candidates(id, channel_id, source_entity_id, target_entity_id, score, reason, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
        ON CONFLICT(channel_id, source_entity_id, target_entity_id) DO UPDATE SET
          score = MAX(memory_merge_candidates.score, excluded.score), reason = excluded.reason,
          updated_at = excluded.updated_at, status = CASE WHEN memory_merge_candidates.status = 'rejected' THEN 'rejected' ELSE 'proposed' END`)
        .run(makeId('mmc'), channelId, sourceId, targetId, clamp01(score), reason.slice(0, 300), at, at)
    },
    setMergeCandidateStatus(id, status) {
      db.prepare('UPDATE memory_merge_candidates SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id)
    },

    snapshotRevision(subjectKind, subjectId, revision, snapshot, reason, actor) {
      db.prepare(`INSERT INTO memory_graph_revisions(id, subject_kind, subject_id, revision, snapshot_json, reason, author_kind, author_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subject_kind, subject_id, revision) DO NOTHING`)
        .run(makeId('mgrv'), subjectKind, subjectId, revision, JSON.stringify(snapshot), reason.slice(0, 200),
          actor.kind, actor.id, now())
    },
    listRevisions(subjectKind, subjectId) {
      return db.prepare(`SELECT id, subject_kind AS subjectKind, subject_id AS subjectId, revision,
          snapshot_json AS snapshotJson, reason, author_kind AS authorKind, author_id AS authorId,
          created_at AS createdAt FROM memory_graph_revisions
        WHERE subject_kind = ? AND subject_id = ? ORDER BY revision DESC`)
        .all(subjectKind, subjectId) as unknown as Array<Record<string, unknown>>
    },
    graphStats(channelId) {
      const counts = db.prepare(`SELECT
          (SELECT COUNT(*) FROM memory_entities WHERE channel_id = ? AND deleted_at IS NULL) AS entities,
          (SELECT COUNT(*) FROM memory_edges WHERE channel_id = ? AND deleted_at IS NULL) AS edges,
          (SELECT COUNT(*) FROM memory_communities WHERE channel_id = ? AND status = 'active' AND deleted_at IS NULL) AS communities,
          (SELECT COUNT(*) FROM memory_entities WHERE channel_id = ? AND status = 'provisional' AND deleted_at IS NULL) AS provisionalEntities,
          (SELECT COUNT(*) FROM memory_edges WHERE channel_id = ? AND status = 'provisional' AND deleted_at IS NULL) AS provisionalEdges,
          (SELECT COUNT(*) FROM memory_edges e WHERE e.channel_id = ? AND e.deleted_at IS NULL
            AND (NOT EXISTS (SELECT 1 FROM memory_entities s WHERE s.id = e.src_id AND s.deleted_at IS NULL)
              OR NOT EXISTS (SELECT 1 FROM memory_entities d WHERE d.id = e.dst_id AND d.deleted_at IS NULL))) AS orphanEdges,
          (SELECT COUNT(*) FROM memory_graph_runs WHERE channel_id = ? AND status = 'running'
            AND started_at < ?) AS staleRuns
        `).get(channelId, channelId, channelId, channelId, channelId, channelId, channelId,
        new Date(Date.now() - 30 * 60_000).toISOString()) as Record<string, number>
      const last = db.prepare(`SELECT finished_at AS at FROM memory_graph_runs WHERE channel_id = ?
        AND status IN ('ok', 'partial') ORDER BY finished_at DESC LIMIT 1`).get(channelId) as { at?: string } | undefined
      return {
        entities: Number(counts.entities ?? 0),
        edges: Number(counts.edges ?? 0),
        communities: Number(counts.communities ?? 0),
        provisionalEntities: Number(counts.provisionalEntities ?? 0),
        provisionalEdges: Number(counts.provisionalEdges ?? 0),
        orphanEdges: Number(counts.orphanEdges ?? 0),
        staleRuns: Number(counts.staleRuns ?? 0),
        lastRunAt: last?.at ?? null,
      }
    },

    ensureEntityVec(dims) {
      if (vecReady) return true
      if (!Number.isFinite(dims) || dims <= 0) return false
      try {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_entities_vec USING vec0(
          embedding float[${Math.round(dims)}], channel_id TEXT partition key, +entity_rowid INTEGER)`)
        vecInsert = db.prepare('INSERT INTO memory_entities_vec(embedding, channel_id, entity_rowid) VALUES (?, ?, ?)')
        vecSearchStmt = db.prepare('SELECT entity_rowid, distance FROM memory_entities_vec WHERE channel_id = ? AND embedding MATCH ? AND k = ?')
        vecDeleteStmt = db.prepare('DELETE FROM memory_entities_vec WHERE entity_rowid = ?')
        vecReady = true
        return true
      }
      catch {
        vecReady = false
        return false
      }
    },
    get entityVecReady() {
      return vecReady
    },
    entityVecSet(entityRowid, channelId, vec) {
      if (!vecReady || !vecInsert) return
      try {
        vecDeleteStmt?.run(entityRowid)
        vecInsert.run(vec, channelId, entityRowid)
      }
      catch { /* 向量失败静默降级 FTS */ }
    },
    entityVecSearch(channelId, vec, k) {
      if (!vecReady || !vecSearchStmt) return []
      try {
        return vecSearchStmt.all(channelId, vec, Math.max(1, Math.min(k, 50))) as unknown as Array<{ entityRowid: number, distance: number }>
      }
      catch {
        return []
      }
    },
    entityVecDelete(entityRowid) {
      if (!vecReady || !vecDeleteStmt) return
      try {
        vecDeleteStmt.run(entityRowid)
      }
      catch { /* ignore */ }
    },
    entityRowid(id) {
      const row = db.prepare('SELECT rowid AS r FROM memory_entities WHERE id = ?').get(id) as { r?: number } | undefined
      return row?.r ?? null
    },
  }
  return repo
}
