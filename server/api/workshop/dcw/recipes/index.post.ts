/**
 * POST /api/workshop/dcw/recipes —— 创建配方(body: { name, description?, params? })。
 * 权限模型 v3:配方归属产线(经 product.lineId),要求对该线 operate;无 productId 的孤儿配方仅 admin。
 */
import { readBody } from 'h3'
import type { RecipeInput } from '#shared/dcw-protocol'
import { requireRole, resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'
import { getDcwProductRepo } from '@/server/services/workshop/dcw/dcw-product.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<RecipeInput>(event) ?? { name: '' }
  let lineId = ''
  if (body.productId) {
    const product = getDcwProductRepo().byId(body.productId)
    if (!product) throw new AppError(404, ErrorCodes.NOT_FOUND, `产品不存在: ${body.productId}`)
    requireLineMode(user, product.lineId, 'operate')
    lineId = product.lineId
  }
  else {
    requireRole(event)
  }
  const recipe = getDcwRecipeRepo().create(body)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'recipe.create', kind: 'recipe', targetKind: 'recipe', targetId: recipe.id,
    lineId: recipe.lineId ?? lineId,
    productId: recipe.productId ?? body.productId ?? '',
    recipeId: recipe.id,
    summary: `创建配方「${recipe.name}」${(recipe.lineId ?? lineId) ? `(产线 ${recipe.lineId ?? lineId})` : '(未分配产线)'}`,
  })
  return { recipe }
})
