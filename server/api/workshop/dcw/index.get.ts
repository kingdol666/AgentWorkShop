/**
 * GET /api/workshop/dcw —— 写控制节点列表 + 网关状态 + 模板/配方/批次/写历史(登录用户)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { filterByLine, visibleLineIds } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { listDcwTemplates } from '@/server/services/workshop/dcw/dcw-templates'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const ctrl = getDcwController()
  // 产线级权限:普通用户仅见授权产线的节点/产线/产线状态(admin/editor 全量)
  const visible = visibleLineIds(user)
  return {
    controller: ctrl.controllerState(),
    nodes: filterByLine(user, ctrl.listViews(), n => n.lineId),
    templates: listDcwTemplates(),
    recipes: ctrl.listRecipes(),
    runs: ctrl.listRuns(),
    history: ctrl.listHistory(60),
    products: ctrl.listProducts(),
    lines: visible ? ctrl.listLines().filter(l => visible.has(l.id)) : ctrl.listLines(),
    lineStates: visible ? ctrl.allLineStates().filter(s => visible.has(s.lineId)) : ctrl.allLineStates(),
  }
})
