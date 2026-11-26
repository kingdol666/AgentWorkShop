/**
 * Core Blocks / 记忆文件工具（批次 J）。
 *  - memory_blocks：read/append/replace/lock/rollback（受 limit/locked 约束）
 *  - memory_files：view/create/insert/str_replace/rename/delete（六命令，路径穿越拒绝）
 * 只写平台记忆库，不涉及设备/配方。
 */
import type { HostToolResult } from '../types'
import { getAmlRuntime } from '../../../aml/runtime'
import { appendBlock, blockRevisions, listBlocks, rollbackBlock, scopeIdOfChannel, scopeIdOfSession, setBlockLocked, upsertBlock } from '../../../memory/blocks'
import { createDocument, documentIndex, documentRevisions, getDocument, insertDocument, listDocuments, normalizeDocumentPath, renameDocument, replaceInDocument, restoreDocument, softDeleteDocument } from '../../../memory/documents'

const db = () => getAmlRuntime().db
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const scopeIdsOf = (channelId: string, sessionId?: string | null): string[] => {
  const ids = [scopeIdOfChannel(channelId)]
  if (sessionId) ids.push(scopeIdOfSession(sessionId))
  return ids
}

export async function toolMemoryBlocks(agentId: string, args: Record<string, unknown>, channelId?: string, sessionId?: string | null): Promise<HostToolResult> {
  const action = str(args.action) || 'read'
  const cid = channelId ?? ''
  if (!cid) return { text: '缺少频道上下文', isError: true }
  const scopeId = str(args.scope) === 'session' && sessionId ? scopeIdOfSession(sessionId) : scopeIdOfChannel(cid)
  try {
    if (action === 'read') {
      const blocks = listBlocks(db(), scopeIdsOf(cid, sessionId))
      if (blocks.length === 0) return { text: '暂无核心块。' }
      return { text: blocks.map(b => `[${b.label}]${b.locked ? ' 🔒' : ''} r${b.revision} (${b.value.length}/${b.limitChars})\n${b.value}`).join('\n\n') }
    }
    if (action === 'append' || action === 'replace') {
      const input = {
        scopeId, scopeKind: scopeId.startsWith('session:') ? 'session' as const : 'channel' as const,
        channelId: cid, sessionId: sessionId ?? '', label: str(args.label), value: str(args.value),
        actor: agentId, limitChars: Number(args.limit_chars ?? 2000), description: str(args.description),
      }
      const out = action === 'append' ? appendBlock(db(), input) : upsertBlock(db(), input)
      return { text: `核心块 ${out.block.label} 已写入 r${out.block.revision}${out.truncated ? '（超限已截断）' : ''}。` }
    }
    if (action === 'lock') {
      const ok = setBlockLocked(db(), scopeId, str(args.label), args.locked !== false, agentId)
      return ok ? { text: '已更新锁定状态。' } : { text: '核心块不存在。', isError: true }
    }
    if (action === 'revisions') {
      return { text: JSON.stringify(blockRevisions(db(), scopeId, str(args.label))) }
    }
    if (action === 'rollback') {
      const ok = rollbackBlock(db(), scopeId, str(args.label), Number(args.revision), agentId)
      return ok ? { text: '已回滚。' } : { text: '目标版本不存在。', isError: true }
    }
    return { text: `未知 action ${action}`, isError: true }
  }
  catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true }
  }
}

export async function toolMemoryFiles(agentId: string, args: Record<string, unknown>, channelId?: string, sessionId?: string | null): Promise<HostToolResult> {
  const command = str(args.command) || 'view'
  const cid = channelId ?? ''
  if (!cid) return { text: '缺少频道上下文', isError: true }
  const scopeId = str(args.scope) === 'session' && sessionId ? scopeIdOfSession(sessionId) : scopeIdOfChannel(cid)
  const input = {
    scopeId, scopeKind: scopeId.startsWith('session:') ? 'session' as const : 'channel' as const,
    channelId: cid, sessionId: sessionId ?? '',
    path: str(args.path), content: str(args.content), authorKind: 'agent' as const, authorId: agentId,
  }
  try {
    if (command === 'view') {
      if (!input.path) {
        const docs = listDocuments(db(), scopeIdsOf(cid, sessionId)).map(d => `${d.path} (${d.size}B, r${d.revision})`)
        return { text: docs.length > 0 ? docs.join('\n') : '暂无记忆文件。' }
      }
      const doc = getDocument(db(), scopeId, normalizeDocumentPath(input.path))
      if (!doc || doc.deletedAt) return { text: '文件不存在。', isError: true }
      return { text: doc.content }
    }
    if (command === 'create') return { text: `已创建 ${createDocument(db(), input).path}` }
    if (command === 'insert') return { text: `已插入，r${insertDocument(db(), input, Number(args.after_line ?? 0)).revision}` }
    if (command === 'str_replace') return { text: `已替换，r${replaceInDocument(db(), input, str(args.old_text)).revision}` }
    if (command === 'rename') {
      const doc = renameDocument(db(), scopeId, str(args.old_path ?? input.path), str(args.new_path ?? args.path), agentId)
      return { text: `已重命名为 ${doc.path}（r${doc.revision}）` }
    }
    if (command === 'delete') {
      const ok = softDeleteDocument(db(), scopeId, input.path, agentId)
      return ok ? { text: '已软删（可恢复）。' } : { text: '文件不存在。', isError: true }
    }
    if (command === 'restore') {
      const ok = restoreDocument(db(), scopeId, input.path)
      return ok ? { text: '已恢复。' } : { text: '文件不存在或未删除。', isError: true }
    }
    if (command === 'revisions') return { text: JSON.stringify(documentRevisions(db(), scopeId, input.path)) }
    if (command === 'index') return { text: JSON.stringify(documentIndex(db(), scopeIdsOf(cid, sessionId), 50)) }
    return { text: `未知 command ${command}`, isError: true }
  }
  catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true }
  }
}
