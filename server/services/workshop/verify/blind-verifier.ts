/**
 * 独立回读验证器（WP-C1，双盲验证的「独立读」内核）—— 反 False-Done。
 *
 * 为什么需要：write 类任务的「验证」历史上是同会话提示词纪律（Agent 自己 daq_query 复测），
 * Agent 可以自报达标。本模块用**设备侧独立回读**重新判一次：
 *   - 期望值 = 写入台账的 to_value（下发意图）；
 *   - 实际值 = 设备当前值（dcw 节点实时值 = 回读物理值，非指令值）；
 *   - 容差 = 台账 actual_value 与 to_value 的偏差（写入时的回读噪声），或缺省容差。
 *
 * 判定：全部命中 → match；任一超差 → mismatch；**证据不足 → inconclusive**。
 * 纪律：inconclusive **不等于 pass**（L1/门必须按"未证实"处理）。
 *
 * 说明（如实）：本版是「独立回读」而非「fresh-session 探针频道」——后者需要运行时
 * spawn 一个 observe 模式实例，属后续工作；独立回读已能覆盖"Agent 自报 vs 设备事实"的核心断点。
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { getDcwController } from '../dcw/dcw-controller'

export type BlindVerdict = 'match' | 'mismatch' | 'inconclusive'

export interface BlindProbeResult {
  /** 节点 → 期望/实际/容差 */
  values: Array<{ nodeId: string, nodeName: string, expected: number, actual: number, tol: number, ok: boolean }>
  /** 探针自身说明（缺数据原因等） */
  detail: string
}

/** 可注入探针（测试用；生产缺省 readbackProbe） */
export type BlindProbe = (event: {
  eventId: string
  nodeId: string
  nodeName: string
  toValue: number | null
  actualValue: number | null
}) => BlindProbeResult

/** 生产探针：读 dcw 控制器节点实时值（= 回读物理值） */
export function readbackProbe(event: { nodeId: string, nodeName: string, toValue: number | null, actualValue: number | null }): BlindProbeResult {
  const expected = event.toValue
  if (typeof expected !== 'number' || !Number.isFinite(expected)) {
    return { values: [], detail: '台账缺 to_value，无法独立判读' }
  }
  let node: {
    readValue?: number | null
    lastReadAt?: string | null
    readIntervalMs?: number | null
  } | undefined
  try {
    node = getDcwController().byId(event.nodeId)
  }
  catch {
    node = undefined
  }
  if (!node) {
    return { values: [], detail: `节点 ${event.nodeId} 无实时值（未绑定/未运行）` }
  }
  const interval = Number(node.readIntervalMs ?? 5_000)
  const maxAgeMs = Math.max(30_000, (Number.isFinite(interval) && interval > 0 ? interval : 5_000) * 3)
  const picked = selectIndependentReadback(node, Date.now(), maxAgeMs)
  if ('reason' in picked) {
    return { values: [], detail: `节点 ${event.nodeId} ${picked.reason}` }
  }
  const actual = picked.value
  // 容差：写入时回读与指令的偏差（至少 0.5% 量级，防浮点噪声），缺省 0.01
  const writeGap = typeof event.actualValue === 'number' && Number.isFinite(event.actualValue)
    ? Math.abs(event.actualValue - expected)
    : 0
  const tol = Math.max(0.01, Math.abs(expected) * 0.005, writeGap)
  return {
    values: [{ nodeId: event.nodeId, nodeName: event.nodeName, expected, actual, tol, ok: Math.abs(actual - expected) <= tol }],
    detail: `独立回读 ${actual} vs 指令 ${expected}（容差 ${tol.toFixed(3)}）`,
  }
}

/**
 * 选取**独立**回读值：readValue 来自周期读/按需 readNow（设备侧），不是 write() 的
 * ACK 回执（node.value 在驱动缺回读时等于指令值，用它验证等于自己证明自己）。
 * 读数必须带时间戳且未过期；缺读数/过期 → 证据不足（inconclusive），不得判 match。
 */
export function selectIndependentReadback(
  node: { readValue?: number | null, lastReadAt?: string | null },
  now: number,
  maxAgeMs: number,
): { value: number } | { reason: string } {
  const actual = node.readValue
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    return { reason: '无独立设备读数（写回执不是独立回读）' }
  }
  const at = node.lastReadAt ? Date.parse(node.lastReadAt) : Number.NaN
  if (!Number.isFinite(at)) {
    return { reason: '独立读数缺少时间戳，无法判断新鲜度' }
  }
  const age = now - at
  if (age > maxAgeMs) {
    return { reason: `独立读数已过期（${Math.round(age / 1000)}s > ${Math.round(maxAgeMs / 1000)}s）` }
  }
  return { value: actual }
}

export interface BlindVerificationResult {
  eventId: string
  verdict: BlindVerdict
  detail: string
  probe: BlindProbeResult
}

function verdictOf(probe: BlindProbeResult): BlindVerdict {
  if (probe.values.length === 0) return 'inconclusive'
  return probe.values.every(v => v.ok) ? 'match' : 'mismatch'
}

/** 对一条干预台账做独立验证（幂等：同 event 只落一行；重复调用返回既有判定） */
export function verifyInterventionEvent(
  db: DatabaseSync,
  eventId: string,
  probe: BlindProbe = readbackProbe,
  taskId = '',
): BlindVerificationResult | null {
  const event = db.prepare(
    `SELECT id, channel_id AS channelId, line_id AS lineId, node_id AS nodeId, node_name AS nodeName,
            to_value AS toValue, actual_value AS actualValue, recipe_run_id AS recipeRunId
       FROM intervention_events WHERE id = ?`,
  ).get(eventId) as {
    id: string
    channelId: string
    lineId: string
    nodeId: string
    nodeName: string
    toValue: number | null
    actualValue: number | null
    recipeRunId: string | null
  } | undefined
  if (!event) return null

  const existing = db.prepare(
    `SELECT verdict, detail, task_id AS taskId FROM blind_verifications WHERE event_id = ?`,
  ).get(eventId) as { verdict: BlindVerdict, detail: string, taskId: string } | undefined
  if (existing) {
    // 补归属：定时器先验、任务终态后到（不覆盖已有归属）
    if (taskId && !existing.taskId) {
      try {
        db.prepare('UPDATE blind_verifications SET task_id = ? WHERE event_id = ?').run(taskId, eventId)
      }
      catch { /* 旧库缺列：跳过归属 */ }
    }
    return { eventId, verdict: existing.verdict, detail: `${existing.detail}（既有判定，幂等）`, probe: { values: [], detail: existing.detail } }
  }

  const result = probe({
    eventId,
    nodeId: event.nodeId,
    nodeName: event.nodeName,
    toValue: event.toValue,
    actualValue: event.actualValue,
  })
  const verdict = verdictOf(result)
  try {
    db.prepare(
      `INSERT INTO blind_verifications (id, event_id, channel_id, line_id, task_id, verdict, detail, probe_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `bv-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      eventId, event.channelId, event.lineId, taskId, verdict, result.detail,
      JSON.stringify({ values: result.values, recipeRunId: event.recipeRunId }),
      new Date().toISOString(),
    )
  }
  catch { /* 唯一约束竞态：另一路已落库，本次按只读返回 */ }
  return { eventId, verdict, detail: result.detail, probe: result }
}

/**
 * 批量验证本频道的待验证干预（写入台账最近 N 条，尚未验证的）。
 * 返回按判定分组的计数；失败单条不阻断整批。
 * `taskId + sinceIso`：把本次周期内**已由定时器验证但未归属**的行补归属到该任务
 * （定时器可能先于任务终态运行；补归属只影响 L1/C4 取数，不改判定）。
 */
export function verifyPendingInterventions(
  db: DatabaseSync,
  channelId: string,
  opts: { limit?: number, probe?: BlindProbe, taskId?: string, sinceIso?: string } = {},
): { match: number, mismatch: number, inconclusive: number, total: number } {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  if (opts.taskId && opts.sinceIso) {
    try {
      db.prepare(
        `UPDATE blind_verifications SET task_id = ?
          WHERE channel_id = ? AND task_id = '' AND created_at >= ?`,
      ).run(opts.taskId, channelId, opts.sinceIso)
    }
    catch { /* 旧库缺列：跳过归属 */ }
  }
  const rows = db.prepare(
    `SELECT e.id FROM intervention_events e
      WHERE e.channel_id = ?
        AND NOT EXISTS (SELECT 1 FROM blind_verifications b WHERE b.event_id = e.id)
      ORDER BY e.ts DESC LIMIT ?`,
  ).all(channelId, limit) as Array<{ id: string }>
  const counts = { match: 0, mismatch: 0, inconclusive: 0, total: 0 }
  for (const r of rows) {
    try {
      const res = verifyInterventionEvent(db, r.id, opts.probe ?? readbackProbe, opts.taskId ?? '')
      if (!res) continue
      counts[res.verdict] += 1
      counts.total += 1
    }
    catch { /* 单条失败不阻断 */ }
  }
  return counts
}

/**
 * 全库补扫（维护定时器调用）：对仍有未验证写入台账的频道逐个验证。
 * 上限保护（频道数 × 每频道条数），单频道失败不阻断其他频道。
 */
export function verifyAllPending(db: DatabaseSync, opts: { perChannel?: number, probe?: BlindProbe } = {}): { match: number, mismatch: number, inconclusive: number, total: number } {
  const total = { match: 0, mismatch: 0, inconclusive: 0, total: 0 }
  let channels: Array<{ channelId: string }>
  try {
    channels = db.prepare(
      `SELECT DISTINCT e.channel_id AS channelId FROM intervention_events e
        WHERE e.channel_id != ''
          AND NOT EXISTS (SELECT 1 FROM blind_verifications b WHERE b.event_id = e.id)
        LIMIT 50`,
    ).all() as Array<{ channelId: string }>
  }
  catch {
    return total
  }
  for (const c of channels) {
    try {
      const r = verifyPendingInterventions(db, c.channelId, { limit: opts.perChannel ?? 20, probe: opts.probe })
      total.match += r.match
      total.mismatch += r.mismatch
      total.inconclusive += r.inconclusive
      total.total += r.total
    }
    catch { /* 单频道失败不阻断 */ }
  }
  return total
}

/** 频道验证看板（REST 只读） */
export function listBlindVerifications(db: DatabaseSync, channelId: string, limit = 50): Array<{
  eventId: string
  verdict: BlindVerdict
  detail: string
  createdAt: string
}> {
  try {
    return db.prepare(
      `SELECT event_id AS eventId, verdict, detail, created_at AS createdAt
         FROM blind_verifications WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(channelId, Math.min(Math.max(limit, 1), 200)) as Array<{ eventId: string, verdict: BlindVerdict, detail: string, createdAt: string }>
  }
  catch {
    return []
  }
}

/** L1 复核用的单条判定（无验证记录 → null，不虚构通过） */
export interface BlindTaskCheck {
  criterion: 'blind.readback'
  pass: boolean
  detail: string
}

/**
 * 按任务取独立回读判定（WP-C1 → L1 接线）。
 * - 无记录 → null（该任务没有设备写，不产生 check）；
 * - 全部 match → pass；
 * - 任一 mismatch / inconclusive → fail（**inconclusive ≠ pass**，fail-closed）。
 */
export function blindCheckForTask(db: DatabaseSync, taskId: string): BlindTaskCheck | null {
  if (!taskId) return null
  let rows: Array<{ verdict: BlindVerdict, detail: string }>
  try {
    rows = db.prepare(
      `SELECT verdict, detail FROM blind_verifications WHERE task_id = ? ORDER BY created_at ASC`,
    ).all(taskId) as Array<{ verdict: BlindVerdict, detail: string }>
  }
  catch {
    return null
  }
  if (rows.length === 0) return null
  const bad = rows.filter(r => r.verdict !== 'match')
  if (bad.length === 0) {
    return { criterion: 'blind.readback', pass: true, detail: `${rows.length} 条独立回读全部 match` }
  }
  return {
    criterion: 'blind.readback',
    pass: false,
    detail: `${bad.length}/${rows.length} 条未证实：${bad.map(r => `${r.verdict}（${r.detail}）`).join('；')}`,
  }
}

/**
 * 按任务取独立回读指标（WP-C4 判据取数）：节点 id/名称 → 设备实时值。
 * 只暴露 probe_json 里的独立回读值，不接收 Agent 自述；无记录返回空对象。
 */
export function blindMetricsForTask(db: DatabaseSync, taskId: string): Record<string, number> {
  if (!taskId) return {}
  let rows: Array<{ probeJson: string }>
  try {
    rows = db.prepare(
      `SELECT probe_json AS probeJson FROM blind_verifications WHERE task_id = ? ORDER BY created_at DESC`,
    ).all(taskId) as Array<{ probeJson: string }>
  }
  catch {
    return {}
  }
  const metrics: Record<string, number> = {}
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.probeJson || '{}') as { values?: Array<{ nodeId?: string, nodeName?: string, actual?: number }> }
      for (const v of parsed.values ?? []) {
        if (typeof v.actual !== 'number' || !Number.isFinite(v.actual)) continue
        if (v.nodeId) metrics[v.nodeId] ??= v.actual
        if (v.nodeName) metrics[v.nodeName] ??= v.actual
      }
    }
    catch { /* 单行损坏不阻断 */ }
  }
  return metrics
}
