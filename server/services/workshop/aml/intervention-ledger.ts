/**
 * 干预台账服务(科学探索计划 P2,docs/plans/2026-11-02-scientific-exploration-plan.md):
 * 每一次治理下发(manual/agent/recipe/rollback)在 dcw write() 唯一咽喉单点入册一行
 * —— 意图值/实写值/回读证实/路径/依据,外加机器可读判据与可辨识性 verdict 回填。
 * "从经验学习"的事实源:Agent 复盘读结构化台账,而不是 45s 单点差分。
 *
 * 纪律:
 *  - 只记**已受理**下发;拒绝路径沿 recordOps 审计(write.ts reject()),不入本表;
 *  - 台账失败绝不改变写结果语义(调用方 try/catch 吞掉,与 write-audit 同纪律);
 *  - verdict 语义:'pending'=判读窗未满/待回填;'unassessed'=无判读上下文(manual/recipe 等);
 *    其余四态来自 aml/identifiability 引擎(identifiable_effect / no_resolvable_effect /
 *    underpowered / confounded)。
 */
import { createId } from './twin/contracts'
import { getAmlRuntime } from './runtime'
import type { IdentifiabilityVerdict } from './identifiability'

/** 机器可读判据(随干预落库;不是散文) */
export interface InterventionCriterion {
  metric?: string
  op?: string
  threshold?: number
  /** 关心的效应量(判据 MDE):分辨率罩不住它 → underpowered */
  mde?: number
}

/** 台账判定态(DB 里是 TEXT;读取时收敛到该联合类型) */
export type InterventionVerdict = 'pending'
  | 'unassessed'
  | 'identifiable_effect'
  | 'no_resolvable_effect'
  | 'underpowered'
  | 'confounded'

export interface InterventionRecordInput {
  nodeId: string
  nodeName?: string
  lineId?: string
  fromValue: number | null
  toValue: number
  /** 回读证实值(readback-verified 时;否则 null) */
  actualValue: number | null
  /** readback-verified | transport-ack | unverified */
  ack?: string
  /** manual | agent | recipe | rollback */
  path: string
  actor?: string
  actorName?: string
  channelId?: string
  approvalId?: string | null
  recipeRunId?: string | null
  hypothesis?: string
  /** 判读目标节点(exploration 等带判读上下文的路径写入;写入者判 verdict 回填) */
  targetNodeId?: string | null
  criterion?: InterventionCriterion | null
  /** 判读窗长(ms);settle 后由调用方或回填判定 */
  settleMs?: number | null
}

export interface InterventionEventRow {
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
  criterion: InterventionCriterion | null
  settleMs: number | null
  verdict: InterventionVerdict
  effect: number | null
  ciLow: number | null
  ciHigh: number | null
  mde: number | null
  /** 引擎判定摘要(suggestedWindowMs/postCoveragePeriods/reasons 等,回填时写入) */
  verdictDetail: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

function mapRow(r: Record<string, unknown>): InterventionEventRow {
  const parse = (s: unknown): unknown => {
    if (typeof s !== 'string' || !s) return null
    try {
      return JSON.parse(s)
    }
    catch {
      return null
    }
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
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
    criterion: (parse(r.criterion_json) as InterventionCriterion | null) ?? null,
    settleMs: num(r.settle_ms),
    verdict: String(r.verdict ?? 'pending') as InterventionVerdict,
    effect: num(r.effect),
    ciLow: num(r.ci_low),
    ciHigh: num(r.ci_high),
    mde: num(r.mde),
    verdictDetail: (parse(r.verdict_json) as Record<string, unknown> | null) ?? null,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }
}

/** 写入一行(失败返回 null 并打日志,绝不抛出 —— 调用方在写咽喉内) */
export function recordIntervention(input: InterventionRecordInput): string | null {
  try {
    const id = createId('intv')
    const now = new Date().toISOString()
    const verdict = input.targetNodeId ? 'pending' : 'unassessed'
    getAmlRuntime().db.prepare(`INSERT INTO intervention_events(id,ts,line_id,node_id,node_name,from_value,to_value,actual_value,ack,path,actor,actor_name,channel_id,approval_id,recipe_run_id,hypothesis,target_node_id,criterion_json,settle_ms,verdict,verdict_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id, now, input.lineId ?? '', input.nodeId, input.nodeName ?? '', input.fromValue, input.toValue,
        input.actualValue, input.ack ?? '', input.path, input.actor ?? '', input.actorName ?? '',
        input.channelId ?? '', input.approvalId ?? null, input.recipeRunId ?? null, input.hypothesis ?? '',
        input.targetNodeId ?? null, input.criterion ? JSON.stringify(input.criterion) : null,
        input.settleMs ?? null, verdict, null, now, now,
      )
    return id
  }
  catch (err) {
    console.error('[intervention-ledger] 台账写入失败(不影响写结果):', err instanceof Error ? err.message : err)
    return null
  }
}

/** verdict 回填后的反射钩子(RSI WP-A2;manager 装配;null = 不反射) */
let assessmentReflectHook: ((eventId: string) => void) | null = null

/** 注册/注销 verdict 反射钩子(幂等;传 null 注销) */
export function registerInterventionAssessmentHook(fn: ((eventId: string) => void) | null): void {
  assessmentReflectHook = fn
}

/** 回填可辨识性判定(exploration 判读或回填任务调用) */
export function attachAssessment(
  id: string,
  assessment: {
    verdict: Exclude<InterventionVerdict, 'pending'>
    effect?: number | null
    ciLow?: number | null
    ciHigh?: number | null
    mde?: number | null
    targetNodeId?: string | null
    detail?: Record<string, unknown> | null
  },
): boolean {
  try {
    getAmlRuntime().db.prepare(`UPDATE intervention_events SET verdict=?, effect=?, ci_low=?, ci_high=?, mde=?, target_node_id=COALESCE(?, target_node_id), verdict_json=?, updated_at=? WHERE id=?`)
      .run(
        assessment.verdict,
        assessment.effect ?? null, assessment.ciLow ?? null, assessment.ciHigh ?? null, assessment.mde ?? null,
        assessment.targetNodeId ?? null,
        assessment.detail ? JSON.stringify(assessment.detail) : null,
        new Date().toISOString(), id,
      )
    // RSI 经验反射(WP-A2):verdict 落地即触发经验蒸馏(钩子由 manager 装配;
    // 未注册时(单测/独立脚本)静默跳过 —— 学习环永不阻断台账写入)
    try {
      assessmentReflectHook?.(id)
    }
    catch { /* 学习环故障不影响判定回填 */ }
    return true
  }
  catch (err) {
    console.error('[intervention-ledger] verdict 回填失败:', err instanceof Error ? err.message : err)
    return false
  }
}

/** 引擎 verdict → 台账 verdict 映射(INSUFFICIENT_DATA 归 unassessed,如实"未判") */
export function verdictCodeOf(engine: IdentifiabilityVerdict): Exclude<InterventionVerdict, 'pending'> {
  switch (engine.verdict) {
    case 'IDENTIFIABLE':
      return engine.significant ? 'identifiable_effect' : 'no_resolvable_effect'
    case 'UNDERPOWERED':
      return 'underpowered'
    case 'CONFOUNDED':
      return 'confounded'
    default:
      return 'unassessed'
  }
}

/** 引擎判定 → 台账 verdict_json 摘要(供前置门与工具读) */
export function verdictDetailOf(engine: IdentifiabilityVerdict): Record<string, unknown> {
  return {
    engineVerdict: engine.verdict,
    dominantPeriodMs: engine.dominantPeriodMs,
    postCoveragePeriods: engine.postCoveragePeriods,
    suggestedWindowMs: engine.suggestedWindowMs,
    suggestedLevels: engine.suggestedLevels,
    collinearity: engine.collinearity,
    controlLevels: engine.controlLevels,
    reasons: engine.reasons,
  }
}

export function listInterventions(filter: { nodeId?: string, lineId?: string, limit?: number } = {}): InterventionEventRow[] {
  try {
    const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 20)))
    const where: string[] = []
    const args: Array<string | number> = []
    if (filter.nodeId) {
      where.push('node_id = ?')
      args.push(filter.nodeId)
    }
    if (filter.lineId) {
      where.push('line_id = ?')
      args.push(filter.lineId)
    }
    const sql = `SELECT * FROM intervention_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ?`
    const rows = getAmlRuntime().db.prepare(sql).all(...args, limit) as Array<Record<string, unknown>>
    return rows.map(mapRow)
  }
  catch {
    return []
  }
}

export function latestIntervention(nodeId: string): InterventionEventRow | null {
  return listInterventions({ nodeId, limit: 1 })[0] ?? null
}

/**
 * 前置门数据源:同节点上次干预是否未收口(verdict=pending 且判读窗未满)。
 * 收口前再发新干预 = 两次干预的响应叠加,判读必然失真 → 应拦。
 */
export function pendingUnclosedEvent(nodeId: string): { row: InterventionEventRow, remainMs: number } | null {
  const last = latestIntervention(nodeId)
  if (!last || last.verdict !== 'pending') return null
  const settle = last.settleMs ?? 45_000
  const elapsed = Date.now() - Date.parse(last.ts)
  if (!Number.isFinite(elapsed)) return null
  if (elapsed >= settle) return null
  return { row: last, remainMs: settle - elapsed }
}

/**
 * 前置门数据源:同节点最近一次 underpowered/confounded 判定的"建议窗"是否尚未过期。
 * 过期前发新干预会重复同一欠功效探索 —— 拦下并给出正交化建议。
 */
export function recentBlockedVerdictEvent(nodeId: string): { row: InterventionEventRow, suggestedWindowMs: number } | null {
  const last = latestIntervention(nodeId)
  if (!last || (last.verdict !== 'underpowered' && last.verdict !== 'confounded')) return null
  const suggested = Number(last.verdictDetail?.suggestedWindowMs)
  const windowMs = Number.isFinite(suggested) && suggested > 0 ? suggested : (last.settleMs ?? 45_000) * 3
  const elapsed = Date.now() - Date.parse(last.ts)
  if (!Number.isFinite(elapsed) || elapsed >= windowMs) return null
  return { row: last, suggestedWindowMs: windowMs }
}

const VERDICT_LABEL: Record<string, string> = {
  pending: '判读待回填',
  unassessed: '未判定(无判读上下文)',
  identifiable_effect: '效应可分辨',
  no_resolvable_effect: '无可分辨效应(负结论)',
  underpowered: '欠功效(不可辨识)',
  confounded: '被混杂(不可辨识)',
}

export function verdictLabel(verdict: string): string {
  return VERDICT_LABEL[verdict] ?? verdict
}

/** 面向 Agent/提示词的台账摘要行(结构化证据,替代单点差分叙事) */
export function interventionLines(rows: InterventionEventRow[]): string[] {
  return rows.map((r) => {
    const delta = r.toValue != null && r.fromValue != null ? (r.toValue - r.fromValue) : null
    const effect = r.effect != null ? `效应=${r.effect.toPrecision(4)}` : ''
    const ci = r.ciLow != null && r.ciHigh != null ? ` CI[${r.ciLow.toPrecision(3)}, ${r.ciHigh.toPrecision(3)}]` : ''
    const mde = r.mde != null ? ` MDE=${r.mde.toPrecision(3)}` : ''
    return `${r.ts} ${r.nodeName || r.nodeId} ${r.fromValue ?? '?'}→${r.toValue}${delta != null ? `(Δ${delta > 0 ? '+' : ''}${Number(delta.toFixed(6))})` : ''} [${r.path}] 判定:${verdictLabel(r.verdict)}${effect}${ci}${mde}${r.ack && r.ack !== 'readback-verified' ? ` 回读:${r.ack}` : ''}`
  })
}

/** P5 增益估计口径(2026-11-03):只信可辨识步 */
export interface LedgerGainEstimate {
  /** identifiable_effect 步的 effect/Δlevel 中位数;无可辨识步时 null */
  estimatedGain: number | null
  /** 参与估计的可辨识步数 */
  gainSamples: number
  /** 因欠功效/混杂/负结论被排除的步数(诚实分母) */
  gainExcludedSteps: number
}

/**
 * 从台账行估计动作增益(P5,2026-11-03):
 * 只用 verdict=identifiable_effect 且 effect/from/to 齐备的行 —— underpowered/confounded
 * 步的效应量不可归因,混入估计会把增益拉偏(FL-7 实测:全步中位数 3.98 vs 仅可辨识 4.73,
 * 真值 6.0)。方向语义:Δlevel≈0 的行(同值重写)不参与;增益取中位数抗单步离群。
 */
export function estimateGainFromRows(
  rows: Array<Pick<InterventionEventRow, 'verdict' | 'effect' | 'fromValue' | 'toValue'>>,
): LedgerGainEstimate {
  const gains = rows
    .filter(r => r.verdict === 'identifiable_effect'
      && r.effect != null && r.fromValue != null && r.toValue != null
      && Math.abs(Number(r.toValue) - Number(r.fromValue)) > 1e-9)
    .map(r => Number(r.effect) / (Number(r.toValue) - Number(r.fromValue)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  return {
    estimatedGain: gains.length > 0 ? gains[Math.floor(gains.length / 2)]! : null,
    gainSamples: gains.length,
    gainExcludedSteps: rows.length - gains.length,
  }
}
