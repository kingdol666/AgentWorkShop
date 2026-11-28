/**
 * 图谱管理面服务：子图/详情/人工 CRUD/合并候选/社区/运行/设置。
 * 权限与审计在 API 层；本层只做 channel 归属校验、CAS/错误映射、快照。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../../utils/errors'
import { recordOps } from '../../ops/ops'
import { createMemoryGraphRepo, type GraphQueryScope, type GraphRepo } from './repo'
import { runMemoryGraphConsolidation } from './agent'
import { loadSubgraph, type GraphSubgraphOptions } from './retrieval'
import { canonicalRelation, isEntityType, isGraphRelation } from './normalize'
import { memoryGraphSchedulerConfig } from './scheduler'
import type {
  GraphEdge,
  GraphEntity,
  GraphEntityStatus,
  GraphPartitionSpec,
  GraphPolarity,
  GraphRelation,
  GraphRun,
} from './types'

export interface GraphActor {
  id: string
  name: string
}

export interface GraphService {
  readonly available: boolean
  subgraph(channelId: string, opts: GraphSubgraphOptions): ReturnType<typeof loadSubgraph>
  listEntities(channelId: string, opts?: { q?: string, types?: string[], statuses?: string[], limit?: number, offset?: number } & GraphQueryScope): { items: GraphEntity[], total: number }
  listEdges(channelId: string, opts?: { q?: string, relations?: string[], statuses?: string[], limit?: number, offset?: number } & GraphQueryScope): { items: GraphEdge[], total: number }
  entityDetail(channelId: string, entityId: string): Record<string, unknown>
  edgeDetail(channelId: string, edgeId: string): Record<string, unknown>
  createEntity(channelId: string, input: Record<string, unknown>, actor: GraphActor): GraphEntity
  updateEntity(channelId: string, entityId: string, input: Record<string, unknown>, actor: GraphActor): GraphEntity
  deleteEntity(channelId: string, entityId: string, actor: GraphActor, reason?: string): void
  restoreEntity(channelId: string, entityId: string, actor: GraphActor): GraphEntity
  mergeEntity(channelId: string, entityId: string, targetId: string, actor: GraphActor): unknown
  unmergeEntity(channelId: string, entityId: string, actor: GraphActor): GraphEntity
  createEdge(channelId: string, input: Record<string, unknown>, actor: GraphActor): GraphEdge
  updateEdge(channelId: string, edgeId: string, input: Record<string, unknown>, actor: GraphActor): GraphEdge
  rejectEdge(channelId: string, edgeId: string, input: Record<string, unknown>, actor: GraphActor): GraphEdge
  deleteEdge(channelId: string, edgeId: string, actor: GraphActor, reason?: string): void
  restoreEdge(channelId: string, edgeId: string, actor: GraphActor): GraphEdge
  mergeCandidates(channelId: string, status?: string): Array<Record<string, unknown>>
  acceptCandidate(channelId: string, candidateId: string, actor: GraphActor): unknown
  rejectCandidate(channelId: string, candidateId: string, actor: GraphActor): void
  communities(channelId: string): Array<Record<string, unknown>>
  communityDetail(channelId: string, communityId: string): Record<string, unknown>
  runs(channelId: string, limit?: number): GraphRun[]
  getRun(channelId: string, runId: string): Record<string, unknown>
  startRun(channelId: string, mode: 'incremental' | 'full', actor: GraphActor, partition?: GraphPartitionSpec): { runId: string }
  settings(channelId: string): Record<string, unknown>
  updateSettings(channelId: string, input: Record<string, unknown>, actor: GraphActor): Record<string, unknown>
}

function fail(status: number, code: string, message: string): never {
  throw new AppError(status, code, message)
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function asBool(v: unknown): boolean | undefined {
  if (v === undefined) return undefined
  return v === true || v === 1 || v === '1'
}

function channelLine(db: DatabaseSync, channelId: string): string {
  try {
    const row = db.prepare('SELECT COALESCE(line_id, \'\') AS lineId FROM channels WHERE id = ?').get(channelId) as { lineId?: string } | undefined
    return row?.lineId ?? ''
  }
  catch {
    return ''
  }
}

export function createMemoryGraphService(db: DatabaseSync): GraphService {
  const repo: GraphRepo = createMemoryGraphRepo(db)

  function requireEntity(channelId: string, id: string): GraphEntity {
    const entity = repo.getEntity(id, false)
    if (!entity || entity.channelId !== channelId) fail(404, 'GRAPH_ENTITY_NOT_FOUND', '图谱实体不存在')
    return entity
  }

  function requireEdge(channelId: string, id: string): GraphEdge {
    const edge = repo.getEdge(id)
    if (!edge || edge.channelId !== channelId) fail(404, 'GRAPH_EDGE_NOT_FOUND', '图谱关系不存在')
    return edge
  }

  function audit(channelId: string, actor: GraphActor, action: string, targetKind: string, targetId: string, summary: string): void {
    try {
      recordOps({
        actor: actor.id, actorName: actor.name, actorKind: 'user', action,
        kind: 'system', targetKind, targetId,
        summary: summary.slice(0, 400), lineId: channelLine(db, channelId),
      })
    }
    catch { /* 审计失败不影响主流程 */ }
  }

  function mapConflict(err: unknown): never {
    if (err instanceof AppError) throw err
    const e = err as { code?: string, currentRevision?: number, message?: string }
    if (e?.code === 'REVISION_CONFLICT') {
      throw new AppError(409, 'GRAPH_REVISION_CONFLICT', `版本冲突，当前 revision=${e.currentRevision ?? '?'}`)
    }
    throw new AppError(400, 'GRAPH_INVALID', e?.message ?? '图谱操作失败')
  }

  return {
    available: repo.available,

    subgraph(channelId, opts) {
      return loadSubgraph(repo, channelId, opts)
    },

    listEntities(channelId, opts = {}) {
      const items = repo.listEntities(channelId, {
        q: opts.q, types: opts.types, statuses: opts.statuses,
        scopeKinds: opts.scopeKinds, scopeKeys: opts.scopeKeys, ownerUserId: opts.ownerUserId,
        limit: opts.limit ?? 100, offset: opts.offset ?? 0,
      })
      return {
        items,
        total: repo.countEntities(channelId, {
          scopeKinds: opts.scopeKinds, scopeKeys: opts.scopeKeys, ownerUserId: opts.ownerUserId,
        }),
      }
    },

    listEdges(channelId, opts = {}) {
      const scope = { scopeKinds: opts.scopeKinds, scopeKeys: opts.scopeKeys, ownerUserId: opts.ownerUserId }
      let items = repo.listEdges(channelId, {
        ...scope, relations: opts.relations, statuses: opts.statuses,
        limit: opts.limit ?? 200, offset: opts.offset ?? 0,
      })
      if (opts.q?.trim()) {
        const q = opts.q.trim().toLowerCase()
        items = items.filter(e => e.fact.toLowerCase().includes(q) || e.relation.includes(q))
      }
      return { items, total: repo.countEdges(channelId, scope) }
    },

    entityDetail(channelId, entityId) {
      const entity = requireEntity(channelId, entityId)
      const aliases = repo.listAliases(entityId)
      const mentions = repo.listMentions(entityId, 100).map((m) => {
        const row = db.prepare('SELECT id, title, kind, status, updated_at AS updatedAt FROM agent_memories WHERE id = ?')
          .get(m.memoryId) as { id?: string, title?: string, kind?: string, status?: string, updatedAt?: string } | undefined
        return { ...m, memoryTitle: row?.title ?? '', memoryKind: row?.kind ?? '', memoryStatus: row?.status ?? '', memoryUpdatedAt: row?.updatedAt ?? '' }
      })
      const out = repo.listEdges(channelId, { srcId: entityId, limit: 200 })
      const inc = repo.listEdges(channelId, { dstId: entityId, limit: 200 })
      const edgeIds = [...new Set([...out, ...inc].map(e => e.id))]
      const edges = edgeIds.map(id => repo.getEdge(id)).filter((e): e is GraphEdge => Boolean(e))
      const otherIds = [...new Set(edges.flatMap(e => [e.srcId, e.dstId]).filter(id => id !== entityId))]
      const others = new Map(repo.listEntitiesByIds(otherIds).map(e => [e.id, e]))
      const community = repo.communityForEntity(entityId)
      return {
        entity,
        aliases,
        mentions,
        edges: edges.map(e => ({
          ...e,
          other: others.get(e.srcId === entityId ? e.dstId : e.srcId)?.canonicalName ?? '',
          direction: e.srcId === entityId ? 'out' : 'in',
        })),
        community,
        revisions: repo.listRevisions('entity', entityId),
      }
    },

    edgeDetail(channelId, edgeId) {
      const edge = requireEdge(channelId, edgeId)
      const entities = new Map(repo.listEntitiesByIds([edge.srcId, edge.dstId]).map(e => [e.id, e]))
      const evidence = repo.listEvidence(edgeId)
      const claimIds = [...new Set(evidence.map(e => e.claimId).filter(Boolean))]
      const claims = claimIds.length > 0
        ? db.prepare(`SELECT claim_id AS claimId, verdict, effect, ci_low AS ciLow, ci_high AS ciHigh,
              from_value AS fromValue, to_value AS toValue, unit, observed_at AS observedAt
            FROM experience_claims WHERE claim_id IN (${claimIds.map(() => '?').join(',')})`).all(...claimIds)
        : []
      return {
        edge,
        source: entities.get(edge.srcId) ?? null,
        target: entities.get(edge.dstId) ?? null,
        evidence,
        claims,
        revisions: repo.listRevisions('edge', edgeId),
      }
    },

    createEntity(channelId, input, actor) {
      const name = asString(input.name ?? input.canonicalName)
      const type = asString(input.type ?? input.entityType) || 'concept'
      if (!name) fail(422, 'GRAPH_ENTITY_NAME_REQUIRED', '实体名不能为空')
      if (!isEntityType(type)) fail(422, 'GRAPH_ENTITY_TYPE_INVALID', '实体类型非法')
      const scopeKind = asString(input.scopeKind) || 'channel'
      if (!['channel', 'session', 'line', 'product', 'global'].includes(scopeKind)) fail(422, 'GRAPH_SCOPE_INVALID', 'scopeKind 非法')
      const owner = (db.prepare('SELECT COALESCE(owner_user_id, \'\') AS owner FROM channels WHERE id = ?').get(channelId) as { owner?: string } | undefined)?.owner ?? ''
      let scopeKey = asString(input.scopeKey)
      if (scopeKind === 'global') scopeKey = owner
      if (scopeKind === 'session' && !scopeKey) fail(422, 'GRAPH_SESSION_REQUIRED', 'session 作用域需要 scopeKey=sessionId')
      if (scopeKind === 'session') {
        const session = db.prepare('SELECT id FROM channel_sessions WHERE id = ? AND channel_id = ?').get(scopeKey, channelId)
        if (!session) fail(404, 'SESSION_NOT_FOUND', '会话不存在或不属于该频道')
      }
      if (scopeKind === 'line') {
        const line = channelLine(db, channelId)
        if (!line || scopeKey !== line) fail(422, 'GRAPH_LINE_INVALID', 'line 作用域必须是本频道绑定的产线')
      }
      if (scopeKind === 'product') {
        if (!scopeKey) fail(422, 'GRAPH_PRODUCT_REQUIRED', 'product 作用域需要 scopeKey=产品 id')
        let bound: unknown
        try {
          bound = db.prepare('SELECT 1 AS ok FROM channel_product_bindings WHERE channel_id = ? AND product_id = ? LIMIT 1')
            .get(channelId, scopeKey)
        }
        catch { /* 绑定表缺失时按未绑定处理（旧库） */ }
        if (!bound) fail(422, 'GRAPH_PRODUCT_INVALID', 'product 作用域必须是本频道已绑定的产品')
      }
      const existing = repo.findEntityByKey(channelId, scopeKind as never, scopeKey, type, asString(input.canonicalKey) || name.toLowerCase())
      if (existing) fail(409, 'GRAPH_ENTITY_EXISTS', '同作用域实体已存在')
      const result = repo.upsertEntity({
        channelId, ownerUserId: owner, scopeKind: scopeKind as never, scopeKey,
        productId: asString(input.productId), entityType: type, canonicalName: name,
        canonicalKey: asString(input.canonicalKey) || undefined,
        aliases: Array.isArray(input.aliases) ? input.aliases.map(String) : [],
        summary: asString(input.summary), confidence: asNumber(input.confidence) ?? 1,
        salience: asNumber(input.salience) ?? 0.6, status: 'active',
        locked: asBool(input.locked) ?? false, authorKind: 'human', authorId: actor.id,
        sourceKind: 'human', validFrom: asString(input.validFrom) || new Date().toISOString(),
      })
      audit(channelId, actor, 'memory.graph.entity.create', 'memory-entity', result.entity.id, `创建图谱实体 ${name}`)
      return result.entity
    },

    updateEntity(channelId, entityId, input, actor) {
      requireEntity(channelId, entityId)
      const expectedRevision = asNumber(input.expectedRevision)
      const patch: Record<string, unknown> = { expectedRevision }
      if (input.name !== undefined || input.canonicalName !== undefined) patch.canonicalName = asString(input.name ?? input.canonicalName)
      if (input.type !== undefined || input.entityType !== undefined) {
        const t = asString(input.type ?? input.entityType)
        if (!isEntityType(t)) fail(422, 'GRAPH_ENTITY_TYPE_INVALID', '实体类型非法')
        patch.entityType = t
      }
      if (input.aliases !== undefined) patch.aliases = Array.isArray(input.aliases) ? input.aliases.map(String) : []
      if (input.summary !== undefined) patch.summary = asString(input.summary)
      if (input.status !== undefined) patch.status = asString(input.status) as GraphEntityStatus
      if (input.locked !== undefined) patch.locked = asBool(input.locked)
      if (input.validFrom !== undefined) patch.validFrom = asString(input.validFrom) || null
      if (input.validTo !== undefined) patch.validTo = asString(input.validTo) || null
      try {
        const entity = repo.updateEntity(entityId, patch as never, { kind: 'human', id: actor.id })
        audit(channelId, actor, 'memory.graph.entity.update', 'memory-entity', entityId, `编辑图谱实体 ${entity.canonicalName}`)
        return entity
      }
      catch (err) { mapConflict(err) }
    },

    deleteEntity(channelId, entityId, actor, reason = '') {
      requireEntity(channelId, entityId)
      repo.softDeleteEntity(entityId, { kind: 'human', id: actor.id }, reason)
      audit(channelId, actor, 'memory.graph.entity.delete', 'memory-entity', entityId, `删除图谱实体：${reason}`)
    },

    restoreEntity(channelId, entityId, actor) {
      requireEntity(channelId, entityId)
      repo.restoreEntity(entityId, { kind: 'human', id: actor.id })
      const entity = requireEntity(channelId, entityId)
      audit(channelId, actor, 'memory.graph.entity.restore', 'memory-entity', entityId, '恢复图谱实体')
      return entity
    },

    mergeEntity(channelId, entityId, targetId, actor) {
      const source = requireEntity(channelId, entityId)
      const target = requireEntity(channelId, targetId)
      const result = repo.mergeEntity(source.id, target.id, { kind: 'human', id: actor.id })
      audit(channelId, actor, 'memory.graph.entity.merge', 'memory-entity', entityId, `合并 ${source.canonicalName} → ${target.canonicalName}`)
      return result
    },

    unmergeEntity(channelId, entityId, actor) {
      requireEntity(channelId, entityId)
      const entity = repo.unmergeEntity(entityId, { kind: 'human', id: actor.id })
      audit(channelId, actor, 'memory.graph.entity.unmerge', 'memory-entity', entityId, '取消合并')
      return entity
    },

    createEdge(channelId, input, actor) {
      const srcId = asString(input.srcId ?? input.sourceId)
      const dstId = asString(input.dstId ?? input.targetId)
      if (!srcId || !dstId) fail(422, 'GRAPH_EDGE_ENDPOINTS_REQUIRED', '关系两端不能为空')
      const src = requireEntity(channelId, srcId)
      const dst = requireEntity(channelId, dstId)
      if (src.id === dst.id) fail(422, 'GRAPH_EDGE_SELF', '不能创建自环')
      const rawRelation = asString(input.relation) || 'relates_to'
      const relation = isGraphRelation(rawRelation) ? rawRelation as GraphRelation : canonicalRelation(rawRelation).relation
      const fact = asString(input.fact)
      const result = repo.upsertEdge({
        channelId, scopeKind: src.scopeKind, scopeKey: src.scopeKey, productId: src.productId,
        srcId: src.id, dstId: dst.id, relation,
        relationLabel: asString(input.relationLabel) || rawRelation,
        fact, factKey: asString(input.factKey) || undefined,
        polarity: (asString(input.polarity) || 'positive') as GraphPolarity,
        confidence: asNumber(input.confidence) ?? 1, weight: asNumber(input.weight) ?? 1,
        status: 'active', authorKind: 'human', authorId: actor.id, sourceKind: 'human',
        locked: asBool(input.locked) ?? false,
        evidence: Array.isArray(input.evidenceMemoryIds)
          ? input.evidenceMemoryIds.map(String).filter(Boolean).map(id => ({ memoryId: id, confidence: 1 }))
          : [],
        validFrom: asString(input.validFrom) || new Date().toISOString(),
        validTo: asString(input.validTo) || null,
      })
      if (!result) fail(400, 'GRAPH_EDGE_REJECTED', '关系未写入（端点不存在或证据不足）')
      audit(channelId, actor, 'memory.graph.edge.create', 'memory-edge', result.edge.id, `创建关系 ${src.canonicalName} ${relation} ${dst.canonicalName}`)
      return result.edge
    },

    updateEdge(channelId, edgeId, input, actor) {
      requireEdge(channelId, edgeId)
      const patch: Record<string, unknown> = { expectedRevision: asNumber(input.expectedRevision) }
      if (input.relation !== undefined) {
        const raw = asString(input.relation)
        if (!isGraphRelation(raw)) fail(422, 'GRAPH_RELATION_INVALID', '关系类型非法')
        patch.relation = raw
      }
      if (input.relationLabel !== undefined) patch.relationLabel = asString(input.relationLabel)
      if (input.fact !== undefined) patch.fact = asString(input.fact)
      if (input.polarity !== undefined) patch.polarity = asString(input.polarity) as GraphPolarity
      if (input.confidence !== undefined) patch.confidence = asNumber(input.confidence)
      if (input.weight !== undefined) patch.weight = asNumber(input.weight)
      if (input.status !== undefined) patch.status = asString(input.status)
      if (input.locked !== undefined) patch.locked = asBool(input.locked)
      if (input.validFrom !== undefined) patch.validFrom = asString(input.validFrom) || null
      if (input.validTo !== undefined) patch.validTo = asString(input.validTo) || null
      try {
        const edge = repo.updateEdge(edgeId, patch as never, { kind: 'human', id: actor.id })
        audit(channelId, actor, 'memory.graph.edge.update', 'memory-edge', edgeId, `编辑关系 ${edge.relation}`)
        return edge
      }
      catch (err) { mapConflict(err) }
    },

    rejectEdge(channelId, edgeId, input, actor) {
      const edge = requireEdge(channelId, edgeId)
      const updated = repo.updateEdge(edgeId, {
        status: 'rejected', validTo: new Date().toISOString(),
        expectedRevision: asNumber(input.expectedRevision) ?? edge.revision,
      } as never, { kind: 'human', id: actor.id })
      audit(channelId, actor, 'memory.graph.edge.reject', 'memory-edge', edgeId, `否证关系：${asString(input.reason)}`)
      return updated
    },

    deleteEdge(channelId, edgeId, actor, reason = '') {
      requireEdge(channelId, edgeId)
      repo.softDeleteEdge(edgeId, { kind: 'human', id: actor.id }, reason)
      audit(channelId, actor, 'memory.graph.edge.delete', 'memory-edge', edgeId, `删除关系：${reason}`)
    },

    restoreEdge(channelId, edgeId, actor) {
      const current = requireEdge(channelId, edgeId)
      // 软删行必须清 deleted_at（updateEdge 只改状态，恢复后仍被列表过滤）。
      if (current.deletedAt) {
        repo.restoreEdge(edgeId, { kind: 'human', id: actor.id })
      }
      else {
        repo.updateEdge(edgeId, {
          status: 'active', validTo: null, expectedRevision: current.revision,
        } as never, { kind: 'human', id: actor.id })
      }
      const edge = requireEdge(channelId, edgeId)
      audit(channelId, actor, 'memory.graph.edge.restore', 'memory-edge', edgeId, '恢复关系')
      return edge
    },

    mergeCandidates(channelId, status = 'proposed') {
      return repo.listMergeCandidates(channelId, status)
    },

    acceptCandidate(channelId, candidateId, actor) {
      const row = db.prepare(`SELECT id, channel_id AS channelId, source_entity_id AS sourceId,
          target_entity_id AS targetId, status FROM memory_merge_candidates WHERE id = ?`)
        .get(candidateId) as { id?: string, channelId?: string, sourceId?: string, targetId?: string, status?: string } | undefined
      if (!row || row.channelId !== channelId) fail(404, 'GRAPH_CANDIDATE_NOT_FOUND', '合并候选不存在')
      if (row.status !== 'proposed') fail(409, 'GRAPH_CANDIDATE_CLOSED', '合并候选已处理')
      const result = repo.mergeEntity(row.sourceId!, row.targetId!, { kind: 'human', id: actor.id })
      repo.setMergeCandidateStatus(candidateId, 'accepted')
      audit(channelId, actor, 'memory.graph.merge.accept', 'memory-entity', row.sourceId!, '接受合并候选')
      return result
    },

    rejectCandidate(channelId, candidateId, actor) {
      const row = db.prepare('SELECT channel_id AS channelId, status FROM memory_merge_candidates WHERE id = ?')
        .get(candidateId) as { channelId?: string, status?: string } | undefined
      if (!row || row.channelId !== channelId) fail(404, 'GRAPH_CANDIDATE_NOT_FOUND', '合并候选不存在')
      repo.setMergeCandidateStatus(candidateId, 'rejected')
      audit(channelId, actor, 'memory.graph.merge.reject', 'memory-entity', candidateId, '拒绝合并候选')
    },

    communities(channelId) {
      return repo.listCommunities(channelId, { limit: 200 }).map(c => ({
        ...c, members: repo.communityMembers(c.id).slice(0, 20).map(m => ({ id: m.id, name: m.canonicalName, type: m.entityType })),
      }))
    },

    communityDetail(channelId, communityId) {
      const community = repo.getCommunity(communityId)
      if (!community || community.channelId !== channelId) fail(404, 'GRAPH_COMMUNITY_NOT_FOUND', '社区不存在')
      const members = repo.communityMembers(communityId)
      const ids = new Set(members.map(m => m.id))
      const edges = repo.listEdges(channelId, { limit: 5000 }).filter(e => ids.has(e.srcId) && ids.has(e.dstId)).slice(0, 100)
      return { community, members, edges }
    },

    runs(channelId, limit = 30) {
      return repo.listRuns(channelId, limit)
    },

    getRun(channelId, runId) {
      const run = repo.getRun(runId)
      if (!run || run.channelId !== channelId) fail(404, 'GRAPH_RUN_NOT_FOUND', '整理任务不存在')
      return { ...run }
    },

    startRun(channelId, mode, actor, partition) {
      const p = partition ?? { scopeKind: 'channel' as const, scopeKey: '' }
      const runId = repo.startRun(channelId, mode, p.scopeKind, p.scopeKey ?? '')
      void runMemoryGraphConsolidation(db, channelId, {
        runId,
        partition: p,
        force: mode === 'full',
        useLlm: Boolean(process.env.AW_MEMORY_GRAPH_LLM_URL?.trim() || process.env.AW_MEMORY_CURATOR_LLM_URL?.trim()),
      })
      audit(channelId, actor, 'memory.graph.run.start', 'channel', channelId, `手动整理（${mode}，${p.scopeKind}${p.scopeKey ? `:${p.scopeKey}` : ''}）`)
      return { runId }
    },

    settings(channelId) {
      const state = repo.ensureState(channelId)
      const cfg = memoryGraphSchedulerConfig()
      return {
        enabled: state.enabled,
        intervalMs: cfg.intervalMs,
        initialDelayMs: cfg.initialDelayMs,
        sweepLimit: cfg.sweepLimit,
        useLlm: cfg.useLlm,
        lastRunAt: state.lastRunAt,
        lastFullRebuildAt: state.lastFullRebuildAt,
        entityCount: state.entityCount,
        edgeCount: state.edgeCount,
      }
    },

    updateSettings(channelId, input, actor) {
      if (input.enabled === undefined) fail(422, 'GRAPH_SETTINGS_EMPTY', 'enabled 必填')
      repo.updateState(channelId, { enabled: Boolean(asBool(input.enabled)) })
      audit(channelId, actor, 'memory.graph.settings.update', 'channel', channelId, `图谱自动整理 ${asBool(input.enabled) ? '开启' : '关闭'}`)
      return this.settings(channelId)
    },
  }
}
