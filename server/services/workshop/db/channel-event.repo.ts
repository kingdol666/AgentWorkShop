/**
 * ChannelEvent 仓储:AEP 事件持久化(channel_events)。
 * hub publish 同步写入(server 驱动);时间线/lane 历史经 REST 拉取渲染,与 client 无关。
 *
 * 过滤查询(EventQueryOpts):lane 按需加载按 agent 维度拉取(避免单 agent 的
 * 高频流式帧淹没全局 200 帧窗口);excludeTypes 剔除过程帧(agent.delta 的
 * 打字机增量在历史回放里由落定 agent.message 携带全文,无需逐帧重放)。
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

/** 历史查询过滤(lane 按需加载 / 历史窗口提质) */
export interface EventQueryOpts {
  /** 仅该 agent 的事件(a2a.message 归发送方,与 WS 信封 agentId 同口径) */
  agentId?: string
  /** 排除的事件类型(如 ['agent.delta']) */
  excludeTypes?: readonly string[]
}

export type ChannelEventRepo = ReturnType<typeof createChannelEventRepo>

const COLS = `id, channel_id AS channelId, seq, type, at, agent_id AS agentId, task_id AS taskId, payload_json AS payloadJson`

export function createChannelEventRepo(db: DatabaseSync) {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO channel_events (channel_id, seq, type, at, agent_id, task_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  /** 动态条件语句缓存(opts 变体有限,按 SQL 文本缓存命中稳定) */
  const stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>()

  /** WHERE 追加过滤(agentId / excludeTypes),返回 [sql片段, 绑定参数] */
  const filterClause = (opts?: EventQueryOpts): [string, unknown[]] => {
    let sql = ''
    const params: unknown[] = []
    if (opts?.agentId !== undefined) {
      sql += ' AND agent_id = ?'
      params.push(opts.agentId)
    }
    if (opts?.excludeTypes && opts.excludeTypes.length > 0) {
      sql += ` AND type NOT IN (${opts.excludeTypes.map(() => '?').join(', ')})`
      params.push(...opts.excludeTypes)
    }
    return [sql, params]
  }

  const select = (baseWhere: string, tail: string, baseParams: unknown[], tailParams: unknown[], opts?: EventQueryOpts) => {
    const [filterSql, filterParams] = filterClause(opts)
    const sql = `SELECT ${COLS} FROM channel_events WHERE ${baseWhere}${filterSql} ${tail}`
    let stmt = stmtCache.get(sql)
    if (!stmt) {
      stmt = db.prepare(sql)
      stmtCache.set(sql, stmt)
    }
    // 绑定顺序与 SQL 文本一致:WHERE 基础参数 → 过滤参数 → 排序/分页参数
    return stmt.all(...baseParams, ...filterParams, ...tailParams) as unknown as ChannelEventRow[]
  }

  /** hub publish 同步写库(INSERT OR IGNORE:hub 内存 seq 与库重放幂等) */
  function insert(channelId: string, e: StoredAepEvent): void {
    insertStmt.run(channelId, e.seq, e.type, e.at, e.agentId, e.taskId, JSON.stringify(e.payload))
  }

  /** 最近 N 条(倒序取→正序返回,时间线顺序) */
  function listRecent(channelId: string, limit: number, opts?: EventQueryOpts): StoredAepEvent[] {
    return select('channel_id = ?', 'ORDER BY seq DESC LIMIT ?', [channelId], [limit], opts)
      .map(rowToEvent)
      .reverse()
  }

  /** 翻页:seq < beforeSeq 的最近 N 条(正序返回) */
  function listBefore(channelId: string, beforeSeq: number, limit: number, opts?: EventQueryOpts): StoredAepEvent[] {
    return select('channel_id = ? AND seq < ?', 'ORDER BY seq DESC LIMIT ?', [channelId, beforeSeq], [limit], opts)
      .map(rowToEvent)
      .reverse()
  }

  function maxSeq(channelId: string): number {
    return ((db.prepare('SELECT MAX(seq) AS maxSeq FROM channel_events WHERE channel_id = ?')
      .get(channelId) as { maxSeq: number | null } | undefined)?.maxSeq) ?? 0
  }

  function count(channelId: string, opts?: EventQueryOpts): number {
    const [filterSql, filterParams] = filterClause(opts)
    const sql = `SELECT COUNT(*) AS n FROM channel_events WHERE channel_id = ?${filterSql}`
    let stmt = stmtCache.get(sql)
    if (!stmt) {
      stmt = db.prepare(sql)
      stmtCache.set(sql, stmt)
    }
    return ((stmt.get(channelId, ...filterParams) as { n: number } | undefined)?.n) ?? 0
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
