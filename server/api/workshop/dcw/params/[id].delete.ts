/**
 * DELETE /api/workshop/dcw/params/:id —— 删除工艺参数映射(仅删语义面,执行节点不受影响)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { getDcwParamRepo } from '@/server/services/workshop/dcw/param-map.repo'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  requireLineMode(user, getDcwController().paramById(id).lineId, 'operate')
  getDcwParamRepo().remove(id)
  return { removed: id }
})
