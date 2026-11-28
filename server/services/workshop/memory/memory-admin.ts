/**
 * 记忆中心管理面（HITL）：列表/详情/覆写/批注/版本回滚/软删恢复/硬删/置顶。
 *
 * 纪律：
 *  - 覆写先快照到 `memory_revisions`（原文保留，可 diff / 回滚）；
 *  - `validated` / `retired` 不可直接编辑（需先退役），避免改写验证态证据链；
 *  - 软删 = `deleted_at`（检索/注入/统计统一过滤）；硬删仅 owner，且联动 vec；
 *  - 所有写操作走 `expectedRevision` CAS；审计由调用方（REST）补 `recordOps`。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { EmbeddingProvider } from '../runtime/embedding-provider'
import { getEmbeddingProvider } from '../runtime/embedding-provider'
import { createMemoryRepo, type MemoryActor } from '../db/memory.repo'
import type { MemoryKind, MemoryScopeKind, MemoryStatus } from '../db/database'
import { segmentCJK, unsegmentCJK, vectorizeMemory } from '../runtime/memory/helpers'
import { invalidateHarnessOverlayCache } from '../experience/overlay'
import { effectStatsOf, markMemoryRestored } from './effect'

export class MemoryAdminError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message)
  }
}

export interface MemoryListFilter {
  ownerUserId?: string | null
  channelIds?: string[]
  scopeKind?: MemoryScopeKind
  status?: MemoryStatus
  kind?: MemoryKind
  authorKind?: 'agent' | 'human' | 'system'
  q?: string
  includeDeleted?: boolean
  limit?: number
  offset?: number
}

export interface MemoryListItem {
  id: string
  channelId: string
  agentId: string
  kind: string
  title: string
  content: string
  importance: number
  scopeKind: string
  scopeKey: string
  status: string
  authorKind: string
  authorId: string
  ownerUserId: string | null
  revision: number
  pinned: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  originRef: string
}

export function listMemory(db: DatabaseSync, filter: MemoryListFilter = {}): { items: MemoryListItem[], total: number } {
  const where: string[] = []
  const args: Array<string | number> = []
  if (!filter.includeDeleted) where.push('m.deleted_at IS NULL')
  if (filter.ownerUserId !== undefined) {
    if (filter.ownerUserId === null) where.push('m.owner_user_id IS NULL')
    else {
      where.push('m.owner_user_id = ?')
      args.push(filter.ownerUserId)
    }
  }
  if (filter.channelIds !== undefined) {
    if (filter.channelIds.length === 0) return { items: [], total: 0 }
    where.push(`m.channel_id IN (${filter.channelIds.map(() => '?').join(', ')})`)
    args.push(...filter.channelIds)
  }
  if (filter.scopeKind) {
    where.push('m.scope_kind = ?')
    args.push(filter.scopeKind)
  }
  if (filter.status) {
    where.push('m.status = ?')
    args.push(filter.status)
  }
  if (filter.kind) {
    where.push('m.kind = ?')
    args.push(filter.kind)
  }
  if (filter.authorKind) {
    where.push('m.author_kind = ?')
    args.push(filter.authorKind)
  }
  if (filter.q) {
    where.push('(m.title LIKE ? OR m.content LIKE ?)')
    args.push(`%${filter.q}%`, `%${filter.q}%`)
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const offset = Math.max(filter.offset ?? 0, 0)
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const total = Number((db.prepare(`SELECT COUNT(*) AS c FROM agent_memories m ${whereSql}`).get(...args) as { c: number }).c)
  const rows = db.prepare(
    `SELECT m.id, m.channel_id AS channelId, m.agent_id AS agentId, m.kind, m.title, m.content, m.importance,
            m.scope_kind AS scopeKind, m.scope_key AS scopeKey, m.status,
            m.author_kind AS authorKind, m.author_id AS authorId, m.owner_user_id AS ownerUserId,
            m.revision, m.pinned, m.created_at AS createdAt, m.updated_at AS updatedAt,
            m.deleted_at AS deletedAt, m.origin_ref AS originRef
       FROM agent_memories m ${whereSql}
      ORDER BY m.pinned DESC, m.updated_at DESC, m.created_at DESC
      LIMIT ? OFFSET ?`,
  ).all(...args, limit, offset) as Array<Record<string, unknown>>
  return {
    items: rows.map(r => ({
      ...(r as unknown as MemoryListItem),
      title: String(r.title ?? ''),
      content: unsegmentCJK(String(r.content ?? '')),
      pinned: Number(r.pinned ?? 0) === 1,
    })),
    total,
  }
}

export function memoryFacets(db: DatabaseSync, opts: { ownerUserId?: string | null, channelIds?: string[] } = {}): {
  byScope: Record<string, number>
  byStatus: Record<string, number>
  byKind: Record<string, number>
  deleted: number
} {
  const where: string[] = ['m.deleted_at IS NULL']
  const args: Array<string | number> = []
  if (opts.ownerUserId !== undefined) {
    if (opts.ownerUserId === null) where.push('m.owner_user_id IS NULL')
    else {
      where.push('m.owner_user_id = ?')
      args.push(opts.ownerUserId)
    }
  }
  if (opts.channelIds !== undefined) {
    if (opts.channelIds.length === 0) return { byScope: {}, byStatus: {}, byKind: {}, deleted: 0 }
    where.push(`m.channel_id IN (${opts.channelIds.map(() => '?').join(', ')})`)
    args.push(...opts.channelIds)
  }
  const group = (col: string) => Object.fromEntries(
    (db.prepare(`SELECT m.${col} AS k, COUNT(*) AS n FROM agent_memories m WHERE ${where.join(' AND ')} GROUP BY m.${col}`)
      .all(...args) as Array<{ k: string, n: number }>).map(r => [String(r.k), Number(r.n)]),
  )
  const deleted = Number((db.prepare(
    `SELECT COUNT(*) AS c FROM agent_memories m WHERE m.deleted_at IS NOT NULL${opts.ownerUserId ? ' AND m.owner_user_id = ?' : ''}`,
  ).get(...(opts.ownerUserId ? [opts.ownerUserId] : [])) as { c: number }).c)
  return { byScope: group('scope_kind'), byStatus: group('status'), byKind: group('kind'), deleted }
}

export function getMemory(db: DatabaseSync, id: string, opts: { includeDeleted?: boolean } = {}): MemoryListItem & {
  annotations: Array<Record<string, unknown>>
  revisions: Array<Record<string, unknown>>
  effect: { uses: number, successes: number, failures: number, flagged: boolean, restoredAt: string | null } | null
} {
  const repo = createMemoryRepo(db)
  const state = repo.stateById(id)
  if (!state || (state.deletedAt && !opts.includeDeleted)) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  const row = db.prepare(
    `SELECT m.id, m.channel_id AS channelId, m.agent_id AS agentId, m.kind, m.title, m.content, m.importance,
            m.scope_kind AS scopeKind, m.scope_key AS scopeKey, m.status,
            m.author_kind AS authorKind, m.author_id AS authorId, m.owner_user_id AS ownerUserId,
            m.revision, m.pinned, m.created_at AS createdAt, m.updated_at AS updatedAt,
            m.deleted_at AS deletedAt, m.origin_ref AS originRef
       FROM agent_memories m WHERE m.id = ?`,
  ).get(id) as Record<string, unknown> | undefined
  if (!row) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  return {
    ...(row as unknown as MemoryListItem),
    content: unsegmentCJK(String(row.content ?? '')),
    pinned: Number(row.pinned ?? 0) === 1,
    annotations: repo.listAnnotations(id),
    revisions: repo.listRevisions(id),
    effect: effectStatsOf(db, id),
  }
}

export function createMemory(db: DatabaseSync, input: {
  channelId: string
  agentId?: string
  scopeKind: MemoryScopeKind
  scopeKey?: string
  title: string
  content: string
  importance?: number
  ownerUserId?: string | null
  actor: MemoryActor
}): { id: string } {
  if (!input.title.trim()) throw new MemoryAdminError(400, 'INVALID', '标题不能为空')
  if (input.scopeKind === 'session' && !(input.scopeKey ?? '').trim()) {
    throw new MemoryAdminError(400, 'INVALID', 'session 作用域必须提供 scopeKey=sessionId')
  }
  const repo = createMemoryRepo(db)
  const dedupKey = `manual:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
  const agentId = input.agentId ?? '__team__'
  const write = repo.upsert({
    channelId: input.channelId,
    agentId,
    kind: 'semantic',
    title: input.title,
    titleFts: segmentCJK(input.title),
    content: segmentCJK(input.content),
    importance: input.importance ?? 0.7,
    dedupKey,
    ownerUserId: input.ownerUserId,
  }, { kind: 'human', id: input.actor.id })
  // 手工新建同样要进向量层（2026-11-28 实机验收补正）：此前只有 updateMemory 会向量化，
  // 记忆中心新建的行在下次回填前永远搜不到（FTS-only），与"写入即索引"不一致。
  // 向量是派生索引，允许失败（vectorizeMemory 内部静默）；主表已落库。
  // 解析 provider 本身也可能抛（配置异常）——必须兜住，否则主表已写入却把接口打成 500。
  try {
    void vectorizeMemory(repo, getEmbeddingProvider(), input.channelId, agentId, dedupKey, input.content)
  }
  catch { /* 派生索引失败不影响主表写入 */ }
  // 手工新建必须落调用方声明的 scope；repo.upsert 不写 scope 列（默认 session 会漏检索）。
  // session 档必须同步 session_id：检索的会话过滤、图谱 session 分区的来源 SQL 都读这一列。
  const sessionId = input.scopeKind === 'session' ? (input.scopeKey ?? '').trim() : ''
  db.prepare(`UPDATE agent_memories SET scope_kind = ?, scope_key = ?,
      session_id = CASE WHEN ? = 'session' THEN ? ELSE session_id END,
      owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?`)
    .run(input.scopeKind, input.scopeKey ?? '', input.scopeKind, sessionId, input.ownerUserId ?? null, write.id)
  return { id: write.id }
}

export async function updateMemory(
  db: DatabaseSync,
  input: {
    id: string
    title?: string
    content?: string
    importance?: number
    expectedRevision: number
    reason: string
    actor: MemoryActor
  },
  deps: { embedder?: EmbeddingProvider | null } = {},
): Promise<{ revision: number }> {
  const repo = createMemoryRepo(db)
  const current = repo.getById(input.id)
  if (!current) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  if (current.status === 'validated' || current.status === 'retired') {
    throw new MemoryAdminError(409, 'MEMORY_IMMUTABLE', '已验证/已退役条目不可直接编辑：请先退役或新建条目')
  }
  const revision = current.revision ?? 1
  if (revision !== input.expectedRevision) {
    throw new MemoryAdminError(409, 'REVISION_CONFLICT', `版本冲突：当前 revision=${revision}，请刷新后重试`)
  }
  if (!input.reason.trim()) throw new MemoryAdminError(400, 'INVALID', '覆写必须填写理由（审计要求）')
  const title = input.title ?? current.title
  const plainContent = input.content ?? unsegmentCJK(current.content)
  const storedContent = segmentCJK(plainContent)
  repo.snapshotRevision({
    memoryId: input.id,
    revision,
    title: current.title,
    content: current.content,
    evidenceJson: current.evidenceJson ?? '',
    authorKind: current.authorKind ?? 'agent',
    authorId: current.authorId ?? '',
    reason: input.reason,
  })
  const now = new Date().toISOString()
  const changed = Number(db.prepare(
    `UPDATE agent_memories
        SET title = ?, title_fts = ?, content = ?, importance = ?, author_kind = 'human', author_id = ?,
            revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
  ).run(title, segmentCJK(title), storedContent, input.importance ?? current.importance, input.actor.id, now, input.id, revision).changes ?? 0)
  if (changed === 0) throw new MemoryAdminError(409, 'REVISION_CONFLICT', '并发更新冲突，请刷新后重试')

  // 语义索引必须跟随正文：能算就重算，不能算就删掉旧向量（绝不留下"旧文本向量 + 新正文"）。
  // 未显式注入 embedder 时按配置动态解析（评审 P2：REST PATCH 曾不传 deps → 编辑后向量被删且永不重算）。
  const rowidRow = db.prepare('SELECT rowid FROM agent_memories WHERE id = ?').get(input.id) as { rowid: number | bigint } | undefined
  if (rowidRow) repo.vecDelete(Number(rowidRow.rowid))
  const embedder = deps.embedder ?? getEmbeddingProvider()
  if (embedder && rowidRow) {
    const dedupKey = current.dedupKey ?? ''
    await vectorizeMemory(repo, embedder, current.channelId, current.agentId, dedupKey, plainContent).catch(() => {})
  }
  invalidateHarnessOverlayCache(current.channelId)
  return { revision: revision + 1 }
}

/**
 * 解除人工保护（2026-11-28）：覆写/回滚会把行标成 `author_kind='human'`，此后运行时
 * 对该 key 的所有自动写入（简报刷新、编年史滚动、任务进展、经验再蒸馏）都会拿到
 * `protected` 而静默停摆 —— 这是"人工权威"的代价，但必须给一条回退通道，否则记忆
 * 中心一次误编辑会永久冻结 AgentRuntime 的记忆模块。
 *
 * 语义：把行交还给自动维护（author_kind='agent'），旧版正文先入 versions 便于追溯。
 * 不允许对 validated 行使用（已验证条目要改只能退役重建）。
 */
export function unprotectMemory(db: DatabaseSync, input: {
  id: string
  expectedRevision: number
  reason: string
  actor: MemoryActor
}): { revision: number } {
  const repo = createMemoryRepo(db)
  const current = repo.getById(input.id)
  if (!current) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  if (current.deletedAt) throw new MemoryAdminError(409, 'DELETED', '已软删条目不可解除保护，请先恢复')
  if ((current.authorKind ?? 'agent') !== 'human') {
    throw new MemoryAdminError(409, 'NOT_PROTECTED', '该条目当前不是人工保护状态')
  }
  if (current.status === 'validated') {
    throw new MemoryAdminError(409, 'MEMORY_IMMUTABLE', '已验证条目不可解除保护：请退役后重建')
  }
  if (!input.reason.trim()) throw new MemoryAdminError(400, 'INVALID', '解除保护必须填写理由（审计要求）')
  const revision = current.revision ?? 1
  if (revision !== input.expectedRevision) {
    throw new MemoryAdminError(409, 'REVISION_CONFLICT', `版本冲突：当前 revision=${revision}`)
  }
  repo.snapshotRevision({
    memoryId: input.id,
    revision,
    title: current.title,
    content: current.content,
    evidenceJson: current.evidenceJson ?? '',
    authorKind: 'human',
    authorId: current.authorId ?? '',
    reason: `unprotect: ${input.reason}`,
  })
  const now = new Date().toISOString()
  const changed = Number(db.prepare(
    `UPDATE agent_memories
        SET author_kind = 'agent', author_id = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
  ).run(input.actor.id, now, input.id, revision).changes ?? 0)
  if (changed === 0) throw new MemoryAdminError(409, 'REVISION_CONFLICT', '并发更新冲突，请刷新后重试')
  invalidateHarnessOverlayCache(current.channelId)
  return { revision: revision + 1 }
}

export function rollbackMemory(db: DatabaseSync, input: {
  id: string
  revision: number
  expectedRevision: number
  reason: string
  actor: MemoryActor
}): { revision: number } {
  const repo = createMemoryRepo(db)
  const current = repo.getById(input.id)
  if (!current) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  // 与 updateMemory 同一不可变纪律：已验证/已退役条目不得用历史正文回滚，
  // 否则会以 validated 名义把未经验证的旧文本重新投入自动注入。
  if (current.status === 'validated' || current.status === 'retired') {
    throw new MemoryAdminError(409, 'MEMORY_IMMUTABLE', '已验证/已退役条目不可回滚：请先退役或新建条目')
  }
  const target = repo.getRevision(input.id, input.revision)
  if (!target) throw new MemoryAdminError(404, 'REVISION_NOT_FOUND', '目标版本不存在')
  const revision = current.revision ?? 1
  if (revision !== input.expectedRevision) {
    throw new MemoryAdminError(409, 'REVISION_CONFLICT', `版本冲突：当前 revision=${revision}`)
  }
  repo.snapshotRevision({
    memoryId: input.id,
    revision,
    title: current.title,
    content: current.content,
    evidenceJson: current.evidenceJson ?? '',
    authorKind: current.authorKind ?? 'agent',
    authorId: current.authorId ?? '',
    reason: `rollback→r${input.revision}: ${input.reason}`,
  })
  const now = new Date().toISOString()
  const changed = Number(db.prepare(
    `UPDATE agent_memories
        SET title = ?, title_fts = ?, content = ?, author_kind = 'human', author_id = ?,
            revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
  ).run(String(target.title), segmentCJK(String(target.title)), String(target.content), input.actor.id, now, input.id, revision).changes ?? 0)
  if (changed === 0) throw new MemoryAdminError(409, 'REVISION_CONFLICT', '并发更新冲突')
  const rowidRow = db.prepare('SELECT rowid FROM agent_memories WHERE id = ?').get(input.id) as { rowid: number | bigint } | undefined
  if (rowidRow) repo.vecDelete(Number(rowidRow.rowid))
  invalidateHarnessOverlayCache(current.channelId)
  return { revision: revision + 1 }
}

export function annotateMemory(db: DatabaseSync, input: { id: string, body: string, actor: MemoryActor }): { id: string } {
  if (!input.body.trim()) throw new MemoryAdminError(400, 'INVALID', '批注内容不能为空')
  const repo = createMemoryRepo(db)
  if (!repo.stateById(input.id)) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  return { id: repo.annotate(input.id, input.body.trim(), input.actor.id) }
}

export function softDeleteMemory(db: DatabaseSync, input: { id: string, reason: string, actor: MemoryActor }): { ok: boolean } {
  const repo = createMemoryRepo(db)
  const state = repo.stateById(input.id)
  if (!state) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  const ok = repo.softDelete(input.id, input.actor.id, input.reason)
  if (ok) {
    const rowidRow = db.prepare('SELECT rowid FROM agent_memories WHERE id = ?').get(input.id) as { rowid: number | bigint } | undefined
    if (rowidRow) repo.vecDelete(Number(rowidRow.rowid))
    invalidateHarnessOverlayCache(state.channelId)
  }
  return { ok }
}

export function restoreMemory(db: DatabaseSync, id: string): { ok: boolean } {
  const repo = createMemoryRepo(db)
  const state = repo.stateById(id)
  if (!state) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  const ok = repo.restore(id)
  if (ok) {
    // 批次 H：人工恢复后 30 天内不再自动退役（防抖动）
    markMemoryRestored(db, id)
    invalidateHarnessOverlayCache(state.channelId)
  }
  return { ok }
}

/** 硬删：仅 owner 调用方允许（权限由 REST 层判定）；联动 vec，FTS 由 DELETE 触发器清理 */
export function purgeMemory(db: DatabaseSync, id: string): { ok: boolean } {
  const repo = createMemoryRepo(db)
  const state = repo.stateById(id)
  if (!state) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  if (!state.deletedAt) throw new MemoryAdminError(409, 'NOT_SOFT_DELETED', '硬删前必须先软删')
  const res = repo.purge(id)
  if (res.rowid !== null) repo.vecDelete(res.rowid)
  invalidateHarnessOverlayCache(state.channelId)
  return { ok: res.ok }
}

export function setMemoryPinned(db: DatabaseSync, id: string, pinned: boolean): { ok: boolean } {
  const repo = createMemoryRepo(db)
  const state = repo.stateById(id)
  if (!state) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  const ok = repo.setPinned(id, pinned)
  if (ok) invalidateHarnessOverlayCache(state.channelId)
  return { ok }
}

/**
 * 人工裁定「不成立」（批次 B / W5）：
 *  - 原行退役（保留正文/证据/审计，不硬删）；
 *  - 生成一条负向 candidate（有证据锚点 traceId，避免"无证据经验"），供后续检索/学习；
 *  - 原因必填，写入批注与运维审计（REST 层补 recordOps）。
 */
export function rejectMemory(db: DatabaseSync, input: { id: string, reason: string, actor: MemoryActor }): { ok: boolean, retired: boolean, negativeId: string | null } {
  const reason = input.reason.trim()
  if (!reason) throw new MemoryAdminError(400, 'INVALID', '裁定不成立必须填写原因（审计要求）')
  const repo = createMemoryRepo(db)
  const state = repo.stateById(input.id)
  if (!state) throw new MemoryAdminError(404, 'NOT_FOUND', '记忆不存在')
  if (state.deletedAt) throw new MemoryAdminError(409, 'DELETED', '已软删条目不可裁定，请先恢复')
  // 自动维护型条目（知识手册/简报/编年史/反思）不能"裁定不成立"：retired 会被
  // repo.upsert 视为受保护，而整理侧的 force 只认人工编辑行 —— 一条被 retired 的
  // 知识手册将永远无法再生（记忆中心也点不动）。这类条目要做的是软删或重新汇整。
  if (state.kind === 'curated' || state.kind === 'brief' || state.kind === 'chronicle' || state.kind === 'reflection') {
    throw new MemoryAdminError(409, 'AGENT_MAINTAINED',
      `「${state.kind}」由平台自动维护，不能裁定不成立：如需停用请软删，知识手册请走"重新汇整"`)
  }
  const now = new Date().toISOString()
  const wasRetired = state.status === 'retired'
  const retired = wasRetired
    ? true
    : Number(db.prepare(`UPDATE agent_memories SET status = 'retired', updated_at = ? WHERE id = ?`).run(now, input.id).changes ?? 0) > 0
  let negativeId: string | null = null
  if (state.kind === 'experience' && !wasRetired) {
    // 已是 retired 不重复生成负向候选；dedupKey 固定保证重复裁定幂等
    try {
      const negative = repo.upsertExperience({
        channelId: state.channelId,
        agentId: state.agentId,
        kind: 'experience',
        title: `[人工否定] ${state.id.slice(0, 8)}`,
        titleFts: segmentCJK(`人工否定 ${state.id.slice(0, 8)}`),
        content: segmentCJK(`人工裁定原经验不成立。原因：${reason.slice(0, 500)}`),
        importance: 0.6,
        taskId: null,
        sessionId: '',
        dedupKey: `exp:human-reject:${state.id}`,
        outcome: 'negative',
        evidence: { traceId: `human-reject:${state.id}` },
        scopeKind: 'channel',
        scopeKey: '',
        status: 'candidate',
      })
      negativeId = negative.id
    }
    catch {
      negativeId = null
    }
  }
  try {
    repo.annotate(input.id, `人工裁定不成立：${reason.slice(0, 800)}`, input.actor.id)
  }
  catch { /* 批注失败不影响退役 */ }
  invalidateHarnessOverlayCache(state.channelId)
  return { ok: true, retired, negativeId }
}
