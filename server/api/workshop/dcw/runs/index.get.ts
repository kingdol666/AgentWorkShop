/**
 * GET /api/workshop/dcw/runs —— 生产批次列表。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { filterByLine } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  // 产线权限:批次列表按产线过滤
  return { runs: filterByLine(user, getDcwRecipeRepo().listRuns(), r => r.lineId) }
})
