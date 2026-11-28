/**
 * 知识网络规范化：实体键、别名、事实键、关系词表、相似度。
 *
 * 纪律：
 *  - canonical_key 用于精确去重（去空白/标点，保留字母数字与 CJK）；
 *  - fact_key 保留数字与小数点（60 与 62、3.05 与 3.1 不能碰撞）；
 *  - 关系先走受控词表，未知关系归 relates_to 并保留原始 label；
 *  - CJK FTS 走 segmentCJK（与记忆 FTS 同一口径）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { segmentCJK } from '../../runtime/memory/helpers'
import {
  GRAPH_RELATIONS,
  type GraphEntityType,
  type GraphRelation,
  type GraphSeed,
} from './types'

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function shortHash(text: string, len = 16): string {
  return sha256(text).slice(0, len)
}

export function makeId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`
}

export function deterministicId(prefix: string, parts: Array<string | number>): string {
  return `${prefix}-${shortHash(parts.join('|'))}`
}

/** 实体去重键：NFKC + 小写 + 去空白/标点/符号；保留字母、数字、CJK */
export function normalizeEntityKey(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim()
}

/** 展示/匹配用的紧凑文本：保留空格归一，去掉多余标点 */
export function normalizeCompact(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
    .trim()
}

/**
 * 事实键：保留数字/小数点/单位，避免 3.05 与 3.1 被归一成同一键。
 * 空事实返回 ''（结构化边按 src+relation+dst 归并）。
 */
export function normalizeFact(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/→/g, '>')
    .replace(/->/g, '>')
    .replace(/[^\p{L}\p{N}.%>+\-/]+/gu, '')
}

export function factKeyOf(fact: string): string {
  const n = normalizeFact(fact)
  return n ? shortHash(n, 16) : ''
}

/** FTS 写入文本：名称 + 别名 + 摘要，CJK 逐字分段（与记忆 FTS 同口径） */
export function entitySearchText(name: string, aliases: string[] = [], summary = ''): string {
  return segmentCJK([name, ...aliases, summary].filter(Boolean).join(' '))
    .replace(/\s+/g, ' ')
    .trim()
}

const RELATION_SYNONYMS: Array<[RegExp, GraphRelation]> = [
  [/^(mentions?|提及|提到)$/i, 'mentions'],
  [/^(causes?|cause|导致|引起|造成|引发)$/i, 'causes'],
  [/^(affects?|affect|effects?|影响|改善|提升|降低|减少|增加)$/i, 'affects'],
  [/^(supports?|support|证实|支持|验证|佐证)$/i, 'supports'],
  [/^(contradicts?|contradict|矛盾|冲突|反驳|否定)$/i, 'contradicts'],
  [/^(supersedes?|supersede|取代|替代|覆盖)$/i, 'supersedes'],
  [/^(derived_from|derived|from|派生|来源|出自)$/i, 'derived_from'],
  [/^(part_of|belongs_to|属于|组成部分|子项)$/i, 'part_of'],
  [/^(used_for|uses|用于|用途)$/i, 'used_for'],
  [/^(precedes?|before|先于|之前|早于)$/i, 'precedes'],
  [/^(has_parameter|有参数|包含参数)$/i, 'has_parameter'],
  [/^(uses_recipe|使用配方|采用配方)$/i, 'uses_recipe'],
  [/^(observed_in|观测于|出现在)$/i, 'observed_in'],
  [/^(relates?_to|related|相关|关联)$/i, 'relates_to'],
]

export function canonicalRelation(raw: string): { relation: GraphRelation, label: string } {
  const text = String(raw ?? '').trim()
  if (!text) return { relation: 'relates_to', label: '' }
  const lower = text.toLowerCase().replace(/\s+/g, '_')
  for (const [re, relation] of RELATION_SYNONYMS) {
    if (re.test(lower) || re.test(text)) return { relation, label: text }
  }
  return { relation: 'relates_to', label: text }
}

export function isGraphRelation(value: string): value is GraphRelation {
  return (GRAPH_RELATIONS as string[]).includes(value)
}

export function isEntityType(value: string): value is GraphEntityType {
  return value === 'episode' || value === 'concept' || value === 'parameter'
    || value === 'metric' || value === 'device' || value === 'node'
    || value === 'recipe' || value === 'product' || value === 'line'
    || value === 'task' || value === 'event' || value === 'document' || value === 'person'
}

/** 字符 bigram Jaccard（CJK/短名友好）+ ASCII 词 Jaccard，取较大值 */
export function similarity(a: string, b: string): number {
  const x = normalizeEntityKey(a)
  const y = normalizeEntityKey(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    if (s.length === 1) set.add(s)
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const bx = bigrams(x)
  const by = bigrams(y)
  let inter = 0
  for (const g of bx) if (by.has(g)) inter++
  const union = bx.size + by.size - inter
  const bigramScore = union > 0 ? inter / union : 0
  const words = (s: string): Set<string> => new Set(s.split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  const wx = words(normalizeCompact(a))
  const wy = words(normalizeCompact(b))
  let wInter = 0
  for (const w of wx) if (wy.has(w)) wInter++
  const wUnion = wx.size + wy.size - wInter
  const wordScore = wUnion > 0 ? wInter / wUnion : 0
  return Math.max(bigramScore, wordScore)
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

export function safeJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as T[] : []
  }
  catch {
    return []
  }
}

export function safeJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  }
  catch {
    return {}
  }
}

export function uniqueAliases(aliases: string[], name: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of [name, ...aliases]) {
    const text = String(a ?? '').trim().slice(0, 80)
    const key = normalizeEntityKey(text)
    if (!text || !key || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out.slice(0, 20)
}

export function seedWeight(reason: GraphSeed['reason']): number {
  switch (reason) {
    case 'alias':
    case 'canonical': return 1
    case 'fts': return 0.8
    case 'vector': return 0.8
    case 'mention': return 0.5
    default: return 0.5
  }
}
