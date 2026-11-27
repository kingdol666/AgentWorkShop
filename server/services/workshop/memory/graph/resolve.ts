/**
 * 实体解析：精确键/别名 → 相似度 → 新建/合并候选。
 *
 * 保守纪律：
 *  - 只在同 channel + 同 scope + 同 entityType 内合并；
 *  - 相似度 ≥0.92 自动并别名；0.78–0.92 只建合并候选，不自动合并；
 *  - locked/human 行不改；
 *  - 合并只写 merged_into（读时归一），不物理搬边，支持 unmerge。
 */
import type { MemoryScopeKind } from '../../db/database'
import {
  normalizeEntityKey,
  similarity,
  uniqueAliases,
} from './normalize'
import type { GraphRepo, UpsertEntityInput } from './repo'
import type { GraphEntity, GraphEntityType } from './types'

export interface EntityIndex {
  byKey: Map<string, GraphEntity>
  byAlias: Map<string, GraphEntity>
  all: GraphEntity[]
}

export function buildEntityIndex(entities: GraphEntity[]): EntityIndex {
  const byKey = new Map<string, GraphEntity>()
  const byAlias = new Map<string, GraphEntity>()
  for (const e of entities) {
    if (e.deletedAt || e.mergedInto || e.status === 'rejected' || e.status === 'retired') continue
    byKey.set(`${e.entityType}|${e.canonicalKey}`, e)
    for (const alias of uniqueAliases(e.aliases, e.canonicalName)) {
      byAlias.set(`${e.entityType}|${normalizeEntityKey(alias)}`, e)
    }
  }
  return { byKey, byAlias, all: entities.filter(e => !e.deletedAt && !e.mergedInto && e.status !== 'rejected' && e.status !== 'retired') }
}

export function findExact(index: EntityIndex, name: string, type: GraphEntityType): GraphEntity | null {
  const key = normalizeEntityKey(name)
  if (!key) return null
  return index.byKey.get(`${type}|${key}`) ?? index.byAlias.get(`${type}|${key}`) ?? null
}

export function findFuzzy(
  index: EntityIndex,
  name: string,
  type: GraphEntityType,
  scopeKind: string,
  scopeKey: string,
  limit = 3,
): Array<{ entity: GraphEntity, score: number }> {
  const out: Array<{ entity: GraphEntity, score: number }> = []
  for (const e of index.all) {
    if (e.entityType !== type || e.scopeKind !== scopeKind || e.scopeKey !== scopeKey) continue
    const score = similarity(name, e.canonicalName)
    if (score >= 0.78) out.push({ entity: e, score })
  }
  out.sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id))
  return out.slice(0, limit)
}

export interface ResolveInput extends Omit<UpsertEntityInput, 'entityType' | 'canonicalName'> {
  name: string
  type: GraphEntityType
  scopeKind: MemoryScopeKind
  scopeKey: string
}

export interface ResolveResult {
  entity: GraphEntity
  outcome: 'exact' | 'linked' | 'created' | 'candidate'
  candidateTargetId?: string
  /** 命中人工否决/锁定/已删除行：调用方不得再为它挂提及或边。 */
  blocked?: boolean
}

/**
 * 解析或创建实体；调用方负责把返回实体加入 index（本函数会更新 index）。
 */
export function resolveOrCreateEntity(
  repo: GraphRepo,
  index: EntityIndex,
  input: ResolveInput,
): ResolveResult {
  const exact = findExact(index, input.canonicalKey ?? input.name, input.type)
  if (exact) {
    if (exact.status === 'rejected') return { entity: exact, outcome: 'exact', blocked: true }
    if (exact.scopeKind === input.scopeKind && exact.scopeKey === input.scopeKey) {
      repo.addAlias(exact.id, input.name, input.sourceKind ?? 'memory', input.confidence ?? 0.6)
      return { entity: exact, outcome: 'exact' }
    }
  }
  const fuzzy = findFuzzy(index, input.name, input.type, input.scopeKind, input.scopeKey)
    .filter(f => f.entity.status !== 'rejected' && f.entity.status !== 'retired')
  const best = fuzzy[0]
  if (best && best.score >= 0.92 && !best.entity.locked && best.entity.authorKind !== 'human') {
    repo.addAlias(best.entity.id, input.name, input.sourceKind ?? 'memory', best.score)
    return { entity: repo.getEntity(best.entity.id) ?? best.entity, outcome: 'linked' }
  }
  const up = repo.upsertEntity({
    ...input,
    canonicalName: input.name,
    entityType: input.type,
    status: input.status ?? 'provisional',
    confidence: input.confidence ?? 0.5,
    aliases: uniqueAliases(input.aliases ?? [], input.name),
  })
  const created = up.entity
  // 人工否决/锁定行由 repo 保护；不得加入索引或继续挂边/提及。
  if (up.outcome === 'protected') return { entity: created, outcome: 'exact', blocked: true }
  index.all.push(created)
  index.byKey.set(`${created.entityType}|${created.canonicalKey}`, created)
  for (const alias of uniqueAliases(created.aliases, created.canonicalName)) {
    index.byAlias.set(`${created.entityType}|${normalizeEntityKey(alias)}`, created)
  }
  if (best && best.score >= 0.78) {
    repo.upsertMergeCandidate(created.channelId, created.id, best.entity.id, best.score,
      `名称相似 ${input.name} ↔ ${best.entity.canonicalName}`)
    return { entity: created, outcome: 'candidate', candidateTargetId: best.entity.id }
  }
  return { entity: created, outcome: 'created' }
}
