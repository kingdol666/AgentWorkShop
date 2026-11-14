/**
 * RSI 经验反射器（WP-A2）—— 把「任务结果 + 验收判定 + 干预 verdict」**确定性蒸馏**为
 * 带证据链的经验条目（kind='experience'）。
 *
 * 设计纪律（plan ADR-2 / G2）：
 *  - Tier1 确定性蒸馏，零 LLM：输入全部是结构化事实（state/verdict/criteria/metrics），
 *    输出内容可机器复核 —— 经验进库看 verdict，不看 Agent 自述；
 *  - 无 verdict 背书的因果断言 → outcome='unknown' + status='candidate' + `[anecdotal]` 前缀；
 *  - 证据锚点缺失由 repo.upsertExperience fail-closed 拒绝（绝不产生无证据经验）；
 *  - line/product 作用域一律 candidate（先验证再晋级，防错误经验复利），channel/session 为 active。
 *
 * 三类事实的 scope 归属：
 *  - 任务终态：channel（本频道经验；sessionId 一并保留供 session 档检索）
 *  - 项目评审：approved/rejected 带 validityScope → line/product；否则 channel
 *  - 干预 verdict：line（有 lineId 时）否则 channel
 */
import type { MemoryScopeKind, MemoryStatus } from '../../db/database'
import type { ExperienceEvidence, MemoryRepo } from '../../db/memory.repo'
import type { EmbeddingProvider } from '../embedding-provider'
import { segmentCJK, vectorizeMemory } from './helpers'
import { channelModeOf } from '../../channel-mode'

/** 任务终态事实（message.ts / supervise.ts / 调度器 bus 单点收口后采集） */
export interface TaskFact {
  source: 'task'
  channelId: string
  agentId: string
  taskId: string
  title: string
  state: string
  sessionId?: string
  /** 交付物/结论原文（可为空；空则回退 description/title） */
  deliverable?: string
  /** 项目任务附带的 L0 判据结果（criteria_check_json 投影） */
  criteria?: { ok: boolean, checks: Array<{ id?: string, kind?: string, ok?: boolean, detail?: string }> }
  /** 同频道同产线的干预 verdict 摘要（来自 intervention_events；可为空） */
  intervention?: { eventId: string, verdict: string, effect?: number | null, recipeRunId?: string | null }
  /** 产线/产品锚点（channel line 绑定解析；用于作用域与证据） */
  lineId?: string
  productId?: string
  /** 失败场合的失败分类（project_work_item_attempts.failure_class） */
  failureClass?: string
}

/** 项目成果评审终态事实（reviewResult / decideApproval 之后采集） */
export interface ReviewFact {
  source: 'review'
  channelId: string
  agentId: string
  resultId: string
  /** approved | rejected（L1 技术验收与 L2 业务签核合一语义：通过/驳回） */
  verdict: 'approved' | 'rejected'
  title: string
  /** 成果摘要/驳回原因 */
  summary?: string
  /** 成果声明的有效域（validity_scope：line/product） */
  validityScope?: { kind?: string, key?: string }
  lineId?: string
  productId?: string
  taskId?: string
  traceId?: string
}

/** 干预 verdict 回填事实（intervention_events.attachAssessment 后采集） */
export interface InterventionFact {
  source: 'intervention'
  channelId: string
  agentId: string
  eventId: string
  verdict: 'identifiable_effect' | 'no_resolvable_effect' | 'underpowered' | 'confounded' | 'unassessed'
  nodeName?: string
  fromValue?: number | null
  toValue?: number | null
  actualValue?: number | null
  ack?: string | null
  hypothesis?: string | null
  recipeRunId?: string | null
  effect?: number | null
  ciLow?: number | null
  ciHigh?: number | null
  mde?: number | null
  criterion?: Record<string, unknown> | null
  lineId?: string
  productId?: string
}

export type ExperienceFact = TaskFact | ReviewFact | InterventionFact

/** 蒸馏产物（可直接交给 repo.upsertExperience） */
export interface DistilledExperience {
  title: string
  content: string
  outcome: 'positive' | 'negative' | 'neutral' | 'unknown'
  status: MemoryStatus
  scopeKind: MemoryScopeKind
  scopeKey: string
  importance: number
  sessionId: string
  dedupKey: string
  evidence: ExperienceEvidence
  /** 附带指标（已并入 evidence.metrics；此处保留供测试/观测） */
  metrics?: Record<string, number>
}

const ANECDOTAL = '[anecdotal] '

/** 数字格式化（避免 1e-7 之类的科学计数进入可读内容；无效值返回 null） */
function num(v: number | null | undefined): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const fixed = Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)
  return fixed.replace(/\.?0+$/, '')
}

/** 判据摘要（metric op threshold → 一行） */
function criterionText(c: Record<string, unknown> | null | undefined): string {
  if (!c) return ''
  const metric = typeof c['metric'] === 'string' ? c['metric'] : ''
  const op = typeof c['op'] === 'string' ? c['op'] : ''
  const threshold = num(typeof c['threshold'] === 'number' ? c['threshold'] : null)
  if (!metric) return ''
  return `${metric}${op}${threshold ?? '?'}`
}

/** 作用域与状态：line/product 一律 candidate（ADR-7），其余 active */
function scopeOf(kind: MemoryScopeKind, key: string): { scopeKind: MemoryScopeKind, scopeKey: string, status: MemoryStatus } {
  if ((kind === 'line' || kind === 'product') && key) {
    return { scopeKind: kind, scopeKey: key, status: 'candidate' }
  }
  return { scopeKind: 'channel', scopeKey: '', status: 'active' }
}

/**
 * 蒸馏任务终态事实。
 * 返回 null 表示"没有可沉淀的内容"（无交付物且无判据）—— 宁缺毋滥，不写空经验。
 */
export function distillTaskFact(f: TaskFact): DistilledExperience | null {
  const completed = f.state === 'COMPLETED'
  const criteriaFailed = f.criteria ? f.criteria.ok === false : false
  const verdictText = f.intervention
    ? `干预判定 ${f.intervention.verdict}${f.intervention.effect !== null && f.intervention.effect !== undefined ? `（effect=${num(f.intervention.effect)}）` : ''}`
    : ''
  const body = (f.deliverable ?? '').trim().slice(0, 300)
  if (!body && !criteriaFailed && !verdictText) return null

  const outcome = criteriaFailed || !completed
    ? 'negative' as const
    : f.intervention?.verdict === 'identifiable_effect'
      ? 'positive' as const
      : f.intervention && f.intervention.verdict !== 'identifiable_effect'
        ? 'unknown' as const
        : 'positive' as const

  const hasVerdict = !!f.intervention && f.intervention.verdict !== 'unassessed'
  const scope = scopeOf(f.lineId ? 'line' : 'channel', f.lineId ?? '')

  const parts = [
    `任务「${f.title}」终态 ${f.state}`,
    criteriaFailed ? `L0 判据未通过（${(f.criteria?.checks ?? []).filter(c => c.ok === false).map(c => c.id ?? c.kind ?? '?').join('、')}）` : '',
    f.failureClass ? `失败分类 ${f.failureClass}` : '',
    verdictText,
    body ? `结论：${body}` : '',
  ].filter(Boolean)

  const evidence: ExperienceEvidence = {
    taskIds: [f.taskId],
    ...(f.intervention?.eventId ? { interventionEventId: f.intervention.eventId } : {}),
    ...(f.intervention?.recipeRunId ? { recipeRunId: f.intervention.recipeRunId } : {}),
    ...(f.intervention?.effect !== null && f.intervention?.effect !== undefined ? { metrics: { effect: f.intervention.effect } } : {}),
  }

  return {
    title: `${completed ? '完成' : '未完成'}：${f.title}`,
    content: segmentCJK((hasVerdict ? '' : ANECDOTAL) + parts.join('；')),
    outcome,
    status: scope.status,
    scopeKind: scope.scopeKind,
    scopeKey: scope.scopeKey,
    importance: completed && !criteriaFailed ? 0.8 : 0.6,
    sessionId: f.sessionId ?? '',
    dedupKey: `exp:task:${f.taskId}`,
    evidence,
  }
}

/** 蒸馏评审终态事实：通过=正向（带产出），驳回=负向教训 */
export function distillReviewFact(f: ReviewFact): DistilledExperience {
  const approved = f.verdict === 'approved'
  const scopeKind = (f.validityScope?.kind === 'line' || f.validityScope?.kind === 'product') ? f.validityScope.kind : null
  const scopeKey = f.validityScope?.key ?? ''
  const byScope = scopeKind && scopeKey ? scopeOf(scopeKind, scopeKey) : scopeOf('channel', '')
  const parts = [
    `项目成果评审 ${approved ? '通过' : '驳回'}：${f.title}`,
    f.summary ? `结论：${f.summary.slice(0, 300)}` : '',
    approved ? '可在作用域内复用该成果' : '该路径不可复用，需返工',
  ].filter(Boolean)
  const evidence: ExperienceEvidence = {
    resultId: f.resultId,
    ...(f.taskId ? { taskIds: [f.taskId] } : {}),
    ...(f.traceId ? { traceId: f.traceId } : {}),
  }
  return {
    title: `${approved ? '成果通过' : '成果驳回'}：${f.title}`,
    content: segmentCJK(parts.join('；')),
    outcome: approved ? 'positive' : 'negative',
    status: byScope.status,
    scopeKind: byScope.scopeKind,
    scopeKey: byScope.scopeKey,
    importance: approved ? 0.85 : 0.7,
    sessionId: '',
    dedupKey: `exp:review:${f.resultId}:${f.verdict}`,
    evidence,
  }
}

/**
 * 蒸馏干预 verdict 事实（科学判定 → 可复用经验）。
 * unassessed 不产生经验（无判定上下文，凭它沉淀等于凭噪声学习）。
 */
export function distillInterventionFact(f: InterventionFact): DistilledExperience | null {
  if (f.verdict === 'unassessed') return null
  const change = [num(f.fromValue), num(f.toValue)].every(v => v !== null)
    ? `${num(f.fromValue)}→${num(f.toValue)}`
    : (f.hypothesis ?? '').slice(0, 80)
  const effectText = num(f.effect)
  const ciText = num(f.ciLow) !== null && num(f.ciHigh) !== null ? `CI[${num(f.ciLow)}, ${num(f.ciHigh)}]` : ''
  const parts = [
    `节点「${f.nodeName ?? '?'}」干预 ${change || '(无数值)'}`,
    f.actualValue !== null && f.actualValue !== undefined ? `回读 ${num(f.actualValue)}` : '',
    f.ack ? `ACK ${f.ack}` : '',
    criterionText(f.criterion) ? `判据 ${criterionText(f.criterion)}` : '',
    `判定 ${f.verdict}`,
    effectText !== null ? `effect=${effectText}` : '',
    ciText,
    num(f.mde) !== null ? `MDE=${num(f.mde)}` : '',
  ].filter(Boolean)

  const positive = f.verdict === 'identifiable_effect' && (f.effect ?? 0) !== 0
  const outcome = f.verdict === 'identifiable_effect'
    ? (positive ? 'positive' as const : 'neutral' as const)
    : f.verdict === 'no_resolvable_effect'
      ? 'negative' as const
      : 'unknown' as const
  const metrics: Record<string, number> = {}
  if (effectText !== null && f.effect !== null && f.effect !== undefined) metrics.effect = f.effect
  if (typeof f.mde === 'number') metrics.mde = f.mde

  const scope = scopeOf(f.lineId ? 'line' : 'channel', f.lineId ?? '')
  const evidence: ExperienceEvidence = {
    interventionEventId: f.eventId,
    ...(f.recipeRunId ? { recipeRunId: f.recipeRunId } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    ...(f.criterion ? { criterion: f.criterion } : {}),
  }
  return {
    title: `干预判定 ${f.verdict}：${f.nodeName ?? '节点'}`,
    content: segmentCJK(parts.join('；')),
    outcome,
    status: scope.status,
    scopeKind: scope.scopeKind,
    scopeKey: scope.scopeKey,
    importance: f.verdict === 'identifiable_effect' ? 0.9 : 0.6,
    sessionId: '',
    dedupKey: `exp:int:${f.eventId}`,
    evidence,
    metrics,
  }
}

/** 统一蒸馏入口（未知 source → null，防御性） */
export function distillExperience(fact: ExperienceFact): DistilledExperience | null {
  switch (fact.source) {
    case 'task': return distillTaskFact(fact)
    case 'review': return distillReviewFact(fact)
    case 'intervention': return distillInterventionFact(fact)
    default: return null
  }
}

export interface ReflectResult {
  written: boolean
  id?: string
  dedupKey?: string
  reason?: string
}

/**
 * 蒸馏并落库（含向量化）。
 * 失败不抛出：学习环故障绝不打断产线主链路（调用方已 try/catch，本层再兜一层）。
 */
export async function reflectExperience(
  repo: MemoryRepo,
  embedder: EmbeddingProvider | null,
  fact: ExperienceFact,
  options: { industrialScopeEnabled?: boolean } = {},
): Promise<ReflectResult> {
  const distilled = distillExperience(fact)
  if (!distilled) return { written: false, reason: 'nothing-to-distill' }
  const industrialEnabled = options.industrialScopeEnabled ?? (channelModeOf(fact.channelId) === 'production_line_integrated')
  if (!industrialEnabled && (distilled.scopeKind === 'line' || distilled.scopeKind === 'product' || distilled.scopeKind === 'global')) {
    distilled.scopeKind = 'channel'
    distilled.scopeKey = ''
    distilled.status = 'active'
  }
  try {
    if (!industrialEnabled) {
      const previous = repo.findByAgentDedup(fact.channelId, fact.agentId, distilled.dedupKey)
      const row = previous ? repo.getById(previous.id) : null
      if (row?.kind === 'experience' && (row.scopeKind === 'line' || row.scopeKind === 'product' || row.scopeKind === 'global')) {
        return { written: false, reason: 'industrial experience requires production_line_integrated mode' }
      }
    }
    const { id } = repo.upsertExperience({
      channelId: fact.channelId,
      agentId: fact.agentId,
      kind: 'experience',
      title: distilled.title,
      titleFts: segmentCJK(distilled.title),
      content: distilled.content,
      importance: distilled.importance,
      taskId: fact.source === 'task' ? fact.taskId : (fact.source === 'review' ? fact.taskId ?? null : null),
      sessionId: distilled.sessionId,
      dedupKey: distilled.dedupKey,
      outcome: distilled.outcome,
      evidence: distilled.evidence,
      scopeKind: distilled.scopeKind,
      scopeKey: distilled.scopeKey,
      status: distilled.status,
      expiresAt: null,
    })
    await vectorizeMemory(repo, embedder, fact.channelId, fact.agentId, distilled.dedupKey, distilled.content)
    return { written: true, id, dedupKey: distilled.dedupKey }
  }
  catch (err) {
    return { written: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
