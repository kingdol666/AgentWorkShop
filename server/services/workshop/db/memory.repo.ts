/**
 * Memory 仓储:agent_memories(持久记忆)+ FTS5 全文索引。
 * upsert 经 (agent_id, dedup_key) 去重(AFTER UPDATE 触发器同步 FTS);
 * search 的 bm25 检索恒含团队共享行(agent_id='__team__');list* 严格本人。
 * 向量方法(vec*)在 P1 扩展;本文件保持纯 node:sqlite 同步。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { MemoryKind, MemoryOutcome, MemoryRow, MemoryScopeKind, MemoryStatus } from './database'

/** 团队共享记忆域 sentinel(单 channel 内全员可读) */
export const TEAM_AGENT_ID = '__team__'

/** '2026-09' → '2026-10'(跨年安全);用于半开区间 [本月1日, 下月1日) 查询 */
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${(y ?? 0) + 1}-01` : `${y}-${String((m ?? 0) + 1).padStart(2, '0')}`
}

export interface MemoryUpsertInput {
  channelId: string
  agentId: string
  /** 语义见 database.ts MemoryKind(harvest 族参与维护;semantic 知识;策展层双免) */
  kind: MemoryKind
  title: string
  /** title 的 CJK 切分副本(FTS 索引用;调用方经 AgentMemory.segmentCJK 处理,V8) */
  titleFts: string
  /** 已 CJK 单字切分的存储文本(AgentMemory.segmentCJK 处理) */
  content: string
  importance: number
  taskId?: string | null
  /** 诞生时的 session 作用域(''=channel 级;recall 的 session 档按此过滤) */
  sessionId?: string | null
  dedupKey: string
}

export type MemoryRepo = ReturnType<typeof createMemoryRepo>

/**
 * 经验证据链契约(WP-A1;序列化进 evidence_json)。
 * 至少一个锚点必填 —— 无锚点的因果断言只允许以 anecdotal/unknown 形式进入(调用方决定)。
 * 解析失败/空对象的事件由 upsertExperience 直接拒绝(fail-closed)。
 */
export interface ExperienceEvidence {
  /** 任务锚点(任务终态触发) */
  taskIds?: string[]
  traceId?: string
  /** 配方试验批次(recipe_trial 回执 runId) */
  runId?: string
  recipeRunId?: string
  /** 干预台账行(verdict 来源) */
  interventionEventId?: string
  /** 项目成果(评审终态触发) */
  resultId?: string
  /** 可观测指标快照(如 { iae: 12.3, pv: 220.5 }) */
  metrics?: Record<string, number>
  /** 机器可读判据(metric/op/threshold/mde) */
  criterion?: Record<string, unknown>
}

/** 经验条目写入入参(区别于普通 upsert:强制证据校验与生命周期字段) */
export interface ExperienceUpsertInput extends MemoryUpsertInput {
  outcome?: MemoryOutcome
  /** 结构化的证据对象(序列化后落库;同时接受已序列化字符串供重放) */
  evidence?: ExperienceEvidence | string
  scopeKind?: MemoryScopeKind
  scopeKey?: string
  status?: MemoryStatus
  expiresAt?: string | null
}

/** 证据对象里"至少一个"的锚点键(空值不计) */
const EVIDENCE_ANCHOR_KEYS = ['taskIds', 'traceId', 'runId', 'recipeRunId', 'interventionEventId', 'resultId'] as const

/**
 * 规范化并校验证据 JSON:非法 JSON / 非对象 / 无任何锚点 → 抛错(fail-closed)。
 * 返回可直接落库的紧凑 JSON 字符串。
 */
export function normalizeExperienceEvidence(evidence: ExperienceEvidence | string | undefined): string {
  if (evidence === undefined || evidence === '') {
    throw new Error('experience evidence required: at least one anchor (taskIds/traceId/runId/recipeRunId/interventionEventId/resultId)')
  }
  let parsed: unknown = evidence
  if (typeof evidence === 'string') {
    try {
      parsed = JSON.parse(evidence)
    }
    catch {
      throw new Error('invalid experience evidence: not valid JSON')
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid experience evidence: expected object')
  }
  const obj = parsed as Record<string, unknown>
  const hasAnchor = EVIDENCE_ANCHOR_KEYS.some((k) => {
    const v = obj[k]
    if (Array.isArray(v)) return v.some(x => typeof x === 'string' && x.length > 0)
    return typeof v === 'string' && v.length > 0
  })
  if (!hasAnchor) {
    throw new Error('invalid experience evidence: no anchor provided')
  }
  return JSON.stringify(obj)
}

const COLS = `m.id, m.channel_id AS channelId, m.agent_id AS agentId, m.kind, m.title, m.content, m.dedup_key AS dedupKey, m.title_fts AS titleFts,
  m.importance, m.task_id AS taskId, m.session_id AS sessionId, m.access_count AS accessCount,
  m.last_accessed_at AS lastAccessedAt, m.created_at AS createdAt,
  m.outcome, m.evidence_json AS evidenceJson, m.scope_kind AS scopeKind, m.scope_key AS scopeKey,
  m.status, m.expires_at AS expiresAt`

export function createMemoryRepo(db: DatabaseSync) {
  const upsertStmt = db.prepare(
    `INSERT INTO agent_memories
       (id, channel_id, agent_id, kind, title, title_fts, content, importance, task_id, session_id, dedup_key, access_count, last_accessed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    ON CONFLICT(agent_id, dedup_key, channel_id) DO UPDATE SET
      channel_id = excluded.channel_id, kind = excluded.kind, title = excluded.title, title_fts = excluded.title_fts,
      content = excluded.content, importance = excluded.importance, created_at = excluded.created_at`,
  )
  const searchStmt = db.prepare(
    `SELECT ${COLS}, f.rank AS bm25
     FROM agent_memories_fts f
     JOIN agent_memories m ON m.rowid = f.memory_rowid
     WHERE agent_memories_fts MATCH ? AND m.agent_id IN (?, ?)
     ORDER BY f.rank LIMIT ?`,
  )
  const searchInSessionStmt = db.prepare(
    `SELECT ${COLS}, f.rank AS bm25
     FROM agent_memories_fts f
     JOIN agent_memories m ON m.rowid = f.memory_rowid
     WHERE agent_memories_fts MATCH ? AND m.agent_id IN (?, ?) AND m.session_id = ?
     ORDER BY f.rank LIMIT ?`,
  )
  const listRecentStmt = db.prepare(
    `SELECT ${COLS} FROM agent_memories m WHERE m.agent_id = ? ORDER BY m.created_at DESC LIMIT ?`,
  )
  const findByDedupStmt = db.prepare(
    `SELECT id, rowid FROM agent_memories WHERE channel_id = ? AND agent_id = ? AND dedup_key = ?`,
  )
  const listByAgentChannelStmt = db.prepare(
    `SELECT ${COLS} FROM agent_memories m WHERE m.channel_id = ? AND m.agent_id = ? ORDER BY m.created_at DESC LIMIT ?`,
  )
  const listByAgentRowidStmt = db.prepare(
    `SELECT m.rowid, ${COLS} FROM agent_memories m WHERE m.agent_id = ? ORDER BY m.created_at DESC LIMIT ?`,
  )
  const touchStmt = db.prepare(
    `UPDATE agent_memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
  )
  const deleteStmt = db.prepare(`DELETE FROM agent_memories WHERE id = ?`)
  const agentIdsStmt = db.prepare(
    `SELECT DISTINCT agent_id FROM agent_memories WHERE agent_id != ?`,
  )
  const channelIdsStmt = db.prepare(
    `SELECT DISTINCT channel_id AS channelId FROM agent_memories`,
  )
  const getByIdStmt = db.prepare(
    `SELECT ${COLS} FROM agent_memories m WHERE m.id = ?`,
  )
  // 经验条目写入(WP-A1):kind 恒 'experience';conflict 时刷新证据/作用域/生命周期(access_count 保留)。
  // **状态单调性**(2026-11-10 审计):validated/retired 是人类策展结果,重放/重存不得把它
  // 打回 candidate,也不得覆盖其证据(旧实现无条件写 status/evidence_json ——
  // 任何一次反射器重放都会抹掉人工合并的成果)。
  const upsertExperienceStmt = db.prepare(
    `INSERT INTO agent_memories
       (id, channel_id, agent_id, kind, title, title_fts, content, importance, task_id, session_id, dedup_key,
        access_count, last_accessed_at, created_at, outcome, evidence_json, scope_kind, scope_key, status, expires_at)
     VALUES (?, ?, ?, 'experience', ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, dedup_key, channel_id) DO UPDATE SET
      channel_id = excluded.channel_id, kind = 'experience', title = excluded.title, title_fts = excluded.title_fts,
      content = excluded.content, importance = excluded.importance, task_id = excluded.task_id,
      session_id = excluded.session_id, outcome = excluded.outcome,
      evidence_json = CASE WHEN agent_memories.status IN ('validated', 'retired')
        THEN agent_memories.evidence_json ELSE excluded.evidence_json END,
      scope_kind = excluded.scope_kind, scope_key = excluded.scope_key,
      status = CASE WHEN agent_memories.status IN ('validated', 'retired')
        THEN agent_memories.status ELSE excluded.status END,
      expires_at = excluded.expires_at, created_at = excluded.created_at`,
  )
  const markStatusStmt = db.prepare(`UPDATE agent_memories SET status = ? WHERE id = ? AND status = ?`)
  const expireSweepStmt = db.prepare(
    `UPDATE agent_memories SET status = 'retired'
      WHERE expires_at IS NOT NULL AND expires_at != '' AND expires_at <= ? AND status != 'retired'`,
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
        input.taskId ?? null, input.sessionId ?? '', input.dedupKey, new Date().toISOString(),
      )
    },

    /**
     * 经验条目写入(WP-A1;RSI 证据链唯一写入口)。
     * 强制证据锚点校验:非法 JSON / 无锚点 → 抛错且不落行(fail-closed,绝不产生无证据经验)。
     * conflict 语义:同 (agent, dedup, channel) 刷新证据与生命周期,access_count 保留。
     */
    upsertExperience(input: ExperienceUpsertInput): { id: string } {
      const evidenceJson = normalizeExperienceEvidence(input.evidence)
      upsertExperienceStmt.run(
        randomUUID(), input.channelId, input.agentId,
        input.title, input.titleFts, input.content, input.importance,
        input.taskId ?? null, input.sessionId ?? '', input.dedupKey, new Date().toISOString(),
        input.outcome ?? 'neutral', evidenceJson,
        input.scopeKind ?? 'session', input.scopeKey ?? '',
        input.status ?? 'active', input.expiresAt ?? null,
      )
      const at = findByDedupStmt.get(input.channelId, input.agentId, input.dedupKey) as { id: string } | undefined
      return { id: at?.id ?? '' }
    },

    /**
     * 按作用域取**经验行**（跨 Channel 共享检索 / 晋升门 / 看板的数据面）。
     * 恒过滤 kind='experience' —— 普通记忆（episodic/semantic）也有 scope_kind 默认值，
     * 不过滤会把它们计入经验看板/共享域（实测 live 看板 29 条 vs 真实 4 条）。
     * channelIds 缺省不限制 channel；statuses 缺省排除 retired（退休经验不再参与注入）。
     */
    listByScope(opts: {
      scopeKind: MemoryScopeKind
      scopeKey?: string
      channelIds?: string[]
      statuses?: MemoryStatus[]
      limit?: number
    }): Array<MemoryRow & { rowid: number }> {
      const where: string[] = [`m.kind = 'experience'`, 'm.scope_kind = ?']
      const args: Array<string | number> = [opts.scopeKind]
      if (opts.scopeKey !== undefined) {
        where.push('m.scope_key = ?')
        args.push(opts.scopeKey)
      }
      const statuses = opts.statuses ?? ['active', 'candidate', 'validated', 'contested']
      where.push(`m.status IN (${statuses.map(() => '?').join(', ')})`)
      args.push(...statuses)
      if (opts.channelIds !== undefined) {
        if (opts.channelIds.length === 0) return []
        where.push(`m.channel_id IN (${opts.channelIds.map(() => '?').join(', ')})`)
        args.push(...opts.channelIds)
      }
      args.push(Math.min(Math.max(opts.limit ?? 50, 1), 500))
      return db.prepare(
        `SELECT m.rowid, ${COLS} FROM agent_memories m
          WHERE ${where.join(' AND ')}
          ORDER BY m.created_at DESC LIMIT ?`,
      ).all(...args) as unknown as Array<MemoryRow & { rowid: number }>
    },

    /** 生命周期迁移：调用方必须声明 expected-state；条件 UPDATE 防止旧读覆盖并发新状态 */
    markStatus(id: string, status: MemoryStatus, expectedStatus: MemoryStatus): boolean {
      if (status === 'validated' && expectedStatus !== 'candidate') return false
      if (expectedStatus === 'validated' && status !== 'retired') return false
      if (expectedStatus === 'retired' && status !== 'retired') return false
      return Number(markStatusStmt.run(status, id, expectedStatus).changes ?? 0) > 0
    },

    /** 过期扫描:expires_at <= now 且未退休 → status='retired';返回迁移行数(维护定时器调用) */
    expireSweep(nowIso = new Date().toISOString()): number {
      return Number(expireSweepStmt.run(nowIso).changes ?? 0)
    },

    /** 经验状态分布(看板/门统计;可按作用域收窄) */
    experienceStats(opts: { scopeKind?: MemoryScopeKind } = {}): Array<{ status: string, n: number }> {
      const rows = opts.scopeKind
        ? db.prepare(`SELECT status, COUNT(*) AS n FROM agent_memories WHERE kind = 'experience' AND scope_kind = ? GROUP BY status`)
            .all(opts.scopeKind)
        : db.prepare(`SELECT status, COUNT(*) AS n FROM agent_memories WHERE kind = 'experience' GROUP BY status`).all()
      return (rows as Array<{ status: string, n: number }>).map(r => ({ status: r.status, n: Number(r.n) }))
    },

    /**
     * 频道的作用域上下文(WP-A3):line 绑定来自 channels.line_id(迁移列)。
     * product 目前无频道级绑定列 → 恒 null,由调用方显式传 scopeContext.productId 覆盖。
     * 查询失败(极端旧库)返回空对象,不阻断召回。
     */
    channelScope(channelId: string): { lineId: string | null, productId: string | null } {
      try {
        const row = db.prepare('SELECT line_id AS lineId FROM channels WHERE id = ?').get(channelId) as { lineId?: string } | undefined
        return { lineId: row?.lineId || null, productId: null }
      }
      catch {
        return { lineId: null, productId: null }
      }
    },

    /** bm25 检索(恒含 team 共享行;matchQuery 为 OR 连接切分词;sessionId 给定→仅该 session 作用域行) */
    search(agentId: string, matchQuery: string, limit: number, opts: { sessionId?: string } = {}): Array<MemoryRow & { bm25: number }> {
      if (opts.sessionId) {
        return searchInSessionStmt.all(matchQuery, agentId, TEAM_AGENT_ID, opts.sessionId, limit) as unknown as Array<MemoryRow & { bm25: number }>
      }
      return searchStmt.all(matchQuery, agentId, TEAM_AGENT_ID, limit) as unknown as Array<MemoryRow & { bm25: number }>
    },

    /**
     * 跨团队共享域检索(hardening 后的协作扩展;只读):仅 __team__ 行,
     * 限定目标 channel 集合(调用方保证同主/启用),按 bm25 排序。
     * matchQuery 为 OR 连接的切分词(与 search 同规约)。
     */
    searchTeamSharedAcross(matchQuery: string, channelIds: string[], limit: number): Array<MemoryRow & { bm25: number }> {
      if (channelIds.length === 0) return []
      const placeholders = channelIds.map(() => '?').join(', ')
      const stmt = db.prepare(
        `SELECT ${COLS}, f.rank AS bm25
         FROM agent_memories_fts f
         JOIN agent_memories m ON m.rowid = f.memory_rowid
         WHERE agent_memories_fts MATCH ? AND m.agent_id = ? AND m.channel_id IN (${placeholders})
         ORDER BY f.rank LIMIT ?`,
      )
      return stmt.all(matchQuery, TEAM_AGENT_ID, ...channelIds, limit) as unknown as Array<MemoryRow & { bm25: number }>
    },

    /** 某 channel 团队共享域的行数(跨团队概览的"知识量"指标) */
    countTeamShared(channelId: string): number {
      return Number(
        db.prepare(`SELECT COUNT(*) AS c FROM agent_memories WHERE channel_id = ? AND agent_id = ?`)
          .get(channelId, TEAM_AGENT_ID)?.c ?? 0,
      )
    },

    /**
     * 跨 Channel 经验检索(WP-A4;只读)。
     * 与 searchTeamSharedAcross 的差别:读 **experience 行**(不限 agent_id/__team__),
     * 但强制 scope_kind 白名单 + status ∈ {active, validated}(candidate/retired 不外泄),
     * channel 集合由调用方(manager)按同 owner 授权给出。
     * line/product 档必须给 scopeKey(产线/产品锚点),否则返回空集(不做无边界的"全产线"泄露)。
     */
    searchExperienceAcross(
      matchQuery: string,
      channelIds: string[],
      opts: { scopeKinds: MemoryScopeKind[], scopeKey?: string, limit?: number },
    ): Array<MemoryRow & { bm25: number }> {
      if (channelIds.length === 0 || opts.scopeKinds.length === 0) return []
      const where: string[] = [
        `agent_memories_fts MATCH ?`,
        `m.kind = 'experience'`,
        `m.status IN ('active', 'validated')`,
        `m.scope_kind IN (${opts.scopeKinds.map(() => '?').join(', ')})`,
        `m.channel_id IN (${channelIds.map(() => '?').join(', ')})`,
      ]
      const args: Array<string | number> = [matchQuery, ...opts.scopeKinds, ...channelIds]
      // line/product 是带锚点的作用域:无锚点即无命中(global 不需要 key)
      const keyedScopes = opts.scopeKinds.filter(s => s === 'line' || s === 'product')
      if (keyedScopes.length > 0) {
        if (!opts.scopeKey) return []
        where.push(`(m.scope_kind NOT IN ('line', 'product') OR m.scope_key = ?)`)
        args.push(opts.scopeKey)
      }
      args.push(Math.min(Math.max(opts.limit ?? 5, 1), 20))
      return db.prepare(
        `SELECT ${COLS}, f.rank AS bm25
         FROM agent_memories_fts f
         JOIN agent_memories m ON m.rowid = f.memory_rowid
         WHERE ${where.join(' AND ')}
         ORDER BY f.rank LIMIT ?`,
      ).all(...args) as unknown as Array<MemoryRow & { bm25: number }>
    },

    /**
     * 会话的记忆写入策略(channel_sessions.memory_policy;缺省 session)。
     * 未找到会话/旧库 → 'session'(最保守),失败不抛出。
     */
    sessionMemoryPolicy(sessionId: string): 'session' | 'channel' | 'shared' {
      if (!sessionId) return 'session'
      try {
        const row = db.prepare(`SELECT memory_policy AS policy FROM channel_sessions WHERE id = ?`)
          .get(sessionId) as { policy?: string } | undefined
        const p = row?.policy
        return p === 'shared' || p === 'channel' ? p : 'session'
      }
      catch {
        return 'session'
      }
    },

    listRecent(agentId: string, limit: number): MemoryRow[] {
      return listRecentStmt.all(agentId, limit) as unknown as MemoryRow[]
    },

    listByAgent(agentId: string, limit: number): MemoryRow[] {
      return listRecentStmt.all(agentId, limit) as unknown as MemoryRow[]
    },

    /** 按 rowid 批量取主表行(向量 kNN 命中 → 主表;空数组返回 []) */
    listByRowids(rowids: number[]): Array<MemoryRow & { rowid: number }> {
      if (rowids.length === 0) return []
      const placeholders = rowids.map(() => '?').join(', ')
      return db.prepare(
        `SELECT m.rowid, ${COLS} FROM agent_memories m WHERE m.rowid IN (${placeholders})`,
      ).all(...rowids.map(BigInt)) as unknown as Array<MemoryRow & { rowid: number }>
    },

    /** upsert 后取定位置(供向量写回 rowid;按 channel 作用域——team 哨兵行跨 channel 各自独立) */
    findByAgentDedup(channelId: string, agentId: string, dedupKey: string): { id: string, rowid: number } | null {
      return (findByDedupStmt.get(channelId, agentId, dedupKey) as { id: string, rowid: number } | undefined) ?? null
    },

    /** channel × agent 双键列表(team 行按 channel 隔离的正确口径;listByAgent 为全局 agent 域) */
    listByAgentChannel(channelId: string, agentId: string, limit: number): MemoryRow[] {
      return listByAgentChannelStmt.all(channelId, agentId, limit) as unknown as MemoryRow[]
    },

    /** listByAgent + rowid(维护专用:过期/淘汰删除需联动 vec 行) */
    listByAgentWithRowid(agentId: string, limit: number): Array<MemoryRow & { rowid: number }> {
      return listByAgentRowidStmt.all(agentId, limit) as unknown as Array<MemoryRow & { rowid: number }>
    },

    /**
     * 按 (agent, kind, 年月) 精确取行 —— 供空闲反思使用。
     * 替代原先「limit=1_000_000 拉全量再由 JS filter」的退化作法:
     * 过滤条件下推到 SQL(走 agent_id+kind 前缀),返回量与实际增量同阶,
     * 不再随记忆总量线性放大内存与 CPU。
     * month 形如 '2026-09'(与 createdAt 的 ISO 前 7 位一致)。
     */
    listByAgentKindMonth(agentId: string, kind: MemoryKind, month: string): MemoryRow[] {
      return db.prepare(
        `SELECT ${COLS} FROM agent_memories m
          WHERE m.agent_id = ? AND m.kind = ?
            AND m.created_at >= ? AND m.created_at < ?
          ORDER BY m.created_at ASC`,
      ).all(agentId, kind, `${month}-01`, `${nextMonth(month)}-01`) as unknown as MemoryRow[]
    },

    /** 当月某 kind 的计数(反思触发阈值判断用;不取行体,零拷贝) */
    countByAgentKindMonth(agentId: string, kind: MemoryKind, month: string): number {
      const row = db.prepare(
        `SELECT COUNT(*) AS c FROM agent_memories
          WHERE agent_id = ? AND kind = ? AND created_at >= ? AND created_at < ?`,
      ).get(agentId, kind, `${month}-01`, `${nextMonth(month)}-01`) as { c: number } | undefined
      return Number(row?.c ?? 0)
    },

    touch(id: string): void {
      touchStmt.run(new Date().toISOString(), id)
    },

    /** 删除(FTS 触发器自动清理;向量行由上层先 vecDelete);返回是否删除 */
    delete(id: string): boolean {
      return deleteStmt.run(id).changes > 0
    },

    /** 删除某 channel 全部记忆(channel 级联删除:成员私有行 + team 公共行;vec 残留由维护任务清理);返回删除数 */
    deleteByChannel(channelId: string): number {
      const rows = db.prepare(
        `SELECT rowid FROM agent_memories WHERE channel_id = ?`,
      ).all(channelId) as Array<{ rowid: number | bigint }>
      for (const r of rows) {
        try {
          // 与 vecDelete 同语义:按 mem_rowid 反查 vec 行后删(分区表 rowid 不可控)
          const old = vecFindRowStmt?.get(BigInt(r.rowid)) as { rowid: number | bigint } | undefined
          if (old) vecDeleteRowStmt?.run(BigInt(old.rowid))
        }
        catch { /* vec 未启用 */ }
      }
      return Number(db.prepare(`DELETE FROM agent_memories WHERE channel_id = ?`).run(channelId).changes)
    },

    /** 有记忆的 agent 清单(维护任务迭代;排除 team) */
    listMemoryAgentIds(): string[] {
      return (agentIdsStmt.all(TEAM_AGENT_ID) as Array<{ agent_id: string }>).map(r => r.agent_id)
    },

    /** 有记忆的 channel 清单(team 域行按 channel 迭代维护用) */
    listChannelIds(): string[] {
      return (channelIdsStmt.all() as Array<{ channelId: string }>).map(r => r.channelId)
    },

    /** 按 id 取单行(brief 置顶注入等直取场景;不存在返回 null) */
    getById(id: string): MemoryRow | null {
      return (getByIdStmt.get(id) as MemoryRow | undefined) ?? null
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

    /** 清孤儿 vec 行(mem_rowid 已不在主表;维护任务统一收口;vec 未启用/失败 → 0) */
    vecCleanOrphans(): number {
      if (vecDims === null) return 0
      try {
        return Number(db.prepare(
          `DELETE FROM agent_memories_vec WHERE mem_rowid NOT IN (SELECT rowid FROM agent_memories)`,
        ).run().changes)
      }
      catch { return 0 }
    },
  }
}
