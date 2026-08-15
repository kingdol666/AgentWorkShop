/**
 * Memory 仓储:agent_memories(持久记忆)+ FTS5 全文索引。
 * upsert 经 (agent_id, dedup_key) 去重(AFTER UPDATE 触发器同步 FTS);
 * search 的 bm25 检索恒含团队共享行(agent_id='__team__');list* 严格本人。
 * 向量方法(vec*)在 P1 扩展;本文件保持纯 node:sqlite 同步。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { MemoryRow } from './database'

/** 团队共享记忆域 sentinel(单 channel 内全员可读) */
export const TEAM_AGENT_ID = '__team__'

export interface MemoryUpsertInput {
  channelId: string
  agentId: string
  kind: 'episodic-task' | 'episodic-peer' | 'semantic'
  title: string
  /** title 的 CJK 切分副本(FTS 索引用;调用方经 AgentMemory.segmentCJK 处理,V8) */
  titleFts: string
  /** 已 CJK 单字切分的存储文本(AgentMemory.segmentCJK 处理) */
  content: string
  importance: number
  taskId?: string | null
  dedupKey: string
}

export type MemoryRepo = ReturnType<typeof createMemoryRepo>

const COLS = `m.id, m.channel_id AS channelId, m.agent_id AS agentId, m.kind, m.title, m.content,
  m.importance, m.task_id AS taskId, m.access_count AS accessCount,
  m.last_accessed_at AS lastAccessedAt, m.created_at AS createdAt`

export function createMemoryRepo(db: DatabaseSync) {
  const upsertStmt = db.prepare(
    `INSERT INTO agent_memories
       (id, channel_id, agent_id, kind, title, title_fts, content, importance, task_id, dedup_key, access_count, last_accessed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
     ON CONFLICT(agent_id, dedup_key) DO UPDATE SET
       kind = excluded.kind, title = excluded.title, title_fts = excluded.title_fts,
       content = excluded.content, importance = excluded.importance, created_at = excluded.created_at`,
  )
  const searchStmt = db.prepare(
    `SELECT ${COLS}, f.rank AS bm25
     FROM agent_memories_fts f
     JOIN agent_memories m ON m.rowid = f.memory_rowid
     WHERE agent_memories_fts MATCH ? AND m.agent_id IN (?, ?)
     ORDER BY f.rank LIMIT ?`,
  )
  const listRecentStmt = db.prepare(
    `SELECT id, channel_id AS channelId, agent_id AS agentId, kind, title, content,
            importance, task_id AS taskId, access_count AS accessCount,
            last_accessed_at AS lastAccessedAt, created_at AS createdAt
     FROM agent_memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
  const findByDedupStmt = db.prepare(
    `SELECT id, rowid FROM agent_memories WHERE agent_id = ? AND dedup_key = ?`,
  )
  const touchStmt = db.prepare(
    `UPDATE agent_memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
  )
  const deleteStmt = db.prepare(`DELETE FROM agent_memories WHERE id = ?`)
  const agentIdsStmt = db.prepare(
    `SELECT DISTINCT agent_id FROM agent_memories WHERE agent_id != ?`,
  )
  // ===== 向量方法(P1;vec0 分区表 + mem_rowid 辅助列映射)=====
  // 已实测事实:
  // - vec0 分区表不支持显式 rowid 插入 → 以 +mem_rowid 辅助列映射 agent_memories.rowid
  // - node:sqlite 把 number 绑定为 REAL → 一切整数绑定(vec 辅助列/rowid/k)必须 BigInt(n),
  //   否则 "Auxiliary column type mismatch"
  // - 刷新语义 = SELECT rowid WHERE mem_rowid → DELETE → 重插(分区表 rowid 不可控)
  // - 语句在建表成功后才 prepare(vec0 DDL 不进 SCHEMA_SQL:维度运行时才知)
  let vecDims: number | null = null
  let vecFindRowStmt: StatementSync | null = null
  let vecDeleteRowStmt: StatementSync | null = null
  let vecInsertStmt: StatementSync | null = null
  let vecSearchStmt: StatementSync | null = null

  function vecEnsureTable(dims: number): boolean {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_vec USING vec0(
        embedding float[${dims}], agent_id TEXT partition key, +mem_rowid INTEGER)`)
      // 维度校验探针:已存表若维度不同,试插会炸 → 返回 false(不破坏已有数据)
      // ('__probe__' 分区即刻删除,无害)
      vecInsertStmt = db.prepare(`INSERT INTO agent_memories_vec(embedding, agent_id, mem_rowid) VALUES (?, ?, ?)`)
      vecInsertStmt.run(new Float32Array(dims), '__probe__', BigInt(-1))
      db.prepare(`DELETE FROM agent_memories_vec WHERE mem_rowid = ?`).run(BigInt(-1))
      vecFindRowStmt = db.prepare(`SELECT rowid FROM agent_memories_vec WHERE mem_rowid = ?`)
      vecDeleteRowStmt = db.prepare(`DELETE FROM agent_memories_vec WHERE rowid = ?`)
      vecSearchStmt = db.prepare(
        `SELECT mem_rowid, distance FROM agent_memories_vec WHERE agent_id = ? AND embedding MATCH ? AND k = ?`)
      return true
    }
    catch {
      vecFindRowStmt = vecDeleteRowStmt = vecInsertStmt = vecSearchStmt = null
      return false
    }
  }

  return {
    upsert(input: MemoryUpsertInput): void {
      upsertStmt.run(
        randomUUID(), input.channelId, input.agentId, input.kind,
        input.title, input.titleFts, input.content, input.importance,
        input.taskId ?? null, input.dedupKey, new Date().toISOString(),
      )
    },

    /** bm25 检索(恒含 team 共享行;matchQuery 为 OR 连接切分词) */
    search(agentId: string, matchQuery: string, limit: number): Array<MemoryRow & { bm25: number }> {
      return searchStmt.all(matchQuery, agentId, TEAM_AGENT_ID, limit) as unknown as Array<MemoryRow & { bm25: number }>
    },

    listRecent(agentId: string, limit: number): MemoryRow[] {
      return listRecentStmt.all(agentId, limit) as unknown as MemoryRow[]
    },

    listByAgent(agentId: string, limit: number): MemoryRow[] {
      return listRecentStmt.all(agentId, limit) as unknown as MemoryRow[]
    },

    /** upsert 后取定位置(供向量写回 rowid) */
    findByAgentDedup(agentId: string, dedupKey: string): { id: string, rowid: number } | null {
      return (findByDedupStmt.get(agentId, dedupKey) as { id: string, rowid: number } | undefined) ?? null
    },

    touch(id: string): void {
      touchStmt.run(new Date().toISOString(), id)
    },

    /** 删除(FTS 触发器自动清理;向量行由上层先 vecDelete);返回是否删除 */
    delete(id: string): boolean {
      return deleteStmt.run(id).changes > 0
    },

    /** 有记忆的 agent 清单(维护任务迭代;排除 team) */
    listMemoryAgentIds(): string[] {
      return (agentIdsStmt.all(TEAM_AGENT_ID) as Array<{ agent_id: string }>).map(r => r.agent_id)
    },

    // ===== vec:延迟建表(vecInit)/ 刷新写入(vecSet)/ 删除(vecDelete)/ 分区 kNN(vecSearch)=====

    /** 首次调用按 dims 建表;同 dims 幂等 true;不同 dims 拒绝 false(禁用向量,绝不重建) */
    vecInit(dims: number): boolean {
      if (vecDims === dims) return true
      if (vecDims !== null) return false
      if (!vecEnsureTable(dims)) return false
      vecDims = dims
      return true
    },

    /** 向量层是否可用(建表成功即 true) */
    get vecReady(): boolean {
      return vecDims !== null
    },

    /** 写/覆盖某记忆行的向量(按 mem_rowid 刷新:删旧插新;失败静默不阻塞主流程) */
    vecSet(memRowid: number, agentId: string, vec: Float32Array): void {
      if (vecFindRowStmt === null || vecDeleteRowStmt === null || vecInsertStmt === null) return
      try {
        const old = vecFindRowStmt.get(BigInt(memRowid)) as { rowid: number | bigint } | undefined
        if (old) vecDeleteRowStmt.run(BigInt(old.rowid))
        vecInsertStmt.run(vec, agentId, BigInt(memRowid))
      }
      catch { /* 向量写失败不阻塞主流程 */ }
    },

    /** 删除某记忆行的向量(删除记忆联动;不存在/失败均静默) */
    vecDelete(memRowid: number): void {
      if (vecFindRowStmt === null || vecDeleteRowStmt === null) return
      try {
        const old = vecFindRowStmt.get(BigInt(memRowid)) as { rowid: number | bigint } | undefined
        if (old) vecDeleteRowStmt.run(BigInt(old.rowid))
      }
      catch { /* 同上 */ }
    },

    /** agent 域内 kNN(分区键隔离;禁用时返回空) */
    vecSearch(agentId: string, vec: Float32Array, k: number): Array<{ memRowid: number, distance: number }> {
      if (vecSearchStmt === null) return []
      try {
        const rows = vecSearchStmt.all(agentId, vec, BigInt(k)) as Array<{ mem_rowid: number | bigint, distance: number }>
        return rows.map(r => ({ memRowid: Number(r.mem_rowid), distance: r.distance }))
      }
      catch { return [] }
    },
  }
}
