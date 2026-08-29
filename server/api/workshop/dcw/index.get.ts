/**
 * GET /api/workshop/dcw —— 写控制节点列表 + 网关状态 + 模板/配方/批次/写历史(登录用户)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { listDcwTemplates } from '@/server/services/workshop/dcw/dcw-templates'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const ctrl = getDcwController()
  return {
    controller: ctrl.controllerState(),
    nodes: ctrl.listViews(),
    templates: listDcwTemplates(),
    recipes: ctrl.listRecipes(),
    runs: ctrl.listRuns(),
    history: ctrl.listHistory(60),
    products: ctrl.listProducts(),
    lines: ctrl.listLines(),
    lineStates: ctrl.allLineStates(),
  }
})
