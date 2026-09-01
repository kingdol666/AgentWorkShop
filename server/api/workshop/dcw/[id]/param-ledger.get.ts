/**
 * GET /api/workshop/dcw/:id/param-ledger —— 节点参数台账(三值对照 + 在册历史,一次读全)。
 * current(当前设定) / recipeTarget(活动配方目标) / lastGood(良好批次值) / journal / records。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const ledger = getRecipeRollBackManager().ledger(id)
  return { ledger }
})
