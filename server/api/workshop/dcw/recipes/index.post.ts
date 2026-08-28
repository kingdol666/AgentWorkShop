/**
 * POST /api/workshop/dcw/recipes —— 创建配方(body: { name, description?, params? })。
 */
import { readBody } from 'h3'
import type { RecipeInput } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<RecipeInput>(event) ?? { name: '' }
  const recipe = getDcwRecipeRepo().create(body)
  return { recipe }
})
