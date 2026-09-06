/**
 * GET /api/workshop/dcw/lines —— 产线列表 + 各产线运行状态。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { visibleLineIds } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const ctrl = getDcwController()
  // 产线级权限:普通用户仅见授权产线(admin/editor 全量)
  const visible = visibleLineIds(user)
  return {
    lines: visible ? ctrl.listLines().filter(l => visible.has(l.id)) : ctrl.listLines(),
    states: visible ? ctrl.allLineStates().filter(s => visible.has(s.lineId)) : ctrl.allLineStates(),
  }
})
