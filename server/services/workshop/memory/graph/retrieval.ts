/**
 * 图谱检索：实体种子 → PPR 扩展 → 记忆投影 → RRF 融合（由 recall 调用）。
 *
 * 设计依据：
 *  - HippoRAG 的 PPR + passage projection（多跳一次完成）；
 *  - Zep/Graphiti 的混合检索（BM25/cosine/graph）；
 *  - 不改变现有 recall 的评分/MMR，只在 collectHits 的 RRF 汇聚点加一路 graph 榜。
 *
 * 降级：任何异常/超时（>60ms）返回空；不影响 FTS/向量。
 */
import { buildMatchQuery } from '../../runtime/memory/helpers'
import { TEAM_SENTINEL } from '../../runtime/memory/memory-scopes'
import type { MemoryScopeKind } from '../../db/database'
import { normalizeEntityKey } from './normalize'
import type { GraphRepo } from './repo'
import {
  RELATION_WEIGHT,
  type GraphDigest,
  type GraphEdge,
  type GraphEntity,
  type GraphRetrievalResult,
  type GraphSeed,
  type GraphSubgraph,
} from './types'

const DEFAULT_SCOPE_KINDS: MemoryScopeKind[] = ['channel', 'line', 'product', 'global']
const MAX_SEEDS = 8
const MAX_NODES = 300
const MAX_EDGES = 1200
const MAX_HOPS = 2
const PPR_ALPHA = 0.85
const PPR_ITERATIONS = 20
const PPR_EPS = 1e-6
const GRAPH_DEADLINE_MS = 60

export interface GraphRetrievalOptions {
  asOf?: string | null
  qv?: Float32Array | null
  scopeKinds?: MemoryScopeKind[]
  scopeKeys?: string[]
  ownerUserId?: string
  seedLimit?: number
  limitNodes?: number
  limitEdges?: number
  maxHops?: number
  alpha?: number
  maxIterations?: number
  /**
   * viewer agent（2026-11-28 审核轮缺口收口）：给定时，session/channel 分区的实体必须
   * 有 ≥1 条存活 mention 来自 viewer 本人或 __team__ 才可见 —— 与 inScope 的 agent 归属
   * 过滤对齐；line/product/global 是显式跨 agent 共享档（agentIn=any），不过滤。
   * 零 mention 实体 fail-closed。REST（owner 面）不传，保持全量。
   */
  viewerAgentId?: string
}

function cjkBigrams(text: string): string[] {
  const runs = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []
  const out: string[] = []
  for (const run of runs) {
    if (run.length <= 6) out.push(run)
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

/** 查询词：整串 + ASCII 词 + CJK bigram；用于 alias_key 精确匹配。 */
export function queryTerms(query: string): string[] {
  const compact = String(query ?? '').normalize('NFKC').toLowerCase().trim()
  if (!compact) return []
  const set = new Set<string>()
  const whole = normalizeEntityKey(compact)
  if (whole.length >= 2) set.add(whole)
  for (const token of compact.split(/[^\p{L}\p{N}]+/u)) {
    const key = normalizeEntityKey(token)
    if (key.length >= 2) set.add(key)
  }
  for (const gram of cjkBigrams(compact)) {
    const key = normalizeEntityKey(gram)
    if (key.length >= 2) set.add(key)
  }
  return [...set].slice(0, 24)
}

function scopeAllowed(entity: GraphEntity, allowed: Set<string>, keys?: string[], ownerUserId?: string): boolean {
  if (!allowed.has(entity.scopeKind)) return false
  if (keys && keys.length > 0 && !keys.includes(entity.scopeKey)) return false
  if (entity.scopeKind === 'global' && ownerUserId && entity.ownerUserId !== ownerUserId) return false
  return true
}

/** 可作为检索/投影节点的实体：软删、已合并、人工否决一律不参与。 */
export function usableEntity(entity: GraphEntity | null | undefined): entity is GraphEntity {
  return Boolean(entity && !entity.deletedAt && !entity.mergedInto
    && (entity.status === 'active' || entity.status === 'provisional'))
}

/**
 * Agent 视角的图可见性（与 inScope 的 agent 归属过滤对齐）。
 * session/channel 分区的实体可能由同会话/同频道**其他 agent** 的私有记忆派生
 * （物化源 SQL 只按分区过滤）。原始记忆在 FTS 面有 agent 过滤，图谱派生面
 * （实体名/事实/社区摘要）此前没有对应物。viewer 给定时：
 *  - session/channel 分区：≥1 条存活 mention 来自 viewer 或 __team__ 才可见；
 *  - 其余分区（line/product/global）：显式跨 agent 共享档，不过滤；
 *  - 零 mention 实体：fail-closed 不可见。
 */
export function filterEntitiesForViewer(
  repo: GraphRepo,
  entities: GraphEntity[],
  viewerAgentId: string | undefined,
): Set<string> {
  const visible = new Set<string>()
  if (!viewerAgentId) {
    for (const e of entities) visible.add(e.id)
    return visible
  }
  const scoped = entities.filter(e => e.scopeKind === 'session' || e.scopeKind === 'channel')
  const agentsByEntity = scoped.length > 0 ? repo.mentionAgentsByEntity(scoped.map(e => e.id)) : new Map()
  for (const e of entities) {
    if (e.scopeKind !== 'session' && e.scopeKind !== 'channel') {
      visible.add(e.id)
      continue
    }
    const agents = agentsByEntity.get(e.id)
    if (agents && (agents.has(viewerAgentId) || agents.has(TEAM_SENTINEL))) visible.add(e.id)
  }
  return visible
}

export function findSeeds(
  repo: GraphRepo,
  channelId: string,
  query: string,
  opts: GraphRetrievalOptions = {},
): GraphSeed[] {
  const allowed = new Set<string>((opts.scopeKinds ?? DEFAULT_SCOPE_KINDS) as string[])
  const seedScope = { scopeKinds: opts.scopeKinds, scopeKeys: opts.scopeKeys, ownerUserId: opts.ownerUserId }
  const seeds = new Map<string, GraphSeed>()
  const add = (entity: GraphEntity, weight: number, reason: GraphSeed['reason']): void => {
    if (!scopeAllowed(entity, allowed, opts.scopeKeys, opts.ownerUserId)) return
    if (entity.deletedAt || entity.mergedInto) return
    if (entity.status !== 'active' && entity.status !== 'provisional') return
    const prev = seeds.get(entity.id)
    if (!prev || weight > prev.weight) seeds.set(entity.id, { entityId: entity.id, weight, reason })
  }

  const terms = queryTerms(query)
  if (terms.length > 0) {
    for (const e of repo.findEntitiesByAlias(channelId, terms, 30, seedScope)) {
      add(e, normalizeEntityKey(e.canonicalName) === normalizeEntityKey(query) ? 1 : 0.9, 'alias')
    }
  }
  const match = buildMatchQuery(query)
  if (match) {
    for (const e of repo.searchEntitiesFts(channelId, match, 20, seedScope)) add(e, 0.8, 'fts')
  }
  if (opts.qv && repo.entityVecReady) {
    const hits = repo.entityVecSearch(channelId, opts.qv, 10)
    const entities = repo.listEntitiesByRowids(hits.map(h => h.entityRowid))
    for (const e of entities) add(e, 0.8, 'vector')
  }
  if (seeds.size === 0 && query.trim()) {
    for (const e of repo.listEntities(channelId, { q: query.trim(), limit: 10, ...seedScope })) add(e, 0.5, 'mention')
  }
  // 子串种子：中文查询常无空格，alias_key 精确匹配不够；用领域术语包含关系补召回。
  if (terms.length > 0 && seeds.size < (opts.seedLimit ?? MAX_SEEDS)) {
    const limit = Math.max(1, opts.seedLimit ?? MAX_SEEDS)
    for (const e of repo.listEntities(channelId, { limit: 500, statuses: ['active', 'provisional'], ...seedScope })) {
      if (e.entityType === 'episode' || e.deletedAt || e.mergedInto) continue
      const key = normalizeEntityKey(e.canonicalName)
      if (key.length < 2) continue
      if (terms.some(t => t.length >= 2 && (key.includes(t) || t.includes(key)))) {
        add(e, 0.45, 'mention')
      }
      if (seeds.size >= limit) break
    }
  }
  return [...seeds.values()]
    .sort((a, b) => b.weight - a.weight || a.entityId.localeCompare(b.entityId))
    .slice(0, Math.max(1, opts.seedLimit ?? MAX_SEEDS))
}

interface Expanded {
  entityScores: Map<string, number>
  edges: GraphEdge[]
}

export function expandGraph(
  repo: GraphRepo,
  channelId: string,
  seeds: GraphSeed[],
  opts: GraphRetrievalOptions = {},
): Expanded {
  if (seeds.length === 0) return { entityScores: new Map(), edges: [] }
  const allowed = new Set<string>((opts.scopeKinds ?? DEFAULT_SCOPE_KINDS) as string[])
  const limitNodes = Math.max(1, opts.limitNodes ?? MAX_NODES)
  const limitEdges = Math.max(1, opts.limitEdges ?? MAX_EDGES)
  const maxHops = Math.max(1, opts.maxHops ?? MAX_HOPS)
  const asOf = opts.asOf ?? null
  const allEdges = repo.listEdges(channelId, {
    statuses: ['active', 'provisional'],
    asOf,
    scopeKinds: opts.scopeKinds,
    scopeKeys: opts.scopeKeys,
    ownerUserId: opts.ownerUserId,
    limit: 15000,
  }).filter(e => allowed.has(e.scopeKind) && RELATION_WEIGHT[e.relation] > 0)

  const adjacency = new Map<string, Map<string, number>>()
  const ensure = (id: string): Map<string, number> => {
    if (!adjacency.has(id)) adjacency.set(id, new Map())
    return adjacency.get(id)!
  }
  for (const e of allEdges) {
    if (e.srcId === e.dstId) continue
    const w = RELATION_WEIGHT[e.relation] * Math.max(0.05, e.confidence) * Math.max(0.1, e.weight ?? 1)
    if (w <= 0) continue
    ensure(e.srcId).set(e.dstId, (ensure(e.srcId).get(e.dstId) ?? 0) + w)
    ensure(e.dstId).set(e.srcId, (ensure(e.dstId).get(e.srcId) ?? 0) + w)
  }

  // BFS 限制诱导子图规模；随后一次性裁掉软删/已合并/否决实体（≤ limitNodes 个，单次查询）。
  const nodes = new Set<string>(seeds.map(s => s.entityId))
  const depth = new Map<string, number>(seeds.map(s => [s.entityId, 0]))
  const queue = seeds.map(s => s.entityId).sort()
  while (queue.length > 0) {
    const id = queue.shift()!
    const d = depth.get(id) ?? 0
    if (d >= maxHops) continue
    const neighbors = adjacency.get(id)
    if (!neighbors) continue
    for (const to of [...neighbors.keys()].sort()) {
      if (!nodes.has(to)) {
        if (nodes.size >= limitNodes) break
        nodes.add(to)
        depth.set(to, d + 1)
        queue.push(to)
      }
    }
    if (nodes.size >= limitNodes) break
  }
  const nodeEntities = repo.listEntitiesByIds([...nodes])
  const usableNodeIds = new Set(nodeEntities.filter(usableEntity).map(e => e.id))
  for (const id of [...nodes]) {
    if (!usableNodeIds.has(id)) nodes.delete(id)
  }
  const edges = allEdges.filter(e => nodes.has(e.srcId) && nodes.has(e.dstId)).slice(0, limitEdges)

  // PPR
  const alpha = Math.max(0.05, Math.min(0.95, opts.alpha ?? PPR_ALPHA))
  const iterations = Math.max(1, opts.maxIterations ?? PPR_ITERATIONS)
  const restart = new Map<string, number>()
  let seedSum = 0
  for (const s of seeds) {
    if (!nodes.has(s.entityId)) continue
    restart.set(s.entityId, (restart.get(s.entityId) ?? 0) + s.weight)
    seedSum += s.weight
  }
  if (seedSum <= 0) return { entityScores: new Map(), edges }
  for (const [id, w] of restart) restart.set(id, w / seedSum)

  let rank = new Map(restart)
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>()
    for (const [id, w] of restart) next.set(id, (1 - alpha) * w)
    for (const [id, value] of rank) {
      if (value <= 0) continue
      const neighbors = adjacency.get(id)
      if (!neighbors || neighbors.size === 0) continue
      let sum = 0
      for (const w of neighbors.values()) sum += w
      if (sum <= 0) continue
      for (const [to, w] of neighbors) {
        if (!nodes.has(to)) continue
        next.set(to, (next.get(to) ?? 0) + alpha * value * (w / sum))
      }
    }
    let diff = 0
    for (const [id, v] of next) diff += Math.abs(v - (rank.get(id) ?? 0))
    rank = next
    if (diff < PPR_EPS) break
  }
  let total = 0
  for (const v of rank.values()) total += v
  if (total > 0) for (const [id, v] of rank) rank.set(id, v / total)
  return { entityScores: rank, edges }
}

export function projectToMemories(
  repo: GraphRepo,
  entityScores: Map<string, number>,
  edges: GraphEdge[],
): Map<string, { score: number, entityIds: string[], edgeIds: string[] }> {
  const out = new Map<string, { score: number, entityIds: string[], edgeIds: string[] }>()
  const add = (memoryId: string, score: number, entityId?: string, edgeId?: string): void => {
    if (!memoryId || score <= 0) return
    const cur = out.get(memoryId) ?? { score: 0, entityIds: [], edgeIds: [] }
    cur.score += score
    if (entityId && !cur.entityIds.includes(entityId) && cur.entityIds.length < 10) cur.entityIds.push(entityId)
    if (edgeId && !cur.edgeIds.includes(edgeId) && cur.edgeIds.length < 10) cur.edgeIds.push(edgeId)
    out.set(memoryId, cur)
  }
  const entities = repo.listEntitiesByIds([...entityScores.keys()])
  for (const entity of entities) {
    if (!usableEntity(entity)) continue
    const score = entityScores.get(entity.id) ?? 0
    if (score <= 0) continue
    if (entity.memoryId) add(entity.memoryId, score * 0.9, entity.id)
    const count = repo.countMentions(entity.id)
    for (const mention of repo.listMentions(entity.id, 50)) {
      add(mention.memoryId, score * mention.confidence / Math.sqrt(1 + count), entity.id)
    }
  }
  const topEdges = [...edges]
    .map(e => ({ e, s: (entityScores.get(e.srcId) ?? 0) + (entityScores.get(e.dstId) ?? 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 200)
  for (const { e, s } of topEdges) {
    for (const evidence of repo.listEvidence(e.id)) {
      add(evidence.memoryId, s * evidence.confidence * 0.25, e.srcId, e.id)
    }
  }
  return out
}

export function graphRetrieve(
  repo: GraphRepo,
  channelId: string,
  query: string,
  opts: GraphRetrievalOptions = {},
): GraphRetrievalResult {
  const started = Date.now()
  try {
    const seeds = findSeeds(repo, channelId, query, opts)
    if (seeds.length === 0) {
      return { memoryScores: new Map(), entityScores: new Map(), edges: [], seedIds: [], durationMs: Date.now() - started }
    }
    const expanded = expandGraph(repo, channelId, seeds, opts)
    // viewer 过滤（先于记忆投影）：隐藏实体的 mention/证据不得把他人私有记忆带进投影。
    const visible = filterEntitiesForViewer(repo, repo.listEntitiesByIds([...expanded.entityScores.keys()]), opts.viewerAgentId)
    const entityScores = new Map([...expanded.entityScores].filter(([id]) => visible.has(id)))
    const edges = opts.viewerAgentId
      ? expanded.edges.filter(e => visible.has(e.srcId) && visible.has(e.dstId))
      : expanded.edges
    const memoryScores = projectToMemories(repo, entityScores, edges)
    return {
      memoryScores,
      entityScores,
      edges,
      seedIds: seeds.map(s => s.entityId),
      durationMs: Date.now() - started,
    }
  }
  catch {
    return { memoryScores: new Map(), entityScores: new Map(), edges: [], seedIds: [], durationMs: Date.now() - started }
  }
}

/** 注入摘要：top 2 事实 + top 1 社区标题；≤~160 字符，调用方再计 token。 */
export function buildGraphDigest(
  repo: GraphRepo,
  channelId: string,
  query: string,
  opts: GraphRetrievalOptions & { maxFacts?: number } = {},
): GraphDigest | null {
  const result = graphRetrieve(repo, channelId, query, opts)
  if (result.durationMs > GRAPH_DEADLINE_MS) return null
  const topEntities = [...result.entityScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id)
  if (topEntities.length === 0) return null
  const topSet = new Set(topEntities)
  const candidates = [...result.edges]
    .filter(e => topSet.has(e.srcId) || topSet.has(e.dstId))
    .filter(e => e.relation !== 'mentions')
    .sort((a, b) => (b.confidence * (b.weight ?? 1)) - (a.confidence * (a.weight ?? 1)))
  const entities = repo.listEntitiesByIds([...new Set(candidates.flatMap(e => [e.srcId, e.dstId]))])
  const usable = new Map(entities.filter(usableEntity).map(e => [e.id, e]))
  const facts = candidates
    .filter(e => usable.has(e.srcId) && usable.has(e.dstId))
    .filter(e => repo.edgeEvidenceLive(e.id))
    .slice(0, Math.max(1, Math.min(2, opts.maxFacts ?? 2)))
  if (facts.length === 0) return null
  const nameOf = new Map(entities.map(e => [e.id, e.canonicalName]))
  const lines: string[] = ['## 知识网络（自动汇整）']
  const refs: GraphDigest['refs'] = []
  for (const e of facts) {
    const src = nameOf.get(e.srcId) ?? e.srcId
    const dst = nameOf.get(e.dstId) ?? e.dstId
    // provisional 关系是共现/LLM 候选而非已确认事实；注入时必须显式标注待验证。
    const pending = e.status === 'provisional' ? '（待验证）' : ''
    lines.push(`- ${pending}${src} --${e.relation}--> ${dst}${e.fact ? `：${e.fact.slice(0, 60)}` : ''}`)
    refs.push({ id: e.id, kind: 'graph-edge', scopeKind: e.scopeKind, scopeKey: e.scopeKey })
  }
  const community = repo.communityForEntity(topEntities[0]!)
  if (community) {
    // viewer 给定时，社区摘要也来自成员记忆的改写：至少一个可见成员才随 digest 出去。
    const members = repo.communityMembers(community.id)
    const visibleMembers = filterEntitiesForViewer(repo, members, opts.viewerAgentId)
    if (visibleMembers.size > 0) {
      lines.push(`- 社区：${community.title}（${community.memberCount} 个实体）`)
      refs.push({ id: community.id, kind: 'graph-community', scopeKind: community.scopeKind, scopeKey: community.scopeKey })
    }
  }
  return { text: lines.join('\n').slice(0, 420), refs }
}

export interface GraphSubgraphOptions {
  q?: string
  entity?: string
  depth?: number
  asOf?: string | null
  scopeKinds?: MemoryScopeKind[]
  scopeKeys?: string[]
  ownerUserId?: string
  types?: string[]
  relations?: string[]
  statuses?: string[]
  limit?: number
  /** 是否显示 episode（记忆片段）节点；默认 false，实体网络更清晰 */
  includeEpisodes?: boolean
  /** viewer agent（session/channel 分区按 mention 归属过滤；见 GraphRetrievalOptions.viewerAgentId） */
  viewerAgentId?: string
}

/** UI 子图：有 q/entity 走种子扩展；否则取显著实体 + 1 跳。 */
export function loadSubgraph(repo: GraphRepo, channelId: string, opts: GraphSubgraphOptions = {}): GraphSubgraph {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 250)
  const allowed = new Set<string>((opts.scopeKinds ?? DEFAULT_SCOPE_KINDS) as string[])
  const repoScope = { scopeKinds: opts.scopeKinds, scopeKeys: opts.scopeKeys, ownerUserId: opts.ownerUserId }
  const asOf = opts.asOf ?? null
  const seedEntity = opts.entity ? repo.getEntity(opts.entity) : null
  const query = opts.q?.trim() || ''
  let seeds: GraphSeed[] = []
  // 跨频道 id 守卫：scopeAllowed 只看分区，channel 档的 scopeKey 恒为 ''，不校验频道会串图。
  if (seedEntity && seedEntity.channelId === channelId && usableEntity(seedEntity)
    && scopeAllowed(seedEntity, allowed, opts.scopeKeys, opts.ownerUserId)) {
    seeds = [{ entityId: seedEntity.id, weight: 1, reason: 'canonical' }]
  }
  else if (query) {
    seeds = findSeeds(repo, channelId, query, {
      asOf, scopeKinds: opts.scopeKinds, scopeKeys: opts.scopeKeys, ownerUserId: opts.ownerUserId, seedLimit: 8,
      viewerAgentId: opts.viewerAgentId,
    })
  }
  let nodes: GraphEntity[]
  let edges: GraphEdge[]
  if (seeds.length > 0) {
    const expanded = expandGraph(repo, channelId, seeds, {
      asOf, scopeKinds: opts.scopeKinds, scopeKeys: opts.scopeKeys, ownerUserId: opts.ownerUserId,
      limitNodes: limit, limitEdges: Math.max(limit * 3, 300),
      maxHops: Math.max(1, Math.min(2, opts.depth ?? 2)),
      viewerAgentId: opts.viewerAgentId,
    })
    const ids = [...expanded.entityScores.keys()]
    nodes = repo.listEntitiesByIds(ids)
      .filter(e => e.channelId === channelId && usableEntity(e) && scopeAllowed(e, allowed, opts.scopeKeys, opts.ownerUserId))
    edges = expanded.edges
  }
  else {
    nodes = repo.listEntities(channelId, {
      statuses: opts.statuses?.length ? opts.statuses : ['active', 'provisional'],
      types: opts.types,
      scopeKinds: opts.scopeKinds,
      scopeKeys: opts.scopeKeys,
      ownerUserId: opts.ownerUserId,
      limit,
    }).filter(e => usableEntity(e) && scopeAllowed(e, allowed, opts.scopeKeys, opts.ownerUserId))
    if (opts.types?.length) nodes = nodes.filter(e => opts.types!.includes(e.entityType))
    const ids = new Set(nodes.map(n => n.id))
    edges = repo.listEdges(channelId, {
      statuses: opts.statuses?.length ? opts.statuses : ['active', 'provisional'],
      asOf,
      scopeKinds: opts.scopeKinds,
      scopeKeys: opts.scopeKeys,
      ownerUserId: opts.ownerUserId,
      relations: opts.relations,
      limit: Math.max(limit * 4, 400),
    }).filter(e => ids.has(e.srcId) && ids.has(e.dstId)).slice(0, Math.max(limit * 4, 400))
  }
  if (opts.types?.length) nodes = nodes.filter(e => opts.types!.includes(e.entityType))
  if (opts.relations?.length) edges = edges.filter(e => opts.relations!.includes(e.relation))
  if (!opts.includeEpisodes) nodes = nodes.filter(n => n.entityType !== 'episode')
  // viewer 过滤：session/channel 分区的他人派生实体不出子图（与 graphRetrieve 同口径）。
  const visibleNodes = filterEntitiesForViewer(repo, nodes, opts.viewerAgentId)
  if (opts.viewerAgentId) {
    nodes = nodes.filter(n => visibleNodes.has(n.id))
  }
  const nodeIds = new Set(nodes.map(n => n.id))
  edges = edges.filter(e => nodeIds.has(e.srcId) && nodeIds.has(e.dstId)).slice(0, limit * 4)
  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.srcId, (degree.get(e.srcId) ?? 0) + 1)
    degree.set(e.dstId, (degree.get(e.dstId) ?? 0) + 1)
  }
  let communities = repo.listCommunities(channelId, {
    limit: 50, scopeKinds: opts.scopeKinds, scopeKeys: opts.scopeKeys,
  })
  if (opts.viewerAgentId) {
    // 社区摘要来自成员记忆改写：没有可见成员的社区不展示。
    communities = communities.filter((c) => {
      const members = repo.communityMembers(c.id)
      return filterEntitiesForViewer(repo, members, opts.viewerAgentId).size > 0
    })
  }
  const communityByEntity = new Map<string, string>()
  for (const c of communities.slice(0, 20)) {
    for (const m of repo.communityMembers(c.id)) communityByEntity.set(m.id, c.id)
  }
  const totalEntities = repo.countEntities(channelId, repoScope)
  const totalEdges = repo.countEdges(channelId, repoScope)
  return {
    nodes: nodes.map(n => ({ ...n, degree: degree.get(n.id) ?? 0, communityId: communityByEntity.get(n.id) ?? null })),
    edges,
    communities,
    stats: {
      entityTotal: totalEntities,
      edgeTotal: totalEdges,
      communityTotal: communities.length,
      truncated: nodes.length >= limit || totalEntities > nodes.length || totalEdges > edges.length,
      asOf,
      revision: repo.getState(channelId)?.revision ?? 0,
    },
  }
}
