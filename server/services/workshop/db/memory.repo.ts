/**
 * Memory 仓储:agent_memories(持久记忆)+ FTS5 全文索引。
 * upsert 经 (agent_id, dedup_key) 去重(AFTER UPDATE 触发器同步 FTS);
 * search 的 bm25 检索恒含团队共享行(agent_id='__team__');list* 严格本人。
 * 向量方法(vec*)在 P1 扩展;本文件保持纯 node:sqlite 同步。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
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
  }
}
