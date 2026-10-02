/**
 * POST /api/workshop/dcw/recipes/:id/mark-good —— 标记已知良好批次(基准恢复目标)。
 * body: { runId: string }
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { getDcwRecipeRepo } from '@/server/services/workshop/dcw/dcw-recipe.repo'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  // 权限模型 v3:线域操作切 grant 制 —— 对该配方产线要求 operate(admin 天然放行)
  const recipe = getDcwRecipeRepo().byId(id)
  requireLineMode(user, recipe?.lineId, 'operate')
  const body = await readBody<{ runId?: string }>(event) ?? {}
  if (!body.runId)
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'runId 必填')
  const updated = getDcwRecipeRepo().markGood(id, String(body.runId))
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'recipe.mark-good', targetKind: 'recipe', targetId: id, detail: { runId: body.runId } })
  return { recipe: updated }
})
