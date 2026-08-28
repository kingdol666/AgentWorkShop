/**
 * GET /api/workshop/dcw/recipes —— 配方 + 批次列表。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const repo = getDcwRecipeRepo()
  return { recipes: repo.list(), runs: repo.listRuns() }
})
