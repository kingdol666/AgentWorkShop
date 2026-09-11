/**
 * GET /api/workshop/aml —— 平台概览(运行时状态 + 环境自检 + 近期数据集/模型/作业计数)。
 * env 内联进来让首屏一次请求就能渲染「运行环境」面板,避免额外往返;
 * 完整环境详情(含任务日志)仍由 GET /aml/env 提供。
 */
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { runtimeStatus } from '@/server/services/workshop/aml/job-orchestrator'
import { envStatus } from '@/server/services/workshop/aml/env-manager'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const rt = getAmlRuntime()
  const status = await runtimeStatus()
  const env = await envStatus()
  return {
    runtime: status,
    env: {
      amlRoot: env.amlRoot,
      amlRootSource: env.amlRootSource,
      uv: env.uv,
      venv: env.venv,
      disk: env.disk,
      preflight: env.preflight,
      task: env.task ? { id: env.task.id, kind: env.task.kind, status: env.task.status } : null,
    },
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
