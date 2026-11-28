/**
 * 社区检测与摘要（标签传播，增量友好）。
 *
 * 口径：
 *  - 只对非 episode、active/provisional、未删除/未合并实体聚类；
 *  - 边权 = 关系权重 × 置信 × 边权；contradicts 权重 0（不传播）；
 *  - 异步标签传播，确定性排序与 tie-break；
 *  - 小于 minSize 的簇解散（成员不强行归并）；
 *  - 0 层社区；若存在多个 0 层且跨社区边足够，再做 1 层父社区；
 *  - 摘要默认模板，可由 Agent 用 LLM 覆盖（失败保留模板）。
 */
import { deterministicId, shortHash } from './normalize'
import type { MemoryScopeKind } from '../../db/database'
import {
  RELATION_WEIGHT,
  type GraphEdge,
  type GraphEntity,
} from './types'

export interface DetectedCommunity {
  id: string
  level: number
  parentId: string | null
  title: string
  summary: string
  memberIds: string[]
  edgeCount: number
  scopeKind?: MemoryScopeKind
  scopeKey?: string
}

export interface DetectCommunityOptions {
  minSize?: number
  maxIterations?: number
}

interface Group {
  memberIds: string[]
  edgeCount: number
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const union = sa.size + sb.size - inter
  return union > 0 ? inter / union : 0
}

function labelPropagation(
  nodes: string[],
  adjacency: Map<string, Map<string, number>>,
  maxIterations: number,
): Map<string, string> {
  const labels = new Map<string, string>()
  for (const id of nodes) labels.set(id, id)
  const order = [...nodes].sort()
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false
    for (const id of order) {
      const neighbors = adjacency.get(id)
      if (!neighbors || neighbors.size === 0) continue
      const scores = new Map<string, number>()
      for (const [to, weight] of neighbors) {
        const label = labels.get(to) ?? to
        scores.set(label, (scores.get(label) ?? 0) + weight)
      }
      let bestLabel = labels.get(id)!
      let bestScore = -1
      for (const [label, score] of scores) {
        if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && label < bestLabel)) {
          bestLabel = label
          bestScore = score
        }
      }
      if (bestLabel !== labels.get(id)) {
        labels.set(id, bestLabel)
        changed = true
      }
    }
    if (!changed) break
  }
  return labels
}

function buildAdjacency(entities: GraphEntity[], edges: GraphEdge[]): {
  adjacency: Map<string, Map<string, number>>
  degrees: Map<string, number>
  internalEdges: Map<string, GraphEdge[]>
} {
  const ids = new Set(entities.map(e => e.id))
  const adjacency = new Map<string, Map<string, number>>()
  const degrees = new Map<string, number>()
  const internalEdges = new Map<string, GraphEdge[]>()
  for (const id of ids) {
    adjacency.set(id, new Map())
    degrees.set(id, 0)
  }
  for (const edge of edges) {
    if (edge.deletedAt || !['active', 'provisional'].includes(edge.status)) continue
    if (!ids.has(edge.srcId) || !ids.has(edge.dstId) || edge.srcId === edge.dstId) continue
    const rw = RELATION_WEIGHT[edge.relation] ?? 0
    if (rw <= 0) continue
    const weight = rw * Math.max(0.05, edge.confidence) * Math.max(0.1, edge.weight ?? 1)
    adjacency.get(edge.srcId)!.set(edge.dstId, (adjacency.get(edge.srcId)!.get(edge.dstId) ?? 0) + weight)
    adjacency.get(edge.dstId)!.set(edge.srcId, (adjacency.get(edge.dstId)!.get(edge.srcId) ?? 0) + weight)
    degrees.set(edge.srcId, (degrees.get(edge.srcId) ?? 0) + 1)
    degrees.set(edge.dstId, (degrees.get(edge.dstId) ?? 0) + 1)
    if (!internalEdges.has(edge.srcId)) internalEdges.set(edge.srcId, [])
    if (!internalEdges.has(edge.dstId)) internalEdges.set(edge.dstId, [])
    internalEdges.get(edge.srcId)!.push(edge)
    internalEdges.get(edge.dstId)!.push(edge)
  }
  return { adjacency, degrees, internalEdges }
}

function groupsFromLabels(
  labels: Map<string, string>,
  entities: GraphEntity[],
  edges: GraphEdge[],
  minSize: number,
): Group[] {
  const byLabel = new Map<string, string[]>()
  for (const [id, label] of labels) {
    if (!byLabel.has(label)) byLabel.set(label, [])
    byLabel.get(label)!.push(id)
  }
  const entityById = new Map(entities.map(e => [e.id, e]))
  const groups: Group[] = []
  for (const memberIds of byLabel.values()) {
    if (memberIds.length < minSize) continue
    const set = new Set(memberIds)
    const edgeCount = edges.filter(e => set.has(e.srcId) && set.has(e.dstId)).length
    // 成员排序：度/显著性优先，保证稳定
    memberIds.sort((a, b) => {
      const ea = entityById.get(a)
      const eb = entityById.get(b)
      const sa = (ea?.salience ?? 0) + Math.min(1, (ea?.degree ?? 0) / 10)
      const sb = (eb?.salience ?? 0) + Math.min(1, (eb?.degree ?? 0) / 10)
      return sb - sa || a.localeCompare(b)
    })
    groups.push({ memberIds, edgeCount })
  }
  groups.sort((a, b) => b.memberIds.length - a.memberIds.length || a.memberIds[0]!.localeCompare(b.memberIds[0]!))
  return groups
}

function communityId(memberIds: string[]): string {
  return deterministicId('com', [...memberIds].sort())
}

function templateSummary(group: Group, entities: GraphEntity[], edges: GraphEdge[]): { title: string, summary: string } {
  const byId = new Map(entities.map(e => [e.id, e]))
  const set = new Set(group.memberIds)
  const names = group.memberIds.slice(0, 4).map(id => byId.get(id)?.canonicalName ?? id)
  const title = `${names.slice(0, 2).join('、')}${group.memberIds.length > 2 ? ' 等' : ''}`.slice(0, 80)
  const facts = edges
    .filter(e => set.has(e.srcId) && set.has(e.dstId) && e.relation !== 'mentions')
    .sort((a, b) => (b.confidence * (b.weight ?? 1)) - (a.confidence * (a.weight ?? 1)))
    .slice(0, 5)
    .map(e => `${byId.get(e.srcId)?.canonicalName ?? e.srcId} --${e.relation}--> ${byId.get(e.dstId)?.canonicalName ?? e.dstId}${e.fact ? `：${e.fact.slice(0, 80)}` : ''}`)
  const summary = [
    `社区：${names.join('、')}${group.memberIds.length > names.length ? ` 等 ${group.memberIds.length} 个实体` : ''}。`,
    facts.length > 0 ? `关键关系：\n- ${facts.join('\n- ')}` : '暂无高置信关系。',
  ].join('\n')
  return { title, summary }
}

/** 0 层社区（无历史复用；Agent 侧用 detectCommunitiesWithExisting 保 id 稳定） */
export function detectCommunities(
  entities: GraphEntity[],
  edges: GraphEdge[],
  opts: DetectCommunityOptions = {},
): DetectedCommunity[] {
  const minSize = Math.max(2, opts.minSize ?? 3)
  const usable = entities.filter(e =>
    e.entityType !== 'episode' && !e.deletedAt && !e.mergedInto
    && (e.status === 'active' || e.status === 'provisional'))
  if (usable.length < minSize) return []
  const { adjacency } = buildAdjacency(usable, edges)
  const labels = labelPropagation(usable.map(e => e.id), adjacency, opts.maxIterations ?? 10)
  const groups = groupsFromLabels(labels, usable, edges, minSize)
  return groups.map((group) => {
    const t = templateSummary(group, usable, edges)
    return {
      id: communityId(group.memberIds), level: 0, parentId: null,
      title: t.title, summary: t.summary, memberIds: group.memberIds, edgeCount: group.edgeCount,
    }
  })
}

/** 带成员的现有社区（agent 从 repo.communityMembers 组装） */
export function detectCommunitiesWithExisting(
  entities: GraphEntity[],
  edges: GraphEdge[],
  existing: Array<{ id: string, memberIds: string[] }>,
  opts: Omit<DetectCommunityOptions, 'existing'> = {},
): DetectedCommunity[] {
  const minSize = Math.max(2, opts.minSize ?? 3)
  const usable = entities.filter(e =>
    e.entityType !== 'episode' && !e.deletedAt && !e.mergedInto
    && (e.status === 'active' || e.status === 'provisional'))
  if (usable.length < minSize) return []
  const { adjacency } = buildAdjacency(usable, edges)
  const labels = labelPropagation(usable.map(e => e.id), adjacency, opts.maxIterations ?? 10)
  const groups = groupsFromLabels(labels, usable, edges, minSize)
  const used = new Set<string>()
  return groups.map((group) => {
    let reuse: { id: string, memberIds: string[] } | null = null
    let best = 0
    for (const c of existing) {
      if (used.has(c.id)) continue
      const sim = jaccard(group.memberIds, c.memberIds)
      if (sim > best) {
        best = sim
        reuse = c
      }
    }
    const id = reuse && best >= 0.6 ? reuse.id : communityId(group.memberIds)
    if (reuse && best >= 0.6) used.add(reuse.id)
    const t = templateSummary(group, usable, edges)
    return {
      id, level: 0, parentId: null, title: t.title, summary: t.summary,
      memberIds: group.memberIds, edgeCount: group.edgeCount,
    }
  })
}

/** 用 LLM 覆盖摘要；失败/空保留模板。返回新数组。 */
export async function summarizeCommunities(
  communities: DetectedCommunity[],
  entities: GraphEntity[],
  edges: GraphEdge[],
  summarize: (input: { title: string, memberNames: string[], facts: string[] }) => Promise<string | null>,
): Promise<DetectedCommunity[]> {
  const byId = new Map(entities.map(e => [e.id, e]))
  const out: DetectedCommunity[] = []
  for (const c of communities) {
    const set = new Set(c.memberIds)
    const facts = edges
      .filter(e => set.has(e.srcId) && set.has(e.dstId) && e.relation !== 'mentions')
      .slice(0, 8)
      .map(e => `${byId.get(e.srcId)?.canonicalName ?? e.srcId} --${e.relation}--> ${byId.get(e.dstId)?.canonicalName ?? e.dstId}${e.fact ? `：${e.fact.slice(0, 100)}` : ''}`)
    const memberNames = c.memberIds.slice(0, 20).map(id => byId.get(id)?.canonicalName ?? id)
    const summary = await summarize({ title: c.title, memberNames, facts }).catch(() => null)
    out.push({ ...c, summary: summary?.trim() ? summary.trim().slice(0, 1200) : c.summary })
  }
  return out
}

/** 社区摘要 hash（用于“成员/事实变化才重写”） */
export function communitySummaryHash(c: DetectedCommunity): string {
  return shortHash(`${[...c.memberIds].sort().join(',')}|${c.summary}`, 16)
}
