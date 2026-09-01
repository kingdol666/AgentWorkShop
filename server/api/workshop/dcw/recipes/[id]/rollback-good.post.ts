/**
 * POST /api/workshop/dcw/recipes/:id/rollback-good —— 基准恢复:重新下发 lastGood 批次冻结参数集。
 */
import { getRouterParam } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const outcomes = await getRecipeRollBackManager().rollbackRecipeGood(id, user.id)
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'recipe.rollback-good', targetKind: 'recipe', targetId: id, detail: { outcomes } })
  return { outcomes }
})
