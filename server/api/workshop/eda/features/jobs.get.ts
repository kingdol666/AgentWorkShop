/**
 * GET /api/workshop/eda/features/jobs —— 特征任务账本(eda_feature_jobs)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { listFeatureJobs } from '@/server/services/workshop/eda/features'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  return { jobs: listFeatureJobs(Number(q.limit) || 50) }
})
