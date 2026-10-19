/**
 * DELETE /api/workshop/dcw/recipes/:id —— 删除配方。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  // 删除前取归属维度(remove 后不可读),产线日志按线/配方归档
  const recipe = getDcwRecipeRepo().byId(id)
  getDcwRecipeRepo().remove(id)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'recipe.delete', kind: 'recipe', targetKind: 'recipe', targetId: id,
    lineId: recipe?.lineId ?? '',
    productId: recipe?.productId ?? '',
    recipeId: id,
    summary: `删除配方「${recipe?.name ?? id}」${recipe?.lineId ? `(产线 ${recipe.lineId})` : ''}`,
  })
  return { deleted: true }
})
