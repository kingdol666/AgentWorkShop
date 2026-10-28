/**
 * GET /api/workshop/dcw/:id/param-ledger —— 节点参数台账(三值对照 + 在册历史,一次读全)。
 * current(当前设定) / recipeTarget(活动配方目标) / lastGood(良好批次值) / journal / records。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const node = getDcwController().byId(id)
  if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
  requireLineForResource(user, node.lineId, '数控节点', 'readonly')
  const ledger = getRecipeRollBackManager().ledger(id)
  return { ledger }
})
