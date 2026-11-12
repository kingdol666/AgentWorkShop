/**
 * POST /api/workshop/daq/:id/test —— 存量节点连接测试(用节点已保存的驱动参数)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { broadcastSceneEvent } from '../../../../services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const node = getDaqController().byId(id)
  if (!node) throw new AppError(404, 'NOT_FOUND', `数采节点不存在: ${id}`)
  requireLineMode(user, node.lineId, 'readonly')
  const test = await getDaqController().testNode(id)
  return { test }
})
