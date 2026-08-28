/**
 * GET /api/workshop/dcw/runs —— 生产批次列表。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  return { runs: getDcwRecipeRepo().listRuns() }
})
