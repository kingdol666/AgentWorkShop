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
import { createMemoryGraphRepo } from './graph/repo'
import { segmentCJK } from '../runtime/memory/helpers'
import { withTransaction } from '../db/transaction'

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
         ${opts.sessionId ? 'AND session_id = ?' : ''}
       ORDER BY created_at ASC`,
  ).all(opts.channelId, ...(opts.sessionId ? [opts.sessionId] : [])) as Array<Record<string, unknown>>
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
        const rawSession = String(row.sessionId ?? '')
        // 会话必须属于目标频道；否则按频道级导入，绝不跨频道落会话。
        const sessionOk = rawSession
          ? Boolean(db.prepare('SELECT 1 AS ok FROM channel_sessions WHERE id = ? AND channel_id = ?').get(rawSession, channelId))
          : true
        if (!sessionOk) {
          report.skipped++
          continue
        }
        const rawAgent = String(row.agentId ?? '')
        // agent 仅影响回忆可见性；导入目标频道已固定，允许保留原 agent 以便迁移私有行。
        const agentOk = Boolean(rawAgent)
        if (!agentOk) {
          report.skipped++
          continue
        }
        const content = redacted.hits > 0 ? redacted.text : String(row.content ?? '')
        const title = String(row.title ?? 'imported')
        repo.upsert({
          channelId, agentId: rawAgent, kind: String(row.kind ?? 'semantic') as never,
          title, titleFts: segmentCJK(title),
          content: segmentCJK(content), importance: Number(row.importance ?? 0.5), sessionId: rawSession,
          dedupKey: String(row.dedupKey ?? `import:${row.id}`),
        })
        report.memories++
      }
      else if (row.type === 'block') {
        const requested = String(row.scopeId ?? '')
        if (requested && requested !== scopeId) {
          report.skipped++
          continue
        }
        upsertBlock(db, {
          scopeId, channelId, label: String(row.label ?? 'imported'),
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

/** 健康检查：块/文档超限、FTS 行数、孤儿日志、图谱/向量/待合并。 */
export function memoryHealth(db: DatabaseSync, channelId: string): Record<string, unknown> {
  const scopeIds = [scopeIdOfChannel(channelId)]
  const blocks = listBlocks(db, scopeIds)
  const docs = documentIndex(db, scopeIds, 500)
  const memCount = Number((db.prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE channel_id = ? AND deleted_at IS NULL').get(channelId) as { n: number }).n)
  const ftsCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM agent_memories_fts f
    JOIN agent_memories m ON m.rowid = f.memory_rowid WHERE m.channel_id = ?`).get(channelId) as { n: number }).n)
  let graph: Record<string, unknown> = {}
  try {
    const repo = createMemoryGraphRepo(db)
    if (repo.available) {
      const entityCount = repo.countEntities(channelId)
      const entityFts = Number((db.prepare(`SELECT COUNT(*) AS n FROM memory_entities_fts f
        JOIN memory_entities e ON e.rowid = f.entity_rowid WHERE e.channel_id = ?`).get(channelId) as { n: number }).n)
      const pendingMerges = Number((db.prepare(`SELECT COUNT(*) AS n FROM memory_merge_candidates
        WHERE channel_id = ? AND status = 'proposed'`).get(channelId) as { n: number }).n)
      graph = {
        ...repo.graphStats(channelId),
        entities: entityCount,
        entityFtsRows: entityFts,
        entityFtsHealthy: entityFts >= entityCount,
        pendingMergeCandidates: pendingMerges,
        revision: repo.getState(channelId)?.revision ?? 0,
      }
    }
  }
  catch { /* 图谱表未初始化时保持空 */ }
  let vectorRows: number
  try {
    vectorRows = Number((db.prepare('SELECT COUNT(*) AS n FROM agent_memories_vec').get() as { n: number }).n)
  }
  catch { vectorRows = 0 }
  return {
    channelId,
    memories: memCount,
    ftsRows: ftsCount,
    ftsHealthy: ftsCount >= memCount,
    vectorRows,
    blocks: blocks.length,
    blocksOverLimit: blocks.filter(b => b.value.length >= b.limitChars).map(b => b.label),
    documents: docs.length,
    documentsOverLimit: docs.filter(d => d.size >= 64 * 1024).map(d => d.path),
    graph,
  }
}

/**
 * 旧库图谱残留清理(2026-11-28):修复前的口径曾把 agent 私有 semantic 行、
 * 带会话戳的过程行物化进频道图分区 —— 收紧后这些来源不再合法,但旧库已物化的
 * 实体/边不会自行消失(历史残留持续经图谱投影泄漏给其他成员)。
 *
 * 判定与 graph/repo.ts `sourceScope('channel')` 严格同口径:合法来源记忆 = 未删、
 * 未 retired,且 `agent_id='__team__' OR (kind IN (episodic-task/peer/team-task) AND session_id='')`。
 * 清理对象(保守):
 *  - 残留边:agent 创建、未锁定、source_kind='memory',且证据面**全部**不合法
 *    (无任何合法存活记忆证据,也无 ontology/claim 锚点);
 *  - 残留实体:agent 创建、未锁定、未合并、source_kind='memory',且 memory_id 不合法、
 *    无合法提及、无任何"将存活"边的合法证据支撑;
 *  - 连带:孤儿 mention/alias/社区成员/证据/合并候选;state 计数按存言行重算。
 * 人工创建/锁定的行一律保留;图谱其余分区(session/global)不动。
 */
export function purgeGraphResidue(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = { edgesPurged: 0, entitiesPurged: 0, orphansCleaned: 0, statesRecalculated: 0 }
  // 与 graph/repo.ts sourceScope('channel') 同口径;别名参数化(同一谓词出现在 m/km 两个别名下)
  const eligible = (a: string) =>
    `(${a}.agent_id = '__team__' OR (${a}.kind IN ('episodic-task', 'episodic-peer', 'episodic-team-task') AND ${a}.session_id = ''))`
  try {
    withTransaction(db, () => {
      // 1) 残留边:证据面全部不合法(证据表无合法存活记忆,且无 ontology/claim 锚点)。
      //    rejected 墓碑(人工否证)与已软删行不碰 —— 墓碑是「整理不得复活」的载体。
      counts.edgesPurged = Number(db.prepare(
        `DELETE FROM memory_edges WHERE id IN (
           SELECT e.id FROM memory_edges e
            WHERE e.scope_kind = 'channel' AND e.author_kind = 'agent' AND e.locked = 0
              AND e.source_kind = 'memory' AND e.deleted_at IS NULL AND e.status != 'rejected'
              AND NOT EXISTS (
                SELECT 1 FROM memory_edge_evidence ev
                  JOIN agent_memories m ON m.id = ev.memory_id
                 WHERE ev.edge_id = e.id AND m.deleted_at IS NULL AND m.status != 'retired'
                   AND ${eligible('m')})
              AND NOT EXISTS (
                SELECT 1 FROM memory_edge_evidence ev2
                 WHERE ev2.edge_id = e.id AND (ev2.memory_id = '' OR ev2.memory_id LIKE 'ontology:%' OR ev2.memory_id LIKE 'claim:%'))
         )`,
      ).run().changes ?? 0)
      // 2) 残留实体:无任何合法存活性来源(源记忆/提及/存活边证据)。
      //    rejected 墓碑(人工否证)不碰 —— 清掉它等于允许整理按同名再建。
      counts.entitiesPurged = Number(db.prepare(
        `DELETE FROM memory_entities WHERE id IN (
           SELECT t.id FROM memory_entities t
            WHERE t.scope_kind = 'channel' AND t.author_kind = 'agent' AND t.locked = 0
              AND t.merged_into IS NULL AND t.deleted_at IS NULL AND t.source_kind = 'memory'
              AND t.status != 'rejected'
              AND NOT EXISTS (
                SELECT 1 FROM agent_memories m WHERE m.id = t.memory_id
                  AND m.deleted_at IS NULL AND m.status != 'retired' AND ${eligible('m')})
              AND NOT EXISTS (
                SELECT 1 FROM memory_entity_mentions men
                  JOIN agent_memories m ON m.id = men.memory_id
                 WHERE men.entity_id = t.id AND m.deleted_at IS NULL AND m.status != 'retired'
                   AND ${eligible('m')})
              AND NOT EXISTS (
                SELECT 1 FROM memory_edges ke
                 WHERE (ke.src_id = t.id OR ke.dst_id = t.id) AND ke.deleted_at IS NULL
                   AND EXISTS (
                     SELECT 1 FROM memory_edge_evidence kev
                       LEFT JOIN agent_memories km ON km.id = kev.memory_id
                      WHERE kev.edge_id = ke.id AND (
                        (km.id IS NOT NULL AND km.deleted_at IS NULL AND km.status != 'retired' AND ${eligible('km')})
                        OR kev.memory_id = '' OR kev.memory_id LIKE 'ontology:%' OR kev.memory_id LIKE 'claim:%')))
         )`,
      ).run().changes ?? 0)
      // 3) 连带孤儿行(mention/alias/社区成员/证据/合并候选)
      const orphanStmts = [
        `DELETE FROM memory_entity_mentions WHERE entity_id NOT IN (SELECT id FROM memory_entities)`,
        `DELETE FROM memory_entity_aliases WHERE entity_id NOT IN (SELECT id FROM memory_entities)`,
        `DELETE FROM memory_community_members WHERE entity_id NOT IN (SELECT id FROM memory_entities)`,
        `DELETE FROM memory_edge_evidence WHERE edge_id NOT IN (SELECT id FROM memory_edges)`,
        `DELETE FROM memory_merge_candidates WHERE source_entity_id NOT IN (SELECT id FROM memory_entities)
            OR target_entity_id NOT IN (SELECT id FROM memory_entities)`,
      ]
      let orphans = 0
      for (const sql of orphanStmts) orphans += Number(db.prepare(sql).run().changes ?? 0)
      counts.orphansCleaned = orphans
      // 4) state 计数按存言行重算(残量清理后 entity_count/edge_count 不再可信)
      counts.statesRecalculated = Number(db.prepare(
        `UPDATE memory_graph_state SET
           entity_count = (SELECT COUNT(*) FROM memory_entities e
                            WHERE e.channel_id = memory_graph_state.channel_id
                              AND e.scope_kind = memory_graph_state.scope_kind
                              AND e.scope_key = memory_graph_state.scope_key
                              AND e.deleted_at IS NULL AND e.merged_into IS NULL),
           edge_count = (SELECT COUNT(*) FROM memory_edges e2
                          WHERE e2.channel_id = memory_graph_state.channel_id
                            AND e2.scope_kind = memory_graph_state.scope_kind
                            AND e2.scope_key = memory_graph_state.scope_key
                            AND e2.deleted_at IS NULL AND e2.status IN ('active', 'provisional')),
           updated_at = ?
         WHERE channel_id IN (SELECT DISTINCT channel_id FROM memory_graph_state)`,
      ).run(new Date().toISOString()).changes ?? 0)
    })
  }
  catch (err) {
    counts.error = 1
    console.error('[memory] purgeGraphResidue failed:', err)
  }
  return counts
}

/** 修复：重建 memory/entity FTS + 清理过期工作记忆/孤儿注入日志/stale graph run。 */
export function repairMemory(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {}
  counts.expiredWorking = Number(db.prepare('DELETE FROM runtime_working_memory WHERE expires_at IS NOT NULL AND expires_at <= ?').run(new Date().toISOString()).changes ?? 0)
  counts.orphanInjection = Number(db.prepare(
    `DELETE FROM memory_injection_log WHERE created_at < ?`,
  ).run(new Date(Date.now() - 90 * 86_400_000).toISOString()).changes ?? 0)
  try {
    withTransaction(db, () => {
      db.prepare('DELETE FROM agent_memories_fts').run()
      counts.memoryFtsRebuilt = Number(db.prepare(`INSERT INTO agent_memories_fts(title, content, agent_id, memory_rowid)
        SELECT COALESCE(NULLIF(title_fts, ''), title), content, agent_id, rowid FROM agent_memories`).run().changes ?? 0)
    })
  }
  catch {
    counts.memoryFtsRebuilt = 0
    counts.memoryFtsFailed = 1
  }
  try {
    withTransaction(db, () => {
      db.prepare('DELETE FROM memory_entities_fts').run()
      // 含软删行：实体的 FTS 触发只在 search_text 变化时维护，重建若漏掉删除行，
      // 之后 restore 的实体会永久失去 FTS 索引。
      counts.entityFtsRebuilt = Number(db.prepare(`INSERT INTO memory_entities_fts(search_text, channel_id, entity_rowid)
        SELECT search_text, channel_id, rowid FROM memory_entities`).run().changes ?? 0)
    })
  }
  catch {
    counts.entityFtsRebuilt = 0
    counts.entityFtsFailed = 1
  }
  try {
    counts.staleGraphRuns = createMemoryGraphRepo(db).reconcileStaleRuns()
  }
  catch {
    counts.staleGraphRuns = 0
  }
  // 旧库图谱残留(私有/会话行物化进频道图):按新口径清理,人工行与锁定行保留
  try {
    Object.assign(counts, purgeGraphResidue(db))
  }
  catch {
    counts.graphResidueFailed = 1
  }
  return counts
}
