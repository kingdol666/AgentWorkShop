/**
 * GET /api/workshop/dcw/lines/:id —— 单产线详情(主资源路径)。
 *
 * 对称性修复(2026-11-09,计划 WP5②):该路径此前只有 PATCH/DELETE 与 start/stop 动作端点,
 * 主资源路径可改不可读 —— 读侧只能拉 /dcw/lines 全量列表再前端筛。
 * 授权与列表同源:产线级读授权(visibleLineIds;admin/editor 全量,普通用户仅授权产线)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { visibleLineIds } from '@/server/services/workshop/permissions'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const ctrl = getDcwController()
  const line = ctrl.listLines().find(l => l.id === id)
  if (!line) throw new AppError(404, 'NOT_FOUND', `产线不存在: ${id}`)
  const visible = visibleLineIds(user)
  // 不可见与不存在同码(不泄露未授权产线的存在性)
  if (visible && !visible.has(id)) throw new AppError(404, 'NOT_FOUND', `产线不存在: ${id}`)
  return { line, state: ctrl.allLineStates().find(s => s.lineId === id) ?? null }
})
