/**
 * 操作与数采统一检索（批次 N3，2026-11-26）。
 *
 * 回答“给定产品/配方/修订/批次/节点/时间窗，历史下发过什么、依据/审批是什么、
 * 对应数采前后值如何、判定是什么；被拒绝/结果未知的尝试想写什么”。
 *
 * 只读；权限由调用方（REST / Agent 工具面）按可读产线 ∪ 绑定节点 / 频道 owner 收口。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface OperationProvenanceFilter {
  lineId?: string
  productId?: string
  recipeId?: string
  recipeRevision?: string
  runId?: string
  nodeId?: string
  fromIso?: string
  toIso?: string
  actor?: string
  path?: string
  verdict?: string
  hasDaq?: boolean
  attemptId?: string
  proposalId?: string
  limit?: number
  /** 游标：(ts,id) 之前的下一页；由上一页 nextCursor 原样回传 */
  beforeTs?: string
  beforeId?: string
}

export interface OperationProvenanceItem {
  id: string
  ts: string
  lineId: string
  nodeId: string
  nodeName: string
  fromValue: number | null
  toValue: number
  actualValue: number | null
  ack: string
  path: string
  actor: string
  actorName: string
  channelId: string
  approvalId: string | null
  recipeRunId: string | null
  hypothesis: string
  targetNodeId: string | null
  criterion: Record<string, unknown> | null
  settleMs: number | null
  verdict: string
  effect: number | null
  ciLow: number | null
  ciHigh: number | null
  mde: number | null
  attemptId: string
  taskId: string
  sessionId: string
  productId: string
  recipeId: string
  recipeRevision: string
  contextSource: string
  proposalId: string
  daq: {
    evidenceId: string
    joinQuality: string
    pre: Record<string, unknown>
    post: Record<string, unknown>
    series: Array<Record<string, unknown>>
    sampleCount: number
    quality: Record<string, unknown>
    rawAvailable: boolean
    missingReason: string
    capturedAt: string
  } | null
}

export interface OperationAttemptItem {
  id: string
  nodeId: string
  lineId: string
  approvalId: string
  taskId: string
  state: string
  detail: string
  payload: Record<string, unknown>
  productId: string
  recipeId: string
  recipeRevision: string
  runId: string
  channelId: string
  agentId: string
  sessionId: string
  interventionId: string
  createdAt: string
  updatedAt: string
}

export interface OperationCoverage {
  total: number
  exact: number
  run: number
  timeWindow: number
  unknown: number
  withDaq: number
  rawExpired: number
  missingRaw: number
}

export interface OperationProvenancePage {
  items: OperationProvenanceItem[]
  attempts: OperationAttemptItem[]
  coverage: OperationCoverage
  nextCursor: { ts: string, id: string } | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const json = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'string' || !v) return {}
  try {
    const parsed = JSON.parse(v) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  }
  catch { return {} }
}
const jsonArray = (v: unknown): Array<Record<string, unknown>> => {
  if (typeof v !== 'string' || !v) return []
  try {
    const parsed = JSON.parse(v) as unknown
    return Array.isArray(parsed) ? parsed.filter(x => x && typeof x === 'object') as Array<Record<string, unknown>> : []
  }
  catch { return [] }
}

export function queryOperationProvenance(db: DatabaseSync, filter: OperationProvenanceFilter = {}): OperationProvenancePage {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const where: string[] = []
  const args: Array<string | number> = []
  const add = (sql: string, ...values: Array<string | number>): void => {
    where.push(sql)
    args.push(...values)
  }
  if (filter.lineId) add('i.line_id = ?', filter.lineId)
  if (filter.productId) add('i.product_id = ?', filter.productId)
  if (filter.recipeId) add('i.recipe_id = ?', filter.recipeId)
  if (filter.recipeRevision) add('i.recipe_revision = ?', filter.recipeRevision)
  if (filter.runId) add('i.recipe_run_id = ?', filter.runId)
  if (filter.nodeId) add('(i.node_id = ? OR i.target_node_id = ?)', filter.nodeId, filter.nodeId)
  if (filter.fromIso) add('i.ts >= ?', filter.fromIso)
  if (filter.toIso) add('i.ts <= ?', filter.toIso)
  if (filter.actor) add('(i.actor = ? OR i.actor_name = ?)', filter.actor, filter.actor)
  if (filter.path) add('i.path = ?', filter.path)
  if (filter.verdict) add('i.verdict = ?', filter.verdict)
  if (filter.attemptId) add('i.attempt_id = ?', filter.attemptId)
  if (filter.proposalId) add('i.proposal_id = ?', filter.proposalId)
  if (filter.hasDaq === true) where.push('d.id IS NOT NULL')
  if (filter.hasDaq === false) where.push('d.id IS NULL')
  if (filter.beforeTs && filter.beforeId) {
    where.push('(i.ts < ? OR (i.ts = ? AND i.id < ?))')
    args.push(filter.beforeTs, filter.beforeTs, filter.beforeId)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const rows = db.prepare(
    `SELECT i.*, d.id AS evidence_id, d.join_quality, d.pre_stats_json, d.post_stats_json,
            d.series_json, d.sample_count, d.quality_json, d.raw_available, d.missing_reason, d.captured_at
       FROM intervention_events i
       LEFT JOIN operation_daq_evidence d ON d.intervention_id = i.id
       ${whereSql}
      ORDER BY i.ts DESC, i.id DESC
      LIMIT ?`,
  ).all(...args, limit + 1) as Array<Record<string, unknown>>

  const pageRows = rows.slice(0, limit)
  const items: OperationProvenanceItem[] = pageRows.map((r) => {
    const evidenceId = String(r.evidence_id ?? '')
    return {
      id: String(r.id ?? ''),
      ts: String(r.ts ?? ''),
      lineId: String(r.line_id ?? ''),
      nodeId: String(r.node_id ?? ''),
      nodeName: String(r.node_name ?? ''),
      fromValue: num(r.from_value),
      toValue: num(r.to_value) ?? 0,
      actualValue: num(r.actual_value),
      ack: String(r.ack ?? ''),
      path: String(r.path ?? ''),
      actor: String(r.actor ?? ''),
      actorName: String(r.actor_name ?? ''),
      channelId: String(r.channel_id ?? ''),
      approvalId: (r.approval_id as string | null) ?? null,
      recipeRunId: (r.recipe_run_id as string | null) ?? null,
      hypothesis: String(r.hypothesis ?? ''),
      targetNodeId: (r.target_node_id as string | null) ?? null,
      criterion: r.criterion_json ? json(r.criterion_json) : null,
      settleMs: num(r.settle_ms),
      verdict: String(r.verdict ?? 'pending'),
      effect: num(r.effect),
      ciLow: num(r.ci_low),
      ciHigh: num(r.ci_high),
      mde: num(r.mde),
      attemptId: String(r.attempt_id ?? ''),
      taskId: String(r.task_id ?? ''),
      sessionId: String(r.session_id ?? ''),
      productId: String(r.product_id ?? ''),
      recipeId: String(r.recipe_id ?? ''),
      recipeRevision: String(r.recipe_revision ?? ''),
      contextSource: String(r.context_source ?? 'unknown'),
      proposalId: String(r.proposal_id ?? ''),
      daq: evidenceId
        ? {
            evidenceId,
            joinQuality: String(r.join_quality ?? 'none'),
            pre: json(r.pre_stats_json),
            post: json(r.post_stats_json),
            series: jsonArray(r.series_json),
            sampleCount: Number(r.sample_count ?? 0),
            quality: json(r.quality_json),
            rawAvailable: Number(r.raw_available ?? 0) === 1,
            missingReason: String(r.missing_reason ?? ''),
            capturedAt: String(r.captured_at ?? ''),
          }
        : null,
    }
  })

  // 覆盖率按过滤全集统计（不只当前页），报告 exact/run/time-window/unknown/raw_expired
  const coverageRow = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN i.context_source = 'exact' THEN 1 ELSE 0 END) AS exact_n,
            SUM(CASE WHEN i.context_source = 'run' THEN 1 ELSE 0 END) AS run_n,
            SUM(CASE WHEN i.context_source = 'time-window' THEN 1 ELSE 0 END) AS tw_n,
            SUM(CASE WHEN i.context_source = 'unknown' THEN 1 ELSE 0 END) AS unk_n,
            SUM(CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END) AS daq_n,
            SUM(CASE WHEN d.id IS NOT NULL AND d.raw_available = 0 THEN 1 ELSE 0 END) AS raw_expired_n,
            SUM(CASE WHEN d.id IS NULL THEN 1 ELSE 0 END) AS missing_raw_n
       FROM intervention_events i
       LEFT JOIN operation_daq_evidence d ON d.intervention_id = i.id
       ${whereSql}`,
  ).get(...args) as Record<string, unknown> | undefined
  const coverage: OperationCoverage = {
    total: Number(coverageRow?.total ?? 0),
    exact: Number(coverageRow?.exact_n ?? 0),
    run: Number(coverageRow?.run_n ?? 0),
    timeWindow: Number(coverageRow?.tw_n ?? 0),
    unknown: Number(coverageRow?.unk_n ?? 0),
    withDaq: Number(coverageRow?.daq_n ?? 0),
    rawExpired: Number(coverageRow?.raw_expired_n ?? 0),
    missingRaw: Number(coverageRow?.missing_raw_n ?? 0),
  }

  // 拒绝/未发送/结果未知尝试（accepted 写已进干预台账；这些行只存在于写尝试账本）
  const attemptWhere: string[] = [`a.intervention_id = ''`, `a.state IN ('rejected','not_sent','unknown','prepared','dispatched')`]
  const attemptArgs: Array<string | number> = []
  const addAttempt = (sql: string, value: string): void => {
    attemptWhere.push(sql)
    attemptArgs.push(value)
  }
  if (filter.lineId) addAttempt('a.line_id = ?', filter.lineId)
  if (filter.productId) addAttempt('a.product_id = ?', filter.productId)
  if (filter.recipeId) addAttempt('a.recipe_id = ?', filter.recipeId)
  if (filter.recipeRevision) addAttempt('a.recipe_revision = ?', filter.recipeRevision)
  if (filter.runId) addAttempt('a.run_id = ?', filter.runId)
  if (filter.nodeId) addAttempt('a.node_id = ?', filter.nodeId)
  if (filter.fromIso) addAttempt('a.created_at >= ?', filter.fromIso)
  if (filter.toIso) addAttempt('a.created_at <= ?', filter.toIso)
  const attempts = db.prepare(
    `SELECT a.* FROM dcw_write_attempts a
      WHERE ${attemptWhere.join(' AND ')}
      ORDER BY a.created_at DESC LIMIT ?`,
  ).all(...attemptArgs, limit) as Array<Record<string, unknown>>

  return {
    items,
    attempts: attempts.map(a => ({
      id: String(a.id ?? ''),
      nodeId: String(a.node_id ?? ''),
      lineId: String(a.line_id ?? ''),
      approvalId: String(a.approval_id ?? ''),
      taskId: String(a.task_id ?? ''),
      state: String(a.state ?? ''),
      detail: String(a.detail ?? ''),
      payload: json(a.payload_json),
      productId: String(a.product_id ?? ''),
      recipeId: String(a.recipe_id ?? ''),
      recipeRevision: String(a.recipe_revision ?? ''),
      runId: String(a.run_id ?? ''),
      channelId: String(a.channel_id ?? ''),
      agentId: String(a.agent_id ?? ''),
      sessionId: String(a.session_id ?? ''),
      interventionId: String(a.intervention_id ?? ''),
      createdAt: String(a.created_at ?? ''),
      updatedAt: String(a.updated_at ?? ''),
    })),
    coverage,
    nextCursor: rows.length > limit
      ? { ts: String(pageRows[pageRows.length - 1]?.ts ?? ''), id: String(pageRows[pageRows.length - 1]?.id ?? '') }
      : null,
  }
}

/** Agent 面文本视图：设定 + 上下文 + DAQ 前后值 + 判定（只读） */
export function operationProvenanceLines(page: OperationProvenancePage): string[] {
  const lines: string[] = []
  for (const item of page.items) {
    const ctx = [
      item.productId ? `产品=${item.productId}` : '产品=?',
      item.recipeId ? `配方=${item.recipeId}${item.recipeRevision ? `@v${item.recipeRevision}` : ''}` : '',
      item.recipeRunId ? `run=${item.recipeRunId}` : '',
      `上下文=${item.contextSource}`,
    ].filter(Boolean).join(' ')
    const daq = item.daq
      ? `DAQ(${item.daq.joinQuality}) 前均值=${fmt(item.daq.pre.mean)} 后均值=${fmt(item.daq.post.mean)} n=${item.daq.sampleCount}${item.daq.rawAvailable ? '' : `[raw已过期${item.daq.missingReason ? `:${item.daq.missingReason}` : ''}]`}`
      : 'DAQ=未采集'
    const effect = item.effect != null
      ? ` effect=${item.effect.toPrecision(4)}${item.ciLow != null && item.ciHigh != null ? ` CI[${item.ciLow.toPrecision(3)},${item.ciHigh.toPrecision(3)}]` : ''}`
      : ''
    lines.push(`${item.ts} ${item.nodeName || item.nodeId} ${fmt(item.fromValue)}→${fmt(item.toValue)} [${item.path}] ${ctx} ${daq} 判定=${item.verdict}${effect}${item.approvalId ? ` 审批=${item.approvalId}` : ''}${item.attemptId ? ` attempt=${item.attemptId}` : ''}`)
  }
  if (lines.length === 0) lines.push('没有匹配的操作记录（按当前过滤条件）。')
  const a = page.attempts
  if (a.length > 0) {
    lines.push(`另有 ${a.length} 条未受理/结果未知尝试（保留“想写什么值”）：`)
    for (const t of a.slice(0, 10)) {
      const wanted = typeof t.payload.eng === 'number' ? t.payload.eng : t.payload.eng
      lines.push(`  ${t.createdAt} ${t.nodeId} want=${wanted ?? '?'} ${t.state}${t.productId ? ` 产品=${t.productId}` : ''}${t.runId ? ` run=${t.runId}` : ''}`)
    }
  }
  const c = page.coverage
  lines.push(`覆盖率：总 ${c.total}｜exact ${c.exact}｜run ${c.run}｜time-window ${c.timeWindow}｜unknown ${c.unknown}｜有快照 ${c.withDaq}｜raw过期 ${c.rawExpired}`)
  return lines
}

function fmt(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(6)).toString() : '?'
}
