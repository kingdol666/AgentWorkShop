/**
 * GET /api/workshop/aml —— 平台概览(运行时状态 + 近期数据集/模型/作业计数)。
 */
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { runtimeStatus } from '@/server/services/workshop/aml/job-orchestrator'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const rt = getAmlRuntime()
  const status = await runtimeStatus()
  return {
    runtime: status,
    counts: {
      datasets: rt.repo.dataset.list({ limit: 1000 }).length,
      models: rt.repo.model.list({ limit: 1000 }).length,
      productions: rt.repo.model.list({ stage: 'production', limit: 1000 }).length,
    },
    recentDatasets: rt.repo.dataset.list({ limit: 10 }),
    recentModels: rt.repo.model.list({ limit: 10 }),
    recentJobs: rt.repo.job.list({ limit: 10 }),
  }
})
