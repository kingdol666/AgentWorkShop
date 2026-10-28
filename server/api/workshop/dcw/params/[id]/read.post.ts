/**
 * POST /api/workshop/dcw/params/:id/read —— 工艺参数读取(读执行节点 PLC 值,物理量纲)。
 * 被动观测免审批;返回 PLC 实时读数 + 当前设定值。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { getDcwParamRepo } from '@/server/services/workshop/dcw/param-map.repo'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { paramLineId, requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  if (!getDcwParamRepo().byId(id)) throw new AppError(404, ErrorCodes.NOT_FOUND, `工艺参数不存在: ${id}`)
  requireLineForResource(user, paramLineId(id), '工艺参数', 'readonly')
  const read = await getDcwController().readParam(id)
  return { read }
})
