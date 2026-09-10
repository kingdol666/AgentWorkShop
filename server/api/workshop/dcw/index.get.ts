/**
 * GET /api/workshop/dcw —— 写控制节点列表 + 网关状态 + 模板/配方/批次/写历史(登录用户)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { filterByLine, isPrivilegedRole, visibleLineIds } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { listDcwTemplates } from '@/server/services/workshop/dcw/dcw-templates'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const ctrl = getDcwController()
  // 产线级权限:普通用户仅见授权产线及其下属数据(admin/editor 全量)。
  // recipes/products/runs 携带 lineId;history 按 nodeId→节点产线联结;
  // 全局网关统计仅特权角色可见(计数不含产线维度但属运营面)。
  const visible = visibleLineIds(user)
  const privileged = isPrivilegedRole(user)
  const inLine = (lineId: string | null | undefined): boolean =>
    lineId != null && lineId !== '' && visible != null && visible.has(lineId)
  const nodeLine = (nodeId: string): string | undefined => ctrl.byId(nodeId)?.lineId
  return {
    controller: privileged
      ? ctrl.controllerState()
      : { running: ctrl.controllerState().running === true },
    nodes: filterByLine(user, ctrl.listViews(), n => n.lineId),
    templates: listDcwTemplates(),
    recipes: visible ? ctrl.listRecipes().filter(r => inLine(r.lineId)) : ctrl.listRecipes(),
    runs: visible ? ctrl.listRuns().filter(r => inLine(r.lineId)) : ctrl.listRuns(),
    history: visible
      ? ctrl.listHistory(400).filter(h => inLine(nodeLine(h.nodeId))).slice(0, 60)
      : ctrl.listHistory(60),
    products: visible ? ctrl.listProducts().filter(p => inLine(p.lineId)) : ctrl.listProducts(),
    lines: visible ? ctrl.listLines().filter(l => visible.has(l.id)) : ctrl.listLines(),
    lineStates: visible ? ctrl.allLineStates().filter(s => visible.has(s.lineId)) : ctrl.allLineStates(),
  }
})
