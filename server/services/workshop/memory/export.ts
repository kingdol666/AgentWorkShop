/**
 * 记忆导出/导入/敏感过滤/修复（批次 L，2026-11-27）。
 * - 导出按 scope JSONL：memories / blocks / documents / links（含 revision 元数据）；
 * - 导入同 scope 幂等（dedupKey/path 冲突更新或跳过）；
 * - 敏感过滤：可配置 denylist，命中不落库（写入前调用）；
 * - 健康：FTS 重建、孤儿注入日志清理、块/文档超限统计。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createMemoryRepo } from '../db/memory.repo'
import { listBlocks, upsertBlock, scopeIdOfChannel, scopeIdOfSession } from './blocks'
import { createDocument, documentIndex, listDocuments } from './documents'
import { listMemoryLinks } from './links'

const DEFAULT_DENY = [
  /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*[^\s,;]{8,}/gi,
  /\b(?:\d[ -]*?){13,19}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
]

export function redactSensitive(text: string, patterns: RegExp[] = DEFAULT_DENY): { text: string, hits: number } {
  let hits = 0
  let out = text
  for (const re of patterns) {
    out = out.replace(re, (m) => {
      hits++
      return m.length > 8 ? `${m.slice(0, 4)}***` : '***'
    })
  }
  return { text: out, hits }
}

export interface ExportOptions {
  channelId: string
  sessionId?: string | null
  includeDeleted?: boolean
}

/** 导出 JSONL（不含二进制/向量；文档正文原样） */
export function exportMemoryJsonl(db: DatabaseSync, opts: ExportOptions): string {
  const repo = createMemoryRepo(db)
  const lines: string[] = []
  const scopeIds = [scopeIdOfChannel(opts.channelId)]
  if (opts.sessionId) scopeIds.push(scopeIdOfSession(opts.sessionId))
  const rows = db.prepare(
    `SELECT id, channel_id AS channelId, agent_id AS agentId, kind, title, content, importance, task_id AS taskId,
            session_id AS sessionId, dedup_key AS dedupKey, outcome, evidence_json AS evidenceJson,
            scope_kind AS scopeKind, scope_key AS scopeKey, status, expires_at AS expiresAt,
            author_kind AS authorKind, author_id AS authorId, revision, pinned, created_at AS createdAt,
            updated_at AS updatedAt, deleted_at AS deletedAt, valid_from AS validFrom, valid_to AS validTo
       FROM agent_memories WHERE channel_id = ? ${opts.includeDeleted ? '' : 'AND deleted_at IS NULL'}
       ORDER BY created_at ASC`,
  ).all(opts.channelId) as Array<Record<string, unknown>>
  for (const row of rows) lines.push(JSON.stringify({ type: 'memory', ...row }))
  for (const block of listBlocks(db, scopeIds)) lines.push(JSON.stringify({ type: 'block', ...block }))
  for (const doc of listDocuments(db, scopeIds, { includeDeleted: opts.includeDeleted })) {
    lines.push(JSON.stringify({ type: 'document', path: doc.path, content: doc.content, revision: doc.revision, scopeKind: doc.scopeKind }))
  }
  for (const row of rows) {
    for (const link of listMemoryLinks(db, String(row.id))) {
      lines.push(JSON.stringify({ type: 'link', ...link }))
    }
  }
  void repo
  return lines.join('\n')
}

export interface ImportReport {
  memories: number
  blocks: number
  documents: number
  skipped: number
  redacted: number
}

/** 导入同 scope JSONL（幂等：memory dedupKey / block label / document path） */
export function importMemoryJsonl(db: DatabaseSync, channelId: string, jsonl: string, actor: string): ImportReport {
  const report: ImportReport = { memories: 0, blocks: 0, documents: 0, skipped: 0, redacted: 0 }
  const repo = createMemoryRepo(db)
  const scopeId = scopeIdOfChannel(channelId)
  for (const line of jsonl.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(text) as Record<string, unknown>
    }
    catch {
      report.skipped++
      continue
    }
    const redacted = redactSensitive(String(row.content ?? row.value ?? ''))
    if (redacted.hits > 0) report.redacted++
    try {
      if (row.type === 'memory') {
        const content = redacted.hits > 0 ? redacted.text : String(row.content ?? '')
        repo.upsert({
          channelId, agentId: String(row.agentId ?? 'import'), kind: String(row.kind ?? 'semantic') as never,
          title: String(row.title ?? 'imported'), titleFts: String(row.title ?? 'imported'),
          content, importance: Number(row.importance ?? 0.5), sessionId: String(row.sessionId ?? ''),
          dedupKey: String(row.dedupKey ?? `import:${row.id}`),
        })
        report.memories++
      }
      else if (row.type === 'block') {
        upsertBlock(db, {
          scopeId: String(row.scopeId ?? scopeId), channelId, label: String(row.label ?? 'imported'),
          value: redacted.hits > 0 ? redacted.text : String(row.value ?? ''), actor,
          limitChars: Number(row.limitChars ?? 2000), description: String(row.description ?? ''),
          human: true,
        })
        report.blocks++
      }
      else if (row.type === 'document') {
        const content = redacted.hits > 0 ? redacted.text : String(row.content ?? '')
        createDocument(db, {
          scopeId, channelId, path: String(row.path ?? ''), content,
          authorKind: 'human', authorId: actor, sessionId: '',
        })
        report.documents++
      }
      else {
        report.skipped++
      }
    }
    catch {
      report.skipped++
    }
  }
  return report
}

/** 健康检查：块/文档超限、FTS 行数、孤儿日志 */
export function memoryHealth(db: DatabaseSync, channelId: string): Record<string, unknown> {
  const scopeIds = [scopeIdOfChannel(channelId)]
  const blocks = listBlocks(db, scopeIds)
  const docs = documentIndex(db, scopeIds, 500)
  const memCount = Number((db.prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE channel_id = ? AND deleted_at IS NULL').get(channelId) as { n: number }).n)
  const ftsCount = Number((db.prepare('SELECT COUNT(*) AS n FROM agent_memories_fts').get() as { n: number }).n)
  return {
    channelId,
    memories: memCount,
    ftsRows: ftsCount,
    ftsHealthy: ftsCount >= memCount,
    blocks: blocks.length,
    blocksOverLimit: blocks.filter(b => b.value.length >= b.limitChars).map(b => b.label),
    documents: docs.length,
    documentsOverLimit: docs.filter(d => d.size >= 64 * 1024).map(d => d.path),
  }
}

/** 修复：重建 FTS（删除后重插）+ 清理过期工作记忆/孤儿注入日志 */
export function repairMemory(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {}
  counts.expiredWorking = Number(db.prepare('DELETE FROM runtime_working_memory WHERE expires_at IS NOT NULL AND expires_at <= ?').run(new Date().toISOString()).changes ?? 0)
  counts.orphanInjection = Number(db.prepare(
    `DELETE FROM memory_injection_log WHERE created_at < ?`,
  ).run(new Date(Date.now() - 90 * 86_400_000).toISOString()).changes ?? 0)
  return counts
}
