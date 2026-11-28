/**
 * 记忆文件（批次 J）/memories 六命令。
 *
 * 纪律：
 *  - 路径必须 `/memories/<scope>/...`；拒绝 `..`、反斜杠、编码穿越、绝对盘符；
 *  - 大小/数量上限；删除软删可恢复；每次命令追加不可变 revision；
 *  - 内容存储原文（不再做 FTS 切分；文件浏览器/注入索引读取原文）。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface MemoryDocument {
  id: string
  scopeId: string
  scopeKind: string
  scopeKey: string
  channelId: string
  sessionId: string
  path: string
  content: string
  contentHash: string
  size: number
  revision: number
  authorKind: string
  authorId: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

const COLS = `id, scope_id AS scopeId, scope_kind AS scopeKind, scope_key AS scopeKey, channel_id AS channelId,
  session_id AS sessionId, path, content, content_hash AS contentHash, size, revision,
  author_kind AS authorKind, author_id AS authorId, deleted_at AS deletedAt, created_at AS createdAt, updated_at AS updatedAt`

const MAX_DOC_BYTES = 64 * 1024
const MAX_DOCS_PER_SCOPE = 200
const MAX_PATH_LEN = 240

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** 路径规范化与穿越拒绝（返回规范路径；非法抛错） */
export function normalizeDocumentPath(raw: string): string {
  const input = String(raw ?? '').trim()
  if (!input) throw new Error('path 必填')
  if (input.length > MAX_PATH_LEN) throw new Error(`path 过长（>${MAX_PATH_LEN}）`)
  if (input.includes('\\') || /%2e|%2f|%5c/i.test(input)) throw new Error('非法路径（编码/反斜杠穿越）')
  if (/^[a-z]:/i.test(input)) throw new Error('不允许绝对盘符路径')
  if (!input.startsWith('/memories/')) throw new Error('路径必须位于 /memories/ 下')
  const parts = input.split('/')
  if (parts.some(p => p === '..' || p === '.')) throw new Error('路径不得包含 . 或 ..')
  const normalized = parts.filter(Boolean).join('/')
  if (!normalized.startsWith('memories/') || normalized.split('/').length < 3) {
    throw new Error('路径至少 /memories/<scope>/<file>')
  }
  return `/${normalized}`
}

export function getDocument(db: DatabaseSync, scopeId: string, path: string): MemoryDocument | null {
  const row = db.prepare(`SELECT ${COLS} FROM memory_documents WHERE scope_id = ? AND path = ?`).get(scopeId, path) as Record<string, unknown> | undefined
  return row ? row as unknown as MemoryDocument : null
}

export function listDocuments(db: DatabaseSync, scopeIds: string[], opts: { includeDeleted?: boolean } = {}): MemoryDocument[] {
  if (scopeIds.length === 0) return []
  const where = [`scope_id IN (${scopeIds.map(() => '?').join(', ')})`]
  if (!opts.includeDeleted) where.push('deleted_at IS NULL')
  return db.prepare(`SELECT ${COLS} FROM memory_documents WHERE ${where.join(' AND ')} ORDER BY path ASC`)
    .all(...scopeIds) as unknown as MemoryDocument[]
}

function snapshot(db: DatabaseSync, doc: MemoryDocument): void {
  db.prepare(
    `INSERT INTO memory_document_revisions(id, document_id, revision, content, content_hash, author_kind, author_id, deleted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(document_id, revision) DO NOTHING`,
  ).run(`mdr-${randomUUID().slice(0, 12)}`, doc.id, doc.revision, doc.content, doc.contentHash, doc.authorKind, doc.authorId, doc.deletedAt, new Date().toISOString())
}

export interface DocumentWriteInput {
  scopeId: string
  scopeKind?: 'channel' | 'session'
  scopeKey?: string
  channelId: string
  sessionId?: string
  path: string
  content: string
  authorKind: 'agent' | 'human' | 'system'
  authorId: string
}

export function createDocument(db: DatabaseSync, input: DocumentWriteInput): MemoryDocument {
  const path = normalizeDocumentPath(input.path)
  if (Buffer.byteLength(input.content, 'utf8') > MAX_DOC_BYTES) throw new Error('文件超过 64KB 上限')
  const existing = getDocument(db, input.scopeId, path)
  if (existing && !existing.deletedAt) throw new Error('文件已存在；请用 insert/str_replace')
  const count = Number((db.prepare('SELECT COUNT(*) AS n FROM memory_documents WHERE scope_id = ? AND deleted_at IS NULL').get(input.scopeId) as { n: number }).n)
  if (count >= MAX_DOCS_PER_SCOPE) throw new Error(`作用域文件数超过 ${MAX_DOCS_PER_SCOPE} 上限`)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO memory_documents(id, scope_id, scope_kind, scope_key, runtime_id, session_id, channel_id, path, content,
       content_hash, size, revision, author_kind, author_id, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)
     ON CONFLICT(scope_id, path) DO UPDATE SET content = excluded.content, content_hash = excluded.content_hash,
       size = excluded.size, revision = memory_documents.revision + 1, author_kind = excluded.author_kind,
       author_id = excluded.author_id, deleted_at = NULL, updated_at = excluded.updated_at`,
  ).run(`md-${randomUUID().slice(0, 12)}`, input.scopeId, input.scopeKind ?? (input.scopeId.startsWith('session:') ? 'session' : 'channel'),
    input.scopeKey ?? '', input.sessionId ?? '', input.channelId, path, input.content, sha256(input.content),
    Buffer.byteLength(input.content, 'utf8'), input.authorKind, input.authorId, now, now)
  return getDocument(db, input.scopeId, path)!
}

export function insertDocument(db: DatabaseSync, input: DocumentWriteInput, afterLine?: number): MemoryDocument {
  const path = normalizeDocumentPath(input.path)
  const existing = getDocument(db, input.scopeId, path)
  if (!existing || existing.deletedAt) throw new Error('文件不存在')
  const lines = existing.content.split('\n')
  const at = Math.max(0, Math.min(afterLine ?? lines.length, lines.length))
  lines.splice(at, 0, input.content)
  return replaceContent(db, existing, lines.join('\n'), input)
}

export function replaceInDocument(db: DatabaseSync, input: DocumentWriteInput, oldText: string): MemoryDocument {
  const path = normalizeDocumentPath(input.path)
  const existing = getDocument(db, input.scopeId, path)
  if (!existing || existing.deletedAt) throw new Error('文件不存在')
  if (!oldText || !existing.content.includes(oldText)) throw new Error('str_replace 目标文本不存在')
  return replaceContent(db, existing, existing.content.replace(oldText, input.content), input)
}

function replaceContent(db: DatabaseSync, existing: MemoryDocument, content: string, input: DocumentWriteInput): MemoryDocument {
  if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) throw new Error('文件超过 64KB 上限')
  snapshot(db, existing)
  db.prepare(
    `UPDATE memory_documents SET content = ?, content_hash = ?, size = ?, revision = revision + 1,
       author_kind = ?, author_id = ?, updated_at = ? WHERE id = ?`,
  ).run(content, sha256(content), Buffer.byteLength(content, 'utf8'), input.authorKind, input.authorId, new Date().toISOString(), existing.id)
  return getDocument(db, existing.scopeId, existing.path)!
}

export function renameDocument(db: DatabaseSync, scopeId: string, from: string, to: string, _actor: string): MemoryDocument {
  const src = getDocument(db, scopeId, normalizeDocumentPath(from))
  if (!src || src.deletedAt) throw new Error('源文件不存在')
  const target = normalizeDocumentPath(to)
  if (getDocument(db, scopeId, target) && !getDocument(db, scopeId, target)?.deletedAt) throw new Error('目标路径已存在')
  snapshot(db, src)
  db.prepare('UPDATE memory_documents SET path = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
    .run(target, new Date().toISOString(), src.id)
  return getDocument(db, scopeId, target)!
}

export function softDeleteDocument(db: DatabaseSync, scopeId: string, path: string, _actor: string): boolean {
  const doc = getDocument(db, scopeId, normalizeDocumentPath(path))
  if (!doc || doc.deletedAt) return false
  snapshot(db, doc)
  db.prepare('UPDATE memory_documents SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), new Date().toISOString(), doc.id)
  return true
}

export function restoreDocument(db: DatabaseSync, scopeId: string, path: string): boolean {
  const doc = getDocument(db, scopeId, normalizeDocumentPath(path))
  if (!doc || !doc.deletedAt) return false
  db.prepare('UPDATE memory_documents SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), doc.id)
  return true
}

export function documentRevisions(db: DatabaseSync, scopeId: string, path: string): Array<{ revision: number, contentHash: string, authorKind: string, createdAt: string }> {
  const doc = getDocument(db, scopeId, normalizeDocumentPath(path))
  if (!doc) return []
  return db.prepare('SELECT revision, content_hash AS contentHash, author_kind AS authorKind, created_at AS createdAt FROM memory_document_revisions WHERE document_id = ? ORDER BY revision DESC')
    .all(doc.id) as Array<{ revision: number, contentHash: string, authorKind: string, createdAt: string }>
}

/** 注入索引（只列路径/大小/修订，不注入正文） */
export function documentIndex(db: DatabaseSync, scopeIds: string[], limit = 20): Array<{ path: string, size: number, revision: number }> {
  if (scopeIds.length === 0) return []
  return db.prepare(
    `SELECT path, size, revision FROM memory_documents WHERE scope_id IN (${scopeIds.map(() => '?').join(', ')})
       AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  ).all(...scopeIds, Math.min(Math.max(limit, 1), 100)) as Array<{ path: string, size: number, revision: number }>
}
