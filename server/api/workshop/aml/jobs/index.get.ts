/**
 * GET /api/workshop/aml/jobs —— 作业列表(status/datasetId 过滤;产线可见性过滤)。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { filterByLine } from '@/server/services/workshop/permissions'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const rt = getAmlRuntime()
  const jobs = rt.repo.job.list({
    status: typeof q.status === 'string' && q.status ? q.status : undefined,
    datasetId: typeof q.datasetId === 'string' && q.datasetId ? q.datasetId : undefined,
    limit: 100,
  })
  // datasetId → lineId 映射(产线可见性过滤;避免逐作业重复查询)
  const lineByDataset = new Map<string, string | null>()
  const lineOf = (datasetId: string): string | null => {
    if (!lineByDataset.has(datasetId)) lineByDataset.set(datasetId, rt.repo.dataset.get(datasetId)?.lineId ?? null)
    return lineByDataset.get(datasetId) ?? null
  }
  return { jobs: filterByLine(user, jobs, j => lineOf(j.datasetId)) }
})
