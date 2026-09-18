/**
 * GET /api/workshop/dcw/params —— 工艺参数映射列表(登录用户)。
 * 仅语义面(key/单位/限界/当前值/驱动类别);寄存器等 PLC 寻址细节不透出。
 * ?lineId= 过滤产线;?limits=1 附带各参数的有效限界剖面(分层 + 交集)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { filterByLine } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const ctrl = getDcwController()
  const q = getQuery(event)
  const lineFilter = q.lineId ? String(q.lineId) : ''
  let params = ctrl.listParamViews()
  params = filterByLine(user, params, p => p.lineId)
  if (lineFilter) params = params.filter(p => p.lineId === lineFilter)
  const withLimits = q.limits === '1'
  return {
    params,
    limits: withLimits ? params.map(p => ctrl.paramLimitsOf(p.id)) : undefined,
  }
})
