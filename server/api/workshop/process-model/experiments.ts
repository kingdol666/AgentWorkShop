/**
 * GET /api/workshop/process-model/experiments?lineId= —— 模拟参数试验计划列表(非 admin 必须带 lineId)
 * POST —— 创建计划(仅 simulated 产线;真实线 SIM_ONLY_VIOLATION;创建入册 D16/SW1.6)
 */
import { getQuery, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { filterByLine } from '@/server/services/workshop/permissions'
import { createExperimentPlan, listExperimentPlans } from '@/server/services/workshop/process-model/experiment'
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
  })
  const planDetail = JSON.parse(plan.planJson || '{}') as { repeats?: number, specId?: string | null }
  recordConfigAction(user, 'process_model.experiment.create', { kind: 'process_model_experiment', id: plan.id },
    `创建模拟试验计划 ${plan.id}(line=${lineId},repeats=${planDetail.repeats ?? '?'})`, { lineId, specId: planDetail.specId ?? undefined }, lineId)
  return { plan }
})
