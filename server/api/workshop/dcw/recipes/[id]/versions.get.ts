/**
 * GET /api/workshop/dcw/recipes/:id/versions —— 配方参数版本历史(旧→新,尾行=当前版)。
 * 每条:version/at/by(来源)/actorName(人话操作者)/description(变更原因)/params。
 * 2026-10-28:按配方所属产线校验只读授权。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { recipeLineId, requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const recipe = getDcwController().listRecipes().find(r => r.id === id)
  if (!recipe) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
  requireLineForResource(user, recipeLineId(id) ?? recipe.lineId, '配方', 'readonly')
  return { versions: getDcwController().recipeVersions(id) }
})
