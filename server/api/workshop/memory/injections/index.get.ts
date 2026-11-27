/**
 * GET /api/workshop/memory/injections?taskId=&channelId=&limit= —— 注入留痕查询（M34）。
 * 只返回 refs 与可读标题，不复制正文；非 admin 仅能看自己 owner 的频道。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

interface RefRow { id: string, kind: string, source?: string, scopeKind?: string, scopeKey?: string }

function parseRefs(raw: unknown): RefRow[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r): r is RefRow => Boolean(r && typeof r === 'object' && typeof (r as RefRow).id === 'string'))
  }
  catch {
    return []
  }
}

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const q = getQuery(event)
  const taskId = String(q.taskId ?? '').trim()
  const channelId = String(q.channelId ?? '').trim()
  const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)
  const db = getAmlRuntime().db
  const where = ['1=1']
  const params: Array<string | number> = []
  if (taskId) {
    where.push('l.task_id = ?')
    params.push(taskId)
  }
  if (channelId) {
    where.push('l.channel_id = ?')
    params.push(channelId)
  }
  if (user.role !== 'admin') {
    where.push('c.owner_user_id = ?')
    params.push(user.id)
  }
  const logs = db.prepare(`SELECT l.id, l.channel_id AS channelId, l.agent_id AS agentId,
      l.session_id AS sessionId, l.task_id AS taskId, l.refs_json AS refsJson, l.created_at AS createdAt,
      c.name AS channelName
    FROM memory_injection_log l JOIN channels c ON c.id = l.channel_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.created_at DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>

  const allRefs = logs.flatMap(l => parseRefs(l.refsJson))
  const byKind = (k: string): string[] => [...new Set(allRefs.filter(r => r.kind === k).map(r => r.id))]
  const memoryIds = [...new Set(allRefs.filter(r => !['block', 'graph-entity', 'graph-edge', 'graph-community'].includes(r.kind)).map(r => r.id))]
  const blockIds = byKind('block')
  const entityIds = byKind('graph-entity')
  const edgeIds = byKind('graph-edge')
  const communityIds = byKind('graph-community')

  const memories = new Map<string, {
    title: string
    kind: string
    scopeKind: string
    scopeKey: string
    status: string
  }>()
  if (memoryIds.length > 0) {
    const rows = db.prepare(`SELECT id, title, kind, scope_kind AS scopeKind, scope_key AS scopeKey, status
      FROM agent_memories WHERE id IN (${memoryIds.map(() => '?').join(',')})`).all(...memoryIds) as Array<{
      id: string
      title: string
      kind: string
      scopeKind: string
      scopeKey: string
      status: string
    }>
    for (const r of rows) memories.set(r.id, r)
  }
  const blocks = new Map<string, string>()
  if (blockIds.length > 0) {
    const rows = db.prepare(`SELECT id, label FROM memory_blocks WHERE id IN (${blockIds.map(() => '?').join(',')})`)
      .all(...blockIds) as Array<{ id: string, label: string }>
    for (const r of rows) blocks.set(r.id, r.label)
  }
  const entities = new Map<string, { name: string, type: string }>()
  if (entityIds.length > 0) {
    const rows = db.prepare(`SELECT id, canonical_name AS name, entity_type AS type FROM memory_entities
      WHERE id IN (${entityIds.map(() => '?').join(',')})`).all(...entityIds) as Array<{ id: string, name: string, type: string }>
    for (const r of rows) entities.set(r.id, r)
  }
  const edges = new Map<string, { relation: string, fact: string }>()
  if (edgeIds.length > 0) {
    const rows = db.prepare(`SELECT id, relation, fact FROM memory_edges
      WHERE id IN (${edgeIds.map(() => '?').join(',')})`).all(...edgeIds) as Array<{ id: string, relation: string, fact: string }>
    for (const r of rows) edges.set(r.id, r)
  }
  const communities = new Map<string, { title: string }>()
  if (communityIds.length > 0) {
    const rows = db.prepare(`SELECT id, title FROM memory_communities
      WHERE id IN (${communityIds.map(() => '?').join(',')})`).all(...communityIds) as Array<{ id: string, title: string }>
    for (const r of rows) communities.set(r.id, r)
  }

  return {
    items: logs.map((l) => {
      const refs = parseRefs(l.refsJson).slice(0, 50).map((r) => {
        if (r.kind === 'block') return { ...r, label: blocks.get(r.id) ?? r.id, subtitle: '核心块' }
        if (r.kind === 'graph-entity') return { ...r, label: entities.get(r.id)?.name ?? r.id, subtitle: `图谱实体${entities.get(r.id)?.type ? ` · ${entities.get(r.id)!.type}` : ''}` }
        if (r.kind === 'graph-edge') return { ...r, label: edges.get(r.id)?.relation ?? r.id, subtitle: edges.get(r.id)?.fact ?? '图谱关系' }
        if (r.kind === 'graph-community') return { ...r, label: communities.get(r.id)?.title ?? r.id, subtitle: '知识社区' }
        const m = memories.get(r.id)
        return { ...r, label: m?.title ?? r.id, subtitle: m ? `${m.kind} · ${m.scopeKind}${m.scopeKey ? `:${m.scopeKey}` : ''}` : '' }
      })
      return {
        id: l.id, channelId: l.channelId, channelName: l.channelName,
        agentId: l.agentId, sessionId: l.sessionId, taskId: l.taskId,
        createdAt: l.createdAt, refs,
      }
    }),
  }
})
