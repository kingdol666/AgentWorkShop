/**
 * ChannelEvent 仓储:AEP 事件持久化(channel_events)。
 * hub publish 同步写入(server 驱动);时间线历史经 REST 拉取渲染,与 client 无关。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelEventRow } from './database'

export interface StoredAepEvent {
  seq: number
  type: string
  at: string
  agentId: string | null
  taskId: string | null
  payload: unknown
}

export type ChannelEventRepo = ReturnType<typeof createChannelEventRepo>

const COLS = `id, channel_id AS channelId, seq, type, at, agent_id AS agentId, task_id AS taskId, payload_json AS payloadJson`

export function createChannelEventRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO channel_events (channel_id, seq, type, at, agent_id, task_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const listRecentStmt = db.prepare(
    `SELECT ${COLS} FROM channel_events WHERE channel_id = ? ORDER BY seq DESC LIMIT ?`,
  )
  const listBeforeStmt = db.prepare(
    `SELECT ${COLS} FROM channel_events WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
  )
  const maxSeqStmt = db.prepare(
    `SELECT MAX(seq) AS maxSeq FROM channel_events WHERE channel_id = ?`,
  )
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM channel_events WHERE channel_id = ?`,
  )

  /** hub publish 同步写库(INSERT OR IGNORE:hub 内存 seq 与库重放幂等) */
  function insert(channelId: string, e: StoredAepEvent): void {
    insertStmt.run(channelId, e.seq, e.type, e.at, e.agentId, e.taskId, JSON.stringify(e.payload))
  }

  /** 最近 N 条(倒序取→正序返回,时间线顺序) */
  function listRecent(channelId: string, limit: number): StoredAepEvent[] {
    return (listRecentStmt.all(channelId, limit) as unknown as ChannelEventRow[])
      .map(rowToEvent)
      .reverse()
  }

  /** 翻页:seq < beforeSeq 的最近 N 条(正序返回) */
  function listBefore(channelId: string, beforeSeq: number, limit: number): StoredAepEvent[] {
    return (listBeforeStmt.all(channelId, beforeSeq, limit) as unknown as ChannelEventRow[])
      .map(rowToEvent)
      .reverse()
  }

  function maxSeq(channelId: string): number {
    return ((maxSeqStmt.get(channelId) as { maxSeq: number | null } | undefined)?.maxSeq) ?? 0
  }

  function count(channelId: string): number {
    return ((countStmt.get(channelId) as { n: number } | undefined)?.n) ?? 0
  }

  return { insert, listRecent, listBefore, maxSeq, count }
}

function rowToEvent(row: ChannelEventRow): StoredAepEvent {
  let payload: unknown = null
  try {
    payload = JSON.parse(row.payloadJson)
  }
  catch { /* 损坏 payload 容错为 null */ }
  return {
    seq: row.seq,
    type: row.type,
    at: row.at,
    agentId: row.agentId,
    taskId: row.taskId,
    payload,
  }
}
