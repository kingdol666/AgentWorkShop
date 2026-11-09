/**
 * GET /api/workshop/daq/:id —— 单数采节点详情(主资源路径)。
 *
 * 对称性修复(2026-11-09):该路径此前只有 PATCH/DELETE 与 bind/ingest/samples/frames 等动作端点,
 * 主资源路径可改不可读(读侧只能拉 /daq 列表)。只读:授权按产线 readonly
 * (与 PATCH 的 operate 同源、低一档)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const node = getDaqController().byId(id)
  if (!node) throw new AppError(404, 'NOT_FOUND', `数采节点不存在: ${id}`)
  requireLineMode(user, node.lineId, 'readonly')
  return { node }
})
