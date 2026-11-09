/**
 * RSI 经验事实采集器（WP-A2）—— 从平台库**只读**聚合三类触发点所需的结构化事实，
 * 再交给 reflector 蒸馏。所有查询单库完成（AML 与平台共用同一 DatabaseSync 实例）。
 *
 * 链接口径（为什么不按 task_id 关联干预）：
 *  - intervention_events 只带 channel_id/line_id/recipe_run_id/approval_id，**没有 task_id**；
 *    按时间窗/频道猜测关联会产生假归因（比不关联更糟），因此干预经验走自己的触发点，
 *    任务经验只记录"判据是否通过 + 失败分类"这些确定事实。
 */
import type { DatabaseSync } from 'node:sqlite'
import { parseJson } from '../../db/database'
import type { InterventionFact, ReviewFact, TaskFact } from './reflector'

/** 任务行投影（只取必需列，避免宽表读取） */
interface TaskRowLite {
  id: string
  channel_id: string
  title: string
  description: string | null
  state: string
  session_id: string | null
  artifacts_json: string | null
}

/** project_results 关键投影（criteria/有效性域/血缘） */
interface ResultRowLite {
  id: string
  channel_id: string
  line_id: string
  title: string
  summary: string
  status: string
  validity_scope: string
  criteria_check_json: string
  trace_id: string
  source_task_id: string
  author_agent_id: string | null
}

/** 干预台账行投影 */
interface InterventionRowLite {
  id: string
  channel_id: string
  line_id: string
  node_name: string
  from_value: number | null
  to_value: number | null
  actual_value: number | null
  ack: string
  hypothesis: string
  recipe_run_id: string | null
  criterion_json: string | null
  verdict: string
  effect: number | null
  ci_low: number | null
  ci_high: number | null
  mde: number | null
}

/** artifacts_json → 纯文本（优先 deliverable/summary 命名成果，其余兜底拼接） */
function artifactsText(artifactsJson: string | null): string {
  const artifacts = parseJson<Array<{ name?: string, parts?: Array<{ text?: string }> }>>(artifactsJson, [])
  if (!Array.isArray(artifacts) || artifacts.length === 0) return ''
  const preferred = artifacts.filter(a => a.name === 'deliverable' || a.name === 'summary')
  const source = preferred.length > 0 ? preferred : artifacts
  return source
    .flatMap(a => (a.parts ?? []).map(p => p.text ?? ''))
    .join(' ')
    .trim()
}

/** 频道绑定的产线（作用域锚点；未绑定返回 ''） */
export function channelLineId(db: DatabaseSync, channelId: string): string {
  const row = db.prepare('SELECT line_id AS lineId FROM channels WHERE id = ?').get(channelId) as { lineId?: string } | undefined
  return row?.lineId ?? ''
}

/** 任务终态事实（判据来自 project_results.criteria_check_json；失败分类来自 attempt） */
export function collectTaskFact(
  db: DatabaseSync,
  input: { channelId: string, taskId: string, agentId: string },
): TaskFact | null {
  const task = db.prepare(
    `SELECT id, channel_id, title, description, state, session_id, artifacts_json FROM tasks WHERE id = ?`,
  ).get(input.taskId) as TaskRowLite | undefined
  if (!task) return null

  // 项目任务：根任务 COMPLETED 时自动生成的 draft 成果携带 L0 判据结果
  const result = db.prepare(
    `SELECT criteria_check_json FROM project_results WHERE source_task_id = ? ORDER BY version DESC LIMIT 1`,
  ).get(input.taskId) as { criteria_check_json: string } | undefined
  const criteriaRaw = parseJson<Record<string, unknown>>(result?.criteria_check_json ?? '{}', {})
  const criteria = Object.keys(criteriaRaw).length > 0
    ? {
        ok: criteriaRaw['ok'] === true,
        checks: Array.isArray(criteriaRaw['checks'])
          ? (criteriaRaw['checks'] as Array<Record<string, unknown>>).map(c => ({
              id: typeof c['id'] === 'string' ? c['id'] : undefined,
              kind: typeof c['kind'] === 'string' ? c['kind'] : undefined,
              ok: c['ok'] === true,
              detail: typeof c['detail'] === 'string' ? c['detail'] : undefined,
            }))
          : [],
      }
    : undefined

  // 失败分类（项目 attempt 才有；普通频道任务为空）
  const attempt = db.prepare(
    `SELECT failure_class FROM project_work_item_attempts WHERE channel_task_id = ? AND failure_class != '' ORDER BY created_at DESC LIMIT 1`,
  ).get(input.taskId) as { failure_class: string } | undefined

  return {
    source: 'task',
    channelId: input.channelId,
    agentId: input.agentId,
    taskId: task.id,
    title: task.title,
    state: task.state,
    sessionId: task.session_id ?? '',
    deliverable: artifactsText(task.artifacts_json) || (task.description ?? ''),
    criteria,
    failureClass: attempt?.failure_class || undefined,
    lineId: channelLineId(db, input.channelId) || undefined,
  }
}

/**
 * 评审终态事实。
 * verdict 映射：成果 approved → approved；rejected/rework_required → rejected。
 * validity_scope 允许 `line:<id>` / `product:<id>` 形式（历史数据也接受裸 key + kind 列缺失）。
 */
export function collectReviewFact(
  db: DatabaseSync,
  input: { resultId: string, verdict: 'approved' | 'rejected' },
): ReviewFact | null {
  const row = db.prepare(
    `SELECT id, channel_id, line_id, title, summary, status, validity_scope, criteria_check_json,
            trace_id, source_task_id, author_agent_id
       FROM project_results WHERE id = ?`,
  ).get(input.resultId) as ResultRowLite | undefined
  if (!row) return null
  const scopeRaw = (row.validity_scope ?? '').trim()
  let validityScope: { kind?: string, key?: string } | undefined
  if (scopeRaw) {
    const [kind, ...rest] = scopeRaw.split(':')
    validityScope = rest.length > 0
      ? { kind, key: rest.join(':') }
      : (kind === 'line' || kind === 'product' ? { kind } : { key: kind })
  }
  return {
    source: 'review',
    channelId: row.channel_id,
    agentId: row.author_agent_id ?? 'system:review',
    resultId: row.id,
    verdict: input.verdict,
    title: row.title,
    summary: row.summary,
    validityScope,
    lineId: row.line_id || channelLineId(db, row.channel_id) || undefined,
    taskId: row.source_task_id || undefined,
    traceId: row.trace_id || undefined,
  }
}

/** 干预 verdict 事实（verdict 回填后采集；pending/unassessed 由 reflector 过滤） */
export function collectInterventionFact(db: DatabaseSync, eventId: string): InterventionFact | null {
  const row = db.prepare(
    `SELECT id, channel_id, line_id, node_name, from_value, to_value, actual_value, ack, hypothesis,
            recipe_run_id, criterion_json, verdict, effect, ci_low, ci_high, mde
       FROM intervention_events WHERE id = ?`,
  ).get(eventId) as InterventionRowLite | undefined
  if (!row) return null
  const verdict = row.verdict as InterventionFact['verdict']
  return {
    source: 'intervention',
    channelId: row.channel_id,
    agentId: 'system:ledger',
    eventId: row.id,
    verdict,
    nodeName: row.node_name,
    fromValue: row.from_value,
    toValue: row.to_value,
    actualValue: row.actual_value,
    ack: row.ack,
    hypothesis: row.hypothesis,
    recipeRunId: row.recipe_run_id,
    effect: row.effect,
    ciLow: row.ci_low,
    ciHigh: row.ci_high,
    mde: row.mde,
    criterion: parseJson<Record<string, unknown> | null>(row.criterion_json ?? '', null),
    lineId: row.line_id || channelLineId(db, row.channel_id) || undefined,
  }
}

/**
 * 干预台账补扫：把 verdict 已回填但尚未沉淀为经验的台账行批量采集。
 * 经验 dedupKey=`exp:int:<eventId>` 保证重复扫描幂等。
 * 由维护定时器驱动（attachAssessment 的即时 hook 之外的兜底）。
 */
export function listUnreflectedInterventions(db: DatabaseSync, opts: { sinceIso: string, limit?: number }): string[] {
  const rows = db.prepare(
    `SELECT e.id FROM intervention_events e
      WHERE e.verdict IN ('identifiable_effect','no_resolvable_effect','underpowered','confounded','unassessed')
        AND e.updated_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_memories m
           WHERE m.kind = 'experience' AND m.dedup_key = 'exp:int:' || e.id
        )
      ORDER BY e.updated_at ASC LIMIT ?`,
  ).all(opts.sinceIso, Math.min(Math.max(opts.limit ?? 50, 1), 500)) as Array<{ id: string }>
  return rows.map(r => r.id)
}
