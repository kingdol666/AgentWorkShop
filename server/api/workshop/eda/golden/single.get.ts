/**
 * GET /api/workshop/eda/golden/single?recipe_id=&node_id= —— 单条 golden 画像(叠加用)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getGolden } from '@/server/services/workshop/eda/golden'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const g = getGolden(String(q.recipe_id ?? ''), String(q.node_id ?? ''))
  if (!g) throw new AppError(404, 'NOT_FOUND' as never, '该配方/节点尚无 golden 参考轨迹。')
  return { golden: g }
})
