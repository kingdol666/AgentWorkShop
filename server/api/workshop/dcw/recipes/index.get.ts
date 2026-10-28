/**
 * GET /api/workshop/dcw/recipes —— 配方 + 批次列表。
 * 2026-10-28:按调用者产线授权过滤(admin/特权见全集)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'
import { filterRowsByLine } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const repo = getDcwRecipeRepo()
  return {
    recipes: filterRowsByLine(user, repo.list(), r => r.lineId),
    runs: filterRowsByLine(user, repo.listRuns(), r => r.lineId),
  }
})
