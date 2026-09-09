/**
 * GET /api/workshop/aml/models —— 模型注册表(stage/product/recipe 过滤;产线可见性过滤)。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { filterByLine } from '@/server/services/workshop/permissions'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const s = (k: string): string | undefined => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined)
  const rt = getAmlRuntime()
  const models = rt.repo.model.list({
    stage: s('stage'),
    productId: s('productId'),
    recipeId: s('recipeId'),
    limit: 200,
  })
  const lineByDataset = new Map<string, string | null>()
  const lineOf = (datasetId: string): string | null => {
    if (!lineByDataset.has(datasetId)) lineByDataset.set(datasetId, rt.repo.dataset.get(datasetId)?.lineId ?? null)
    return lineByDataset.get(datasetId) ?? null
  }
  const visible = filterByLine(user, models, m => lineOf(m.datasetId))
  return {
    models: visible.map(m => ({
      ...m,
      metrics: (() => {
        try {
          return JSON.parse(m.metricsJson)
        }
        catch {
          return null
        }
      })(),
      ioSpec: (() => {
        try {
          return JSON.parse(m.ioSpecJson)
        }
        catch {
          return null
        }
      })(),
    })),
  }
})
