/**
 * 参数试验计划执行器(科学探索计划 P4,docs/plans/2026-11-02-scientific-exploration-plan.md):
 * 把 process_model_experiments 从"仅仿真线可建"升级为**治理分档**:
 *  - simulated=true → tier=sim_auto:建计划即可执行(既有行为不变);
 *  - 真实线 → tier=real_hitl:建计划落 awaiting_approval,须单卡 HITL 批准(卡上带成本核算)
 *    后转 planned 才能执行。
 * 执行语义(正交化由机制保证,不靠 Agent 自觉):
 *  - 步序 = repeats × levels,默认 seeded 随机化(randomizedOrder=false 时按原序);
 *  - 每步:写控制(走 DcwController.write 咽喉,source=agent → 步长/60s 间隔/保持窗照常生效)
 *    → 等 settleMs → 等 observeMs → 下一步;
 *  - 预算:步数上限 + 总时长上限,超限即 FAILED 并写明原因(不静默续跑);
 *  - abortOnAlarm:每步前查告警,命中即 FAILED(剩余步不执行);
 *  - 台账:写咽喉已自动落 intervention_events(hypothesis 前缀 [pexp:<id>] 建立关联),
 *    计划结束时按台账汇总 verdict 分布进计划状态。
 * 副作用全部经注入(测试可替换),默认实现走真实控制器/数采/告警仓储。
 */
import { createHash } from 'node:crypto'
import { AppError } from '../../../utils/errors'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { getDcwController } from '../dcw/dcw-controller'
import { getRecipeRollBackManager } from '../dcw/recipe-rollback-manager'
import { getDaqController } from '../daq/daq-controller'
import { getAmlRuntime } from '../aml/runtime'
import { getExperimentPlan, updateExperimentStatus, type ExperimentPlanRow } from './experiment'
import { assessIdentifiability, dominantPeriod } from '../aml/identifiability'
import { attachAssessment, listInterventions, verdictCodeOf, verdictDetailOf } from '../aml/intervention-ledger'
import { backfillInterventionEvidence } from '../aml/ontology-learning'
import { assertPlanNodesSafe } from './plan-safety'

export interface ExperimentPlanBody {
  version: 1
  lineId: string
  simSceneId: string | null
  specId: string | null
  levels: Record<string, number[]>
  repeats: number
  settleMs: number
  observeMs: number
  randomizedOrder: boolean
  abortOnAlarm: boolean
  design: string
  tier?: 'sim_auto' | 'real_hitl'
  /** 主控制量 → 观测目标节点(执行时读回);缺省取 spec 或首个控制量,无目标则跳过判读 */
  targets?: Record<string, string>
  /** 创建时核算的成本(人读 + 机读) */
  cost?: ExperimentCost
  /** 真实线批准凭据(approveExperimentPlan 写入) */
  approvalId?: string
  approvedBy?: string
  approvedAt?: string
  /** 人工取消凭据(运行中每步前被感知) */
  cancelledBy?: string
  cancelledAt?: string
  note?: string
}

export interface ExperimentCost {
  /** 各控制量中最大的水平数(展示用) */
  levelsPerControl: number
  /** 全部控制量水平数之和(步数基数) */
  levelsTotal: number
  controls: number
  repeats: number
  steps: number
  perStepMs: number
  totalDurationMs: number
  /** 建议的单步响应窗(ms):已知主导周期时为 3×周期,否则 = settleMs */
  suggestedWindowMs: number | null
  dominantPeriodMs: number | null
  summary: string
}

export interface ExperimentStep {
  index: number
  controlId: string
  level: number
  repeat: number
}

/** 真/仿真产线分档(不 throw:调用方按 tier 决定是否挂 HITL) */
export function resolveExperimentTier(lineId: string): { lineId: string, lineName: string, simulated: boolean, tier: 'sim_auto' | 'real_hitl', simSceneId?: string } {
  const line = getDcwLineRepo().byId(lineId)
  if (!line) throw new AppError(404, 'LINE_NOT_FOUND', `产线 ${lineId} 不存在`)
  const simulated = line.simulated === true
  return { lineId: line.id, lineName: line.name, simulated, tier: simulated ? 'sim_auto' : 'real_hitl', simSceneId: line.simSceneId }
}

/** 真实线下 60s 节点最小间隔(与 write() 的在线写联锁同口径) */
const REAL_MIN_STEP_MS = 60_000

/**
 * 成本核算(创建时就算给用户看):步数 × 每步驻留。真实线每步至少 60s(写间隔联锁),
 * 仿真线不受此限。已知主导周期时,建议窗 = 3×周期,单步驻留取 max(settle, 建议窗, 60s)。
 */
export function estimateExperimentCost(plan: Pick<ExperimentPlanBody, 'levels' | 'repeats' | 'settleMs' | 'observeMs' | 'tier'>, opts: { dominantPeriodMs?: number | null } = {}): ExperimentCost {
  const controls = Object.keys(plan.levels).length
  const levelsPerControl = Math.max(0, ...Object.values(plan.levels).map(v => v.length))
  // 步数 = 各控制量水平数之和 × 轮数(不是 max×控制量数 —— 控制量水平数可以不同)
  const levelsTotal = Object.values(plan.levels).reduce((a, v) => a + v.length, 0)
  const repeats = plan.repeats
  const steps = levelsTotal * repeats
  const period = opts.dominantPeriodMs ?? null
  const suggestedWindowMs = period != null && period > 0 ? Math.round(3 * period) : null
  const minStep = plan.tier === 'real_hitl' ? REAL_MIN_STEP_MS : 0
  const holdMs = Math.max(plan.settleMs, suggestedWindowMs ?? 0, minStep)
  const perStepMs = holdMs + plan.observeMs
  const totalDurationMs = steps * perStepMs
  const summary = `${controls} 个控制量共 ${levelsTotal} 个水平 × ${repeats} 轮 = ${steps} 步;每步 ${Math.round(perStepMs / 1000)}s(驻留 ${Math.round(holdMs / 1000)}s${
    suggestedWindowMs != null ? `,含 3×主导周期 ${(suggestedWindowMs / 1000).toFixed(1)}s` : ''
  }${minStep ? ',真实线 60s 写间隔下限' : ''} + 观测 ${Math.round(plan.observeMs / 1000)}s);预计总时长 ≈ ${(totalDurationMs / 3600_000).toFixed(2)} 小时`
  return { levelsPerControl, levelsTotal, controls, repeats, steps, perStepMs, totalDurationMs, suggestedWindowMs, dominantPeriodMs: period, summary }
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0
  const rnd = () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/**
 * 生成执行步序:按 repeats × (control,level) 展开,randomizedOrder 时用计划 id 派生种子洗牌
 * (同一计划可复现;跨控制量也打散,避免"先把一个 MV 走完再走另一个"带来的时间混杂)。
 */
export function buildExperimentSteps(plan: ExperimentPlanBody, planId: string): ExperimentStep[] {
  const base: Array<{ controlId: string, level: number, repeat: number }> = []
  for (let r = 0; r < plan.repeats; r++) {
    for (const [controlId, levels] of Object.entries(plan.levels)) {
      for (const level of levels) base.push({ controlId, level, repeat: r })
    }
  }
  const seed = createHash('sha256').update(planId).digest().readUInt32BE(0)
  const ordered = plan.randomizedOrder ? seededShuffle(base, seed) : base
  return ordered.map((s, index) => ({ index, ...s }))
}

export function parsePlan(row: ExperimentPlanRow): ExperimentPlanBody {
  return JSON.parse(row.planJson) as ExperimentPlanBody
}

/**
 * 人工取消计划(运行中/待批准/已计划均可)。
 * 执行器每步前读状态,感知到 cancelled 即停;已执行步的台账/证据保留。
 */
export function cancelExperimentPlan(id: string, actor: string): ExperimentPlanRow {
  const row = getExperimentPlan(id)
  if (!row) throw new AppError(404, 'EXPERIMENT_PLAN_NOT_FOUND', `试验计划 ${id} 不存在`)
  if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
    throw new AppError(409, 'EXPERIMENT_STATUS_INVALID', `计划 ${id} 已是终态 ${row.status},无需取消`)
  }
  const plan = parsePlan(row)
  const next: ExperimentPlanBody = { ...plan, cancelledBy: actor, cancelledAt: new Date().toISOString() }
  getAmlRuntime().db.prepare('UPDATE process_model_experiments SET plan_json = ?, status = \'cancelled\', updated_at = ? WHERE id = ?')
    .run(JSON.stringify(next), new Date().toISOString(), id)
  return getExperimentPlan(id)!
}

/** 真实线批准:awaiting_approval → planned(记录批准凭据;幂等) */
export function approveExperimentPlan(id: string, approvalId: string, approvedBy: string): ExperimentPlanRow {
  const row = getExperimentPlan(id)
  if (!row) throw new AppError(404, 'EXPERIMENT_PLAN_NOT_FOUND', `试验计划 ${id} 不存在`)
  const plan = parsePlan(row)
  if (row.status === 'planned' && plan.approvalId) return row
  if (row.status !== 'awaiting_approval') {
    throw new AppError(409, 'EXPERIMENT_STATUS_INVALID', `计划 ${id} 当前状态 ${row.status},只有 awaiting_approval 可批准`)
  }
  const next: ExperimentPlanBody = { ...plan, approvalId, approvedBy, approvedAt: new Date().toISOString() }
  const db = getAmlRuntime().db
  db.prepare('UPDATE process_model_experiments SET plan_json = ?, status = \'planned\', updated_at = ? WHERE id = ?')
    .run(JSON.stringify(next), new Date().toISOString(), id)
  return getExperimentPlan(id)!
}

// ---------- 执行 ----------

export interface ExperimentRunnerDeps {
  /** 写控制(默认走 DcwController.write 咽喉;测试注入) */
  write?: (controlId: string, level: number, meta: { hypothesis: string, planId: string, stepIndex: number }) => Promise<{ ok: boolean, message?: string, recordId?: string }>
  /** 关闭单步调控记录(默认 judge=rollback 关闭不执行回退;测试注入) */
  closeRecord?: (recordId: string, reason: string) => void
  /** 读目标窗均值(默认 daq samples;测试注入) */
  readTargetMean?: (targetNodeId: string, fromMs: number, toMs: number) => Promise<number | null>
  /** 读目标窗序列(默认 daq samples;判定用;缺省跳过引擎判读) */
  readTargetSeries?: (targetNodeId: string, fromMs: number, toMs: number) => Promise<number[]>
  /** 告警检查(默认查 audit_log 最近一条 level=error 的 alarm 行;测试注入) */
  alarmActive?: (lineId: string, sinceMs: number) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  /** 时钟(测试可推进) */
  now?: () => number
}

export interface ExperimentRunResult {
  planId: string
  status: 'done' | 'failed' | 'cancelled'
  executedSteps: number
  totalSteps: number
  failedReason?: string
  verdicts: Record<string, number>
  startedAt: string
  finishedAt: string
}

function defaultWrite(): NonNullable<ExperimentRunnerDeps['write']> {
  return async (controlId, level, meta) => {
    try {
      const outcome = await getDcwController().write(controlId, level, null, {
        source: 'agent',
        actor: `plan:${meta.planId}`,
        actorName: `试验计划 ${meta.planId}`,
        hypothesis: meta.hypothesis,
      })
      return { ok: outcome.ok !== false, message: outcome.message, recordId: outcome.recordId }
    }
    catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
}

/**
 * 关闭单步的调控闭环记录(默认实现):不关闭会让下一步被"单一开放记录"守卫拒绝
 * (beforeWrite: 正在优化试验中)。judge('rollback') 按设计只落判定、记录仍 open,
 * 因此用 keep + takeover:关闭记录但**跳过好锚晋升**(试验步是探索,不是产能优化,
 * 不应污染 keep 锚点链)。
 */
function defaultCloseRecord(): NonNullable<ExperimentRunnerDeps['closeRecord']> {
  return (recordId, reason) => {
    try {
      getRecipeRollBackManager().judge(recordId, 'keep', reason, 'system', 'experiment-plan', { takeover: true })
    }
    catch { /* 已关闭/记录不存在:不影响执行 */ }
  }
}

const sleepReal = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function runExperimentPlan(id: string, deps: ExperimentRunnerDeps = {}): Promise<ExperimentRunResult> {
  const row = getExperimentPlan(id)
  if (!row) throw new AppError(404, 'EXPERIMENT_PLAN_NOT_FOUND', `试验计划 ${id} 不存在`)
  const plan = parsePlan(row)
  const tier = plan.tier ?? (resolveExperimentTier(plan.lineId).tier)
  if (row.status === 'running') {
    // 僵死 running 恢复:进程崩溃/重启会把状态永久停在 running(不可重跑也不可取消)。
    // 超过预算上限 + 5min 无更新即判僵死 → 置 failed 并提示可重新创建计划。
    const budgetRaw = JSON.parse(row.budgetJson || '{}') as { maxDurationMs?: number }
    const staleMs = (budgetRaw.maxDurationMs ?? 4 * 3600_000) + 5 * 60_000
    const age = Date.now() - Date.parse(row.updatedAt)
    if (Number.isFinite(age) && age > staleMs) {
      updateExperimentStatus(id, 'failed')
      throw new AppError(409, 'EXPERIMENT_RUN_STALE', `计划 ${id} 上一次执行僵死(超过 ${Math.round(staleMs / 60000)} min 无更新),已置 failed;请重新创建计划(旧计划的台账行仍可查)`)
    }
    throw new AppError(409, 'EXPERIMENT_ALREADY_RUNNING', `计划 ${id} 正在执行`)
  }
  // 语义优先:待批准的真实线计划报"缺批准"而不是泛化的"状态非法"
  if (row.status === 'awaiting_approval' && tier === 'real_hitl') {
    throw new AppError(409, 'EXPERIMENT_APPROVAL_REQUIRED', `计划 ${id} 为真实产线计划且尚未批准:须先 HITL 批准(approve)后才能执行`)
  }
  if (row.status !== 'planned') {
    throw new AppError(409, 'EXPERIMENT_STATUS_INVALID', `计划 ${id} 当前状态 ${row.status},只有 planned 可执行${tier === 'real_hitl' ? '(真实线须先 HITL 批准)' : ''}`)
  }
  // 真实线执行前复核批准凭据(防"建完直接跑"绕过 HITL)
  if (tier === 'real_hitl' && !plan.approvalId) {
    throw new AppError(409, 'EXPERIMENT_APPROVAL_REQUIRED', `计划 ${id} 为真实产线计划,缺少 HITL 批准凭据,拒绝执行`)
  }
  // 执行前复核(防御深度):批准到执行之间产线/节点可能变更(换线、停用、量程调整)。
  // 只对真实线强校验;仿真线计划允许过程模型 MV 逻辑名(不落设备,写入时由 write() 兜底)。
  if (tier === 'real_hitl') assertPlanNodesSafe(plan)
  const budget = JSON.parse(row.budgetJson) as { maxRuns?: number, maxDurationMs?: number }
  const steps = buildExperimentSteps(plan, id)
  if (budget.maxRuns && steps.length > budget.maxRuns) {
    updateExperimentStatus(id, 'failed')
    return {
      planId: id, status: 'failed', executedSteps: 0, totalSteps: steps.length,
      failedReason: `步数 ${steps.length} 超预算 maxRuns=${budget.maxRuns}(创建即拒绝执行)`,
      verdicts: {}, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }
  }

  const write = deps.write ?? defaultWrite()
  const closeRecord = deps.closeRecord ?? defaultCloseRecord()
  const readTarget = deps.readTargetMean ?? (async (nodeId, fromMs, toMs) => {
    try {
      const pts = await getDaqController().samples(nodeId, { fromMs, toMs, bucketMs: 1000, limit: 600 }) as Array<{ value?: number, avg?: number }>
      const vals = pts.map(p => Number(p.value ?? p.avg)).filter(Number.isFinite)
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
    }
    catch {
      return null
    }
  })
  const alarmActive = deps.alarmActive ?? (async (lineId, sinceMs) => {
    try {
      const hit = getAmlRuntime().db.prepare(`SELECT id FROM audit_log WHERE line_id = ? AND level = 'error' AND created_at >= ? LIMIT 1`)
        .get(lineId, new Date(sinceMs).toISOString()) as { id?: string } | undefined
      return !!hit
    }
    catch {
      return false
    }
  })
  const readSeries = deps.readTargetSeries ?? (async (nodeId, fromMs, toMs) => {
    try {
      const pts = await getDaqController().samples(nodeId, { fromMs, toMs, bucketMs: 1000, limit: Math.max(60, Math.ceil((toMs - fromMs) / 1000) + 10) }) as Array<{ value?: number, avg?: number }>
      return pts.map(p => Number(p.value ?? p.avg)).filter(Number.isFinite)
    }
    catch {
      return []
    }
  })
  const sleep = deps.sleep ?? sleepReal
  const now = deps.now ?? (() => Date.now())

  updateExperimentStatus(id, 'running')
  const startedAt = new Date(now()).toISOString()
  const started = now()
  // 计划级主导周期估计:用一段长历史(≥30min 与 6×settle 的较大者)估一次,
  // 逐步判定统一使用 —— 短窗局部自相关会把局部纹波当周期(事故形态)。
  let expectedPeriodMs: number | undefined
  const firstTarget = plan.targets ? Object.values(plan.targets)[0] : undefined
  if (firstTarget) {
    try {
      const longMs = Math.max(30 * 60_000, plan.settleMs * 6)
      const longSeries = await readSeries(firstTarget, now() - longMs, now())
      if (longSeries.length >= 64) {
        const p = dominantPeriod(longSeries)
        // 长历史必须覆盖 ≥3 个周期才采信该估计
        if (p.lagBeats != null && longSeries.length / p.lagBeats >= 3) expectedPeriodMs = p.lagBeats * 1000
      }
    }
    catch { /* 估计失败退回逐步检测 */ }
  }
  let executed = 0
  let failedReason: string | undefined

  // 真实线每步驻留不得低于写联锁的 60s 节点间隔(否则第 2 步必被 429 打回,白跑)
  const holdMs = tier === 'real_hitl' ? Math.max(plan.settleMs, REAL_MIN_STEP_MS) : plan.settleMs
  for (const step of steps) {
    // 取消:每步前读一次计划状态(REST cancel 是异步人工操作,必须能被及时感知)
    const live = getExperimentPlan(id)
    if (live?.status === 'cancelled') {
      failedReason = `计划被人工取消(已执行 ${executed}/${steps.length} 步)`
      break
    }
    // 预算:总时长超限即停(不静默续跑)
    if (budget.maxDurationMs && now() - started > budget.maxDurationMs) {
      failedReason = `超出预算 maxDurationMs=${budget.maxDurationMs}ms(已执行 ${executed}/${steps.length} 步)`
      break
    }
    if (plan.abortOnAlarm && await alarmActive(plan.lineId, started)) {
      failedReason = `告警中止(abortOnAlarm):第 ${executed + 1} 步前检测到产线告警,剩余 ${steps.length - executed} 步未执行`
      break
    }
    const hypothesis = `[pexp:${id}] 试验步 ${step.index + 1}/${steps.length}:${step.controlId}=${step.level}(第 ${step.repeat + 1} 轮)`
    const res = await write(step.controlId, step.level, { hypothesis, planId: id, stepIndex: step.index })
    if (!res.ok) {
      failedReason = `第 ${step.index + 1} 步写入被拒:${res.message ?? '未知原因'}`
      break
    }
    executed++
    const writeAt = now()
    await sleep(holdMs)
    // 观测窗 + 引擎判读:有目标映射时,写前窗/写后窗各取一次序列交给可辨识性引擎,
    // 判定回填本步干预台账(与 optimization_explore 同口径);无目标则只驻留。
    const target = plan.targets?.[step.controlId]
    if (target) {
      const pre = await readSeries(target, writeAt - holdMs, writeAt)
      await sleep(plan.observeMs)
      const post = await readSeries(target, writeAt, now())
      await readTarget(target, writeAt, now())
      if (pre.length >= 8 && post.length >= 8) {
        try {
          const v = assessIdentifiability({ pre, post, beatMs: 1000, ...(expectedPeriodMs != null ? { expectedPeriodMs } : {}) })
          // 写咽喉落行时若无 targetNodeId 会标 unassessed(尚无判定)—— 两者都视为"待判定"
          const row = listInterventions({ nodeId: step.controlId, limit: 50 })
            .find(r => r.hypothesis.startsWith(`[pexp:${id}]`) && (r.verdict === 'pending' || r.verdict === 'unassessed'))
          if (row) {
            attachAssessment(row.id, {
              verdict: verdictCodeOf(v),
              effect: v.effect,
              ciLow: v.ciLow,
              ciHigh: v.ciHigh,
              mde: v.mde,
              targetNodeId: target,
              detail: verdictDetailOf(v),
            })
            // P6:判定回灌本体证据(有已发布本体才落;幂等)
            const updated = listInterventions({ nodeId: step.controlId, limit: 1 })[0]
            if (updated) {
              try {
                backfillInterventionEvidence(updated)
              }
              catch { /* 证据登记失败不影响执行 */ }
            }
          }
        }
        catch { /* 判读失败按未判定处理 */ }
      }
    }
    else {
      await sleep(plan.observeMs)
    }
    // 关闭本步调控记录(否则下一步会被"单一开放记录"守卫拒绝)
    if (res.recordId) closeRecord(res.recordId, `试验计划 ${id} 第 ${step.index + 1} 步执行完成,由计划执行器关闭(关闭记录不晋升锚点)`)
  }

  // 台账汇总:按 hypothesis 前缀 [pexp:<id>] 找本次计划的干预行
  const verdicts: Record<string, number> = {}
  try {
    const involved = new Set(Object.keys(plan.levels))
    const rows = listInterventions({ lineId: plan.lineId, limit: 200 })
      .filter(r => involved.has(r.nodeId) && r.hypothesis.startsWith(`[pexp:${id}]`))
    for (const r of rows) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1
  }
  catch { /* 台账不可读不影响执行结果 */ }

  const cancelled = failedReason?.includes('人工取消') ?? false
  const status: ExperimentRunResult['status'] = cancelled ? 'cancelled' : (failedReason ? 'failed' : 'done')
  updateExperimentStatus(id, status)
  return {
    planId: id,
    status,
    executedSteps: executed,
    totalSteps: steps.length,
    ...(failedReason ? { failedReason } : {}),
    verdicts,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
  }
}
