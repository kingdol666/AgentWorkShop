/**
 * DELETE /api/workshop/dcw/recipes/:id —— 删除配方。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  // 删除前取归属维度(remove 后不可读),产线日志按线/配方归档
  const recipe = getDcwRecipeRepo().byId(id)
  if (!recipe) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
  requireLineForResource(user, recipe.lineId, '配方', 'operate')
  const activeRun = getDcwRecipeRepo().listRuns().find(r => r.recipeId === id && !r.endedAt)
  if (activeRun) {
    throw new AppError(409, ErrorCodes.CONFLICT, `配方「${recipe.name}」仍在批次 ${activeRun.id.slice(0, 8)} 中执行，请先停线/关批次后再删除`)
  }
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
