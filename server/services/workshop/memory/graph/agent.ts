/**
 * Memory Consolidation Agent —— 后台整理记忆为知识网络。
 *
 * 形态：进程内服务型 Agent（版本化 prompt + 工具协议 + 运行台账 + 上限），
 * 不占用 ChannelRuntime；LLM 可选，失败/未配置走确定性规则。
 *
 * 流程：增量来源 → 本体/claim 导入 → 别名提及/provisional concept →
 * LLM 抽取（可选）→ 实体解析/合并候选 → 矛盾失效 → 社区 → 状态水位。
 */
import type { DatabaseSync } from 'node:sqlite'
import { allowPrivateOutbound, safeFetch } from '../../net/ssrf'
import {
  canonicalRelation,
  clamp01,
  factKeyOf,
  isEntityType,
  normalizeEntityKey,
  shortHash,
} from './normalize'
import { buildEntityIndex, resolveOrCreateEntity, type EntityIndex } from './resolve'
import { detectCommunitiesWithExisting, summarizeCommunities, type DetectedCommunity } from './communities'
import {
  extractMemoryMentions,
  importClaims,
  importOntology,
  linkEpisodePrecedes,
  loadPublishedOntology,
} from './extract'
import { createMemoryGraphRepo, type GraphRepo } from './repo'
import type {
  GraphEntity,
  GraphEntityType,
  GraphPartitionSpec,
  GraphRelation,
  GraphRun,
} from './types'

export const GRAPH_AGENT_PROMPT_VERSION = 'memory-graph-agent/v1'

const MAX_SOURCES_PER_RUN = 200
const LLM_BATCH = 8
const MAX_LLM_CALLS = 8
const MAX_LLM_ENTITIES = 200
const MAX_LLM_EDGES = 500
const MAX_ENTITIES_PER_CHANNEL = 5000
const MAX_EDGES_PER_CHANNEL = 20000

const running = new Set<string>()

export interface LlmExtraction {
  entities: Array<{ name: string, type: string, aliases: string[], summary: string }>
  relations: Array<{ src: string, dst: string, relation: string, fact: string, polarity: 'positive' | 'negative' | 'neutral', confidence: number, evidence: string[] }>
  invalidations: Array<{ edgeId: string, reason: string, evidence: string[] }>
}

export interface GraphLlmClient {
  extract(input: {
    channelName: string
    sources: Array<{ id: string, title: string, content: string }>
    knownEntities: Array<{ name: string, type: string }>
  }): Promise<{ result: LlmExtraction, inputChars: number } | null>
  summarize(input: { title: string, memberNames: string[], facts: string[] }): Promise<string | null>
}

function llmConfig(): { url: string, key: string, model: string, timeoutMs: number } | null {
  const url = process.env.AW_MEMORY_GRAPH_LLM_URL?.trim() || process.env.AW_MEMORY_CURATOR_LLM_URL?.trim()
  if (!url) return null
  return {
    url,
    key: process.env.AW_MEMORY_GRAPH_LLM_KEY?.trim() ?? process.env.AW_MEMORY_CURATOR_LLM_KEY?.trim() ?? '',
    model: process.env.AW_MEMORY_GRAPH_LLM_MODEL?.trim() || process.env.AW_MEMORY_CURATOR_LLM_MODEL?.trim() || 'gpt-4o-mini',
    timeoutMs: Number(process.env.AW_MEMORY_GRAPH_LLM_TIMEOUT_MS ?? process.env.AW_MEMORY_CURATOR_LLM_TIMEOUT_MS ?? 25_000),
  }
}

async function callJson(cfg: NonNullable<ReturnType<typeof llmConfig>>, system: string, user: string): Promise<unknown | null> {
  try {
    const res = await safeFetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(Math.max(5_000, cfg.timeoutMs)),
    }, { label: 'Memory Graph LLM 服务', allowPrivateHost: allowPrivateOutbound() ? 'true' : 'false' })
    if (!res.ok) return null
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const raw = json.choices?.[0]?.message?.content ?? ''
    if (!raw.trim()) return null
    return JSON.parse(raw) as unknown
  }
  catch {
    return null
  }
}

function validateExtraction(raw: unknown, sourceIds: Set<string>): LlmExtraction | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const entities: LlmExtraction['entities'] = []
  for (const item of Array.isArray(obj.entities) ? obj.entities.slice(0, 30) : []) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const name = String(e.name ?? '').trim()
    if (!name || name.length > 60) continue
    const aliases = Array.isArray(e.aliases)
      ? e.aliases.map(a => String(a).trim()).filter(a => a && a.length <= 60).slice(0, 10)
      : []
    entities.push({
      name,
      type: isEntityType(String(e.type ?? '')) ? String(e.type) : 'concept',
      aliases,
      summary: String(e.summary ?? '').trim().slice(0, 300),
    })
  }
  const relations: LlmExtraction['relations'] = []
  for (const item of Array.isArray(obj.relations) ? obj.relations.slice(0, 40) : []) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const src = String(r.src ?? '').trim()
    const dst = String(r.dst ?? '').trim()
    if (!src || !dst || src === dst) continue
    const evidence = Array.isArray(r.evidence)
      ? r.evidence.map(x => String(x)).filter(x => sourceIds.has(x)).slice(0, 8)
      : []
    if (evidence.length === 0) continue
    const rel = canonicalRelation(String(r.relation ?? '')).relation
    relations.push({
      src, dst, relation: rel,
      fact: String(r.fact ?? '').trim().slice(0, 300),
      polarity: r.polarity === 'negative' ? 'negative' : r.polarity === 'neutral' ? 'neutral' : 'positive',
      confidence: clamp01(Number(r.confidence ?? 0.5)),
      evidence,
    })
  }
  const invalidations: LlmExtraction['invalidations'] = []
  for (const item of Array.isArray(obj.invalidations) ? obj.invalidations.slice(0, 10) : []) {
    if (!item || typeof item !== 'object') continue
    const inv = item as Record<string, unknown>
    const edgeId = String(inv.edgeId ?? '').trim()
    const evidence = Array.isArray(inv.evidence)
      ? inv.evidence.map(x => String(x)).filter(x => sourceIds.has(x)).slice(0, 8)
      : []
    if (!edgeId || evidence.length === 0) continue
    invalidations.push({ edgeId, reason: String(inv.reason ?? '').slice(0, 200), evidence })
  }
  return { entities, relations, invalidations }
}

export function createGraphLlmClient(): GraphLlmClient | null {
  const cfg = llmConfig()
  if (!cfg) return null
  return {
    async extract(input) {
      const system = [
        '你是产线记忆知识整理 Agent。只依据给定来源记忆抽取实体与关系，不要编造。',
        '输出严格 JSON：{"entities":[{"name","type","aliases","summary"}],"relations":[{"src","dst","relation","fact","polarity","confidence","evidence":["m1"]}],"invalidations":[{"edgeId","reason","evidence":["m2"]}]}。',
        'type 只能是 concept/parameter/metric/device/node/recipe/product/line/task/event/document/person；relation 只能是 causes/affects/supports/contradicts/supersedes/part_of/used_for/precedes/has_parameter/uses_recipe/observed_in/relates_to。',
        '每个 relation 的 evidence 必须是来源 id；不确定就不要输出。invalidations 只能指向已存在的边。',
      ].join('\n')
      const digest = input.sources.map(s => `[${s.id}] ${s.title}\n${s.content.slice(0, 500)}`).join('\n---\n')
      const known = input.knownEntities.slice(0, 80).map(e => `${e.name}(${e.type})`).join('；')
      const user = `频道：${input.channelName}\n已知实体：${known || '（无）'}\n来源：\n${digest}`
      const raw = await callJson(cfg, system, user)
      const result = validateExtraction(raw, new Set(input.sources.map(s => s.id)))
      if (!result) return null
      return { result, inputChars: user.length + system.length }
    },
    async summarize(input) {
      const system = '你是产线知识网络社区摘要器。只依据成员与事实写 2–5 句中文摘要，不要编造。输出 JSON：{"summary":"..."}。'
      const user = `社区：${input.title}\n成员：${input.memberNames.join('、')}\n事实：\n${input.facts.join('\n') || '（无）'}`
      const raw = await callJson(cfg, system, user)
      const summary = raw && typeof raw === 'object' ? String((raw as Record<string, unknown>).summary ?? '').trim() : ''
      return summary.length >= 10 ? summary.slice(0, 1200) : null
    },
  }
}

export interface ConsolidationOptions {
  force?: boolean
  useLlm?: boolean
  maxSources?: number
  llm?: GraphLlmClient | null
  /** 外部（API 手动触发）已创建的 run 行；缺省内部新建 */
  runId?: string
  /** 图谱分区；缺省 channel */
  partition?: GraphPartitionSpec
}

export interface ConsolidationResult {
  runId: string
  status: GraphRun['status']
  scanned: number
  entitiesNew: number
  edgesNew: number
  communities: number
  llmCalls: number
  fallbackReason: string
  error: string
}

interface ChannelRow {
  id: string
  name: string
  lineId: string
  ownerUserId: string | null
  accessMode: string
}

function channelOf(db: DatabaseSync, channelId: string): ChannelRow | null {
  try {
    const row = db.prepare(`SELECT id, name, COALESCE(line_id, '') AS lineId,
        owner_user_id AS ownerUserId, COALESCE(memory_access_mode, 'inherit') AS accessMode
      FROM channels WHERE id = ?`).get(channelId) as ChannelRow | undefined
    return row ?? null
  }
  catch {
    return null
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 同 src/dst/relation 的多条 active 事实：新事实使旧事实失效（保留历史） */
function invalidateSupersededFacts(repo: GraphRepo, channelId: string, scope: Parameters<GraphRepo['listEdges']>[1]): number {
  const edges = repo.listEdges(channelId, { statuses: ['active'], limit: 20000, ...scope })
  const groups = new Map<string, typeof edges>()
  for (const e of edges) {
    if (!['affects', 'has_parameter', 'uses_recipe', 'observed_in'].includes(e.relation)) continue
    if (e.authorKind !== 'claim' && e.authorKind !== 'agent') continue
    if (e.sourceKind !== 'claim' && e.sourceKind !== 'llm') continue
    const key = `${e.srcId}|${e.dstId}|${e.relation}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }
  let invalidated = 0
  for (const list of groups.values()) {
    if (list.length < 2) continue
    list.sort((a, b) =>
      String(b.validFrom ?? b.createdAt).localeCompare(String(a.validFrom ?? a.createdAt))
      || b.confidence - a.confidence)
    const newest = list[0]!
    for (const older of list.slice(1)) {
      if (repo.invalidateEdge(older.id, newest.id, newest.validFrom ?? nowIso())) invalidated++
    }
  }
  return invalidated
}

function findByName(index: EntityIndex, name: string): GraphEntity | null {
  const key = normalizeEntityKey(name)
  if (!key) return null
  for (const e of index.all) {
    if (normalizeEntityKey(e.canonicalName) === key) return e
    if (e.aliases.some(a => normalizeEntityKey(a) === key)) return e
  }
  return null
}

function emptyResult(runId: string, status: GraphRun['status'], error = '', fallback = ''): ConsolidationResult {
  return { runId, status, scanned: 0, entitiesNew: 0, edgesNew: 0, communities: 0, llmCalls: 0, fallbackReason: fallback, error }
}

export async function runMemoryGraphConsolidation(
  db: DatabaseSync,
  channelId: string,
  opts: ConsolidationOptions = {},
): Promise<ConsolidationResult> {
  const repo = createMemoryGraphRepo(db)
  if (!repo.available) return emptyResult('', 'failed', 'graph_tables_missing')
  const channel = channelOf(db, channelId)
  const partition = opts.partition ?? { scopeKind: 'channel' as const }
  const scopeKind = partition.scopeKind
  const ownerUserId = channel?.ownerUserId ?? ''
  const scopeKey = scopeKind === 'global'
    ? (partition.ownerUserId ?? partition.scopeKey ?? ownerUserId)
    : (partition.scopeKey ?? '')
  const runId = opts.runId ?? repo.startRun(channelId, opts.force ? 'full' : 'incremental', scopeKind, scopeKey)
  if (!channel) {
    repo.finishRun(runId, { status: 'failed', error: 'channel_missing' })
    return emptyResult(runId, 'failed', 'channel_missing')
  }
  if (channel.accessMode === 'disabled' || channel.accessMode === 'readonly') {
    repo.finishRun(runId, { status: 'skipped_noop', error: `access_mode_${channel.accessMode}` })
    return emptyResult(runId, 'skipped_noop', `access_mode_${channel.accessMode}`)
  }
  if (channel.accessMode === 'isolated' && ['global', 'line', 'product'].includes(scopeKind)) {
    repo.finishRun(runId, { status: 'skipped_noop', error: 'access_mode_isolated' })
    return emptyResult(runId, 'skipped_noop', 'access_mode_isolated')
  }
  if (scopeKind === 'session') {
    const session = scopeKey
      ? db.prepare('SELECT id FROM channel_sessions WHERE id = ? AND channel_id = ?').get(scopeKey, channelId)
      : null
    if (!session) {
      repo.finishRun(runId, { status: 'skipped_noop', error: 'session_required' })
      return emptyResult(runId, 'skipped_noop', 'session_required')
    }
  }
  if (scopeKind === 'global' && !scopeKey) {
    repo.finishRun(runId, { status: 'skipped_noop', error: 'owner_required' })
    return emptyResult(runId, 'skipped_noop', 'owner_required')
  }
  const state = repo.ensureState(channelId, scopeKind, scopeKey)
  if (!state.enabled && !opts.force) {
    repo.finishRun(runId, { status: 'skipped_noop', error: 'graph_disabled' })
    return emptyResult(runId, 'skipped_noop', 'graph_disabled')
  }
  const runKey = `${channelId}|${scopeKind}|${scopeKey}`
  if (running.has(runKey)) {
    repo.finishRun(runId, { status: 'skipped_noop', error: 'already_running' })
    return emptyResult(runId, 'skipped_noop', 'already_running')
  }
  running.add(runKey)
  let fallbackReason = ''
  try {
    const maxSources = Math.min(Math.max(opts.maxSources ?? MAX_SOURCES_PER_RUN, 1), MAX_SOURCES_PER_RUN)
    const structured = scopeKind === 'line' || scopeKind === 'product'
    const partitionSpec = { scopeKind, scopeKey, ownerUserId }
    const sources = structured ? [] : repo.selectPendingSources(channelId, maxSources, partitionSpec)
    let claims = structured ? repo.listClaimFacts(channelId, 300) : []
    if (scopeKind === 'line') claims = claims.filter(c => !c.productId)
    if (scopeKind === 'product') claims = claims.filter(c => c.productId && (!scopeKey || c.productId === scopeKey))
    // 分区必须显式取本体：line 取产线级（product_id=''），product 取对应产品；
    // 共用旧加载器会在频道绑定产品后把 line 本体顶掉，导致 line 分区凭空变空。
    let ontology = structured
      ? loadPublishedOntology(db, channelId, scopeKind === 'product'
          ? { scopeKind: 'product', productId: scopeKey }
          : { scopeKind: 'line' })
      : null
    if (ontology && scopeKind === 'product' && ontology.productId !== scopeKey) ontology = null
    const sourceFingerprint = structured ? '' : repo.sourceFingerprint(channelId, partitionSpec)
    const claimHash = claims.length > 0 ? shortHash(claims.map(c => `${c.claimId}:${c.observedAt}:${c.verdict}`).join('|'), 32) : ''
    const ontologyHash = ontology ? shortHash(`${ontology.versionId}@${ontology.version}`, 32) : ''
    const needsWork = Boolean(opts.force)
      || sources.length > 0
      || claimHash !== state.lastClaimHash
      || ontologyHash !== state.lastOntologyHash
      || sourceFingerprint !== state.lastSourceHash
    if (!needsWork) {
      repo.finishRun(runId, { status: 'skipped_noop', scanned: 0, fallbackReason: 'no_changes' })
      return emptyResult(runId, 'skipped_noop', '', 'no_changes')
    }

    const llm = opts.llm !== undefined
      ? opts.llm
      : (opts.useLlm ? createGraphLlmClient() : null)
    let llmCalls = 0
    let inputChars = 0
    let entitiesNew = 0
    let entitiesLinked = 0
    let edgesNew = 0
    let scanned = 0
    let partial = false

    const index = buildEntityIndex(repo.listEntities(channelId, {
      limit: MAX_ENTITIES_PER_CHANNEL, statuses: ['active', 'provisional'],
      scopeKinds: [scopeKind], scopeKeys: [scopeKey], ...(scopeKind === 'global' ? { ownerUserId } : {}),
    }))

    if (ontology && (opts.force || ontologyHash !== state.lastOntologyHash)) {
      const r = importOntology(repo, channelId, ontology, index, ownerUserId)
      entitiesNew += r.entities
      entitiesLinked += r.linked
      edgesNew += r.edges
    }
    if (claims.length > 0 && (opts.force || claimHash !== state.lastClaimHash)) {
      const r = importClaims(repo, channelId, claims, index, ownerUserId)
      entitiesNew += r.entities
      entitiesLinked += r.linked
      edgesNew += r.edges
    }

    const normalizedSources = sources.map(m => ({
      ...m,
      ownerUserId: m.ownerUserId || ownerUserId,
      scopeKind,
      scopeKey,
    }))
    const chains = new Map<string, Array<{ episodeId: string, memoryId: string, at: string }>>()
    for (let offset = 0; offset < normalizedSources.length; offset += LLM_BATCH) {
      const batch = normalizedSources.slice(offset, offset + LLM_BATCH)
      for (const memory of batch) {
        scanned++
        const episode = repo.markSourceEpisode(channelId, memory)
        const mention = extractMemoryMentions(repo, memory, index, episode)
        edgesNew += mention.edges
        const at = memory.validFrom ?? memory.updatedAt
        for (const entityId of mention.entityIds) {
          if (!chains.has(entityId)) chains.set(entityId, [])
          const list = chains.get(entityId)!
          if (list.length < 20) list.push({ episodeId: episode.id, memoryId: memory.id, at })
        }
      }
      if (llm && llmCalls < MAX_LLM_CALLS && entitiesNew < MAX_LLM_ENTITIES && edgesNew < MAX_LLM_EDGES) {
        const result = await llm.extract({
          channelName: channel.name || channel.id,
          sources: batch.map(m => ({ id: m.id, title: m.title, content: m.content })),
          knownEntities: index.all.slice(0, 80).map(e => ({ name: e.canonicalName, type: e.entityType })),
        })
        if (!result) {
          fallbackReason = fallbackReason || 'llm_unavailable_or_invalid'
        }
        else {
          llmCalls++
          inputChars += result.inputChars
          for (const e of result.result.entities) {
            if (entitiesNew >= MAX_LLM_ENTITIES) {
              partial = true
              break
            }
            const type: GraphEntityType = isEntityType(e.type) ? e.type : 'concept'
            const out = resolveOrCreateEntity(repo, index, {
              channelId,
              ownerUserId,
              scopeKind,
              scopeKey,
              type,
              name: e.name,
              aliases: e.aliases,
              summary: e.summary,
              confidence: 0.5,
              salience: 0.5,
              status: 'provisional',
              authorKind: 'agent',
              authorId: 'memory-graph',
              sourceKind: 'llm',
              evidenceJson: JSON.stringify({ batch: batch[0]?.id ?? '', prompt: GRAPH_AGENT_PROMPT_VERSION }),
              validFrom: batch[0]?.validFrom ?? batch[0]?.updatedAt ?? nowIso(),
            })
            if (out.outcome === 'created' || out.outcome === 'candidate') entitiesNew++
            if (out.outcome === 'linked') entitiesLinked++
          }
          const local = new Map<string, GraphEntity>()
          for (const e of result.result.entities) {
            const found = findByName(index, e.name)
            if (found) local.set(normalizeEntityKey(e.name), found)
          }
          for (const r of result.result.relations) {
            if (edgesNew >= MAX_LLM_EDGES) {
              partial = true
              break
            }
            const src = findByName(index, r.src) ?? local.get(normalizeEntityKey(r.src))
            const dst = findByName(index, r.dst) ?? local.get(normalizeEntityKey(r.dst))
            if (!src || !dst || src.id === dst.id) continue
            const fact = r.fact || `${src.canonicalName} ${r.relation} ${dst.canonicalName}`
            const quoteSource = batch.find(m => r.evidence.includes(m.id))
            const written = repo.upsertEdge({
              channelId,
              ownerUserId,
              scopeKind,
              scopeKey,
              srcId: src.id,
              dstId: dst.id,
              relation: r.relation as GraphRelation,
              relationLabel: r.relation,
              fact,
              factKey: factKeyOf(fact),
              polarity: r.polarity,
              confidence: r.confidence,
              weight: r.confidence,
              status: 'provisional',
              authorKind: 'agent',
              authorId: 'memory-graph',
              sourceKind: 'llm',
              evidence: r.evidence.map(id => ({
                memoryId: id,
                quote: (quoteSource?.content ?? '').slice(0, 200),
                confidence: r.confidence,
              })),
              validFrom: quoteSource?.validFrom ?? quoteSource?.updatedAt ?? nowIso(),
            })
            if (written) {
              edgesNew++
            }
          }
          for (const inv of result.result.invalidations) {
            const edge = repo.getEdge(inv.edgeId)
            if (!edge) continue
            if (!inv.evidence.some(id => batch.some(m => m.id === id))) continue
            if (repo.invalidateEdge(inv.edgeId, '', nowIso())) edgesNew++
          }
        }
      }
    }

    edgesNew += linkEpisodePrecedes(repo, channelId, chains)
    const invalidated = invalidateSupersededFacts(repo, channelId, {
      scopeKinds: [scopeKind], scopeKeys: [scopeKey], ...(scopeKind === 'global' ? { ownerUserId } : {}),
    })

    const entitiesAfter = repo.listEntities(channelId, {
      limit: MAX_ENTITIES_PER_CHANNEL, statuses: ['active', 'provisional'],
      scopeKinds: [scopeKind], scopeKeys: [scopeKey], ...(scopeKind === 'global' ? { ownerUserId } : {}),
    })
    const edgesAfter = repo.listEdges(channelId, {
      statuses: ['active', 'provisional'], limit: MAX_EDGES_PER_CHANNEL,
      scopeKinds: [scopeKind], scopeKeys: [scopeKey], ...(scopeKind === 'global' ? { ownerUserId } : {}),
    })
    const existing = repo.listCommunities(channelId, {
      limit: 200, scopeKinds: [scopeKind], scopeKeys: [scopeKey],
    }).map(c => ({
      id: c.id, memberIds: repo.communityMembers(c.id).map(e => e.id),
    }))
    let detected: DetectedCommunity[] = detectCommunitiesWithExisting(entitiesAfter, edgesAfter, existing, { minSize: 3 })
      .map(c => ({ ...c, scopeKind, scopeKey }))
    if (llm && detected.length > 0) {
      let summaryCalls = 0
      detected = await summarizeCommunities(detected, entitiesAfter, edgesAfter, async (input) => {
        if (!llm || summaryCalls >= 5 || llmCalls >= MAX_LLM_CALLS) return null
        summaryCalls++
        llmCalls++
        return llm.summarize(input)
      })
    }
    const communityCount = repo.replaceCommunities(channelId, detected, { kind: 'agent', id: 'memory-graph' }, {
      scopeKinds: [scopeKind], scopeKeys: [scopeKey],
    })

    repo.updateState(channelId, {
      lastSourceHash: sourceFingerprint,
      lastClaimHash: claimHash,
      lastOntologyHash: ontologyHash,
      lastRunId: runId,
      lastRunAt: nowIso(),
      lastFullRebuildAt: opts.force ? nowIso() : undefined,
      entityCount: repo.countEntities(channelId, { scopeKinds: [scopeKind], scopeKeys: [scopeKey] }),
      edgeCount: repo.countEdges(channelId, { scopeKinds: [scopeKind], scopeKeys: [scopeKey] }),
    }, scopeKind, scopeKey)
    repo.bumpRevision(channelId)
    const status: GraphRun['status'] = partial ? 'partial' : 'ok'
    repo.finishRun(runId, {
      status,
      scanned,
      eligible: sources.length,
      entitiesNew,
      entitiesLinked,
      edgesNew,
      edgesInvalidated: invalidated,
      communities: communityCount,
      llmCalls,
      inputChars,
      fallbackReason,
    })
    return {
      runId, status, scanned, entitiesNew, edgesNew,
      communities: communityCount, llmCalls, fallbackReason, error: '',
    }
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    repo.finishRun(runId, { status: 'failed', error: message.slice(0, 600) })
    return emptyResult(runId, 'failed', message, fallbackReason)
  }
  finally {
    running.delete(runKey)
  }
}

export async function runMemoryGraphSweep(
  db: DatabaseSync,
  opts: ConsolidationOptions & { limit?: number } = {},
): Promise<ConsolidationResult[]> {
  const repo = createMemoryGraphRepo(db)
  if (!repo.available) return []
  const limit = Math.min(Math.max(opts.limit ?? 2, 1), 10)
  let rows: Array<{ id: string, ownerUserId: string, lineId: string, accessMode: string }>
  try {
    rows = db.prepare(`SELECT c.id, COALESCE(c.owner_user_id, '') AS ownerUserId,
        COALESCE(c.line_id, '') AS lineId, COALESCE(c.memory_access_mode, 'inherit') AS accessMode
      FROM channels c
      LEFT JOIN memory_graph_state s ON s.channel_id = c.id AND s.scope_kind = 'channel' AND s.scope_key = ''
      WHERE COALESCE(c.memory_access_mode, 'inherit') IN ('inherit', 'isolated')
        AND COALESCE(s.enabled, 1) = 1
      ORDER BY COALESCE(s.last_run_at, '1970-01-01T00:00:00.000Z') ASC
      LIMIT ?`).all(limit) as Array<{ id: string, ownerUserId: string, lineId: string, accessMode: string }>
  }
  catch {
    return []
  }
  const out: ConsolidationResult[] = []
  for (const row of rows) {
    if (opts.partition) {
      out.push(await runMemoryGraphConsolidation(db, row.id, opts))
      continue
    }
    // 1) channel partition
    out.push(await runMemoryGraphConsolidation(db, row.id, { ...opts, partition: { scopeKind: 'channel' } }))
    // 2) line partition（有产线绑定且非 isolated 才跑：isolated 不导入 line/product/global）
    if (row.lineId && row.accessMode !== 'isolated') {
      out.push(await runMemoryGraphConsolidation(db, row.id, { ...opts, partition: { scopeKind: 'line', scopeKey: row.lineId } }))
    }
    // 3) product partitions（有产品绑定才跑；isolated 跳过）
    if (row.accessMode !== 'isolated') {
      try {
        const products = db.prepare(`SELECT DISTINCT product_id AS productId FROM channel_product_bindings
          WHERE channel_id = ? AND product_id IS NOT NULL AND product_id != '' LIMIT 5`).all(row.id) as Array<{ productId: string }>
        for (const p of products) {
          out.push(await runMemoryGraphConsolidation(db, row.id, { ...opts, partition: { scopeKind: 'product', scopeKey: p.productId } }))
        }
      }
      catch { /* 产品绑定表缺失不阻断 */ }
      // 4) owner shared partition（global）
      if (row.ownerUserId) {
        out.push(await runMemoryGraphConsolidation(db, row.id, {
          ...opts, partition: { scopeKind: 'global', scopeKey: row.ownerUserId, ownerUserId: row.ownerUserId },
        }))
      }
    }
    // 5) session partitions（每频道最多 5 个活跃会话；session 图只在本会话召回时使用）
    try {
      const sessions = db.prepare(`SELECT DISTINCT session_id AS sessionId FROM agent_memories
        WHERE channel_id = ? AND scope_kind = 'session' AND session_id != '' AND deleted_at IS NULL
          AND status != 'retired' ORDER BY updated_at DESC LIMIT 5`).all(row.id) as Array<{ sessionId: string }>
      for (const s of sessions) {
        out.push(await runMemoryGraphConsolidation(db, row.id, { ...opts, partition: { scopeKind: 'session', scopeKey: s.sessionId } }))
      }
    }
    catch { /* 会话表缺失不阻断 */ }
  }
  return out
}
