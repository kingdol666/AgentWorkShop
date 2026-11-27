/**
 * 参数经验主张（批次 M，2026-11-26）。
 *
 * 把一次干预判定固化成**可查询的结构化主张**，并回指事实链：
 *   intervention_id（操作/审批/值） + daq_evidence_id（前后数采） + run/task/session。
 *
 * 纪律：
 *  - 只读投影，不写配方/设备；
 *  - 证据追加必须继承 head 的 lifecycle/deployment（appendEvidenceVersion）；
 *  - 历史空 claim 标 legacy-unverified，不参与提议；
 *  - verdict=underpowered/confounded 不计 support/refute；no_resolvable_effect 记 refute。
 */
import type { DatabaseSync } from 'node:sqlite'
import { appendEvidenceVersion } from './versions'
import type { EvidenceRef, ParameterClaim } from './types'
import type { InterventionFact } from '../runtime/memory/reflector'

export interface ParameterClaimInput {
  memoryId: string
  fact: InterventionFact
}

interface MemoryLite {
  id: string
  channel_id: string
  agent_id: string
  title: string
  content: string
  scope_kind: string
  scope_key: string
  task_id: string | null
  session_id: string
}

function directionOf(from: number | null | undefined, to: number | null | undefined): ParameterClaim['direction'] {
  if (from == null || to == null) return 'stable'
  if (to > from) return 'increase'
  if (to < from) return 'decrease'
  return 'stable'
}

function targetDirectionOf(criterion: Record<string, unknown> | null | undefined): ParameterClaim['targetDirection'] {
  const op = typeof criterion?.op === 'string' ? criterion.op : ''
  if (op === '>' || op === '>=') return 'increase'
  if (op === '<' || op === '<=') return 'decrease'
  return 'unknown'
}

function polarityOf(verdict: InterventionFact['verdict']): 'support' | 'refute' {
  if (verdict === 'no_resolvable_effect') return 'refute'
  return 'support'
}

/**
 * 写入结构化主张 + 不可变经验版本 + 证据锚点。
 * 幂等：同一 (eventId, memoryId) 重复调用只更新同一行；版本层按 idempotencyKey replay 返回原版本。
 */
export function recordParameterClaim(db: DatabaseSync, input: ParameterClaimInput): { claimId: string, versionId: string } | null {
  const fact = input.fact
  const memory = db.prepare(
    `SELECT id, channel_id, agent_id, title, content, scope_kind, scope_key, task_id, session_id
       FROM agent_memories WHERE id = ? AND kind = 'experience' AND deleted_at IS NULL`,
  ).get(input.memoryId) as MemoryLite | undefined
  if (!memory) return null

  const evidenceRow = db.prepare(
    'SELECT id FROM operation_daq_evidence WHERE intervention_id = ? LIMIT 1',
  ).get(fact.eventId) as { id?: string } | undefined

  const verdict = fact.verdict
  const claimStatus: ParameterClaim['claimStatus'] = verdict === 'unassessed'
    ? 'unverified'
    : 'structured'
  const scopeKind: ParameterClaim['domain'] = 'parameter'
  const lineId = fact.lineId ?? ''
  const productId = fact.productId ?? ''
  const scope = memory.scope_kind === 'product'
    ? { kind: 'product' as const, key: memory.scope_key }
    : memory.scope_kind === 'line'
      ? { kind: 'line' as const, key: memory.scope_key }
      : { kind: 'channel' as const, key: '' }

  const claim: ParameterClaim = {
    domain: scopeKind,
    productId,
    recipeRevision: fact.recipeRevision ?? '',
    variable: fact.nodeName || fact.nodeId || '',
    unit: fact.unit ?? '',
    direction: directionOf(fact.fromValue, fact.toValue),
    condition: fact.hypothesis ?? '',
    polarity: polarityOf(verdict),
    lineId,
    nodeId: fact.nodeId ?? '',
    nodeName: fact.nodeName ?? '',
    recipeId: fact.recipeId ?? '',
    fromValue: fact.fromValue ?? null,
    toValue: fact.toValue ?? 0,
    targetMetric: typeof fact.criterion?.metric === 'string' ? fact.criterion.metric : '',
    targetDirection: targetDirectionOf(fact.criterion),
    targetNodeId: fact.targetNodeId ?? '',
    interventionId: fact.eventId,
    daqEvidenceId: evidenceRow?.id ?? '',
    runId: fact.recipeRunId ?? '',
    taskId: fact.taskId ?? '',
    effect: fact.effect ?? null,
    ciLow: fact.ciLow ?? null,
    ciHigh: fact.ciHigh ?? null,
    mde: fact.mde ?? null,
    verdict,
    environment: process.env.AW_BENCH_MODE === '1' ? 'simulation' : 'production',
    observedAt: new Date().toISOString(),
    claimStatus,
  }

  const polarity: EvidenceRef['polarity'] = verdict === 'no_resolvable_effect'
    ? 'refute'
    : (verdict === 'underpowered' || verdict === 'confounded' || verdict === 'unassessed')
        ? 'unknown'
        : 'support'
  const evidence: EvidenceRef = {
    id: `intv:${fact.eventId}`,
    sourceKind: 'task',
    environment: claim.environment,
    observedAt: claim.observedAt,
    // 同一次整批下发共享一个独立单元，避免把 run 内多节点拆成多条独立证据
    supportUnitId: fact.recipeRunId ? `run:${fact.recipeRunId}` : `event:${fact.eventId}`,
    ...(fact.taskId ? { taskId: fact.taskId } : {}),
    ...(fact.recipeRunId ? { runId: fact.recipeRunId } : {}),
    polarity,
  }

  let versionId = ''
  try {
    const version = appendEvidenceVersion(db, {
      experienceId: memory.id,
      scope,
      claim,
      content: memory.content,
      observedAt: claim.observedAt,
      evidence: [evidence],
      idempotencyKey: `param-claim:${fact.eventId}`,
    })
    versionId = version.versionId
  }
  catch (err) {
    // 版本层失败不丢主张：仍落 claim（version_id 空），但 claim_status 降为 unverified
    if (claim.claimStatus === 'structured') claim.claimStatus = 'unverified'
    void err
  }

  const claimId = `pcl-${fact.eventId}`
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO experience_claims
      (claim_id, memory_id, version_id, event_id, source_kind, domain, line_id, product_id, node_id, node_name,
       variable, unit, recipe_id, recipe_revision, from_value, to_value, direction, target_node_id, target_metric,
       target_direction, effect, ci_low, ci_high, mde, verdict, polarity, environment, observed_at, claim_status,
       intervention_id, daq_evidence_id, run_id, task_id, valid_from, valid_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'intervention', 'parameter', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(event_id, memory_id) DO UPDATE SET
       version_id = excluded.version_id, memory_id = excluded.memory_id, claim_status = excluded.claim_status,
       daq_evidence_id = excluded.daq_evidence_id, effect = excluded.effect, ci_low = excluded.ci_low,
       ci_high = excluded.ci_high, mde = excluded.mde, verdict = excluded.verdict, polarity = excluded.polarity,
       updated_at = excluded.updated_at`,
  ).run(
    claimId, memory.id, versionId, fact.eventId,
    lineId, productId, claim.nodeId, claim.nodeName,
    claim.variable, claim.unit, claim.recipeId, claim.recipeRevision,
    claim.fromValue, claim.toValue, claim.direction, claim.targetNodeId, claim.targetMetric,
    claim.targetDirection, claim.effect, claim.ciLow, claim.ciHigh, claim.mde,
    claim.verdict, claim.polarity, claim.environment, claim.observedAt, claim.claimStatus,
    claim.interventionId, claim.daqEvidenceId, claim.runId, claim.taskId,
    claim.observedAt, now, now,
  )
  return { claimId, versionId }
}

export interface ParameterExperienceFilter {
  lineId?: string
  productId?: string
  nodeId?: string
  variable?: string
  recipeRevision?: string
  verdict?: string
  /** true = 只返回 validated + deployed(active/canary) */
  deployedOnly?: boolean
  /** 默认排除 legacy-unverified */
  includeLegacy?: boolean
  limit?: number
  /**
   * 作用域白名单（2026-11-28 审核轮，fail-closed）：
   *  - 频道档主张（无 line/product 锚点）只允许来自 `scopeChannelIds` 里的频道；
   *  - 产线档按 `scopeLineIds` 跨频道共享（RLS 语义），产品档同理；
   *  - **三个都不给 = 编译成 (1=0)**：忘传不会退化成"查全库"。
   * 加这个字段的根因：`experience_claims` 没有 channel 列，之前只按主张级条件过滤，
   * 任意外部入口都能读到全库所有 owner 的经验正文（REST 端点只校验 URL 频道归属）。
   */
  scopeChannelIds?: string[]
  scopeLineIds?: string[]
  scopeProductIds?: string[]
}

export interface ParameterExperienceItem {
  claimId: string
  memoryId: string
  /** 主张所属记忆行的频道（作用域白名单与工具侧二次校验用） */
  channelId: string
  versionId: string
  title: string
  content: string
  lineId: string
  productId: string
  nodeId: string
  nodeName: string
  variable: string
  unit: string
  recipeId: string
  recipeRevision: string
  fromValue: number | null
  toValue: number
  direction: string
  targetMetric: string
  targetDirection: string
  effect: number | null
  ciLow: number | null
  ciHigh: number | null
  mde: number | null
  verdict: string
  polarity: string
  claimStatus: string
  memoryStatus: string
  lifecycle: string
  deployment: string
  interventionId: string
  daqEvidenceId: string
  runId: string
  observedAt: string
  daq: { preMean: number | null, postMean: number | null, sampleCount: number, rawAvailable: boolean, joinQuality: string } | null
}

export function queryParameterExperience(db: DatabaseSync, filter: ParameterExperienceFilter = {}): ParameterExperienceItem[] {
  const where: string[] = []
  const args: Array<string | number> = []
  const add = (sql: string, ...values: Array<string | number>): void => {
    where.push(sql)
    args.push(...values)
  }
  if (!filter.includeLegacy) where.push(`c.claim_status != 'legacy-unverified'`)
  if (filter.lineId) add('c.line_id = ?', filter.lineId)
  if (filter.productId) add('(c.product_id = ? OR c.product_id = \'\')', filter.productId)
  if (filter.nodeId) add('(c.node_id = ? OR c.target_node_id = ?)', filter.nodeId, filter.nodeId)
  if (filter.variable) add('(c.variable = ? OR c.node_name = ?)', filter.variable, filter.variable)
  if (filter.recipeRevision) add('(c.recipe_revision = ? OR c.recipe_revision = \'\')', filter.recipeRevision)
  if (filter.verdict) add('c.verdict = ?', filter.verdict)
  if (filter.deployedOnly) where.push(`m.status = 'validated' AND COALESCE(v.deployment, 'none') IN ('active','canary')`)
  // 作用域白名单（fail-closed）：三个维度都没给 → (1=0)，绝不退化成全库。
  // 必须在其它条件之后 append，args 顺序与 WHERE 文本顺序一一对应。
  {
    const chs = filter.scopeChannelIds ?? []
    const lns = filter.scopeLineIds ?? []
    const prs = filter.scopeProductIds ?? []
    const ors: string[] = []
    if (chs.length > 0) {
      ors.push(`(COALESCE(c.line_id, '') = '' AND COALESCE(c.product_id, '') = '' AND m.channel_id IN (${chs.map(() => '?').join(', ')}))`)
      args.push(...chs)
    }
    if (lns.length > 0) {
      ors.push(`(COALESCE(c.line_id, '') != '' AND c.line_id IN (${lns.map(() => '?').join(', ')}))`)
      args.push(...lns)
    }
    if (prs.length > 0) {
      ors.push(`(COALESCE(c.line_id, '') = '' AND COALESCE(c.product_id, '') != '' AND c.product_id IN (${prs.map(() => '?').join(', ')}))`)
      args.push(...prs)
    }
    where.push(ors.length > 0 ? `(${ors.join(' OR ')})` : '(1=0)')
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const rows = db.prepare(
    `SELECT c.*, m.title, m.content, m.channel_id AS channelId, m.status AS memory_status,
            v.lifecycle, v.deployment,
            d.pre_stats_json, d.post_stats_json, d.sample_count, d.raw_available, d.join_quality
       FROM experience_claims c
       JOIN agent_memories m ON m.id = c.memory_id AND m.deleted_at IS NULL
       LEFT JOIN experience_heads h ON h.experience_id = c.memory_id
       LEFT JOIN experience_versions v ON v.version_id = h.version_id
       LEFT JOIN operation_daq_evidence d ON d.intervention_id = c.intervention_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.observed_at DESC LIMIT ?`,
  ).all(...args, limit) as Array<Record<string, unknown>>
  return rows.map((r) => {
    const parse = (v: unknown): Record<string, unknown> => {
      if (typeof v !== 'string' || !v) return {}
      try {
        return JSON.parse(v) as Record<string, unknown>
      }
      catch {
        return {}
      }
    }
    const pre = parse(r.pre_stats_json)
    const post = parse(r.post_stats_json)
    return {
      claimId: String(r.claim_id ?? ''),
      memoryId: String(r.memory_id ?? ''),
      channelId: String(r.channelId ?? ''),
      versionId: String(r.version_id ?? ''),
      title: String(r.title ?? ''),
      content: String(r.content ?? ''),
      lineId: String(r.line_id ?? ''),
      productId: String(r.product_id ?? ''),
      nodeId: String(r.node_id ?? ''),
      nodeName: String(r.node_name ?? ''),
      variable: String(r.variable ?? ''),
      unit: String(r.unit ?? ''),
      recipeId: String(r.recipe_id ?? ''),
      recipeRevision: String(r.recipe_revision ?? ''),
      fromValue: typeof r.from_value === 'number' ? r.from_value : null,
      toValue: Number(r.to_value ?? 0),
      direction: String(r.direction ?? 'stable'),
      targetMetric: String(r.target_metric ?? ''),
      targetDirection: String(r.target_direction ?? 'unknown'),
      effect: typeof r.effect === 'number' ? r.effect : null,
      ciLow: typeof r.ci_low === 'number' ? r.ci_low : null,
      ciHigh: typeof r.ci_high === 'number' ? r.ci_high : null,
      mde: typeof r.mde === 'number' ? r.mde : null,
      verdict: String(r.verdict ?? 'unassessed'),
      polarity: String(r.polarity ?? 'support'),
      claimStatus: String(r.claim_status ?? 'structured'),
      memoryStatus: String(r.memory_status ?? ''),
      lifecycle: String(r.lifecycle ?? ''),
      deployment: String(r.deployment ?? 'none'),
      interventionId: String(r.intervention_id ?? ''),
      daqEvidenceId: String(r.daq_evidence_id ?? ''),
      runId: String(r.run_id ?? ''),
      observedAt: String(r.observed_at ?? ''),
      daq: r.intervention_id
        ? {
            preMean: typeof pre.mean === 'number' ? pre.mean : null,
            postMean: typeof post.mean === 'number' ? post.mean : null,
            sampleCount: Number(r.sample_count ?? 0),
            rawAvailable: Number(r.raw_available ?? 0) === 1,
            joinQuality: String(r.join_quality ?? 'none'),
          }
        : null,
    }
  })
}

/**
 * 参数手册（确定性模板；Curator 的领域模板）。
 * 只汇总结构化主张；candidate 单独列为「待验证线索」，不可注入。
 */
export function buildParameterHandbook(db: DatabaseSync, filter: ParameterExperienceFilter = {}): { markdown: string, claimCount: number, sourceCount: number } {
  const items = queryParameterExperience(db, { ...filter, limit: filter.limit ?? 200 })
  const structured = items.filter(i => i.claimStatus === 'structured')
  const byVar = new Map<string, ParameterExperienceItem[]>()
  for (const item of structured) {
    const key = `${item.nodeName || item.nodeId}/${item.variable || '参数'}`
    const list = byVar.get(key) ?? []
    list.push(item)
    byVar.set(key, list)
  }
  const lines: string[] = ['# 参数经验手册', '', `生成时间：${new Date().toISOString()}`, `主张 ${structured.length} 条 / 来源 ${new Set(structured.map(i => i.interventionId)).size} 个`, '']
  lines.push('## 1. 当前推荐')
  if (byVar.size === 0) lines.push('暂无可验证的结构化参数主张。')
  for (const [key, list] of byVar) {
    const support = list.filter(i => i.polarity === 'support' && i.verdict === 'identifiable_effect')
    const refute = list.filter(i => i.polarity === 'refute')
    const best = support[0]
    lines.push(`- **${key}**：${best ? `${best.direction === 'increase' ? '上调' : best.direction === 'decrease' ? '下调' : '保持'}（期望 ${best.effect != null ? best.effect.toPrecision(4) : '?'}${best.ciLow != null && best.ciHigh != null ? `，CI[${best.ciLow.toPrecision(3)}, ${best.ciHigh.toPrecision(3)}]` : ''}）` : '暂无正效应证据'}；支持 ${support.length} / 否证 ${refute.length}`)
  }
  lines.push('', '## 2. 有效区间与禁忌')
  const refuted = structured.filter(i => i.verdict === 'no_resolvable_effect')
  if (refuted.length === 0) lines.push('暂无可分辨的负结论。')
  for (const item of refuted.slice(0, 20)) lines.push(`- 禁忌方向：${item.nodeName || item.nodeId} ${item.direction}（${item.fromValue ?? '?'}→${item.toValue}），该步幅下无可分辨效应`)
  lines.push('', '## 3. 配方修订历史')
  const byRev = new Map<string, number>()
  for (const item of structured) byRev.set(item.recipeRevision || '(未限定)', (byRev.get(item.recipeRevision || '(未限定)') ?? 0) + 1)
  for (const [rev, n] of byRev) lines.push(`- 修订 ${rev}：${n} 条主张`)
  lines.push('', '## 4. 适用条件')
  for (const item of structured.slice(0, 20)) lines.push(`- ${item.lineId || '?'} / 产品 ${item.productId || '(通用)'} / ${item.nodeName || item.nodeId} / 判定 ${item.verdict}`)
  lines.push('', '## 5. 争议与未决')
  const under = structured.filter(i => i.verdict === 'underpowered' || i.verdict === 'confounded')
  if (under.length === 0) lines.push('无欠功效/混杂主张。')
  for (const item of under.slice(0, 20)) lines.push(`- ${item.nodeName || item.nodeId}：${item.verdict}（需更多数据，不参与推荐）`)
  lines.push('', '## 6. 来源')
  for (const item of structured.slice(0, 50)) lines.push(`- ${item.observedAt} ${item.nodeName || item.nodeId} intervention=${item.interventionId} daq=${item.daqEvidenceId || '—'} run=${item.runId || '—'}`)
  return {
    markdown: lines.join('\n'),
    claimCount: structured.length,
    sourceCount: new Set(structured.map(i => i.interventionId)).size,
  }
}
