/**
 * POST /api/workshop/dcw/journal/node/:nodeId/rollback —— 节点级单步回退。
 * body: { to?: anchorId, actor?: string } —— 目标缺省 = 最近稳定锚的 prevValue(撤销栈栈顶)。
 * 回退经 write() 单点:量程/配方窗口/联锁门控自动继承;回退本身入册(source=rollback)。
 */
import { getRouterParam, readBody } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const nodeId = getRouterParam(event, 'nodeId') ?? ''
  const body = await readBody<{ to?: string }>(event) ?? {}
  const record = await getRecipeRollBackManager().rollbackNode(nodeId, user.id, 'user', body.to || undefined)
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'dcw.rollback', targetKind: 'dcw-node', targetId: nodeId, detail: { to: body.to ?? 'last-stable', recordId: record?.id } })
  return { record }
})
