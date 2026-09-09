/**
 * GET /api/workshop/aml/jobs/:id —— 作业详情(含门禁报告与指标;需产线只读权限)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const rt = getAmlRuntime()
  const job = rt.repo.job.get(id)
  if (!job) throw new AppError(404, 'AML_JOB_MISSING', `作业 ${id} 不存在`)
  requireLineMode(user, rt.repo.dataset.get(job.datasetId)?.lineId, 'readonly')
  return {
    job,
    metrics: job.metricsJson ? JSON.parse(job.metricsJson) : null,
    gates: job.gatesJson ? JSON.parse(job.gatesJson) : null,
  }
})
