/**
 * POST /api/workshop/aml/jobs/:id/cancel —— 取消作业(排队/运行中;需产线可操控权限)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { cancelJob } from '@/server/services/workshop/aml/job-orchestrator'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const rt = getAmlRuntime()
  const job = rt.repo.job.get(id)
  if (!job) throw new AppError(404, 'AML_JOB_MISSING', `作业 ${id} 不存在`)
  requireLineMode(user, rt.repo.dataset.get(job.datasetId)?.lineId, 'operate')
  const ok = cancelJob(id, { id: user.id, kind: 'user' })
  return { ok }
})
