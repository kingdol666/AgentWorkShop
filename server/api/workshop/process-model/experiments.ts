/**
 * GET /api/workshop/process-model/experiments?lineId= —— 参数试验计划列表(非 admin 必须带 lineId)
 * POST —— body.action 分派:
 *   (缺省) 创建计划(仿真线→planned 可直接执行;真实线→awaiting_approval,单卡 HITL 批准);
 *   'approve' 人工批准真实线计划(记录批准人/时间入 plan_json);
 *   'run'     执行计划(执行器走 DCW 写咽喉:步限/60s 间隔/保持窗照常生效);
 *   全部动作经 recordConfigAction 入册(D16/SW1.6)。
 */
import { getQuery, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { filterByLine } from '@/server/services/workshop/permissions'
import { createExperimentPlan, listExperimentPlans } from '@/server/services/workshop/process-model/experiment'
import { approveExperimentPlan, runExperimentPlan } from '@/server/services/workshop/process-model/experiment-runner'
import { assertOptimizationAccess, recordConfigAction } from '@/server/services/workshop/optimization/access'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const method = event.method?.toUpperCase() ?? 'GET'
  if (method === 'GET') {
    const q = getQuery(event)
    const lineId = typeof q.lineId === 'string' ? q.lineId : undefined
    if (lineId) assertOptimizationAccess(user, 'read', { kind: 'experiment', lineId })
    const rows = listExperimentPlans(lineId)
    // 无 lineId 时(admin 全量)仍按产线可见性过滤;非 admin 不带 lineId 只能看到自己有权看的产线
    return { plans: user.role === 'admin' ? rows : filterByLine(user, rows, (r: { lineId?: string }) => r.lineId) }
  }
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const action = String(body.action ?? '')
  if (action === 'approve' || action === 'run') {
    const planId = String(body.planId ?? '')
    if (!planId) throw createError({ statusCode: 400, statusMessage: 'planId required' })
    const row = listExperimentPlans(undefined, 500).find(p => p.id === planId)
    if (!row) throw createError({ statusCode: 404, statusMessage: 'plan not found' })
    assertOptimizationAccess(user, 'write', { kind: 'experiment', lineId: row.lineId })
    if (action === 'approve') {
      const approved = approveExperimentPlan(planId, `rest:${user.id}:${Date.now()}`, user.id)
      recordConfigAction(user, 'process_model.experiment.approve', { kind: 'process_model_experiment', id: planId },
        `人工批准试验计划 ${planId}`, { lineId: row.lineId }, row.lineId)
      return { plan: approved }
    }
    const result = await runExperimentPlan(planId)
    recordConfigAction(user, 'process_model.experiment.run', { kind: 'process_model_experiment', id: planId },
      `执行试验计划 ${planId}:${result.status}(${result.executedSteps}/${result.totalSteps} 步)${result.failedReason ? `;${result.failedReason}` : ''}`,
      { lineId: row.lineId }, row.lineId)
    return { result }
  }
  const lineId = String(body.lineId ?? '')
  if (!lineId) throw createError({ statusCode: 400, statusMessage: 'lineId required' })
  assertOptimizationAccess(user, 'write', { kind: 'experiment', lineId })
  const plan = createExperimentPlan({
    lineId,
    specId: typeof body.specId === 'string' ? body.specId : undefined,
    levels: (body.levels ?? {}) as Record<string, number[]>,
    repeats: typeof body.repeats === 'number' ? body.repeats : undefined,
    settleMs: typeof body.settleMs === 'number' ? body.settleMs : undefined,
    observeMs: typeof body.observeMs === 'number' ? body.observeMs : undefined,
    randomizedOrder: body.randomizedOrder !== false,
    abortOnAlarm: body.abortOnAlarm !== false,
    budget: body.budget as { maxRuns?: number, maxDurationMs?: number } | undefined,
    createdBy: user.id,
    targets: body.targets as Record<string, string> | undefined,
    dominantPeriodMs: typeof body.dominantPeriodMs === 'number' ? body.dominantPeriodMs : undefined,
  })
  const planDetail = JSON.parse(plan.planJson || '{}') as { repeats?: number, specId?: string | null }
  recordConfigAction(user, 'process_model.experiment.create', { kind: 'process_model_experiment', id: plan.id },
    `创建模拟试验计划 ${plan.id}(line=${lineId},repeats=${planDetail.repeats ?? '?'})`, { lineId, specId: planDetail.specId ?? undefined }, lineId)
  return { plan }
})
