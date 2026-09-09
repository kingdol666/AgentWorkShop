/**
 * GET /api/workshop/aml/jobs/:id/logs —— 运行日志尾随(?lines=80;活跃作业读内存环,终态读 run.log)。
 * 需产线只读权限。
 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { jobLogsTail } from '@/server/services/workshop/aml/job-orchestrator'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const rt = getAmlRuntime()
  const job = rt.repo.job.get(id)
  if (!job) throw new AppError(404, 'AML_JOB_MISSING', `作业 ${id} 不存在`)
  requireLineMode(user, rt.repo.dataset.get(job.datasetId)?.lineId, 'readonly')
  const q = getQuery(event)
  const lines = Math.min(500, Math.max(10, Number(q.lines) || 80))
  return { logs: jobLogsTail(id, lines) }
})
