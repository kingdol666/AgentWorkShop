/**
 * POST /api/workshop/dcw/runs/:id/rollback —— 批次级回退(撤销这次实验)。
 * 恢复该 run 涉及节点在 run.startedAt 之前的值(账本最近批次前稳定锚)。
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
  const outcomes = await getRecipeRollBackManager().rollbackRun(id, user.id)
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'dcw.run.rollback', targetKind: 'recipe-run', targetId: id, detail: { outcomes } })
  return { outcomes }
})
