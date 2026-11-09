/**
 * 配方证据聚合（WP-D1）—— 把散在三处的效果证据按 recipeRunId 串成一条可机器读的链：
 *   dcw-runs(试验批次:参数快照/逐参 ACK) ←→ intervention_events(干预台账:verdict/effect/CI/MDE)
 *   ←→ analysis_reports(分析结论:recipe_run_id 外键)
 *
 * 为什么需要它：trial 回执里的 runId 只能靠 Agent 自觉"回访"，效果指标与配方记录之间
 * 没有外键级关联（审计发现的最大证据断层）。本模块提供单点只读聚合，供
 * recipe_propose 上下文与经验反射复用。
 */
import type { DatabaseSync } from 'node:sqlite'
import { getDcwController } from './dcw-controller'
import { getAmlRuntime } from '../aml/runtime'

/** 单个参数的下发/回读摘要（来自试验回执） */
export interface RecipeRunParamEvidence {
  nodeId: string | null
  value: number
  ok: boolean
  ack?: string
}

/** 一条试验批次的完整证据 */
export interface RecipeRunEvidence {
  runId: string
  recipeId: string
  recipeName: string
  recipeVersion: string
  startedAt: string
  endedAt: string | null
  ackSummary: Record<string, number>
  params: RecipeRunParamEvidence[]
  /** 干预台账（该批次的下发记录与可辨识性判定） */
  interventions: Array<{
    eventId: string
    nodeName: string
    fromValue: number | null
    toValue: number | null
    actualValue: number | null
    ack: string
    path: string
    verdict: string
    effect: number | null
    ciLow: number | null
    ciHigh: number | null
    mde: number | null
    criterion: Record<string, unknown> | null
    hypothesis: string
  }>
  /** 关联的分析报告（recipe_run_id 外键） */
  reports: Array<{ id: string, title: string, summary: string, createdAt: string }>
  /** 机器可读的成效结论（由 verdict 聚合，不猜测） */
  outcome: 'improved' | 'no_effect' | 'inconclusive' | 'unassessed'
}

/** verdict → 成效结论（identifiable_effect 且 effect != 0 才算 improved） */
export function recipeRunOutcome(interventions: RecipeRunEvidence['interventions']): RecipeRunEvidence['outcome'] {
  if (interventions.length === 0) return 'unassessed'
  const withVerdict = interventions.filter(i => i.verdict !== 'pending')
  if (withVerdict.length === 0) return 'unassessed'
  if (withVerdict.some(i => i.verdict === 'identifiable_effect' && (i.effect ?? 0) !== 0)) return 'improved'
  if (withVerdict.some(i => i.verdict === 'no_resolvable_effect')) return 'no_effect'
  return 'inconclusive'
}

function parseCriterion(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

/**
 * 按 recipeId 取最近 N 个批次的证据链（默认 3 个）。
 * 数据面：dcw controller 的 run 列表（JSON 文件仓储，权威运行态）+ 平台库台账。
 * 失败不抛：返回空数组（学习环绝不阻断配方工具）。
 */
export function getRecipeEvidence(db: DatabaseSync, recipeId: string, opts: { limit?: number } = {}): RecipeRunEvidence[] {
  if (!recipeId) return []
  const limit = Math.min(Math.max(opts.limit ?? 3, 1), 10)
  try {
    const ctrl = getDcwController()
    // repo 按创建顺序 append（旧→新）；取最近 limit 个，输出按时间倒序（最新在前）
    const runs = ctrl.listRuns()
      .filter(r => r.recipeId === recipeId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
    return runs.map((run) => {
      const interventions = db.prepare(
        `SELECT id, node_name, from_value, to_value, actual_value, ack, path, verdict, effect, ci_low, ci_high, mde, criterion_json, hypothesis
           FROM intervention_events WHERE recipe_run_id = ? ORDER BY ts ASC`,
      ).all(run.id) as Array<{
        id: string
        node_name: string
        from_value: number | null
        to_value: number | null
        actual_value: number | null
        ack: string
        path: string
        verdict: string
        effect: number | null
        ci_low: number | null
        ci_high: number | null
        mde: number | null
        criterion_json: string | null
        hypothesis: string
      }>
      const reports = db.prepare(
        `SELECT id, title, summary, created_at AS createdAt FROM analysis_reports WHERE recipe_run_id = ? ORDER BY created_at DESC`,
      ).all(run.id) as Array<{ id: string, title: string, summary: string, createdAt: string }>
      const mapped = interventions.map(i => ({
        eventId: i.id,
        nodeName: i.node_name,
        fromValue: i.from_value,
        toValue: i.to_value,
        actualValue: i.actual_value,
        ack: i.ack,
        path: i.path,
        verdict: i.verdict,
        effect: i.effect,
        ciLow: i.ci_low,
        ciHigh: i.ci_high,
        mde: i.mde,
        criterion: parseCriterion(i.criterion_json),
        hypothesis: i.hypothesis,
      }))
      return {
        runId: run.id,
        recipeId: run.recipeId,
        recipeName: run.recipeName,
        recipeVersion: String(run.recipeVersion ?? ''),
        startedAt: run.startedAt,
        endedAt: run.endedAt ?? null,
        ackSummary: (run.ackSummary ?? {}) as unknown as Record<string, number>,
        params: (run.results ?? []).map(r => ({ nodeId: r.nodeId, value: r.value, ok: r.ok, ack: r.ack })),
        interventions: mapped,
        reports,
        outcome: recipeRunOutcome(mapped),
      }
    })
  }
  catch {
    return []
  }
}

/**
 * 工具面便捷入口：按 recipeId 取证据链文本（失败返回空串）。
 * db 取 AML 运行时（与平台库同一实例；配方工具运行期恒已装配）。
 */
export function recipeEvidenceText(recipeId: string, opts: { limit?: number } = {}): string {
  try {
    return formatRecipeEvidence(getRecipeEvidence(getAmlRuntime().db, recipeId, opts))
  }
  catch {
    return ''
  }
}

/**
 * 证据链渲染为工具上下文文本（recipe_propose / recipe_trial 复用）。
 * 每条批次一段：批次头 + 成效结论 + 干预判定 + 关联分析。
 */
export function formatRecipeEvidence(evidence: RecipeRunEvidence[]): string {
  if (evidence.length === 0) return ''
  const lines: string[] = ['## 配方证据链（按批次；成效结论由 verdict 聚合，非 Agent 自述）']
  for (const e of evidence) {
    const ack = Object.entries(e.ackSummary ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')
    lines.push(`- 批次 ${e.runId}（${e.startedAt.slice(0, 16).replace('T', ' ')}${e.endedAt ? ` ~ ${e.endedAt.slice(0, 16).replace('T', ' ')}` : ''}）成效=${e.outcome}${ack ? ` · ACK ${ack}` : ''}`)
    for (const i of e.interventions) {
      const ci = i.ciLow !== null && i.ciHigh !== null ? ` CI[${i.ciLow}, ${i.ciHigh}]` : ''
      const eff = i.effect !== null ? ` effect=${i.effect}` : ''
      lines.push(`  · ${i.nodeName} ${i.fromValue ?? '?'}→${i.toValue ?? '?'} 回读=${i.actualValue ?? '?'} ACK=${i.ack} 判定=${i.verdict}${eff}${ci}${i.mde !== null ? ` MDE=${i.mde}` : ''}`)
    }
    for (const r of e.reports) lines.push(`  · 分析「${r.title}」${r.summary.slice(0, 60)}`)
  }
  return lines.join('\n')
}
