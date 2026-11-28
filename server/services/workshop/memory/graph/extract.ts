/**
 * 确定性抽取：已发布本体 + 结构化 claim + 记忆标题/别名提及。
 *
 * 原则：
 *  - 结构化来源（ontology/claim）优先生成 active 实体/边；
 *  - 记忆文本只做别名匹配与 provisional concept，避免凭空造关系；
 *  - 每条边都带 evidence（本体用 ontology:<version> 作为来源锚）。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryScopeKind } from '../../db/database'
import { unsegmentCJK } from '../../runtime/memory/helpers'
import {
  canonicalRelation,
  factKeyOf,
  normalizeCompact,
  normalizeEntityKey,
  safeJsonObject,
} from './normalize'
import { resolveOrCreateEntity, type EntityIndex } from './resolve'
import type { GraphRepo } from './repo'
import type {
  GraphClaimFact,
  GraphEntity,
  GraphEntityType,
  GraphRelation,
  GraphSourceMemory,
} from './types'

export interface OntologySeed {
  versionId: string
  version: number
  lineId: string
  productId: string
  entities: Array<{ entityKey: string, kind: string, name: string, description: string, unit: string, role: string }>
  relations: Array<{ id: string, srcKey: string, dstKey: string, predicate: string, propertiesJson: string }>
}

const STOP_ALIAS_KEYS = new Set([
  '参数', '设置', '数据', '系统', '任务', '问题', '经验', '记忆', '方法', '结果',
  'the', 'and', 'for', 'with', 'from', 'this', 'that',
])

const DOMAIN_SUFFIXES = [
  '压力', '温度', '流量', '速度', '厚度', '壁厚', '位置', '电流', '电压', '功率',
  '转速', '重量', '尺寸', '湿度', '浓度', '粘度', '硬度', '强度', '开度', '位移',
  '张力', '扭矩', '时间', '行程', '间隙', '偏差',
]

const DOMAIN_TERMS = [
  '保压压力', '保压', '模温', '料温', '冷却水', '冷却水流量', '背压', '锁模力',
  '射出压力', '熔体温度', '螺杆转速', '注射速度', '保压时间', '冷却时间', '开模位置',
  '壁厚', '良率', '外观', '配方',
]

const ASCII_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'http', 'https', 'www',
  'json', 'true', 'false', 'null', 'sp', 'pv', 'id', 'ok',
  'min', 'max', 'mpa', 'mm', 'cm', 'kg', 'ml', 'rpm', 'kw', 'bar', 'lpm', 'sec',
])

/** 句首/介词/动词前缀：领域短语前常粘连，保留真正名词部分。 */
const LEAD_STOP = /^(?:复检|检查|检测|查看|查|确认|调整|整|调|设置|控制|处理|上调|提升|降低|增加|减少|改善|影响|决定|保持|首件必检|首件|必检|的|与|和|由|时|后|前|在|对|将|把|为|是|有|无|不|需|要|应|先|再|已|未|可|能|会|从|到|至|按|随|当|因|所|其|该|每|各|本|上|下|内|外|度时|超过|低于|高于)+/

/** 无 LLM/本体时的领域术语抽取：中文后缀短语 + 业务词 + ASCII 词。 */
export function extractDomainTerms(text: string): Array<{ name: string, type: GraphEntityType }> {
  const raw = String(text ?? '').normalize('NFKC')
  const found = new Map<string, GraphEntityType>()
  const add = (input: string, type?: GraphEntityType): void => {
    let name = String(input ?? '').trim()
    // 去掉“复检/检查/的/与/由/度时”等粘连前缀，保留真正名词
    name = name.replace(LEAD_STOP, '').trim()
    if (name.length < 2 || name.length > 40) return
    const key = normalizeEntityKey(name)
    if (!key || STOP_ALIAS_KEYS.has(key) || ASCII_STOP.has(key)) return
    found.set(name, type ?? inferDomainType(name))
  }
  const suffixRe = new RegExp(`([\\p{Script=Han}]{2,4})(?:${DOMAIN_SUFFIXES.join('|')})`, 'gu')
  for (const m of raw.matchAll(suffixRe)) add(m[0] ?? '')
  for (const term of DOMAIN_TERMS) {
    if (raw.includes(term)) add(term)
  }
  for (const m of raw.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,30}/g)) {
    const name = m[0]
    if (ASCII_STOP.has(name.toLowerCase())) continue
    add(name)
  }
  const names = [...found.keys()].filter((name) => {
    const key = normalizeEntityKey(name)
    return key.length >= 2 && key.length <= 40 && !STOP_ALIAS_KEYS.has(key)
  })
  // 去掉被更长术语包含的短词（保压 vs 保压压力）
  const pruned = names.filter(name => !names.some(other =>
    other !== name && other.length > name.length && other.includes(name)))
  return pruned.slice(0, 10).map(name => ({ name, type: found.get(name) ?? 'concept' }))
}

function inferDomainType(name: string): GraphEntityType {
  if (/压力|温度|流量|速度|位置|电流|电压|功率|转速|开度|位移|张力|扭矩|模温|料温/.test(name)) return 'parameter'
  if (/壁厚|厚度|尺寸|偏差|间隙/.test(name)) return 'metric'
  if (/机|泵|阀|设备|传感器|电机|缸|模架/.test(name)) return 'device'
  if (/配方/.test(name)) return 'recipe'
  return 'concept'
}

function ontologyType(kind: string, role: string): GraphEntityType {
  const k = kind.toLowerCase()
  const r = role.toLowerCase()
  if (k.includes('param') || r === 'control') return 'parameter'
  if (k.includes('target') || k.includes('metric') || k.includes('quality') || r === 'target' || r === 'observation') return 'metric'
  if (k.includes('device') || k.includes('equip') || k.includes('node') || k.includes('sensor') || r === 'disturbance') return 'device'
  if (k.includes('recipe') || r === 'recipe') return 'recipe'
  if (k.includes('product')) return 'product'
  if (k.includes('line')) return 'line'
  return 'concept'
}

function ontologyRelation(predicate: string): GraphRelation {
  const p = predicate.toLowerCase()
  if (p.includes('influence') || p.includes('affect') || p.includes('actuat')) return 'affects'
  if (p.includes('measure') || p.includes('observ')) return 'observed_in'
  if (p.includes('haspart') || p.includes('part')) return 'part_of'
  if (p.includes('precede')) return 'precedes'
  if (p.includes('based')) return 'derived_from'
  return canonicalRelation(predicate).relation
}

function tierConfidence(propertiesJson: string): number {
  const props = safeJsonObject(propertiesJson)
  const tier = String(props.evidenceTier ?? '').toLowerCase()
  if (tier === 'validated_control') return 0.95
  if (tier === 'observed_correlation') return 0.8
  if (tier === 'candidate_influence') return 0.6
  return 0.75
}

/**
 * 读取频道绑定产线/产品对应的最新已发布本体。
 * - 显式 `scopeKind='line'`：只取产线级本体（product_id=''），即使频道已绑产品；
 * - 显式 `scopeKind='product'`：只取该产品的本体；
 * - 未指定：兼容旧行为（频道只有一个产品时取产品本体，否则取产线本体）。
 * 分区整理必须显式传 scope，否则 line 分区会被产品本体顶掉/变空。
 */
export function loadPublishedOntology(
  db: DatabaseSync,
  channelId: string,
  opts: { scopeKind?: 'line' | 'product', productId?: string } = {},
): OntologySeed | null {
  try {
    const channel = db.prepare(`SELECT c.line_id AS lineId,
        (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(cp.product_id) END FROM channel_product_bindings cp
         WHERE cp.channel_id = c.id AND cp.product_id IS NOT NULL) AS productId
      FROM channels c WHERE c.id = ?`).get(channelId) as { lineId?: string, productId?: string } | undefined
    const lineId = channel?.lineId ?? ''
    if (!lineId) return null
    const productId = opts.scopeKind === 'product'
      ? (opts.productId ?? '')
      : opts.scopeKind === 'line'
        ? ''
        : (channel?.productId ?? '')
    const version = productId
      ? db.prepare(`SELECT id, version, line_id AS lineId, COALESCE(product_id, '') AS productId
          FROM ontology_versions WHERE status = 'published' AND line_id = ? AND product_id = ?
          ORDER BY version DESC LIMIT 1`).get(lineId, productId)
      : db.prepare(`SELECT id, version, line_id AS lineId, COALESCE(product_id, '') AS productId
          FROM ontology_versions WHERE status = 'published' AND line_id = ? AND COALESCE(product_id, '') = ''
          ORDER BY version DESC LIMIT 1`).get(lineId)
    const v = version as { id?: string, version?: number, lineId?: string, productId?: string } | undefined
    if (!v?.id || v.version === undefined) return null
    const entities = db.prepare(`SELECT entity_key AS entityKey, kind, name, description, unit, role
      FROM ontology_entities WHERE version_id = ? AND version = ? ORDER BY entity_key`)
      .all(v.id, v.version) as unknown as OntologySeed['entities']
    const relations = db.prepare(`SELECT id, src_key AS srcKey, dst_key AS dstKey, predicate,
        properties_json AS propertiesJson FROM ontology_relations WHERE version_id = ? AND version = ?`)
      .all(v.id, v.version) as unknown as OntologySeed['relations']
    return {
      versionId: v.id, version: v.version, lineId: v.lineId ?? lineId,
      productId: v.productId ?? '', entities, relations,
    }
  }
  catch {
    return null
  }
}

export interface ImportResult {
  entities: number
  edges: number
  linked: number
}

export function importOntology(
  repo: GraphRepo,
  channelId: string,
  seed: OntologySeed,
  index: EntityIndex,
  ownerUserId = '',
): ImportResult {
  const scopeKind: MemoryScopeKind = seed.productId ? 'product' : 'line'
  const scopeKey = seed.productId || seed.lineId
  const byKey = new Map<string, GraphEntity>()
  let entities = 0
  let linked = 0
  for (const e of seed.entities) {
    const type = ontologyType(e.kind, e.role)
    const result = resolveOrCreateEntity(repo, index, {
      channelId,
      ownerUserId,
      scopeKind,
      scopeKey,
      productId: seed.productId,
      type,
      name: e.name,
      canonicalKey: e.entityKey,
      aliases: [e.name, e.entityKey, e.description.slice(0, 80)].filter(Boolean),
      summary: e.description.slice(0, 400) || `${type}: ${e.name}`,
      confidence: 0.9,
      salience: 0.6,
      status: 'active',
      authorKind: 'ontology',
      authorId: `ontology:${seed.versionId}@v${seed.version}`,
      sourceKind: 'ontology',
      evidenceJson: JSON.stringify({ ontologyVersionId: seed.versionId, version: seed.version, entityKey: e.entityKey }),
      validFrom: new Date().toISOString(),
    })
    byKey.set(e.entityKey, result.entity)
    if (!result.blocked) {
      if (result.outcome === 'created' || result.outcome === 'candidate') entities++
      else if (result.outcome === 'exact' || result.outcome === 'linked') linked++
    }
  }
  let edges = 0
  for (const r of seed.relations) {
    const src = byKey.get(r.srcKey)
    const dst = byKey.get(r.dstKey)
    if (!src || !dst) continue
    const relation = ontologyRelation(r.predicate)
    const confidence = tierConfidence(r.propertiesJson)
    const fact = `${src.canonicalName} ${r.predicate} ${dst.canonicalName}`
    const written = repo.upsertEdge({
      channelId,
      ownerUserId,
      scopeKind,
      scopeKey,
      productId: seed.productId,
      srcId: src.id,
      dstId: dst.id,
      relation,
      relationLabel: r.predicate,
      fact,
      factKey: factKeyOf(fact),
      confidence,
      weight: confidence,
      status: 'active',
      authorKind: 'ontology',
      authorId: `ontology:${seed.versionId}@v${seed.version}`,
      sourceKind: 'ontology',
      evidence: [{
        memoryId: `ontology:${seed.versionId}@v${seed.version}`,
        quote: `本体 v${seed.version} ${r.predicate}`,
        confidence,
      }],
      validFrom: new Date().toISOString(),
    })
    if (written) edges++
  }
  return { entities, edges, linked }
}

const CLAIM_VERDICT_CONFIDENCE: Record<string, number> = {
  identifiable_effect: 0.85,
  no_resolvable_effect: 0.45,
}

export function importClaims(
  repo: GraphRepo,
  channelId: string,
  claims: GraphClaimFact[],
  index: EntityIndex,
  ownerUserId = '',
): ImportResult {
  let entities = 0
  let edges = 0
  let linked = 0
  for (const c of claims) {
    const scopeKind: MemoryScopeKind = c.productId ? 'product' : 'line'
    const scopeKey = c.productId || c.lineId
    if (!scopeKey) continue
    const at = c.observedAt || new Date().toISOString()
    const confidence = CLAIM_VERDICT_CONFIDENCE[c.verdict] ?? 0.5
    const mk = (
      type: GraphEntityType, name: string, aliases: string[], summary: string,
    ): GraphEntity | null => {
      if (!name.trim()) return null
      const r = resolveOrCreateEntity(repo, index, {
        channelId, ownerUserId, scopeKind, scopeKey, productId: c.productId,
        type, name: name.trim().slice(0, 80),
        aliases, summary, confidence, salience: 0.65, status: 'active',
        authorKind: 'claim', authorId: `claim:${c.claimId}`, sourceKind: 'claim',
        evidenceJson: JSON.stringify({ claimId: c.claimId, memoryId: c.memoryId }),
        validFrom: at,
      })
      if (r.outcome === 'created' || r.outcome === 'candidate') entities++
      else if (r.outcome === 'exact' || r.outcome === 'linked') linked++
      if (r.blocked) return null
      return r.entity
    }
    const parameter = mk('parameter', c.variable, [c.variable, `${c.nodeName}.${c.variable}`], `${c.nodeName || c.nodeId} ${c.variable}${c.unit ? ` (${c.unit})` : ''}`)
    const node = mk(c.nodeName ? 'device' : 'node', c.nodeName || c.nodeId, [c.nodeName, c.nodeId].filter(Boolean), `设备/节点 ${c.nodeName || c.nodeId}`)
    const metric = c.targetMetric ? mk('metric', c.targetMetric, [c.targetMetric], `目标指标 ${c.targetMetric}`) : null
    const recipe = c.recipeId ? mk('recipe', c.recipeId, [c.recipeId], `配方 ${c.recipeId}`) : null
    const product = c.productId ? mk('product', c.productId, [c.productId], `产品 ${c.productId}`) : null

    const evidence = [{
      memoryId: c.memoryId, claimId: c.claimId, interventionId: c.interventionId,
      quote: `${c.variable} ${c.fromValue ?? '?'}→${c.toValue ?? '?'} ${c.verdict}`.slice(0, 300),
      confidence,
    }]
    const write = (src: GraphEntity | null, dst: GraphEntity | null, relation: GraphRelation, fact: string, weight = confidence): void => {
      if (!src || !dst || src.id === dst.id) return
      const w = repo.upsertEdge({
        channelId, ownerUserId, scopeKind, scopeKey, productId: c.productId,
        srcId: src.id, dstId: dst.id, relation,
        relationLabel: relation, fact, factKey: factKeyOf(fact),
        polarity: (c.polarity === 'negative' ? 'negative' : c.polarity === 'neutral' ? 'neutral' : 'positive'),
        confidence, weight, status: 'active', authorKind: 'claim',
        authorId: `claim:${c.claimId}`, sourceKind: 'claim',
        evidence, validFrom: at,
      })
      if (w) edges++
    }
    if (parameter && metric) {
      const effect = c.effect === null ? '效应未知' : `效应 ${c.effect}`
      const ci = c.ciLow !== null && c.ciHigh !== null ? `（CI ${c.ciLow}..${c.ciHigh}）` : ''
      write(parameter, metric, 'affects',
        `${c.variable} ${c.fromValue ?? '?'}→${c.toValue ?? '?'}${c.unit ? ` ${c.unit}` : ''}；${c.targetMetric} ${effect}${ci}；${c.verdict}`)
    }
    if (node && parameter) {
      write(node, parameter, 'has_parameter', `${node.canonicalName} 参数 ${c.variable}`, 0.9)
    }
    if (recipe && parameter) {
      write(recipe, parameter, 'has_parameter', `配方 ${c.recipeId}@r${c.recipeRevision} 包含 ${c.variable}`, 0.8)
    }
    if (product && recipe) {
      write(product, recipe, 'uses_recipe', `产品 ${c.productId} 使用配方 ${c.recipeId}`, 0.8)
    }
  }
  return { entities, edges, linked }
}

export interface MentionResult {
  entityIds: string[]
  edges: number
}

/** 记忆文本 → 别名 mentions；无命中时用标题建 provisional concept；少量 co_occurs。 */
export function extractMemoryMentions(
  repo: GraphRepo,
  memory: GraphSourceMemory,
  index: EntityIndex,
  episode: GraphEntity,
): MentionResult {
  // 存储层正文是 CJK 单字切分文本；抽取前必须还原，否则「冷 却 水 流 量」匹配不到领域术语。
  const plain = `${memory.title} ${unsegmentCJK(memory.content)}`
  const text = normalizeEntityKey(plain)
  const matches = new Map<string, { entity: GraphEntity, confidence: number }>()
  // 过程记录（任务/协作事件）只保留 episode 与既有实体的提及：
  // 其正文含 root.completed/COMPLETED/任务 id 等运行元数据，若按普通记忆抽术语会制造大量噪声实体。
  const processRecord = memory.kind.startsWith('episodic-')
  // 规则术语：即使没有本体/LLM，也从文本抽出领域短语，形成可连通的网状实体。
  for (const term of processRecord ? [] : extractDomainTerms(plain)) {
    const result = resolveOrCreateEntity(repo, index, {
      channelId: memory.channelId,
      ownerUserId: memory.ownerUserId,
      scopeKind: memory.scopeKind,
      scopeKey: memory.scopeKey,
      productId: memory.productId,
      type: term.type,
      name: term.name,
      aliases: [term.name],
      summary: `来自记忆：${memory.title.slice(0, 80)}`,
      confidence: 0.55,
      salience: 0.45,
      status: 'provisional',
      authorKind: 'agent',
      authorId: 'memory-graph',
      sourceKind: 'rule-term',
      evidenceJson: JSON.stringify({ memoryId: memory.id }),
      memoryId: memory.id,
      validFrom: memory.validFrom ?? memory.updatedAt,
    })
    if (result.blocked) continue
    matches.set(result.entity.id, { entity: result.entity, confidence: 0.55 })
  }
  for (const entity of index.all) {
    if (entity.entityType === 'episode' || entity.deletedAt || entity.mergedInto) continue
    if (entity.status !== 'active' && entity.status !== 'provisional') continue
    const aliases = [...new Set([entity.canonicalName, ...entity.aliases])]
      .map(a => normalizeEntityKey(a))
      .filter(a => a.length >= 2 && a.length <= 60 && !STOP_ALIAS_KEYS.has(a))
      .sort((a, b) => b.length - a.length)
    for (const alias of aliases) {
      if (!text.includes(alias)) continue
      const prev = matches.get(entity.id)
      const confidence = alias === normalizeEntityKey(entity.canonicalName) ? 0.9 : 0.8
      if (!prev || confidence > prev.confidence) matches.set(entity.id, { entity, confidence })
      break
    }
    if (matches.size >= 20) break
  }

  const entityIds: string[] = []
  for (const { entity, confidence } of matches.values()) {
    repo.addMention(entity.id, memory.id, confidence, 'rule')
    entityIds.push(entity.id)
  }

  if (matches.size === 0 && !processRecord) {
    const title = String(memory.title ?? '').trim()
    if (title.length >= 2 && title.length <= 60 && !STOP_ALIAS_KEYS.has(normalizeEntityKey(title))) {
      const concept = resolveOrCreateEntity(repo, index, {
        channelId: memory.channelId,
        ownerUserId: memory.ownerUserId,
        scopeKind: memory.scopeKind,
        scopeKey: memory.scopeKey,
        productId: memory.productId,
        type: 'concept',
        name: title,
        aliases: [title],
        summary: `来自记忆：${title}`,
        confidence: 0.35,
        salience: 0.4,
        status: 'provisional',
        authorKind: 'agent',
        authorId: 'memory-graph',
        sourceKind: 'memory',
        evidenceJson: JSON.stringify({ memoryId: memory.id }),
        memoryId: memory.id,
        validFrom: memory.validFrom ?? memory.updatedAt,
      })
      if (!concept.blocked) {
        repo.addMention(concept.entity.id, memory.id, 0.4, 'rule:title')
        entityIds.push(concept.entity.id)
      }
    }
  }

  // 少量共现边：同记忆 2–4 个实体，取前 3 对；只作为弱关联
  let edges = 0
  const top = [...matches.values()].slice(0, 4).map(m => m.entity)
  if (top.length >= 2) {
    const limit = Math.min(3, (top.length * (top.length - 1)) / 2)
    for (let i = 0; i < top.length && edges < limit; i++) {
      for (let j = i + 1; j < top.length && edges < limit; j++) {
        const fact = `${top[i]!.canonicalName} 与 ${top[j]!.canonicalName} 同时出现`
        const written = repo.upsertEdge({
          channelId: memory.channelId,
          ownerUserId: memory.ownerUserId,
          scopeKind: memory.scopeKind,
          scopeKey: memory.scopeKey,
          productId: memory.productId,
          srcId: top[i]!.id,
          dstId: top[j]!.id,
          relation: 'co_occurs',
          relationLabel: 'co_occurs',
          fact,
          factKey: factKeyOf(fact),
          confidence: 0.25,
          weight: 0.3,
          status: 'provisional',
          authorKind: 'agent',
          authorId: 'memory-graph',
          sourceKind: 'memory',
          evidence: [{ memoryId: memory.id, quote: memory.title.slice(0, 120), confidence: 0.3 }],
          validFrom: memory.validFrom ?? memory.updatedAt,
        })
        if (written) edges++
      }
    }
  }
  // episode 与实体之间也留 mentions 边，便于 PPR 从实体回到 episode（mention 表仍是主索引）
  for (const entityId of entityIds) {
    repo.upsertEdge({
      channelId: memory.channelId,
      ownerUserId: memory.ownerUserId,
      scopeKind: memory.scopeKind,
      scopeKey: memory.scopeKey,
      productId: memory.productId,
      srcId: episode.id,
      dstId: entityId,
      relation: 'mentions',
      relationLabel: 'mentions',
      fact: `${memory.title.slice(0, 80)} 提及 ${entityId}`,
      factKey: '',
      confidence: 0.4,
      weight: 0.4,
      status: 'provisional',
      authorKind: 'agent',
      authorId: 'memory-graph',
      sourceKind: 'memory',
      evidence: [{ memoryId: memory.id, quote: memory.title.slice(0, 120), confidence: 0.4 }],
      validFrom: memory.validFrom ?? memory.updatedAt,
    })
  }
  return { entityIds, edges }
}

/** 同一实体的 episode 时间链：相邻 episode 生成 precedes（上限 2/来源） */
export function linkEpisodePrecedes(
  repo: GraphRepo,
  channelId: string,
  chains: Map<string, Array<{ episodeId: string, memoryId: string, at: string }>>,
): number {
  let created = 0
  for (const [, episodes] of chains) {
    const sorted = [...episodes].sort((a, b) => a.at.localeCompare(b.at))
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!
      const cur = sorted[i]!
      if (prev.episodeId === cur.episodeId) continue
      const written = repo.upsertEdge({
        channelId,
        srcId: prev.episodeId,
        dstId: cur.episodeId,
        relation: 'precedes',
        relationLabel: 'precedes',
        fact: `${prev.at} 先于 ${cur.at}`,
        factKey: factKeyOf(`${prev.memoryId}->${cur.memoryId}`),
        confidence: 0.6,
        weight: 0.3,
        status: 'active',
        authorKind: 'agent',
        authorId: 'memory-graph',
        sourceKind: 'memory',
        evidence: [{ memoryId: cur.memoryId, quote: '时间链', confidence: 0.5 }],
        validFrom: cur.at,
      })
      if (written) created++
    }
  }
  return created
}

export function claimScopeKey(c: GraphClaimFact): string {
  return c.productId || c.lineId
}

export function mentionTextOf(memory: GraphSourceMemory): string {
  return normalizeCompact(`${memory.title} ${memory.content}`)
}
