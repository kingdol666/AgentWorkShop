/**
 * POST /api/workshop/dcw/optimizations/:id/rollback —— 执行回退(判定与执行分离的执行半段)。
 * body: { approvalId? }(approvalGate 开启时双人复核)。
 * 目标 = 记录的 from 值;经 write() 单点下发,回退本身入册(source=rollback)。
 */
import { getRouterParam, readBody, setResponseStatus } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { gateDangerous } from '@/server/utils/approval-gate'
import { bindDcwBroadcast } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'
import { audit } from '@/server/services/workshop/ops/ops'
import { useRuntimeConfig } from '#imports'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ approvalId?: string }>(event) ?? {}
  const gate = gateDangerous(useRuntimeConfig(event).approvalGate === true, user, { action: 'optimization.rollback', targetId: id, summary: `回退优化记录 ${id}` }, body.approvalId)
  if (gate.pending) {
    setResponseStatus(event, 202)
    return { pending: true, requestId: gate.requestId }
  }
  const record = await getRecipeRollBackManager().rollbackRecord(id, user.id, 'user', body.approvalId)
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'optimization.rollback', targetKind: 'optimization', targetId: id, detail: { recordId: record?.id } })
  return { record }
})
