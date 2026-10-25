/**
 * 本体子图 BFS 纯核心 —— 零 DB / 零框架依赖,供 REST、Agent 工具与单测共用。
 *
 * 语义(与 docs/plans/2026-10-25-ontology-graph-visualization.md §2 一致):
 *  - nodes 含 center(hop=0);limit 统计含 center
 *  - edge.hop = max(hop(src), hop(dst));direction 由两端 hop 差决定(自环=loop)
 *  - direction=both 返回已访问节点之间的全部诱导边(含 lateral);out/in 只保留不倒走该方向的边
 *  - kinds 同时过滤遍历与输出;truncated 仅表示因 limit 未纳入可达节点
 *  - 输出排序确定:nodes 按 (hop, key),edges 按 (hop, id)
 */
import { AppError } from '../../../utils/errors'
import { ONTOLOGY_RELATION_KINDS, type OntologyRelationKind } from './contracts'

export const SUBGRAPH_DEFAULT_HOPS = 1
export const SUBGRAPH_MAX_HOPS = 3
export const SUBGRAPH_DEFAULT_LIMIT = 50
export const SUBGRAPH_MAX_LIMIT = 200

export type SubgraphDirection = 'both' | 'out' | 'in'
export type SubgraphEdgeDirection = 'out' | 'in' | 'lateral' | 'loop'

export interface SubgraphBindingView {
  platformKind: string
  platformId: string
  targetSub: string
  direction: string
  status: string
  unitDeclared: string
  unitTarget: string
  scale: number
  offset: number
}

export interface SubgraphEntityView {
  key: string
  kind: string
  name: string
  description: string
  unit: string
  role?: string
  hop: number
}

export interface SubgraphEdgeView {
  id: string
  kind: string
  srcKey: string
  dstKey: string
  evidenceTier: string
  hop: number
  direction: SubgraphEdgeDirection
}

export interface SubgraphAround {
  ontologyId: string
  version: number
  lineId: string
  center: SubgraphEntityView & { hop: 0, bindings: SubgraphBindingView[] }
  nodes: SubgraphEntityView[]
  edges: SubgraphEdgeView[]
  truncated: boolean
}

export interface SubgraphEntityInput {
  key: string
  kind: string
  name: string
  description?: string
  unit: string
  role?: string
}

export interface SubgraphRelationInput {
  id: string
  kind: string
  srcKey: string
  dstKey: string
  evidenceTier: string
}

export interface SubgraphBindingInput {
  entityKey: string
  platformKind: string
  platformId: string
  targetSub?: string
  direction: string
  status?: string
  unitDeclared?: string
  unitTarget?: string
  scale?: number
  offset?: number
}

export interface SubgraphGraphData {
  entities: SubgraphEntityInput[]
  relations: SubgraphRelationInput[]
  bindings: SubgraphBindingInput[]
}

export interface SubgraphMeta {
  ontologyId: string
  version: number
  lineId: string
}

export interface SubgraphOptions {
  hops?: number
  direction?: SubgraphDirection
  /** null = 不过滤(与 parseSubgraphOptions 的解析结果可直接互传) */
  kinds?: OntologyRelationKind[] | null
  limit?: number
}

/** 已解析、已校验的选项(缺省值已落地) */
export interface ResolvedSubgraphOptions {
  hops: number
  direction: SubgraphDirection
  kinds: OntologyRelationKind[] | null
  limit: number
}

const RELATION_KIND_SET = new Set<string>(ONTOLOGY_RELATION_KINDS)

function isDirection(value: string): value is SubgraphDirection {
  return value === 'both' || value === 'out' || value === 'in'
}

function parseInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(String(value))
  if (!Number.isInteger(n)) return Number.NaN
  return n
}

/** 解析并校验查询参数(未给则取缺省);kinds 支持逗号分隔或数组 */
export function parseSubgraphOptions(raw: {
  hops?: unknown
  direction?: unknown
  kinds?: unknown
  limit?: unknown
} = {}): ResolvedSubgraphOptions {
  const hops = parseInteger(raw.hops, SUBGRAPH_DEFAULT_HOPS)
  if (!Number.isInteger(hops) || hops < 1 || hops > SUBGRAPH_MAX_HOPS) {
    throw new AppError(422, 'ONTOLOGY_SUBGRAPH_HOPS_INVALID', `hops 必须是 1-${SUBGRAPH_MAX_HOPS} 的整数`)
  }
  const directionRaw = typeof raw.direction === 'string' && raw.direction.trim() ? raw.direction.trim() : 'both'
  if (!isDirection(directionRaw)) {
    throw new AppError(422, 'ONTOLOGY_SUBGRAPH_DIRECTION_INVALID', 'direction 必须是 both/out/in')
  }
  const limit = parseInteger(raw.limit, SUBGRAPH_DEFAULT_LIMIT)
  if (!Number.isInteger(limit) || limit < 1 || limit > SUBGRAPH_MAX_LIMIT) {
    throw new AppError(422, 'ONTOLOGY_SUBGRAPH_LIMIT_INVALID', `limit 必须是 1-${SUBGRAPH_MAX_LIMIT} 的整数`)
  }
  let kinds: OntologyRelationKind[] | null = null
  if (raw.kinds !== undefined && raw.kinds !== null) {
    const list = (Array.isArray(raw.kinds) ? raw.kinds : String(raw.kinds).split(','))
      .map(k => String(k).trim())
      .filter(Boolean)
    if (!list.length) {
      throw new AppError(422, 'ONTOLOGY_SUBGRAPH_KIND_INVALID', 'kinds 不能为空(缺省表示全部)')
    }
    for (const kind of list) {
      if (!RELATION_KIND_SET.has(kind)) {
        throw new AppError(422, 'ONTOLOGY_SUBGRAPH_KIND_INVALID',
          `未知关系类型「${kind}」;可选:${ONTOLOGY_RELATION_KINDS.join(', ')}`)
      }
    }
    kinds = [...new Set(list)] as OntologyRelationKind[]
  }
  return { hops, direction: directionRaw, kinds, limit }
}

function bindingOf(bindings: SubgraphBindingInput[], entityKey: string): SubgraphBindingView[] {
  return bindings
    .filter(b => b.entityKey === entityKey)
    .map(b => ({
      platformKind: b.platformKind,
      platformId: b.platformId,
      targetSub: b.targetSub ?? '',
      direction: b.direction,
      status: b.status ?? 'active',
      unitDeclared: b.unitDeclared ?? '',
      unitTarget: b.unitTarget ?? '',
      scale: typeof b.scale === 'number' ? b.scale : 1,
      offset: typeof b.offset === 'number' ? b.offset : 0,
    }))
}

function nodeOf(entity: SubgraphEntityInput, hop: number): SubgraphEntityView {
  return {
    key: entity.key,
    kind: entity.kind,
    name: entity.name,
    description: entity.description ?? '',
    unit: entity.unit,
    role: entity.role,
    hop,
  }
}

/**
 * 以 entityKey 为中心做 BFS,返回诱导子图。
 * 中心实体不存在 → 404 ONTOLOGY_SUBGRAPH_ENTITY_NOT_FOUND。
 */
export function buildSubgraphAround(
  entityKey: string,
  data: SubgraphGraphData,
  meta: SubgraphMeta,
  options: SubgraphOptions = {},
): SubgraphAround {
  // 校验与缺省只有一处实现:服务层/路由/工具都不需要各自复制边界规则
  const opts: ResolvedSubgraphOptions = parseSubgraphOptions(options)
  const entityOf = new Map(data.entities.map(e => [e.key, e]))
  const center = entityOf.get(entityKey)
  if (!center) {
    throw new AppError(404, 'ONTOLOGY_SUBGRAPH_ENTITY_NOT_FOUND',
      `本体 ${meta.ontologyId}@${meta.version} 中不存在实体「${entityKey}」`)
  }
  const kindSet = opts.kinds ? new Set<string>(opts.kinds) : null
  const relations = data.relations.filter(r => !kindSet || kindSet.has(r.kind))
  const outAdj = new Map<string, string[]>()
  const inAdj = new Map<string, string[]>()
  for (const rel of relations) {
    if (rel.srcKey === rel.dstKey) continue
    if (!entityOf.has(rel.srcKey) || !entityOf.has(rel.dstKey)) continue
    const outs = outAdj.get(rel.srcKey) ?? []
    outs.push(rel.dstKey)
    outAdj.set(rel.srcKey, outs)
    const ins = inAdj.get(rel.dstKey) ?? []
    ins.push(rel.srcKey)
    inAdj.set(rel.dstKey, ins)
  }

  const hopOf = new Map<string, number>([[entityKey, 0]])
  let truncated = false
  let frontier = [entityKey]
  let hop = 0
  while (frontier.length && hop < opts.hops) {
    hop += 1
    const next: string[] = []
    for (const key of frontier) {
      const neighbours = opts.direction === 'in'
        ? (inAdj.get(key) ?? [])
        : opts.direction === 'out'
          ? (outAdj.get(key) ?? [])
          : [...(outAdj.get(key) ?? []), ...(inAdj.get(key) ?? [])]
      for (const neighbour of neighbours) {
        if (hopOf.has(neighbour)) continue
        if (hopOf.size >= opts.limit) {
          truncated = true
          continue
        }
        hopOf.set(neighbour, hop)
        next.push(neighbour)
      }
    }
    frontier = next
  }

  const nodes = [...hopOf.entries()]
    .map(([key, h]) => nodeOf(entityOf.get(key)!, h))
    .sort((a, b) => (a.hop - b.hop) || a.key.localeCompare(b.key))

  const edges: SubgraphEdgeView[] = []
  for (const rel of relations) {
    const srcHop = hopOf.get(rel.srcKey)
    const dstHop = hopOf.get(rel.dstKey)
    if (srcHop === undefined || dstHop === undefined) continue
    // 单向模式只保留真正沿该方向跨了一跳的边;同跳横边(lateral)只在 both 模式展示
    if (opts.direction === 'out' && dstHop !== srcHop + 1) continue
    if (opts.direction === 'in' && srcHop !== dstHop + 1) continue
    const direction: SubgraphEdgeDirection = rel.srcKey === rel.dstKey
      ? 'loop'
      : dstHop === srcHop + 1
        ? 'out'
        : srcHop === dstHop + 1
          ? 'in'
          : 'lateral'
    edges.push({
      id: rel.id,
      kind: rel.kind,
      srcKey: rel.srcKey,
      dstKey: rel.dstKey,
      evidenceTier: rel.evidenceTier,
      hop: Math.max(srcHop, dstHop),
      direction,
    })
  }
  edges.sort((a, b) => (a.hop - b.hop) || a.id.localeCompare(b.id))

  return {
    ontologyId: meta.ontologyId,
    version: meta.version,
    lineId: meta.lineId,
    center: { ...nodeOf(center, 0), hop: 0, bindings: bindingOf(data.bindings, entityKey) },
    nodes,
    edges,
    truncated,
  }
}
