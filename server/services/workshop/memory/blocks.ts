/**
 * Core Blocks（批次 J）：小而稳定的核心记忆块（label/value/limit/description/locked/revision）。
 * 人工可编辑/锁定/回滚；Agent 只能 append/replace 未锁定块；超限先摘要/截断。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface MemoryBlock {
  id: string
  scopeId: string
  scopeKind: string
  scopeKey: string
  channelId: string
  sessionId: string
  label: string
  value: string
  limitChars: number
  description: string
  locked: boolean
  revision: number
  updatedBy: string
  updatedAt: string
}

const COLS = `id, scope_id AS scopeId, scope_kind AS scopeKind, scope_key AS scopeKey, channel_id AS channelId,
  session_id AS sessionId, label, value, limit_chars AS limitChars, description, locked, revision,
  updated_by AS updatedBy, updated_at AS updatedAt`

const map = (r: Record<string, unknown>): MemoryBlock => ({
  ...r,
  locked: Number(r.locked ?? 0) === 1,
  limitChars: Number(r.limitChars ?? 2000),
  revision: Number(r.revision ?? 1),
}) as MemoryBlock

export function scopeIdOfChannel(channelId: string): string {
  return `channel:${channelId}`
}
export function scopeIdOfSession(sessionId: string): string {
  return `session:${sessionId}`
}

export function listBlocks(db: DatabaseSync, scopeIds: string[]): MemoryBlock[] {
  if (scopeIds.length === 0) return []
  return (db.prepare(`SELECT ${COLS} FROM memory_blocks WHERE scope_id IN (${scopeIds.map(() => '?').join(', ')}) ORDER BY label ASC`)
    .all(...scopeIds) as Array<Record<string, unknown>>).map(map)
}

export function getBlock(db: DatabaseSync, scopeId: string, label: string): MemoryBlock | null {
  const row = db.prepare(`SELECT ${COLS} FROM memory_blocks WHERE scope_id = ? AND label = ?`).get(scopeId, label) as Record<string, unknown> | undefined
  return row ? map(row) : null
}

function snapshot(db: DatabaseSync, block: MemoryBlock, actor: string): void {
  db.prepare(
    `INSERT INTO memory_block_revisions(id, block_id, revision, value, updated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(block_id, revision) DO NOTHING`,
  ).run(`mbr-${randomUUID().slice(0, 12)}`, block.id, block.revision, block.value, actor, new Date().toISOString())
}

export interface UpsertBlockInput {
  scopeId: string
  scopeKind?: 'channel' | 'session'
  scopeKey?: string
  channelId: string
  sessionId?: string
  label: string
  value: string
  limitChars?: number
  description?: string
  actor: string
  /** 人工操作可覆盖 locked 块 */
  human?: boolean
  expectedRevision?: number
}

export function upsertBlock(db: DatabaseSync, input: UpsertBlockInput): { block: MemoryBlock, truncated: boolean } {
  const label = input.label.trim()
  if (!label || label.length > 80) throw new Error('block label 必填且 ≤80 字符')
  const limit = Math.max(100, Math.min(input.limitChars ?? 2000, 20_000))
  const existing = getBlock(db, input.scopeId, label)
  if (existing?.locked && !input.human) throw new Error(`block ${label} 已锁定，Agent 不可改写`)
  if (existing && input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
    throw new Error(`block ${label} revision 冲突（当前 ${existing.revision}）`)
  }
  if (existing) snapshot(db, existing, input.actor)
  const truncated = input.value.length > limit
  const value = truncated ? input.value.slice(0, limit) : input.value
  const now = new Date().toISOString()
  if (existing) {
    db.prepare(
      `UPDATE memory_blocks SET value = ?, limit_chars = ?, description = ?, revision = revision + 1,
         updated_by = ?, updated_at = ? WHERE id = ?`,
    ).run(value, limit, input.description ?? existing.description, input.actor, now, existing.id)
  }
  else {
    db.prepare(
      `INSERT INTO memory_blocks(id, scope_id, scope_kind, scope_key, runtime_id, agent_id, session_id, channel_id,
         label, value, limit_chars, description, locked, revision, updated_by, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    ).run(`mb-${randomUUID().slice(0, 12)}`, input.scopeId, input.scopeKind ?? (input.scopeId.startsWith('session:') ? 'session' : 'channel'),
      input.scopeKey ?? '', input.actor, input.sessionId ?? '', input.channelId, label, value, limit, input.description ?? '', input.actor, now)
  }
  return { block: getBlock(db, input.scopeId, label)!, truncated }
}

export function appendBlock(db: DatabaseSync, input: UpsertBlockInput): { block: MemoryBlock, truncated: boolean } {
  const existing = getBlock(db, input.scopeId, input.label)
  return upsertBlock(db, { ...input, value: `${existing?.value ?? ''}${existing ? '\n' : ''}${input.value}` })
}

export function setBlockLocked(db: DatabaseSync, scopeId: string, label: string, locked: boolean, actor: string): boolean {
  return Number(db.prepare('UPDATE memory_blocks SET locked = ?, updated_by = ?, updated_at = ? WHERE scope_id = ? AND label = ?')
    .run(locked ? 1 : 0, actor, new Date().toISOString(), scopeId, label).changes ?? 0) > 0
}

export function rollbackBlock(db: DatabaseSync, scopeId: string, label: string, revision: number, actor: string): boolean {
  const row = db.prepare('SELECT value FROM memory_block_revisions WHERE block_id = (SELECT id FROM memory_blocks WHERE scope_id = ? AND label = ?) AND revision = ?')
    .get(scopeId, label, revision) as { value?: string } | undefined
  if (row?.value === undefined) return false
  const block = getBlock(db, scopeId, label)
  if (!block) return false
  snapshot(db, block, actor)
  db.prepare('UPDATE memory_blocks SET value = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?')
    .run(row.value, actor, new Date().toISOString(), block.id)
  return true
}

export function blockRevisions(db: DatabaseSync, scopeId: string, label: string): Array<{ revision: number, value: string, updatedBy: string, createdAt: string }> {
  const block = getBlock(db, scopeId, label)
  if (!block) return []
  return db.prepare('SELECT revision, value, updated_by AS updatedBy, created_at AS createdAt FROM memory_block_revisions WHERE block_id = ? ORDER BY revision DESC')
    .all(block.id) as Array<{ revision: number, value: string, updatedBy: string, createdAt: string }>
}
