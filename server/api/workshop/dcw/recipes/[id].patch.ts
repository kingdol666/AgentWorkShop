/**
 * PATCH /api/workshop/dcw/recipes/:id —— 编辑配方。
 */
import { getRouterParam, readBody } from 'h3'
import type { RecipeInput } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<Partial<RecipeInput>>(event) ?? {}
  const recipe = getDcwRecipeRepo().update(id, body)
  return { recipe }
})
