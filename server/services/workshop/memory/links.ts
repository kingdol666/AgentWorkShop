/**
 * 记忆链接（批次 K）：supports / contradicts / supersedes / derived_from。
 * 只追加，不删除；争议双方可查。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type MemoryLinkRelation = 'supports' | 'contradicts' | 'supersedes' | 'derived_from'

export interface MemoryLink {
  id: string
  srcId: string
  dstId: string
  relation: MemoryLinkRelation
  createdBy: string
  createdAt: string
}

export function addMemoryLink(db: DatabaseSync, input: {
  srcId: string
  dstId: string
  relation: MemoryLinkRelation
  createdBy: string
}): MemoryLink {
  if (input.srcId === input.dstId) throw new Error('链接两端不能相同')
  const id = `ml-${randomUUID().slice(0, 12)}`
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO memory_links(id, src_id, dst_id, relation, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(src_id, dst_id, relation) DO NOTHING`,
  ).run(id, input.srcId, input.dstId, input.relation, input.createdBy, now)
  const row = db.prepare('SELECT id, src_id AS srcId, dst_id AS dstId, relation, created_by AS createdBy, created_at AS createdAt FROM memory_links WHERE src_id = ? AND dst_id = ? AND relation = ?')
    .get(input.srcId, input.dstId, input.relation) as unknown as MemoryLink
  return row
}

export function listMemoryLinks(db: DatabaseSync, memoryId: string, direction: 'both' | 'out' | 'in' = 'both'): MemoryLink[] {
  const where = direction === 'out' ? 'src_id = ?' : direction === 'in' ? 'dst_id = ?' : '(src_id = ? OR dst_id = ?)'
  const args = direction === 'both' ? [memoryId, memoryId] : [memoryId]
  return db.prepare(
    `SELECT id, src_id AS srcId, dst_id AS dstId, relation, created_by AS createdBy, created_at AS createdAt
       FROM memory_links WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
  ).all(...args) as unknown as MemoryLink[]
}

/** 失效不删除：旧行 valid_to=now，新行 valid_from=now，并加 supersedes 链接 */
export function supersedeMemory(db: DatabaseSync, oldId: string, newId: string, actor: string): void {
  const now = new Date().toISOString()
  db.prepare('UPDATE agent_memories SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND (valid_to IS NULL OR valid_to > ?)')
    .run(now, newId, now, oldId, now)
  db.prepare('UPDATE agent_memories SET valid_from = COALESCE(valid_from, ?) WHERE id = ?').run(now, newId)
  addMemoryLink(db, { srcId: newId, dstId: oldId, relation: 'supersedes', createdBy: actor })
}
