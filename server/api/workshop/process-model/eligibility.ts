/**
 * GET /api/workshop/process-model/eligibility?specId= —— 最新资格报告
 * POST —— 从不可变数据集重建序列并评估(body: { specId, specVersion?, datasetId, scope?, actionEvidence? })
 * 归属:spec 的产线可见性(readonly);评估动作入册(D16/SW1.6)。
 */
import { getQuery, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { getEligibilityRepo } from '@/server/services/workshop/process-model/eligibility'
import { evaluateEligibilityFromDataset } from '@/server/services/workshop/process-model/eligibility-service'
import { assertOptimizationAccess, recordConfigAction } from '@/server/services/workshop/optimization/access'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const method = event.method?.toUpperCase() ?? 'GET'
  if (method === 'GET') {
    const q = getQuery(event)
    const specId = String(q.specId ?? '')
    if (!specId) throw createError({ statusCode: 400, statusMessage: 'specId required' })
    assertOptimizationAccess(user, 'read', { kind: 'eligibility', specId })
    return { report: getEligibilityRepo().latest(specId), history: getEligibilityRepo().list(specId, 10) }
  }
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const specId = String(body.specId ?? '')
  const datasetId = String(body.datasetId ?? '')
  if (!specId || !datasetId) throw createError({ statusCode: 400, statusMessage: 'specId 与 datasetId 必填' })
  const ctx = assertOptimizationAccess(user, 'evaluate', { kind: 'eligibility', specId })
  assertOptimizationAccess(user, 'evaluate', { kind: 'dataset', id: datasetId })
  const report = evaluateEligibilityFromDataset({
    specId,
    specVersion: typeof body.specVersion === 'number' ? body.specVersion : undefined,
    datasetId,
    scope: body.scope === 'simulation' ? 'simulation' : 'real',
    evidenceVersion: typeof body.evidenceVersion === 'string' ? body.evidenceVersion : undefined,
  })
  recordConfigAction(user, 'process_model.eligibility.evaluate', { kind: 'process_model_eligibility', id: `${specId}@${body.specVersion ?? '?'}` },
    `评估优化资格 ${specId}(eligible=${(report as { optimizationEligible?: boolean }).optimizationEligible === true})`,
    { datasetId, scope: (report as { scope?: string }).scope }, ctx.lineId)
  return { report }
})
