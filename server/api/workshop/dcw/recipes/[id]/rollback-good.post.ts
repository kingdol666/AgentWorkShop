/**
 * POST /api/workshop/dcw/recipes/:id/rollback-good —— 基准恢复:重新下发 lastGood 批次冻结参数集。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  // 权限模型 v3:线域操作切 grant 制 —— 对该配方产线要求 operate(admin 天然放行)
  const recipe = getDcwController().listRecipes().find(r => r.id === id)
  requireLineMode(user, recipe?.lineId, 'operate')
  const outcomes = await getRecipeRollBackManager().rollbackRecipeGood(id, user.id)
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'recipe.rollback-good', targetKind: 'recipe', targetId: id, detail: { outcomes } })
  return { outcomes }
})
