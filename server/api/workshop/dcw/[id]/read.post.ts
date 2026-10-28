/**
 * POST /api/workshop/dcw/:id/read —— 手动读取 PLC 当前值(读写集成的读半边)。
 * 驱动读(寄存器解码/节点值)→ 标定 decode → 节点读状态记账 + WS dcw.read 直推。
 * 读取是被动观测:不受控制暂停/产线运行门控;不支持读的驱动返回 ok:false 说明。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { requireLineForResource } from '@/server/services/workshop/line-scope'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const node = getDcwController().byId(id)
  if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
  requireLineForResource(user, node.lineId, '数控节点', 'readonly')
  const read = await getDcwController().readNow(id)
  return { read }
})
