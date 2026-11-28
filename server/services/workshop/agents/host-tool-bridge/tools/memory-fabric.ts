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
import { createMemoryGraphRepo } from '../../../memory/graph/repo'
import { loadSubgraph } from '../../../memory/graph/retrieval'
import { normalizeEntityKey } from '../../../memory/graph/normalize'
import { recordMemoryInjection } from '../../../memory/effect'
import { createMemoryRepo } from '../../../db/memory.repo'
import { currentExecutionScope } from '../../execution-scope'

const db = () => getAmlRuntime().db
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const accessModeOf = (channelId: string, sessionId?: string | null) =>
  createMemoryRepo(db()).memoryAccessMode(channelId, sessionId)
const readBlocked = (channelId: string, sessionId?: string | null): HostToolResult | null =>
  accessModeOf(channelId, sessionId) === 'disabled' ? { text: '记忆策略 disabled（incognito）：不读不写', isError: true } : null
const writeBlocked = (channelId: string, sessionId?: string | null): HostToolResult | null => {
  const mode = accessModeOf(channelId, sessionId)
  if (mode === 'disabled') return { text: '记忆策略 disabled（incognito）：不读不写', isError: true }
  if (mode === 'readonly') return { text: '记忆策略 readonly：只读不写', isError: true }
  return null
}
const scopeIdsOf = (channelId: string, sessionId?: string | null): string[] => {
  const ids = [scopeIdOfChannel(channelId)]
  if (sessionId) ids.push(scopeIdOfSession(sessionId))
  return ids
}

export async function toolMemoryBlocks(agentId: string, args: Record<string, unknown>, channelId?: string, sessionId?: string | null): Promise<HostToolResult> {
  const action = str(args.action) || 'read'
  const cid = channelId ?? ''
  if (!cid) return { text: '缺少频道上下文', isError: true }
  const gate = action === 'read' || action === 'revisions' ? readBlocked(cid, sessionId) : writeBlocked(cid, sessionId)
  if (gate) return gate
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
  const gate = command === 'view' || command === 'index' || command === 'revisions'
    ? readBlocked(cid, sessionId)
    : writeBlocked(cid, sessionId)
  if (gate) return gate
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

export async function toolMemoryGraphQuery(agentId: string, args: Record<string, unknown>, channelId?: string, sessionId?: string | null): Promise<HostToolResult> {
  const cid = channelId ?? ''
  if (!cid) return { text: '缺少频道上下文', isError: true }
  const gate = readBlocked(cid, sessionId)
  if (gate) return gate
  try {
    const repo = createMemoryGraphRepo(db())
    if (!repo.available) return { text: '知识图谱尚未初始化。', isError: true }
    const limit = Math.min(Math.max(Number(args.limit ?? 60), 1), 200)
    const hops = Math.min(Math.max(Number(args.hops ?? 2), 1), 2)
    const relation = str(args.relation) || undefined
    const asOf = str(args.as_of) || null
    const scope = str(args.scope) || 'channel'
    const channelRow = db().prepare('SELECT COALESCE(owner_user_id, \'\') AS owner, COALESCE(line_id, \'\') AS lineId FROM channels WHERE id = ?')
      .get(cid) as { owner?: string, lineId?: string } | undefined
    const scopeKeyArg = str(args.scope_key)
    let scopeKinds: string[] = ['channel']
    let scopeKeys: string[] = ['']
    let ownerUserId: string | undefined
    if (scope === 'session') {
      const currentSid = sessionId || currentExecutionScope()?.sessionId || ''
      // 会话私域隔离：Agent 只能读当前执行会话；无会话上下文时一律拒绝，绝不按参数跨会话读。
      if (!currentSid) return { text: 'scope=session 缺少当前会话上下文。', isError: true }
      if (scopeKeyArg && scopeKeyArg !== currentSid) {
        return { text: 'scope=session 只能查询当前执行会话。', isError: true }
      }
      scopeKinds = ['session']
      scopeKeys = [currentSid]
    }
    else if (scope === 'shared') {
      ownerUserId = channelRow?.owner ?? ''
      if (!ownerUserId) return { text: '当前频道无 owner，无法读取共享区图谱。', isError: true }
      scopeKinds = ['global']
      scopeKeys = [ownerUserId]
    }
    else if (scope === 'line') {
      const key = scopeKeyArg || channelRow?.lineId || ''
      if (!key) return { text: 'scope=line 需要产线绑定或 scope_key=lineId。', isError: true }
      if (channelRow?.lineId && key !== channelRow.lineId) {
        return { text: 'scope=line 只能查询当前频道绑定的产线。', isError: true }
      }
      scopeKinds = ['line']
      scopeKeys = [key]
    }
    else if (scope === 'product') {
      if (!scopeKeyArg) return { text: 'scope=product 需要 scope_key=产品 id。', isError: true }
      const bound = db().prepare('SELECT 1 AS ok FROM channel_product_bindings WHERE channel_id = ? AND product_id = ? LIMIT 1')
        .get(cid, scopeKeyArg)
      if (!bound) return { text: 'scope=product 只能查询当前频道已绑定的产品。', isError: true }
      scopeKinds = ['product']
      scopeKeys = [scopeKeyArg]
    }
    else if (scope !== 'channel') {
      return { text: `未知 scope=${scope}；可用 channel/session/shared/line/product。`, isError: true }
    }
    const graphScope = { scopeKinds: scopeKinds as never, scopeKeys, ...(ownerUserId ? { ownerUserId } : {}) }
    let entity = str(args.entity)
    if (entity) {
      const byId = repo.getEntity(entity)
      if (byId) {
        // 传 id 时也必须属于当前频道：否则跨频道实体 id 会绕过分区/频道边界。
        if (byId.channelId !== cid) entity = ''
      }
      else {
        const hit = repo.findEntitiesByAlias(cid, [normalizeEntityKey(entity)], 5, graphScope)[0]
          ?? repo.listEntities(cid, { q: entity, limit: 5, ...graphScope })[0]
        entity = hit?.id ?? ''
      }
    }
    const graph = loadSubgraph(repo, cid, {
      q: str(args.query) || undefined,
      entity: entity || undefined,
      depth: hops,
      asOf,
      relations: relation ? [relation] : undefined,
      limit,
      ...graphScope,
      // session/channel 分区按 viewer agent 过滤（与 inScope 对齐）；line/product/global
      // 是显式跨 agent 共享档（agentIn=any），不传 viewer。
      viewerAgentId: scope === 'session' || scope === 'channel' ? agentId : undefined,
    })
    if (graph.nodes.length === 0) return { text: '知识网络中未找到相关实体；可先让后台整理或扩大关键词。' }
    const nameOf = new Map(graph.nodes.map(n => [n.id, n.canonicalName]))
    const lines: string[] = [
      `知识网络：${graph.stats.entityTotal} 实体 / ${graph.stats.edgeTotal} 关系 / ${graph.stats.communityTotal} 社区${asOf ? `（asOf ${asOf}）` : ''}`,
      '实体：',
      ...graph.nodes.slice(0, 20).map(n => `- [${n.entityType}] ${n.canonicalName}（${n.status}${n.locked ? ' 🔒' : ''}${n.degree ? `，${n.degree} 条关系` : ''}）`),
    ]
    if (graph.edges.length > 0) {
      lines.push('关系：')
      for (const e of graph.edges.slice(0, 30)) {
        lines.push(`- ${nameOf.get(e.srcId) ?? e.srcId} --${e.relation}--> ${nameOf.get(e.dstId) ?? e.dstId}${e.fact ? `：${e.fact.slice(0, 100)}` : ''}（${e.status}，置信 ${e.confidence.toFixed(2)}）`)
      }
    }
    if (graph.communities.length > 0) {
      lines.push('社区：')
      for (const c of graph.communities.slice(0, 5)) {
        lines.push(`- ${c.title}（${c.memberCount} 实体）：${String(c.summary).replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
    const refs = [
      ...graph.nodes.slice(0, 30).map(n => ({ id: n.id, kind: 'graph-entity' as const, source: 'graph' as const, scopeKind: n.scopeKind, scopeKey: n.scopeKey })),
      ...graph.edges.slice(0, 30).map(e => ({ id: e.id, kind: 'graph-edge' as const, source: 'graph' as const, scopeKind: e.scopeKind, scopeKey: e.scopeKey })),
      ...graph.communities.slice(0, 5).map(c => ({ id: c.id, kind: 'graph-community' as const, source: 'graph' as const, scopeKind: c.scopeKind, scopeKey: c.scopeKey })),
    ]
    if (refs.length > 0) {
      try {
        recordMemoryInjection(db(), {
          channelId: cid, agentId, sessionId: sessionId ?? '',
          taskId: currentExecutionScope()?.taskId ?? null, refs,
        })
      }
      catch { /* 留痕失败不影响工具结果 */ }
    }
    return { text: lines.join('\n') }
  }
  catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true }
  }
}
