/**
 * GET /api/workshop/aml/experiments —— 实验排行榜(datasetId 必选;谱系 + 门禁 + 主指标;需产线只读权限)。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const datasetId = typeof q.datasetId === 'string' ? q.datasetId : ''
  if (!datasetId) throw new AppError(422, 'AML_SPEC_INVALID', '缺少 datasetId')
  const rt = getAmlRuntime()
  const ds = rt.repo.dataset.get(datasetId)
  if (!ds) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${datasetId} 不存在`)
  requireLineMode(user, ds.lineId, 'readonly')
  const experiments = rt.repo.experiment.listByDataset(datasetId, 100).map(e => ({
    ...e,
    metrics: safeJson(e.metricsJson),
    gates: safeJson(e.gatesJson),
  }))
  return { experiments }
})

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  }
  catch {
    return null
  }
}
