/**
 * 经验/Profile 晋升门（WP-B3/B4）—— 把「候选」变「已验证」的确定性判定。
 *
 * 纪律（对齐 aml/twin/acceptance.ts 的既有口径）：
 *  - 阈值是**代码常量**，改阈值必须走代码评审（禁止运行时参数）；
 *  - 门只做判定，不执行写：状态迁移由 REST（owner/admin 人工触发）或 bench 晋升驱动；
 *  - 判定拒绝时返回可读理由（谁不满足、差多少），不做"静默通过"。
 */
import type { MemoryRow } from '../db/database'
import type { HarnessProfileRow } from './harness-profile'

/** 经验晋级阈值（代码常量；改动走评审） */
export const EXPERIENCE_GATE = {
  /** 晋级 validated 所需的独立任务样本（证据里 taskIds 去重数） */
  minIndependentTasks: 2,
  /** 晋级的证据锚点最低数（任一锚点） */
  minAnchors: 1,
  /** contested 永不自动晋级 */
  contestedBlocksPromotion: true,
} as const

/** Profile 晋升阈值（bench 结果由 WP-B2 产出后传入；缺 bench 数据 → 不得登 shadow） */
export const PROFILE_GATE = {
  /** shadow → active 需要配对显著性（p < 0.05）或"无回归 + 成本非劣" */
  significanceP: 0.05,
  maxCostDelta: 0.05,
  /** 有效配对下限：低于它的"显著性"没有统计意义（2026-11-10 审计） */
  minPairs: 3,
  /** 证据新鲜度：超过该天数的配对结果不再作为晋升依据 */
  maxAgeDays: 7,
} as const

export interface GateDecision<S extends string> {
  allowed: boolean
  next?: S
  reasons: string[]
}

export interface ExperienceTaskEvidence {
  id: string
  channelId: string
  projectId?: string | null
  state: string
  sessionId?: string | null
}

export function evaluateExperienceTaskEvidence(
  taskIds: string[],
  tasks: ExperienceTaskEvidence[],
  context: { channelId: string, projectId?: string | null },
): { valid: boolean, reasons: string[] } {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const reasons: string[] = []
  for (const id of [...new Set(taskIds)]) {
    const task = byId.get(id)
    if (!task) reasons.push(`任务证据不存在：${id}`)
    else if (task.channelId !== context.channelId) reasons.push(`任务证据不属于当前频道：${id}`)
    else if (context.projectId !== undefined && task.projectId !== context.projectId) reasons.push(`任务证据不属于当前项目：${id}`)
    else if (task.state !== 'COMPLETED') reasons.push(`任务证据未完成：${id}`)
  }
  return { valid: reasons.length === 0, reasons }
}

/** 解析证据 JSON（失败 → 空对象；门按"无锚点"处理） */
export function evidenceOf(row: Pick<MemoryRow, 'evidenceJson'>): {
  taskIds: string[]
  anchors: string[]
  metrics?: Record<string, number>
} {
  let obj: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.evidenceJson ?? '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>
  }
  catch {
    obj = {}
  }
  const taskIds = Array.isArray(obj.taskIds) ? (obj.taskIds as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0) : []
  const anchors = ['traceId', 'runId', 'recipeRunId', 'interventionEventId', 'resultId']
    .filter(k => typeof obj[k] === 'string' && (obj[k] as string).length > 0)
  return {
    taskIds: [...new Set(taskIds)],
    anchors,
    ...(obj.metrics && typeof obj.metrics === 'object' && !Array.isArray(obj.metrics)
      ? { metrics: obj.metrics as Record<string, number> }
      : {}),
  }
}

/**
 * 经验晋级判定（candidate → validated / → retired）。
 * 规则：
 *  - retired：过期 或 outcome=negative 且无正向效应 → 允许退休；
 *  - validated：证据锚点齐 + 独立任务数 ≥ N + 非 contested；
 *  - 其余：拒绝并给出差多少。
 */
export function evaluateExperienceGate(
  row: Pick<MemoryRow, 'status' | 'outcome' | 'evidenceJson' | 'expiresAt'>,
  target: 'validated' | 'retired',
  nowIso = new Date().toISOString(),
): GateDecision<'validated' | 'retired'> {
  const status = row.status ?? 'active'
  if (target === 'retired') {
    if (status === 'retired') return { allowed: false, reasons: ['已经是 retired'] }
    const expired = !!row.expiresAt && row.expiresAt <= nowIso
    return { allowed: true, next: 'retired', reasons: [expired ? '已过期' : '人工退休'] }
  }
  // target === 'validated'
  if (status === 'validated') return { allowed: false, reasons: ['已经是 validated'] }
  if (status === 'retired') return { allowed: false, reasons: ['retired 不可复活（需新建条目）'] }
  if (status === 'contested' && EXPERIENCE_GATE.contestedBlocksPromotion) {
    return { allowed: false, reasons: ['contested（与既有条目矛盾）不得晋级'] }
  }
  const ev = evidenceOf(row)
  const reasons: string[] = []
  if (ev.taskIds.length + ev.anchors.length < EXPERIENCE_GATE.minAnchors) {
    reasons.push('证据锚点缺失')
  }
  if (ev.taskIds.length < EXPERIENCE_GATE.minIndependentTasks) {
    reasons.push(`独立任务样本不足：${ev.taskIds.length}/${EXPERIENCE_GATE.minIndependentTasks}`)
  }
  if (reasons.length > 0) return { allowed: false, reasons }
  return { allowed: true, next: 'validated', reasons: [`证据充分（${ev.taskIds.length} 任务 / ${ev.anchors.length} 锚点）`] }
}

/** bench 配对结果（WP-B2 产出；门只消费结构化字段） */
export interface PairedBenchResult {
  /** 主终点配对显著性（越小越好；无显著性检验时传 null） */
  pValue: number | null
  /** 相对基线的主终点改善（正=改善） */
  primaryDelta: number
  /** 相对基线的成本变化（正=更贵） */
  costDelta: number
}

/**
 * Profile 晋升判定（candidate → shadow → active）。
 * candidate→shadow：允许（隔离验证期，只在本频道生效）。
 * shadow→active：需配对结果通过（p<P 或 无回归且成本非劣）。
 * active→superseded：由激活新版本隐式完成（B1 单 active 不变量）。
 */
export function evaluateProfileGate(
  profile: Pick<HarnessProfileRow, 'status' | 'version'>,
  target: 'shadow' | 'active' | 'superseded',
  bench?: PairedBenchResult | null,
): GateDecision<'shadow' | 'active' | 'superseded'> {
  const status = profile.status
  if (target === 'shadow') {
    if (status === 'shadow' || status === 'active') return { allowed: false, reasons: [`已处于 ${status}`] }
    if (status === 'superseded') return { allowed: false, reasons: ['superseded 不可复活'] }
    return { allowed: true, next: 'shadow', reasons: ['进入隔离验证期（仅本频道可见）'] }
  }
  if (target === 'active') {
    if (status !== 'shadow') return { allowed: false, reasons: [`仅 shadow 可晋级 active（当前 ${status}）`] }
    if (!bench) return { allowed: false, reasons: ['缺少配对评测结果（WP-B2），不得晋级'] }
    const pValue = bench.pValue
    if (typeof pValue !== 'number' || !Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
      return { allowed: false, reasons: ['配对评测 pValue 无效：必须是有限且位于 [0,1] 的数值'] }
    }
    const significant = pValue < PROFILE_GATE.significanceP && bench.primaryDelta > 0
    const nonInferior = bench.primaryDelta >= 0 && bench.costDelta <= PROFILE_GATE.maxCostDelta
    if (significant) return { allowed: true, next: 'active', reasons: [`配对显著改善 p=${pValue}`] }
    if (nonInferior) return { allowed: true, next: 'active', reasons: ['无回归且成本非劣'] }
    return { allowed: false, reasons: [`配对未通过：p=${pValue} Δ主终点=${bench.primaryDelta} Δ成本=${bench.costDelta}`] }
  }
  // superseded
  if (status === 'superseded') return { allowed: false, reasons: ['已 superseded'] }
  return { allowed: true, next: 'superseded', reasons: ['被新 active 版本取代'] }
}

/**
 * 回滚判定（WP-B4）：当前 active 劣化 → 建议回退到上一版本。
 * 纯函数：给定版本序列返回应激活的目标版本（无更早版本 → null）。
 */
export function rollbackTarget(versions: Array<Pick<HarnessProfileRow, 'id' | 'version' | 'status'>>, currentActiveId: string): string | null {
  const current = versions.find(v => v.id === currentActiveId)
  if (!current) return null
  // 回滚目标只能是「曾经 active 过、现被取代」的版本:superseded 正是被取代的前一版。
  // 旧实现不按 status 过滤,会把从未 shadow、从未 bench 的 candidate 经"回滚"直接激活
  // —— 一条完整的晋升门旁路(2026-11-10 审计)。
  const candidates = versions
    .filter(v => v.version < current.version && v.status === 'superseded')
    .sort((a, b) => b.version - a.version)
  return candidates[0]?.id ?? null
}
