/**
 * GET /api/workshop/aml/datasets —— 数据集列表(产线可见性过滤;line/product/recipe 可选过滤)。
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
  lineId: z.string().optional(),
  productId: z.string().optional(),
  recipeId: z.string().optional(),
})

const strOf = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim())

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = await getValidatedQuery(event, zValidator(schema))
  const datasets = filterByLine(
    user,
    getAmlRuntime().repo.dataset.list({
      lineId: strOf(q.lineId),
      productId: strOf(q.productId),
      recipeId: strOf(q.recipeId),
      limit: 200,
    }),
    ds => ds.lineId,
  )
  return { datasets }
})
