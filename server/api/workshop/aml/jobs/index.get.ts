/**
 * GET /api/workshop/aml/jobs —— 作业列表(status/datasetId 过滤;产线可见性过滤)。
 *
 * 2026-11-09: query 收敛到 zod。空串=未提供语义不变(处理器内归一)。
 */
import { getValidatedQuery } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { filterByLine } from '@/server/services/workshop/permissions'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'

const schema = z.object({
  status: z.string().optional(),
  datasetId: z.string().optional(),
})

const strOf = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim())

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = await getValidatedQuery(event, zValidator(schema))
  const rt = getAmlRuntime()
  const jobs = rt.repo.job.list({
    status: strOf(q.status),
    datasetId: strOf(q.datasetId),
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
