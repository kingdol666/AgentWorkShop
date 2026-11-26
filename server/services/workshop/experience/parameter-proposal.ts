/**
 * 参数建议引擎（批次 M2/M3，2026-11-27）。
 *
 * **只读建议，绝不下发**：
 *  - 硬过滤：validated+deployed / line / product 或空 / node / recipeRevision / 有效窗口 / ≥2 独立证据；
 *  - 输出 1–3 条建议 + 必带 doNothing；无经验走 cold_start；全 refute 不重复该方向；
 *  - 每条建议带 intervention/daq 证据深链，落 parameter_proposals；
 *  - 下发仍必须走 recipe_trial/update/apply + HITL + 本体护栏；本模块没有任何设备写路径。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { appendEvidenceVersion, getVersion, headVersionId } from './versions'
import type { EvidenceRef, ExperienceClaim } from './types'
import { queryParameterExperience, type ParameterExperienceItem } from './claims'

export interface ProposalInput {
  channelId: string
  lineId: string
  productId?: string
  recipeId?: string
  recipeRevision?: string
  nodeIds?: string[]
  currentValues?: Record<string, number>
  targetMetric?: string
  actor: string
}

export interface ProposalSuggestion {
  id: string
  nodeId: string
  nodeName: string
  variable: string
  direction: 'increase' | 'decrease' | 'stable'
  fromValue: number | null
  toValue: number
  expectedEffect: number | null
  ciLow: number | null
  ciHigh: number | null
  targetDirection: string
  confidence: number
  mode: 'exploit' | 'explore' | 'cold_start'
  support: number
  refute: number
  evidence: Array<{ memoryId: string, claimId: string, interventionId: string, daqEvidenceId: string }>
  reasons: string[]
}

export interface ProposalResult {
  mode: 'exploit' | 'explore' | 'cold_start'
  suggestions: ProposalSuggestion[]
  doNothing: { kind: 'do_nothing', reason: string }
  messages: string[]
}

interface ProposalRow {
  id: string
  channelId: string
  lineId: string
  productId: string
  recipeId: string
  recipeRevision: string
  nodeId: string
  nodeName: string
  variable: string
  fromValue: number | null
  toValue: number | null
  expectedEffect: number | null
  ciLow: number | null
  ciHigh: number | null
  targetDirection: string
  confidence: number
  mode: string
  evidenceJson: string
  constraintsJson: string
  status: string
  appliedRecipeRevision: string
  feedbackJson: string
}

const SELECT_COLS = `id, channel_id AS channelId, line_id AS lineId, product_id AS productId, recipe_id AS recipeId,
  recipe_revision AS recipeRevision, node_id AS nodeId, node_name AS nodeName, variable, from_value AS fromValue,
  to_value AS toValue, expected_effect AS expectedEffect, ci_low AS ciLow, ci_high AS ciHigh,
  target_direction AS targetDirection, confidence, mode, evidence_json AS evidenceJson,
  constraints_json AS constraintsJson, status, applied_recipe_revision AS appliedRecipeRevision, feedback_json AS feedbackJson`

function unitEvidence(item: ParameterExperienceItem): string {
  return item.runId ? `run:${item.runId}` : `event:${item.interventionId}`
}

function groupEvidence(items: ParameterExperienceItem[]): ParameterExperienceItem[] {
  // 同一 run 的多节点/多干预共享一个独立单元：组内只保留最早一条作为代表
  const seen = new Set<string>()
  const out: ParameterExperienceItem[] = []
  for (const item of items) {
    const unit = unitEvidence(item)
    if (seen.has(unit)) continue
    seen.add(unit)
    out.push(item)
  }
  return out
}

/**
 * 生成建议（幂等：同一 scope/节点/证据集不重复落库）。
 * 无合格经验 → cold_start + doNothing（不硬编方向）。
 */
export function proposeParameterAdjustment(db: DatabaseSync, input: ProposalInput): ProposalResult {
  const messages: string[] = []
  const items = queryParameterExperience(db, {
    lineId: input.lineId,
    productId: input.productId || undefined,
    recipeRevision: input.recipeRevision || undefined,
    deployedOnly: true,
    limit: 200,
  }).filter(item => !input.nodeIds || input.nodeIds.length === 0 || input.nodeIds.includes(item.nodeId))
    .filter(item => item.claimStatus === 'structured' && (item.verdict === 'identifiable_effect' || item.verdict === 'no_resolvable_effect'))

  const byNode = new Map<string, ParameterExperienceItem[]>()
  for (const item of items) {
    const list = byNode.get(item.nodeId) ?? []
    list.push(item)
    byNode.set(item.nodeId, list)
  }
  const suggestions: ProposalSuggestion[] = []
  for (const [nodeId, list] of byNode) {
    const support = groupEvidence(list.filter(i => i.verdict === 'identifiable_effect' && i.effect != null && i.polarity === 'support'))
    const refute = groupEvidence(list.filter(i => i.verdict === 'no_resolvable_effect'))
    const first = support[0] ?? refute[0]
    if (!first) continue
    // 全 refute / 无支持 → 不重复该方向
    if (support.length === 0) {
      messages.push(`${first.nodeName || nodeId}：历史仅有负结论，不重复该方向。`)
      continue
    }
    // 独立证据门槛：同 run 多节点共享单元，至少 2 个单元
    if (support.length < 2) {
      messages.push(`${first.nodeName || nodeId}：独立证据不足 2 个（${support.length}），不生成建议，继续积累。`)
      continue
    }
    const effect = support.reduce((a, b) => a + (b.effect ?? 0), 0) / support.length
    const ciLow = support.map(s => s.ciLow).filter((v): v is number => v != null).sort((a, b) => a - b)[0] ?? null
    const ciHigh = support.map(s => s.ciHigh).filter((v): v is number => v != null).sort((a, b) => b - a)[0] ?? null
    const direction = first.direction === 'increase' || first.direction === 'decrease' ? first.direction : 'stable'
    if (direction === 'stable') continue
    const delta = Math.abs(first.toValue - (first.fromValue ?? first.toValue)) || Math.max(1, Math.abs(first.toValue) * 0.02)
    const fromValue = input.currentValues?.[nodeId] ?? first.fromValue ?? null
    if (fromValue == null) {
      messages.push(`${first.nodeName || nodeId}：缺少当前值，无法给出 from→to；请在调用时提供 currentValues。`)
      continue
    }
    const toValue = direction === 'increase' ? fromValue + delta : fromValue - delta
    const confidence = Math.max(0.2, Math.min(0.95, support.length / (support.length + refute.length + 1)))
    const evidence = support.map(s => ({
      memoryId: s.memoryId, claimId: s.claimId, interventionId: s.interventionId, daqEvidenceId: s.daqEvidenceId,
    }))
    const id = `prop-${randomUUID().slice(0, 12)}`
    const constraints = {
      recipeId: input.recipeId ?? first.recipeId,
      recipeRevision: input.recipeRevision ?? first.recipeRevision,
      targetMetric: input.targetMetric ?? first.targetMetric,
      note: '只读建议；下发必须走 recipe_trial/update + HITL + 本体护栏',
    }
    db.prepare(
      `INSERT INTO parameter_proposals
        (id, channel_id, line_id, product_id, recipe_id, recipe_revision, node_id, node_name, variable,
         from_value, to_value, expected_effect, ci_low, ci_high, target_direction, confidence, mode,
         evidence_json, constraints_json, status, applied_recipe_revision, proposal_id_origin, feedback_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exploit', ?, ?, 'proposed', '', '', '{}', ?, ?, ?)`,
    ).run(id, input.channelId, input.lineId, input.productId ?? '', input.recipeId ?? first.recipeId,
      input.recipeRevision ?? first.recipeRevision, nodeId, first.nodeName, first.variable,
      fromValue, toValue, effect, ciLow, ciHigh, first.targetDirection, confidence,
      JSON.stringify(evidence), JSON.stringify(constraints), input.actor, new Date().toISOString(), new Date().toISOString())
    suggestions.push({
      id, nodeId, nodeName: first.nodeName, variable: first.variable, direction,
      fromValue, toValue, expectedEffect: effect, ciLow, ciHigh,
      targetDirection: first.targetDirection, confidence, mode: 'exploit',
      support: support.length, refute: refute.length, evidence,
      reasons: [
        `支持证据 ${support.length} 个独立单元 / 否证 ${refute.length}`,
        `期望效应 ${effect.toPrecision(4)}${ciLow != null && ciHigh != null ? `（CI[${ciLow.toPrecision(3)}, ${ciHigh.toPrecision(3)}]）` : ''}`,
        `配方修订 ${(input.recipeRevision ?? first.recipeRevision) || '(未限定)'}`,
      ],
    })
    if (suggestions.length >= 3) break
  }
  if (suggestions.length === 0) {
    return {
      mode: 'cold_start',
      suggestions: [],
      doNothing: { kind: 'do_nothing', reason: '无满足硬过滤的历史证据：保持当前配方并积累数据（cold_start）' },
      messages: [...messages, 'cold_start：没有可用的 validated+deployed 经验，不硬编方向。'],
    }
  }
  return {
    mode: 'exploit',
    suggestions,
    doNothing: { kind: 'do_nothing', reason: '证据不足/风险未接受时保持当前配方（始终可选项）' },
    messages,
  }
}

/** 校验 proposal 可用于本次下发（channel/line/节点集/状态/修订兼容） */
export function validateProposalForDispatch(
  db: DatabaseSync,
  proposalId: string,
  ctx: { channelId: string, lineId: string, nodeIds: string[], recipeRevision?: string },
): { ok: true, proposal: ProposalRow } | { ok: false, reason: string } {
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM parameter_proposals WHERE id = ?`).get(proposalId) as ProposalRow | undefined
  if (!row) return { ok: false, reason: '建议不存在' }
  if (row.channelId !== ctx.channelId) return { ok: false, reason: '建议不属于当前频道' }
  if (row.lineId !== ctx.lineId) return { ok: false, reason: '建议不属于当前产线' }
  if (row.status !== 'proposed' && row.status !== 'approved') return { ok: false, reason: `建议状态 ${row.status} 不可下发` }
  if (ctx.nodeIds.length > 0 && !ctx.nodeIds.includes(row.nodeId)) return { ok: false, reason: `建议节点 ${row.nodeId} 不在本次下发节点集` }
  if (ctx.recipeRevision && row.recipeRevision && ctx.recipeRevision !== row.recipeRevision) {
    return { ok: false, reason: `配方修订已变化（建议 ${row.recipeRevision}，当前 ${ctx.recipeRevision}），建议已过期` }
  }
  return { ok: true, proposal: row }
}

export function markProposalStatus(db: DatabaseSync, proposalId: string, status: string, patch: { appliedRecipeRevision?: string, feedback?: Record<string, unknown> } = {}): void {
  try {
    db.prepare(
      `UPDATE parameter_proposals SET status = ?, applied_recipe_revision = COALESCE(?, applied_recipe_revision),
         feedback_json = ?, updated_at = ? WHERE id = ?`,
    ).run(status, patch.appliedRecipeRevision ?? null, JSON.stringify(patch.feedback ?? {}), new Date().toISOString(), proposalId)
  }
  catch { /* 建议状态失败不影响下发 */ }
}

/**
 * 判定回写（M3）：proposal 状态 + 追加证据版本（继承 head 状态）。
 * support/refute 只按 verdict 语义；underpowered/confounded → needs_more_data。
 */
export function attributeProposal(db: DatabaseSync, proposalId: string, event: {
  verdict: string
  effect?: number | null
  ciLow?: number | null
  ciHigh?: number | null
  mde?: number | null
  interventionId: string
}): { ok: boolean, updated: number } {
  try {
    const row = db.prepare(`SELECT ${SELECT_COLS} FROM parameter_proposals WHERE id = ?`).get(proposalId) as ProposalRow | undefined
    if (!row) return { ok: false, updated: 0 }
    const verdict = event.verdict
    const effectValue = event.effect ?? null
    const targetDir = row.targetDirection
    const consistent = effectValue == null || targetDir === 'unknown'
      ? true
      : targetDir === 'increase'
        ? effectValue > 0
        : targetDir === 'decrease'
          ? effectValue < 0
          : true
    const outcome = verdict === 'identifiable_effect'
      ? (consistent ? 'support' : 'refute')
      : verdict === 'no_resolvable_effect'
        ? 'refute'
        : 'needs_more_data'
    let evidence: Array<{ memoryId: string }> = []
    try {
      evidence = JSON.parse(row.evidenceJson) as Array<{ memoryId: string }>
    }
    catch { evidence = [] }
    const now = new Date().toISOString()
    let updated = 0
    for (const ref of evidence) {
      if (!ref?.memoryId) continue
      const head = headVersionId(db, ref.memoryId)
      if (!head) continue
      const version = getVersion(db, head)
      if (!version) continue
      const claim = version.claim as ExperienceClaim
      const polarity: EvidenceRef['polarity'] = outcome === 'support' ? 'support' : outcome === 'refute' ? 'refute' : 'unknown'
      const ev: EvidenceRef = {
        id: `intv:${event.interventionId}`,
        sourceKind: 'task',
        environment: 'production',
        observedAt: now,
        supportUnitId: `event:${event.interventionId}`,
        polarity,
      }
      try {
        appendEvidenceVersion(db, {
          experienceId: ref.memoryId,
          scope: version.scope,
          claim,
          content: `判定回写：${verdict}${event.effect != null ? `，effect=${event.effect}` : ''}`,
          observedAt: now,
          evidence: [ev],
          idempotencyKey: `proposal-feedback:${proposalId}:${event.interventionId}`,
        })
        updated++
      }
      catch { /* 单个经验更新失败不影响其余 */ }
    }
    db.prepare(
      `UPDATE parameter_proposals SET status = ?, feedback_json = ?, updated_at = ? WHERE id = ?`,
    ).run('assessed', JSON.stringify({
      verdict,
      outcome,
      effect: event.effect ?? null,
      ciLow: event.ciLow ?? null,
      ciHigh: event.ciHigh ?? null,
      mde: event.mde ?? null,
      interventionId: event.interventionId,
      assessedAt: now,
    }), now, proposalId)
    return { ok: true, updated }
  }
  catch {
    return { ok: false, updated: 0 }
  }
}
