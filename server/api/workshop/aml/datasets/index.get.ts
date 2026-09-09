/**
 * GET /api/workshop/aml/datasets —— 数据集列表(产线可见性过滤;line/product/recipe 可选过滤)。
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
  const datasets = filterByLine(
    user,
    getAmlRuntime().repo.dataset.list({ lineId: s('lineId'), productId: s('productId'), recipeId: s('recipeId'), limit: 200 }),
    ds => ds.lineId,
  )
  return { datasets }
})
